import { decryptParts, encryptParts, type EncryptedParts } from '@/lib/encryption';
import { dataHmac, safeEqual } from './data-hmac';

/**
 * Cifrado de secretos y datos personales con versión de clave (Regla 01 §5, DECISIONES_TECNICAS §5). Es la única puerta de entrada para
 * cifrar: los servicios piden aquí un **llavero** (`Keyring`) y el **contexto** de cada dato, y nunca manejan la clave directamente.
 *
 * - **Versión de clave:** cada valor cifrado guarda con qué versión se cifró. Se cifra siempre con la actual (`ENCRYPTION_KEY` +
 *   `ENCRYPTION_KEY_VERSION`) y se descifra con la que toque, también las anteriores de `ENCRYPTION_PREVIOUS_KEYS`. La rotación
 *   (`key-rotation.ts`) vuelve a cifrar con la actual todo lo antiguo; cuando termina, la clave anterior se puede retirar.
 * - **Cambiar solo el número de versión no tumba nada:** si la versión guardada no está en el llavero, se prueban las demás. AES-GCM
 *   autentica cada valor, así que con una clave equivocada falla y nunca devuelve basura.
 * - **Contexto:** ata el valor a su uso y, donde se puede, a su fila. Un NIF cifrado copiado a otra columna, o a la tarjeta de otra persona,
 *   no se puede descifrar allí. Los contextos viven en `CRYPTO_CONTEXT` y nadie los escribe a mano.
 * - **HMAC de datos personales:** `dataHmac` (`data-hmac.ts`) se reexporta aquí para buscar sin guardar el dato en claro.
 */

export { dataHmac, safeEqual };

export interface Keyring {
  readonly currentVersion: number;
  /** Versión → clave de 32 bytes en base64. Siempre incluye la actual. */
  readonly keys: ReadonlyMap<number, string>;
}

export interface SealedValue {
  sealed: string;
  keyVersion: number;
}

export class KeyringConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringConfigurationError';
  }
}

/** Ningún valor del llavero puede descifrar el dato: falta la clave con que se cifró, o el valor se ha manipulado o copiado de otro sitio. */
export class DecryptionError extends Error {
  constructor(
    readonly context: string,
    readonly keyVersion: number | null
  ) {
    super(`No se puede descifrar un valor del contexto «${context.split(':')[0]}» (versión de clave ${keyVersion ?? 'desconocida'})`);
    this.name = 'DecryptionError';
  }
}

/** Contextos de cifrado. Los que llevan identificador atan el valor a su fila. */
export const CRYPTO_CONTEXT = {
  platformSecret: (key: string) => `platform-secret:${key}`,
  cardIdUser: (tokenId: number) => `paycomet:idUser:${tokenId}`,
  cardTokenUser: (tokenId: number) => `paycomet:tokenUser:${tokenId}`,
  donorTaxId: 'contribution:donorTaxId',
  userTaxId: (userId: string) => `user:nif:${userId}`,
  invoiceRecipientTaxId: (invoiceNumber: string) => `invoice:recipientTaxId:${invoiceNumber}`,
  sponsorTaxId: (organizationId: string) => `sponsor:cif:${organizationId}`
} as const;

/** Propósitos de HMAC de datos personales que comparten varios módulos. */
export const HMAC_PURPOSE = { donorTaxId: 'donor-tax-id', userTaxId: 'user-tax-id', privacyEmail: 'privacy-email', auditIp: 'audit-ip' } as const;

const BASE64_KEY = /^[A-Za-z0-9+/]+={0,2}$/;

function assertKey(version: number, keyBase64: string): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new KeyringConfigurationError(`Versión de clave no válida: ${version}`);
  if (!BASE64_KEY.test(keyBase64) || Buffer.from(keyBase64, 'base64').length !== 32) throw new KeyringConfigurationError(`La clave de la versión ${version} debe tener 32 bytes en base64`);
}

export function createKeyring(current: { version: number; key: string }, previous: ReadonlyArray<{ version: number; key: string }> = []): Keyring {
  assertKey(current.version, current.key);
  const keys = new Map<number, string>([[current.version, current.key]]);
  for (const entry of previous) {
    assertKey(entry.version, entry.key);
    if (keys.has(entry.version)) throw new KeyringConfigurationError(`La versión de clave ${entry.version} está repetida`);
    if (entry.version > current.version) throw new KeyringConfigurationError(`La clave anterior ${entry.version} es más nueva que la actual (${current.version})`);
    keys.set(entry.version, entry.key);
  }
  return { currentVersion: current.version, keys };
}

/** `ENCRYPTION_PREVIOUS_KEYS`: lista `versión:clave` separada por comas (p. ej. `1:AbC…=,2:XyZ…=`). Vacía o ausente, sin claves anteriores. */
export function parsePreviousKeys(raw: string | undefined): Array<{ version: number; key: string }> {
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map((item) => {
    const separator = item.indexOf(':');
    const version = Number(item.slice(0, separator).trim());
    const key = item.slice(separator + 1).trim();
    if (separator <= 0 || !Number.isSafeInteger(version)) throw new KeyringConfigurationError('ENCRYPTION_PREVIOUS_KEYS debe tener el formato «versión:clave» separado por comas');
    return { version, key };
  });
}

export function keyringFromEnv(env: { ENCRYPTION_KEY: string; ENCRYPTION_KEY_VERSION: number; ENCRYPTION_PREVIOUS_KEYS?: string | undefined }): Keyring {
  return createKeyring({ version: env.ENCRYPTION_KEY_VERSION, key: env.ENCRYPTION_KEY }, parsePreviousKeys(env.ENCRYPTION_PREVIOUS_KEYS));
}

function currentKey(keyring: Keyring): string {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new KeyringConfigurationError('El llavero no tiene la clave actual');
  return key;
}

/** Claves que se prueban para descifrar: primero la de la versión guardada y después las demás, de la más nueva a la más antigua. */
function candidateKeys(keyring: Keyring, keyVersion: number | null): string[] {
  const exact = keyVersion === null ? undefined : keyring.keys.get(keyVersion);
  const others = [...keyring.keys.entries()].sort(([a], [b]) => b - a).map(([, key]) => key).filter((key) => key !== exact);
  return exact ? [exact, ...others] : others;
}

function tryEach<T>(keys: string[], attempt: (key: string) => T, context: string, keyVersion: number | null): T {
  for (const key of keys) {
    try {
      return attempt(key);
    } catch {
      // Autenticación fallida con esta clave: se prueba la siguiente.
    }
  }
  throw new DecryptionError(context, keyVersion);
}

/** Cifra en un solo texto (`iv.authTag.cifrado`) para columnas como `donorTaxIdEnc`, con la versión actual. */
export function sealValue(keyring: Keyring, plaintext: string, context: string): SealedValue {
  const { iv, authTag, ciphertext } = encryptParts(plaintext, currentKey(keyring), context);
  return { sealed: `${iv}.${authTag}.${ciphertext}`, keyVersion: keyring.currentVersion };
}

export function openValue(keyring: Keyring, sealed: string, keyVersion: number | null, context: string): string {
  const [iv, authTag, ciphertext] = sealed.split('.');
  if (!iv || !authTag || ciphertext === undefined) throw new DecryptionError(context, keyVersion);
  return tryEach(candidateKeys(keyring, keyVersion), (key) => decryptParts({ iv, authTag, ciphertext }, key, context), context, keyVersion);
}

/** Cifra en tres columnas (`PlatformSecret`). */
export function sealParts(keyring: Keyring, plaintext: string, context: string): EncryptedParts & { keyVersion: number } {
  return { ...encryptParts(plaintext, currentKey(keyring), context), keyVersion: keyring.currentVersion };
}

export function openParts(keyring: Keyring, parts: EncryptedParts & { keyVersion: number }, context: string): string {
  return tryEach(candidateKeys(keyring, parts.keyVersion), (key) => decryptParts(parts, key, context), context, parts.keyVersion);
}

/** `true` si el valor está cifrado con una versión que no es la actual y la rotación debe volver a cifrarlo. */
export const needsRotation = (keyring: Keyring, keyVersion: number | null): boolean => keyVersion !== keyring.currentVersion;

/** Cuatro últimos caracteres de un secreto, para reconocerlo en la consola sin mostrarlo. Con menos de 12, ninguno. */
export function secretHint(value: string): string | null {
  return value.length >= 12 ? value.slice(-4) : null;
}
