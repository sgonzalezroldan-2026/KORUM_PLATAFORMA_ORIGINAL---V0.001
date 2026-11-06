import { createHmac } from 'node:crypto';

/**
 * Código TOTP (RFC 6238: SHA-1, 30 s, 6 dígitos) a partir de la URI `otpauth://` que devuelve Better Auth al activar el doble factor. Es lo
 * que haría la app del móvil de la persona; lo usan las pruebas de integración y las de navegador.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const character of clean) {
    const value = BASE32.indexOf(character);
    if (value < 0) throw new RangeError('Secreto TOTP no válido');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)));
}

export function secretFromTotpUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new RangeError('La URI TOTP no tiene secreto');
  return secret;
}

export function totpCode(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}
