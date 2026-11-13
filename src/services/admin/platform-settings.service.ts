import { z } from 'zod';
import {
  compareLegalVersions,
  isSectionId,
  LEGAL_DOCUMENTS,
  LEGAL_LOCALES,
  legalKeyOf,
  legalToday,
  parseLegalVersion,
  SECTION_FIELDS,
  type FieldSpec,
  type SectionId
} from '@/core/admin/settings-model';
import { assertVerifiedSuperadmin, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction, type Db } from '@/lib/db';
import { coarseUserAgent, type RequestMeta } from '@/repositories/tenant-guard';
import { InvalidSettingError, SettingConflictError, deleteSecret, updateSecret, updateSettings, invalidateSettingsCache, type SettingChange } from '@/services/settings/settings.service';
import { isSecretKey, secretDefinition, settingDefinition, UnknownSettingError, type SecretKey } from '@/services/settings/setting-definitions';
import { SECRET_REQUIRED_KEYS } from '@/core/admin/settings-model';
import { writeAudit } from '@/services/audit/audit.service';
import type { SettingsRuntime } from './settings-runtime';

/**
 * Guardado de `/admin/ajustes` (Sprint 5.4, QA-A05 · QA-SEC07). Cada bloque de la pantalla guarda **sus** ajustes de una vez (todos o ninguno, con el control de versión de cada
 * uno) y solo los campos de `SECTION_FIELDS`: lo que manda el navegador nunca elige qué ajuste se toca. Todo exige el Super-Admin verificado (TOTP de hace menos de 10 minutos) y deja
 * su rastro; los secretos se escriben cifrados y no se devuelven ni se copian a la auditoría. Lo que un valor válido por sí solo no puede garantizar (una clave sin la que el servicio
 * se para, un monedero con saldo de familias, un texto legal publicado) se comprueba aquí, dentro de la misma transacción.
 */

export type SettingsRejection =
  | 'INVALID'
  | 'STALE'
  | 'UNKNOWN'
  | 'SERVER_IP_REQUIRED'
  | 'FIELD_REQUIRED'
  | 'WALLET_PROVIDER_LOCKED'
  | 'SENDER_REQUIRED'
  | 'INVOICING_PAIR'
  | 'WALLET_PROVIDER_REQUIRED'
  | 'WALLET_KEY_REQUIRED'
  | 'WALLET_CONFIRMATION_REQUIRED'
  | 'WALLET_BALANCES_OPEN'
  | 'VERSION_OLDER'
  | 'VERSION_IN_USE'
  | 'VERSION_NOT_TODAY'
  | 'PUBLISHED_TO_DRAFT'
  | 'SECRET_REQUIRED';

export class SettingsRejectedError extends Error {
  constructor(
    readonly reason: SettingsRejection,
    readonly fields: string[] = []
  ) {
    super(`Ajustes rechazados: ${reason}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`);
    this.name = 'SettingsRejectedError';
  }
}

/**
 * Bloqueo consultivo de la transacción (se libera solo al confirmar o deshacer). Ordena las operaciones que se comprueban unas contra otras y que no comparten fila: el monedero con saldo
 * (modo, proveedor y clave) y la publicación de la política de privacidad en los tres idiomas. Ninguna otra parte los toma, así que no pueden bloquearse en cruz con el resto.
 */
const advisoryLock = async (tx: Db, name: string): Promise<void> => {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))::text`;
};
const HUCHA_LOCK = 'korum:settings:hucha';
const PRIVACY_LOCK = 'korum:settings:privacy-policy';

const auditOf = (meta?: RequestMeta) => ({ ipHash: meta?.ipHash ?? null, userAgent: coarseUserAgent(meta?.userAgent) });

/** Convierte lo que escribió la persona en el valor del ajuste: texto vacío = «sin valor» (`null`), números escritos como texto y selectores de la lista. */
function coerceField(spec: FieldSpec, raw: unknown): unknown {
  switch (spec.kind) {
    case 'text': {
      if (raw === null || raw === undefined) return null;
      if (typeof raw !== 'string') throw new SettingsRejectedError('INVALID', [spec.key]);
      const trimmed = raw.trim();
      return trimmed === '' ? null : trimmed;
    }
    case 'select': {
      if (raw === null || raw === undefined || raw === '') return null;
      if (typeof raw !== 'string' || !spec.options?.includes(raw)) throw new SettingsRejectedError('INVALID', [spec.key]);
      return raw;
    }
    case 'number': {
      if (raw === null || raw === undefined || raw === '') return null;
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,7}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(value)) throw new SettingsRejectedError('INVALID', [spec.key]);
      return value;
    }
    case 'json':
      return raw === undefined ? null : raw;
  }
}

const sectionPayload = z.object({
  section: z.string().refine(isSectionId),
  values: z.record(z.string().max(80), z.unknown()),
  versions: z.record(z.string().max(80), z.number().int().min(0).max(1_000_000)),
  confirmations: z.array(z.string().max(40)).max(5).default([])
});

export interface SaveSectionResult {
  changed: number;
  /** Versión de cada ajuste del bloque tras guardar: la pantalla la recarga con la página. */
  versions: Record<string, number>;
}

/** Hace efectiva la regla de un bloque con lo que quedará guardado (el estado final de cada clave tocada) y lo que ya hay en la base. */
async function validateSection(tx: Db, section: SectionId, final: ReadonlyMap<string, unknown>, confirmations: readonly string[], runtime: Pick<SettingsRuntime, 'paycometMode' | 'fallbacks'>): Promise<void> {
  const mode = runtime.paycometMode;
  const fallbacks = runtime.fallbacks ?? process.env;
  const stored = async (key: string) => tx.platformSetting.findUnique({ where: { key }, select: { valueJson: true } });
  // Lo que valdrá cada ajuste tras guardar: el valor nuevo si el bloque lo trae y, si no, el que ya hay.
  const effective = async (key: string): Promise<unknown> => (final.has(key) ? final.get(key) : (await stored(key))?.valueJson);

  if (section === 'pagos' && mode !== 'mock' && final.has('paycomet.serverIp') && final.get('paycomet.serverIp') === undefined && (await stored('paycomet.serverIp'))) {
    // Sin la IP que se da de alta en Paycomet, las devoluciones fallan: con cobros reales o de pruebas no se puede dejar vacía (DECISIONES §7.1).
    throw new SettingsRejectedError('SERVER_IP_REQUIRED', ['paycomet.serverIp']);
  }
  if (section === 'pagos' && mode !== 'mock') {
    // El código de comercio y el terminal paran los cobros igual que la clave: no se vacían salvo que el servidor tenga una variable de respaldo a la que volver.
    for (const [key, env] of [['paycomet.merchantCode', 'PAYCOMET_MERCHANT_CODE'], ['paycomet.terminalId', 'PAYCOMET_TERMINAL_ID']] as const) {
      if (final.has(key) && final.get(key) === undefined && (await stored(key)) && !fallbacks[env]?.trim()) throw new SettingsRejectedError('FIELD_REQUIRED', [key]);
    }
  }
  if (section === 'email' && mode !== 'mock' && final.has('email.fromAddress') && final.get('email.fromAddress') === undefined && (await stored('email.fromAddress'))) {
    // Sin remitente la bandeja no envía nada: quien paga no recibiría su recibo ni quien firma su enlace.
    throw new SettingsRejectedError('SENDER_REQUIRED', ['email.fromAddress']);
  }
  if (section === 'facturacion') {
    const nif = ((await effective('invoicing.issuerNif')) as string | undefined) ?? fallbacks.VERIFACTU_ISSUER_NIF?.trim();
    const name = ((await effective('invoicing.issuerName')) as string | undefined) ?? fallbacks.VERIFACTU_ISSUER_NAME?.trim();
    // Sin el NIF o sin la razón social no se emite ninguna factura (un patrocinio con fee falla y Paycomet reintenta): o están los dos o ninguno.
    if (Boolean(nif) !== Boolean(name)) throw new SettingsRejectedError('INVOICING_PAIR', ['invoicing.issuerNif', 'invoicing.issuerName']);
  }
  if (section === 'hucha') {
    await advisoryLock(tx, HUCHA_LOCK);
    const currentMode = ((await stored('hucha.mode'))?.valueJson as string | undefined) ?? 'PLEDGE';
    const effectiveMode = ((await effective('hucha.mode')) as string | undefined) ?? 'PLEDGE';
    if (effectiveMode === 'REGULATED_WALLET') {
      if ((await effective('hucha.walletProvider')) === undefined) throw new SettingsRejectedError('WALLET_PROVIDER_REQUIRED', ['hucha.walletProvider']);
      if (!(await tx.platformSecret.findUnique({ where: { key: 'hucha.walletApiKey' }, select: { key: true } }))) throw new SettingsRejectedError('WALLET_KEY_REQUIRED', ['hucha.walletProvider']);
      // Pasar a monedero con saldo exige haber recibido la confirmación del proveedor y la revisión legal (CUMPLIMIENTO §3): se marca de forma expresa.
      if (currentMode !== 'REGULATED_WALLET' && !confirmations.includes('walletLegal')) throw new SettingsRejectedError('WALLET_CONFIRMATION_REQUIRED', ['hucha.mode']);
      // Cambiar la entidad que custodia el saldo con saldos de familias abiertos dejaría ese dinero en manos de otra sin que nadie lo haya trasladado.
      const provider = (await effective('hucha.walletProvider')) as string | undefined;
      if (currentMode === 'REGULATED_WALLET' && provider !== ((await stored('hucha.walletProvider'))?.valueJson as string | undefined) && (await tx.user.count({ where: { walletBalanceCents: { gt: 0 } } })) > 0) {
        throw new SettingsRejectedError('WALLET_PROVIDER_LOCKED', ['hucha.walletProvider']);
      }
    } else if (currentMode === 'REGULATED_WALLET') {
      // Salir del monedero con saldos de familias dejaría ese dinero sin pantalla desde la que retirarlo. (Hoy no existe ninguna recarga que pueda coincidir con este guardado: cuando exista,
      // tendrá que tomar el mismo bloqueo; ver DECISIONES_TECNICAS §2.25.)
      const open = await tx.user.count({ where: { walletBalanceCents: { gt: 0 } } });
      if (open > 0) throw new SettingsRejectedError('WALLET_BALANCES_OPEN', ['hucha.mode']);
    }
  }
}

/**
 * Guarda un bloque de ajustes. `values` lleva solo los campos del bloque (los demás se rechazan) y `versions`, la versión de cada uno que se veía al editar. Rechaza con
 * `SettingsRejectedError` (qué campos y por qué) y deja la base intacta; otra persona que guardó antes da `STALE`.
 */
export async function saveSettingsSection(db: Db, actor: VerifiedSuperadminActor, raw: unknown, runtime: Pick<SettingsRuntime, 'paycometMode' | 'fallbacks'>, meta?: RequestMeta, now: Date = new Date()): Promise<SaveSectionResult> {
  assertVerifiedSuperadmin(actor, 'settings.update', now);
  const payload = sectionPayload.safeParse(raw);
  if (!payload.success) throw new SettingsRejectedError('INVALID');
  const section = payload.data.section as SectionId;
  const specs = SECTION_FIELDS[section];
  const unknown = Object.keys(payload.data.values).filter((key) => !specs.some((spec) => spec.key === key));
  if (unknown.length > 0) throw new SettingsRejectedError('UNKNOWN', unknown);

  const changes: SettingChange[] = [];
  const invalid: string[] = [];
  for (const spec of specs) {
    if (!(spec.key in payload.data.values)) continue;
    const expectedVersion = payload.data.versions[spec.key];
    if (expectedVersion === undefined) {
      invalid.push(spec.key);
      continue;
    }
    const value = coerceField(spec, payload.data.values[spec.key]);
    if (value !== null) {
      const check = settingDefinition(spec.key).schema.safeParse(value);
      if (!check.success) {
        // Los datos de la empresa son un objeto: se dice **qué campo** falla (`platform.company.taxId`), no solo que algo falla.
        const fields = spec.key === 'platform.company' ? [...new Set(check.error.issues.map((issue) => (typeof issue.path[0] === 'string' ? `${spec.key}.${issue.path[0]}` : spec.key)))] : [spec.key];
        invalid.push(...fields);
      }
    }
    // Quien activa el monedero con saldo marca una confirmación expresa: queda en el historial junto al cambio de modo (solo se escribe si el modo cambia de verdad).
    const auditExtra = spec.key === 'hucha.mode' && value === 'REGULATED_WALLET' && payload.data.confirmations.includes('walletLegal') ? { walletLegalConfirmed: true } : undefined;
    changes.push({ key: spec.key, value, expectedVersion, ...(auditExtra ? { auditExtra } : {}) });
  }
  if (invalid.length > 0) throw new SettingsRejectedError('INVALID', invalid);

  try {
    const result = await updateSettings(db, actor, changes, { now, operation: 'settings.update', audit: auditOf(meta), ...(runtime.fallbacks ? { fallbacks: runtime.fallbacks } : {}), ...(section === 'hucha' ? { beforeRead: (tx: Db) => advisoryLock(tx, HUCHA_LOCK) } : {}), validate: (tx, final) => validateSection(tx, section, final, payload.data.confirmations, runtime) });
    return { changed: result.changed.length, versions: result.versions };
  } catch (error) {
    throw asRejection(error);
  }
}

function asRejection(error: unknown): unknown {
  if (error instanceof SettingConflictError) return new SettingsRejectedError('STALE', [error.key]);
  if (error instanceof InvalidSettingError) return new SettingsRejectedError('INVALID', [error.key]);
  if (error instanceof UnknownSettingError) return new SettingsRejectedError('UNKNOWN', [error.key]);
  return error;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Secretos
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const secretPayload = z.object({ key: z.string().refine(isSecretKey), value: z.string().min(1).max(4096) });

/** Guarda un secreto cifrado. El valor no vuelve a salir: ni en la respuesta, ni en la auditoría, ni en los errores. */
export async function saveSecretValue(db: Db, actor: VerifiedSuperadminActor, raw: unknown, runtime: Pick<SettingsRuntime, 'keyring'>, meta?: RequestMeta, now: Date = new Date()): Promise<{ hint: string | null }> {
  assertVerifiedSuperadmin(actor, 'settings.secret_update', now);
  const payload = secretPayload.safeParse(raw);
  if (!payload.success) throw new SettingsRejectedError('INVALID');
  try {
    return await updateSecret(db, actor, runtime.keyring, payload.data.key as SecretKey, payload.data.value, { now, audit: auditOf(meta) });
  } catch (error) {
    throw asRejection(error);
  }
}

/**
 * Quita un secreto de la consola. Se aplican las mismas reglas que al vaciar un campo: con el monedero con saldo activo no se quita la clave de la entidad que lo custodia y, con cobros de
 * pruebas o reales, tampoco la de Paycomet ni la de Brevo **salvo que el servidor tenga una variable de respaldo** a la que volver (sin ella, el servicio se pararía).
 */
export async function removeSecretValue(db: Db, actor: VerifiedSuperadminActor, raw: unknown, runtime: Pick<SettingsRuntime, 'paycometMode' | 'fallbacks'>, meta?: RequestMeta, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'settings.secret_delete', now);
  const payload = z.object({ key: z.string().refine(isSecretKey) }).safeParse(raw);
  if (!payload.success) throw new SettingsRejectedError('INVALID');
  const key = payload.data.key as SecretKey;
  const envName = secretDefinition(key).envFallback;
  const hasFallback = Boolean(envName && (runtime.fallbacks ?? process.env)[envName]?.trim());
  await inTransaction(db, async (tx) => {
    if (key === 'hucha.walletApiKey') await advisoryLock(tx, HUCHA_LOCK);
    if (key === 'hucha.walletApiKey' && (await tx.platformSetting.findUnique({ where: { key: 'hucha.mode' }, select: { valueJson: true } }))?.valueJson === 'REGULATED_WALLET') {
      throw new SettingsRejectedError('WALLET_KEY_REQUIRED', ['hucha.walletApiKey']);
    }
    if (SECRET_REQUIRED_KEYS.includes(key) && runtime.paycometMode !== 'mock' && !hasFallback) throw new SettingsRejectedError('SECRET_REQUIRED', [key]);
    await deleteSecret(tx, actor, key, { now, audit: auditOf(meta) });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Textos legales versionados
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const legalPayload = z.object({
  document: z.enum(LEGAL_DOCUMENTS),
  locale: z.enum(LEGAL_LOCALES),
  version: z.string().max(20),
  status: z.enum(['BORRADOR', 'PUBLICADO']),
  markdown: z.string().min(1).max(200_000),
  expectedVersion: z.number().int().min(0).max(1_000_000)
});

type StoredLegal = { version: string; status: 'BORRADOR' | 'PUBLICADO'; markdown: string };

/**
 * Guarda un texto legal (`legal.{documento}.{idioma}`). Reglas: la versión es la fecha de publicación (`AAAA-MM-DD`, con `.1`, `.2`… si hay varias el mismo día, siempre en su forma canónica) y no
 * puede ser anterior a la guardada; un texto **publicado** no se edita bajo su misma versión (hay que publicar una nueva: lo que aceptó cada persona se identifica por la versión) ni vuelve a
 * borrador; **al publicar, la fecha es la de hoy en España** (ni futura ni atrasada: es la fecha de publicación y sirve de prueba). Al publicar la política de privacidad en los tres idiomas,
 * `privacy.policyVersion` sube a la **más antigua** de las tres (la guardan los consentimientos; para no registrar una versión **posterior** a la que vio la persona).
 */
export async function saveLegalText(db: Db, actor: VerifiedSuperadminActor, raw: unknown, meta?: RequestMeta, now: Date = new Date()): Promise<{ version: string; settingVersion: number }> {
  assertVerifiedSuperadmin(actor, 'settings.update', now);
  const payload = legalPayload.safeParse(raw);
  if (!payload.success) throw new SettingsRejectedError('INVALID');
  const { document, locale, status, markdown, expectedVersion } = payload.data;
  const version = payload.data.version.trim();
  if (parseLegalVersion(version) === null) throw new SettingsRejectedError('INVALID', ['version']);
  const key = legalKeyOf(document, locale);
  const value: StoredLegal = { version, status, markdown };
  if (!settingDefinition(key).schema.safeParse(value).success) throw new SettingsRejectedError('INVALID', ['markdown']);

  try {
    const result = await inTransaction(db, async (tx) => {
      const current = await tx.platformSetting.findUnique({ where: { key }, select: { version: true, valueJson: true } });
      if ((current?.version ?? 0) !== expectedVersion) throw new SettingsRejectedError('STALE', [key]);
      const before = current?.valueJson as StoredLegal | undefined;
      const identical = before !== undefined && before.version === version && before.status === status && before.markdown === markdown;
      if (before) {
        const order = compareLegalVersions(version, before.version);
        // La versión no retrocede frente a un texto **publicado**. Un borrador puede llevar cualquier fecha (p. ej. una errata) y se corrige o se publica con la de hoy.
        if (before.status === 'PUBLICADO' && order < 0) throw new SettingsRejectedError('VERSION_OLDER', ['version']);
        if (before.status === 'PUBLICADO' && status === 'BORRADOR') throw new SettingsRejectedError('PUBLISHED_TO_DRAFT', ['status']);
        // Misma versión (aunque se escriba de otra forma) con un texto publicado: no se reescribe.
        if (before.status === 'PUBLICADO' && order === 0 && !identical) throw new SettingsRejectedError('VERSION_IN_USE', ['version']);
      }
      if (status === 'PUBLICADO' && !identical && parseLegalVersion(version)?.date !== legalToday(now)) throw new SettingsRejectedError('VERSION_NOT_TODAY', ['version']);
      const changes: SettingChange[] = [{ key, value, expectedVersion, auditExtra: { legalVersion: version, legalStatus: status, characters: markdown.length } }];
      if (document === 'privacidad' && status === 'PUBLICADO') {
        // La versión que guarda cada consentimiento es una sola para los tres idiomas: solo sube cuando **los tres** están publicados y pasa a la más antigua de las tres, así una familia no
        // queda registrada con una versión **posterior** a la que vio. Límite conocido (CUMPLIMIENTO §9): al publicar una versión nueva en un idioma, quien acepta en él se sigue registrando
        // con la versión anterior mientras los otros no la alcanzan, y sin archivo de versiones ese texto anterior ya no se puede reproducir.
        // Dos publicaciones a la vez (los tres idiomas) se ordenan con un bloqueo: cada una ve las demás ya confirmadas.
        await advisoryLock(tx, PRIVACY_LOCK);
        const published = [version];
        let allPublished = true;
        for (const other of LEGAL_LOCALES.filter((candidate) => candidate !== locale)) {
          const row = await tx.platformSetting.findUnique({ where: { key: legalKeyOf('privacidad', other) }, select: { valueJson: true } });
          const text = row?.valueJson as StoredLegal | undefined;
          if (text?.status === 'PUBLICADO') published.push(text.version);
          else allPublished = false;
        }
        const policy = await tx.platformSetting.findUnique({ where: { key: 'privacy.policyVersion' }, select: { version: true, valueJson: true } });
        const currentPolicy = (policy?.valueJson as string | undefined) ?? (settingDefinition('privacy.policyVersion').defaultValue as string);
        const oldest = [...published].sort(compareLegalVersions)[0] ?? version;
        // Solo sube: nunca hace retroceder lo que ya aceptaron las personas.
        if (allPublished && compareLegalVersions(oldest, currentPolicy) > 0) changes.push({ key: 'privacy.policyVersion', value: oldest, expectedVersion: policy?.version ?? 0, auditExtra: { reason: 'privacy_text_published' } });
      }
      const saved = await updateSettings(tx, actor, changes, { now, operation: 'settings.update', audit: auditOf(meta) });
      return { version, settingVersion: saved.versions[key] ?? 0, keys: changes.map((change) => change.key) };
    });
    for (const changedKey of result.keys) invalidateSettingsCache(changedKey);
    return { version: result.version, settingVersion: result.settingVersion };
  } catch (error) {
    throw asRejection(error);
  }
}

/** Deja constancia de una comprobación de conexión (sin credenciales ni respuesta del proveedor: solo qué se probó y cómo salió). */
export async function auditConnectionTest(db: Db, actor: VerifiedSuperadminActor, target: string, status: string, code: string | null, meta?: RequestMeta): Promise<void> {
  await writeAudit(db, { actorType: 'USER', actorUserId: actor.userId, ...auditOf(meta), action: 'settings.connection_tested', targetType: 'PlatformSetting', targetId: target, metadata: { status, ...(code ? { code } : {}) } });
}
