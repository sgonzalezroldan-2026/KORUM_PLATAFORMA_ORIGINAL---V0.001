import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { dataHmac, safeEqual } from './data-hmac';

/**
 * Señales del dispositivo, de menos a más invasiva (skill korum-quorum-antifraud §2): cookie propia firmada y subred IP. En la base de
 * datos nunca se guarda ninguna en claro, solo su HMAC.
 */

const SECONDS_PER_DAY = 86_400;

export const DEVICE_COOKIE = {
  name: 'korum_device',
  options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 395 * SECONDS_PER_DAY }
} as const;

const COOKIE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const signCookieId = (secret: string, cookieId: string) => dataHmac(secret, 'device-cookie-signature', cookieId);

export function createDeviceCookieValue(secret: string): string {
  const cookieId = randomBytes(32).toString('base64url');
  return `${cookieId}.${signCookieId(secret, cookieId)}`;
}

/** Devuelve el identificador de una cookie auténtica, o `null` si es inventada o está alterada. */
export function readDeviceCookieId(secret: string, value: string | undefined): string | null {
  const [cookieId, signature, extra] = (value ?? '').split('.');
  if (!cookieId || !signature || extra !== undefined || !COOKIE_ID_PATTERN.test(cookieId)) return null;
  return safeEqual(signature, signCookieId(secret, cookieId)) ? cookieId : null;
}

export const hashDeviceCookieId = (secret: string, cookieId: string) => dataHmac(secret, 'device-cookie-id', cookieId);

/** Las 8 agrupaciones de una IPv6 en minúsculas, sea cual sea la forma en que venga escrita. */
function expandIpv6(ip: string): string[] {
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  let text = ip;
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${ip.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const zeros = rest === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((group) => group.toLowerCase().padStart(4, '0'));
}

/** Subred de una IP: `/24` en IPv4 y `/48` en IPv6. Una IPv4 escrita como IPv6 (`::ffff:1.2.3.4`) cuenta como IPv4. `null` si no es una IP. */
export function ipSubnet(rawIp: string): string | null {
  const ip = rawIp.trim().split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (family !== 6) return null;
  const groups = expandIpv6(ip);
  if (groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff') {
    const high = parseInt(groups[6]!, 16);
    const low = parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.0/24`;
  }
  return `${groups.slice(0, 3).join(':')}::/48`;
}

/** Sin una IP válida se usa un grupo común que también cuenta para la ráfaga: una cabecera manipulada no puede apagar el control. */
export function hashIpSubnet(secret: string, rawIp: string | null | undefined): string {
  return dataHmac(secret, 'ip-subnet', (rawIp ? ipSubnet(rawIp) : null) ?? 'unknown-ip');
}

/** `true` si la IP identifica una red real, y no el grupo común de las IP no válidas. */
export function hasKnownSubnet(rawIp: string | null | undefined): boolean {
  return Boolean(rawIp && ipSubnet(rawIp));
}

/** HMAC de la IP completa de quien firma. */
export function hashSignerIp(secret: string, rawIp: string): string {
  return dataHmac(secret, 'signer-ip', rawIp.trim());
}

export const hashFingerprint = (secret: string, fingerprint: string) => dataHmac(secret, 'device-fingerprint', fingerprint);
