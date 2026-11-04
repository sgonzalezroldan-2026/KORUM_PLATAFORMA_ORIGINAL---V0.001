import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Primitivas AES-256-GCM (Regla 01 §5). `context` ata cada valor a su uso: un valor cifrado copiado a otro campo no se puede descifrar
 * allí. **La aplicación no las usa directamente:** pasa por `src/core/security/crypto.ts`, que añade la versión de clave, la rotación y
 * los contextos de cada dato (`CRYPTO_CONTEXT`).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedParts {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function keyFrom(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new RangeError('La clave de cifrado debe tener 32 bytes');
  return key;
}

export function encryptParts(plaintext: string, keyBase64: string, context: string): EncryptedParts {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(keyBase64), iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decryptParts(parts: EncryptedParts, keyBase64: string, context: string): string {
  const decipher = createDecipheriv(ALGORITHM, keyFrom(keyBase64), Buffer.from(parts.iv, 'base64'), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(parts.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Un solo texto para columnas como `tokenUserEnc`: `iv.authTag.cifrado`. */
export function sealField(plaintext: string, keyBase64: string, context: string): string {
  const { iv, authTag, ciphertext } = encryptParts(plaintext, keyBase64, context);
  return `${iv}.${authTag}.${ciphertext}`;
}

export function openField(sealed: string, keyBase64: string, context: string): string {
  const [iv, authTag, ciphertext] = sealed.split('.');
  if (!iv || !authTag || ciphertext === undefined) throw new RangeError('Valor cifrado mal formado');
  return decryptParts({ iv, authTag, ciphertext }, keyBase64, context);
}
