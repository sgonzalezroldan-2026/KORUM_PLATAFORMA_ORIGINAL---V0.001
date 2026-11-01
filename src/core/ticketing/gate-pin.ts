import { randomInt, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dataHmac } from '@/core/security/data-hmac';

/**
 * PIN de portería de cada evento (skill korum-ticketing-qr §4). Seis dígitos son pocos: lo protegen el límite de intentos, la caducidad y un
 * hash lento. El PIN pasa antes por un HMAC con secreto, así que una copia robada de la base no se puede probar a fuerza bruta sin él.
 */

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

const derive = promisify<string, Buffer, number, { N: number; r: number; p: number; maxmem: number }, Buffer>(scrypt);

const pepper = (secret: string, pin: string) => dataHmac(secret, 'gate-pin', pin);

export function generateGatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function hashGatePin(secret: string, pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pepper(secret, pin), salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Comprueba el PIN en tiempo constante. Un hash mal formado nunca da acceso. */
export async function verifyGatePin(secret: string, pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !expected) return false;
  const expectedKey = Buffer.from(expected, 'base64url');
  const key = await derive(pepper(secret, pin), Buffer.from(salt, 'base64url'), expectedKey.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM });
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}
