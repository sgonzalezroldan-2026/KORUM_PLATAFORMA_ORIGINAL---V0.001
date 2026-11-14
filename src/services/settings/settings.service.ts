import { isDeepStrictEqual } from 'node:util';
import { CRYPTO_CONTEXT, openParts, sealParts, secretHint, type Keyring } from '@/core/security/crypto';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Prisma } from '@/generated/prisma/client';
import { inTransaction, isUniqueViolation, type Db } from '@/lib/db';
import { writeAudit } from '@/services/audit/audit.service';
import { isSecretKey, secretDefinition, settingDefinition, type SecretKey, type SettingKey, type SettingValue } from './setting-definitions';

/**
 * Lectura y escritura de los ajustes de `/admin/ajustes` (QA-SEC07, Regla 01 §5).
 *
 * - **Prioridad:** valor de la consola → variable de respaldo → valor por defecto del catálogo. Un valor de la base que ya no pasa su
 *   validación (p. ej. tras cambiar el catálogo) no se usa en silencio: se lanza `InvalidSettingError` para que se corrija en la consola.
 * - **Caché de 30 s por proceso:** las lecturas frecuentes (cada webhook lee la contraseña de Paycomet) no van a la base. Guardar un
 *   valor vacía la caché de ese proceso al momento; los demás procesos lo ven en, como mucho, 30 s, sin reiniciar nada.
 * - **Escritura:** solo con un `VerifiedSuperadminActor` (sesión con segundo factor reciente, que se vuelve a comprobar en la base dentro
 *   de la transacción), con control de versión opcional para que
 *   dos personas no se pisen, y con rastro en la auditoría. Los secretos nunca se copian a la auditoría, ni siquiera su pista.
 */

export const SETTINGS_CACHE_TTL_MS = 30_000;

export class InvalidSettingError extends Error {
  constructor(
    readonly key: string,
    readonly issues: string[]
  ) {
    super(`El ajuste «${key}» no es válido: ${issues.join('; ')}`);
    this.name = 'InvalidSettingError';
  }
}

export class SettingConflictError extends Error {
  constructor(readonly key: string) {
    super(`El ajuste «${key}» ha cambiado mientras se editaba: vuelve a cargarlo antes de guardar`);
    this.name = 'SettingConflictError';
  }
}

type Fallbacks = Readonly<Record<string, string | undefined>>;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Vacía la caché de este proceso (la usan las escrituras y las pruebas). */
export function invalidateSettingsCache(key?: string): void {
  if (key === undefined) cache.clear();
  else {
    cache.delete(`setting:${key}`);
    cache.delete(`secret:${key}`);
  }
}

async function cached<T>(cacheKey: string, load: () => Promise<T>, useCache = true): Promise<T> {
  // Con variables de respaldo inyectadas (pruebas) no se usa la caché: no distingue de qué variables salió el valor.
  if (!useCache) return load();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(cacheKey, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return value;
}

function parseOrThrow<T>(key: string, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidSettingError(key, result.error.issues.map((issue) => issue.message));
  return result.data;
}

/** Valor efectivo de un ajuste, o `undefined` si no tiene ni valor, ni respaldo, ni valor por defecto. */
export async function getSetting<K extends SettingKey>(db: Db, key: K, fallbacks: Fallbacks = process.env): Promise<SettingValue<K> | undefined> {
  const definition = settingDefinition(key);
  return cached(`setting:${key}`, async () => {
    const row = await db.platformSetting.findUnique({ where: { key }, select: { valueJson: true } });
    if (row) return parseOrThrow(key, definition.schema, row.valueJson) as SettingValue<K>;
    const fromEnv = definition.envFallback ? fallbacks[definition.envFallback]?.trim() : undefined;
    if (fromEnv) return parseOrThrow(key, definition.schema, fromEnv) as SettingValue<K>;
    return definition.defaultValue as SettingValue<K> | undefined;
  }, fallbacks === process.env);
}

/** Secreto descifrado (solo en servidor), o `undefined` si la consola no lo tiene y tampoco hay variable de respaldo. */
export async function getSecret(db: Db, keyring: Keyring, key: SecretKey, fallbacks: Fallbacks = process.env): Promise<string | undefined> {
  const definition = secretDefinition(key);
  return cached(`secret:${key}`, async () => {
    const row = await db.platformSecret.findUnique({ where: { key } });
    if (row) return openParts(keyring, row, CRYPTO_CONTEXT.platformSecret(key));
    const fromEnv = definition.envFallback ? fallbacks[definition.envFallback]?.trim() : undefined;
    return fromEnv || undefined;
  }, fallbacks === process.env);
}

/** Comprobaciones entre ajustes: un valor válido por sí mismo puede no serlo con los demás. */
async function assertCoherent(tx: Db, key: string, value: unknown): Promise<void> {
  if (key === 'hucha.mode' && value === 'REGULATED_WALLET') {
    const provider = await tx.platformSetting.findUnique({ where: { key: 'hucha.walletProvider' }, select: { key: true } });
    if (!provider) throw new InvalidSettingError(key, ['El monedero regulado solo se puede activar con «hucha.walletProvider» configurado (CUMPLIMIENTO §3)']);
  }
}

/**
 * Versión siguiente de un ajuste. Nunca repite una ya usada: con la fila borrada la cuenta vuelve a 0, así que se parte del número de cambios que quedan en la auditoría (inmutable);
 * si no, A (que vio la versión 1), B (que lo vació) y C (que lo creó otra vez con la versión 1) dejarían a A pisar el cambio de C sin aviso.
 */
async function nextVersion(tx: Db, key: string, currentVersion: number): Promise<number> {
  if (currentVersion > 0) return currentVersion + 1;
  const history = await tx.auditLog.count({ where: { targetType: 'PlatformSetting', targetId: key, action: { in: ['settings.setting.updated', 'settings.setting.cleared'] } } });
  return history + 1;
}

export interface UpdateSettingOptions {
  /** Versión que se tenía en pantalla al editar. Si otra persona guardó antes, la escritura se rechaza. */
  expectedVersion?: number;
  now?: Date;
}

/** Crea la fila. Dos altas a la vez de un ajuste sin fila: la que pierde choca con la clave única y se cuenta como «otra persona guardó antes». */
async function createRow(tx: Db, key: string, value: Prisma.InputJsonValue, version: number, userId: string): Promise<void> {
  try {
    await tx.platformSetting.create({ data: { key, valueJson: value, version, updatedById: userId } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SettingConflictError(key);
    throw error;
  }
}

export async function updateSetting<K extends SettingKey>(db: Db, actor: VerifiedSuperadminActor, key: K, value: SettingValue<K>, options: UpdateSettingOptions = {}): Promise<{ version: number }> {
  assertVerifiedSuperadmin(actor, 'settings.update', options.now);
  const definition = settingDefinition(key);
  const parsed = parseOrThrow(key, definition.schema, value) as Prisma.InputJsonValue;
  const result = await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'settings.update', options.now);
    await assertCoherent(tx, key, parsed);
    const current = await tx.platformSetting.findUnique({ where: { key }, select: { version: true } });
    if (options.expectedVersion !== undefined && (current?.version ?? 0) !== options.expectedVersion) throw new SettingConflictError(key);
    const version = await nextVersion(tx, key, current?.version ?? 0);
    // La condición de versión en la escritura cubre la carrera entre la lectura y el guardado.
    if (current) {
      const { count } = await tx.platformSetting.updateMany({ where: { key, version: current.version }, data: { valueJson: parsed, version, updatedById: actor.userId } });
      if (count === 0) throw new SettingConflictError(key);
    } else {
      await createRow(tx, key, parsed, version, actor.userId);
    }
    await writeAudit(tx, {
      actorType: 'USER',
      actorUserId: actor.userId,
      action: 'settings.setting.updated',
      targetType: 'PlatformSetting',
      targetId: key,
      metadata: { version, ...(definition.auditValue ? { newSetting: parsed } : {}) }
    });
    return { version };
  });
  invalidateSettingsCache(key);
  return result;
}

export interface SettingChange {
  /** Clave del catálogo (`settingDefinition` rechaza la que no esté). */
  key: string;
  /** El valor nuevo, tal como lo manda la pantalla (se valida con el esquema del catálogo). `null` borra el ajuste: vuelve la variable de respaldo o el valor por defecto. */
  value: unknown;
  /** La versión que se veía al editar (0 si el ajuste no existía). `null`: sin control de versión (un cambio derivado de otro, como la versión de la política de privacidad). */
  expectedVersion: number | null;
  /** Datos no sensibles que se suman a la auditoría de esta clave (p. ej. la versión y el estado de un texto legal). */
  auditExtra?: Record<string, string | number | boolean>;
}

export interface AuditWho {
  ipHash?: string | null;
  userAgent?: string | null;
}

export interface UpdateSettingsOptions {
  now?: Date;
  operation?: string;
  /** Quién y desde dónde: HMAC de la IP y familia de navegador, para la auditoría. */
  audit?: AuditWho;
  /**
   * Se llama dentro de la transacción, justo después de comprobar quién actúa y **antes de leer ninguna fila**: para tomar un bloqueo que ordene las operaciones que se comprueban unas contra
   * otras. Un bloqueo tomado después de leer (en `validate`) deja que una operación decida con valores que otra ya cambió.
   */
  beforeRead?: (tx: Db) => Promise<void>;
  /** Variables de respaldo (por defecto, las del proceso): un valor igual al de respaldo no cuenta como cambio. */
  fallbacks?: Fallbacks;
  /**
   * Comprobación entre ajustes, dentro de la transacción y con lo que ya hay leído: recibe el estado **final** de cada clave tocada (valor nuevo, o `undefined` si queda sin valor).
   * Lanza para rechazar el guardado entero.
   */
  validate?: (tx: Db, final: ReadonlyMap<string, unknown>) => Promise<void>;
}

export interface UpdateSettingsResult {
  /** Claves que cambiaron de verdad (las que ya valían lo mismo no se escriben, ni suben de versión, ni dejan rastro). */
  changed: string[];
  /** Versión de cada clave tocada tras el guardado (0 si queda sin valor). */
  versions: Record<string, number>;
}

const sameJson = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);

/**
 * Guarda varios ajustes **a la vez**: todos o ninguno, cada uno con su control de versión y su rastro en la auditoría. Las claves se procesan en orden alfabético para que dos
 * guardados simultáneos con claves en común se ordenen en lugar de bloquearse en cruz. Un valor `null` borra el ajuste. Un valor que ya es el vigente (o el de por defecto, si el
 * ajuste no tiene fila) no escribe nada: guardar un bloque sin tocarlo no crea filas ni ruido en la auditoría.
 */
export async function updateSettings(db: Db, actor: VerifiedSuperadminActor, changes: readonly SettingChange[], options: UpdateSettingsOptions = {}): Promise<UpdateSettingsResult> {
  const operation = options.operation ?? 'settings.update';
  assertVerifiedSuperadmin(actor, operation, options.now);
  const seen = new Set<string>();
  const parsed = changes
    .map((change) => {
      if (seen.has(change.key)) throw new InvalidSettingError(change.key, ['El ajuste aparece dos veces en el mismo guardado']);
      seen.add(change.key);
      const definition = settingDefinition(change.key);
      return { change, definition, value: change.value === null ? null : (parseOrThrow(change.key, definition.schema, change.value) as Prisma.InputJsonValue) };
    })
    .sort((a, b) => (a.change.key < b.change.key ? -1 : a.change.key > b.change.key ? 1 : 0));

  const result = await inTransaction(db, async (tx): Promise<UpdateSettingsResult> => {
    await revalidateActor(tx, actor, operation, options.now);
    if (options.beforeRead) await options.beforeRead(tx);
    const out: UpdateSettingsResult = { changed: [], versions: {} };
    const final = new Map<string, unknown>();
    const writes: Array<() => Promise<void>> = [];
    for (const { change, definition, value } of parsed) {
      const current = await tx.platformSetting.findUnique({ where: { key: change.key }, select: { version: true, valueJson: true } });
      const currentVersion = current?.version ?? 0;
      if (change.expectedVersion !== null && currentVersion !== change.expectedVersion) throw new SettingConflictError(change.key);
      // Sin fila, «lo vigente» es la variable de respaldo del servidor o, si no hay, el valor por defecto del catálogo: guardar ese mismo valor (o dejar vacío un campo sin valor) no cambia
      // nada. Si no, guardar un bloque congelaría en la consola los valores del despliegue y un cambio posterior de la variable se ignoraría sin avisar.
      const envValue = definition.envFallback ? (options.fallbacks ?? process.env)[definition.envFallback]?.trim() : undefined;
      const effective = current ? current.valueJson : envValue ? envValue : definition.defaultValue;
      const unchanged = value === null ? current === null : sameJson(value, effective);
      out.versions[change.key] = currentVersion;
      final.set(change.key, value === null ? undefined : value);
      if (unchanged) continue;
      const version = value === null ? 0 : await nextVersion(tx, change.key, currentVersion);
      out.changed.push(change.key);
      out.versions[change.key] = version;
      writes.push(async () => {
        if (value === null) {
          const { count } = await tx.platformSetting.deleteMany({ where: { key: change.key, version: currentVersion } });
          if (count === 0) throw new SettingConflictError(change.key);
        } else if (current) {
          const { count } = await tx.platformSetting.updateMany({ where: { key: change.key, version: currentVersion }, data: { valueJson: value, version, updatedById: actor.userId } });
          if (count === 0) throw new SettingConflictError(change.key);
        } else {
          await createRow(tx, change.key, value, version, actor.userId);
        }
        await writeAudit(tx, {
          actorType: 'USER',
          actorUserId: actor.userId,
          ipHash: options.audit?.ipHash ?? null,
          userAgent: options.audit?.userAgent ?? null,
          action: value === null ? 'settings.setting.cleared' : 'settings.setting.updated',
          targetType: 'PlatformSetting',
          targetId: change.key,
          metadata: { version, ...(definition.auditValue && value !== null ? { newSetting: value } : {}), ...change.auditExtra }
        });
      });
    }
    // Primero se leen y comprueban todas las versiones y después se escribe: un conflicto en la última clave no deja medio guardado (la transacción lo deshace igualmente).
    if (options.validate) await options.validate(tx, final);
    for (const write of writes) await write();
    return out;
  });
  for (const { change } of parsed) invalidateSettingsCache(change.key);
  return result;
}

export async function updateSecret(db: Db, actor: VerifiedSuperadminActor, keyring: Keyring, key: SecretKey, plaintext: string, options: { now?: Date; audit?: AuditWho } = {}): Promise<{ hint: string | null }> {
  assertVerifiedSuperadmin(actor, 'settings.secret_update', options.now);
  const definition = secretDefinition(key);
  const trimmed = plaintext.trim();
  if (trimmed.length < definition.minLength || trimmed.length > 4096) throw new InvalidSettingError(key, [`El secreto debe tener entre ${definition.minLength} y 4096 caracteres`]);
  if (definition.pattern && !definition.pattern.test(trimmed)) throw new InvalidSettingError(key, [definition.patternMessage ?? 'El secreto no tiene el formato esperado']);
  const sealed = sealParts(keyring, trimmed, CRYPTO_CONTEXT.platformSecret(key));
  const hint = secretHint(trimmed);
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'settings.secret_update', options.now);
    const data = { ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.authTag, keyVersion: sealed.keyVersion, hint, updatedById: actor.userId };
    await tx.platformSecret.upsert({ where: { key }, create: { key, ...data }, update: data });
    await writeAudit(tx, { actorType: 'USER', actorUserId: actor.userId, ipHash: options.audit?.ipHash ?? null, userAgent: options.audit?.userAgent ?? null, action: 'settings.secret.updated', targetType: 'PlatformSecret', targetId: key, metadata: { keyVersion: sealed.keyVersion } });
  });
  invalidateSettingsCache(key);
  return { hint };
}

/** Borra un secreto de la consola: vuelve a usarse la variable de respaldo, si la hay. */
export async function deleteSecret(db: Db, actor: VerifiedSuperadminActor, key: SecretKey, options: { now?: Date; audit?: AuditWho } = {}): Promise<void> {
  assertVerifiedSuperadmin(actor, 'settings.secret_delete', options.now);
  secretDefinition(key);
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'settings.secret_delete', options.now);
    const { count } = await tx.platformSecret.deleteMany({ where: { key } });
    if (count > 0) await writeAudit(tx, { actorType: 'USER', actorUserId: actor.userId, ipHash: options.audit?.ipHash ?? null, userAgent: options.audit?.userAgent ?? null, action: 'settings.secret.deleted', targetType: 'PlatformSecret', targetId: key });
  });
  invalidateSettingsCache(key);
}

export interface SecretSummary {
  key: SecretKey;
  configured: boolean;
  /** Últimos 4 caracteres, si el secreto tiene al menos 20 para que no lo delaten. */
  hint: string | null;
  usesEnvFallback: boolean;
  updatedAt: Date | null;
}

/** Lo que la consola puede mostrar de los secretos: nunca el valor. */
export async function describeSecrets(db: Db, keys: readonly string[], fallbacks: Fallbacks = process.env): Promise<SecretSummary[]> {
  const valid = keys.filter(isSecretKey);
  const rows = await db.platformSecret.findMany({ where: { key: { in: valid } }, select: { key: true, hint: true, updatedAt: true } });
  return valid.map((key) => {
    const row = rows.find((candidate) => candidate.key === key);
    const envName = secretDefinition(key).envFallback;
    const usesEnvFallback = !row && Boolean(envName && fallbacks[envName]?.trim());
    return { key, configured: Boolean(row) || usesEnvFallback, hint: row?.hint ?? null, usesEnvFallback, updatedAt: row?.updatedAt ?? null };
  });
}
