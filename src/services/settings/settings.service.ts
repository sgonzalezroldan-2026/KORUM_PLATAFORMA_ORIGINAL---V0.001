import { CRYPTO_CONTEXT, openParts, sealParts, secretHint, type Keyring } from '@/core/security/crypto';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Prisma } from '@/generated/prisma/client';
import { inTransaction, type Db } from '@/lib/db';
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

async function cached<T>(cacheKey: string, load: () => Promise<T>): Promise<T> {
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
  });
}

/** Secreto descifrado (solo en servidor), o `undefined` si la consola no lo tiene y tampoco hay variable de respaldo. */
export async function getSecret(db: Db, keyring: Keyring, key: SecretKey, fallbacks: Fallbacks = process.env): Promise<string | undefined> {
  const definition = secretDefinition(key);
  return cached(`secret:${key}`, async () => {
    const row = await db.platformSecret.findUnique({ where: { key } });
    if (row) return openParts(keyring, row, CRYPTO_CONTEXT.platformSecret(key));
    const fromEnv = definition.envFallback ? fallbacks[definition.envFallback]?.trim() : undefined;
    return fromEnv || undefined;
  });
}

/** Comprobaciones entre ajustes: un valor válido por sí mismo puede no serlo con los demás. */
async function assertCoherent(tx: Db, key: string, value: unknown): Promise<void> {
  if (key === 'hucha.mode' && value === 'REGULATED_WALLET') {
    const provider = await tx.platformSetting.findUnique({ where: { key: 'hucha.walletProvider' }, select: { key: true } });
    if (!provider) throw new InvalidSettingError(key, ['El monedero regulado solo se puede activar con «hucha.walletProvider» configurado (CUMPLIMIENTO §3)']);
  }
}

export interface UpdateSettingOptions {
  /** Versión que se tenía en pantalla al editar. Si otra persona guardó antes, la escritura se rechaza. */
  expectedVersion?: number;
  now?: Date;
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
    const version = (current?.version ?? 0) + 1;
    // La condición de versión en la escritura cubre la carrera entre la lectura y el guardado.
    if (current) {
      const { count } = await tx.platformSetting.updateMany({ where: { key, version: current.version }, data: { valueJson: parsed, version, updatedById: actor.userId } });
      if (count === 0) throw new SettingConflictError(key);
    } else {
      await tx.platformSetting.create({ data: { key, valueJson: parsed, version, updatedById: actor.userId } });
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

export async function updateSecret(db: Db, actor: VerifiedSuperadminActor, keyring: Keyring, key: SecretKey, plaintext: string, options: { now?: Date } = {}): Promise<{ hint: string | null }> {
  assertVerifiedSuperadmin(actor, 'settings.secret_update', options.now);
  const definition = secretDefinition(key);
  const trimmed = plaintext.trim();
  if (trimmed.length < definition.minLength || trimmed.length > 4096) throw new InvalidSettingError(key, [`El secreto debe tener entre ${definition.minLength} y 4096 caracteres`]);
  const sealed = sealParts(keyring, trimmed, CRYPTO_CONTEXT.platformSecret(key));
  const hint = secretHint(trimmed);
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'settings.secret_update', options.now);
    const data = { ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.authTag, keyVersion: sealed.keyVersion, hint, updatedById: actor.userId };
    await tx.platformSecret.upsert({ where: { key }, create: { key, ...data }, update: data });
    await writeAudit(tx, { actorType: 'USER', actorUserId: actor.userId, action: 'settings.secret.updated', targetType: 'PlatformSecret', targetId: key, metadata: { keyVersion: sealed.keyVersion } });
  });
  invalidateSettingsCache(key);
  return { hint };
}

/** Borra un secreto de la consola: vuelve a usarse la variable de respaldo, si la hay. */
export async function deleteSecret(db: Db, actor: VerifiedSuperadminActor, key: SecretKey, options: { now?: Date } = {}): Promise<void> {
  assertVerifiedSuperadmin(actor, 'settings.secret_delete', options.now);
  secretDefinition(key);
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'settings.secret_delete', options.now);
    const { count } = await tx.platformSecret.deleteMany({ where: { key } });
    if (count > 0) await writeAudit(tx, { actorType: 'USER', actorUserId: actor.userId, action: 'settings.secret.deleted', targetType: 'PlatformSecret', targetId: key });
  });
  invalidateSettingsCache(key);
}

export interface SecretSummary {
  key: SecretKey;
  configured: boolean;
  /** Últimos 4 caracteres, si el secreto es lo bastante largo para que no lo delaten. */
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
