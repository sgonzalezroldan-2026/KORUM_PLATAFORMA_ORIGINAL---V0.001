import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma de los pases QR (skill korum-ticketing-qr §4): `korum://v1/pass/{passUuid}?sig={hmac}`.
 * La firma es HMAC-SHA256 en base64url de `v1:{passUuid}` con `QR_HMAC_SECRET`; una fotocopia es válida, pero un pase
 * inventado o alterado no, y el aforo y el uso los controla el servidor al leerlo. En el Sprint 2.3 se amplía con el
 * resto del motor de taquilla.
 */

export const QR_PAYLOAD_PREFIX = 'korum://v1/pass/';
const MIN_SECRET_LENGTH = 32;

function assertSecret(secret: string) {
  if (secret.length < MIN_SECRET_LENGTH) throw new RangeError(`QR_HMAC_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres`);
}

/** Firma (base64url) de un pase. */
export function signPass(secret: string, passUuid: string): string {
  assertSecret(secret);
  return createHmac('sha256', secret).update(`v1:${passUuid}`).digest('base64url');
}

/**
 * Firma para **ver** el pase desde el enlace del email (invitados sin cuenta). Es otra firma, con otro dominio (`v1-view:`): ese enlace
 * queda en registros y en el `Referer`, y no debe permitir rehacer el QR que abre la puerta (que es de un solo uso).
 */
export function signPassView(secret: string, passUuid: string): string {
  assertSecret(secret);
  return createHmac('sha256', secret).update(`v1-view:${passUuid}`).digest('base64url');
}

export function verifyPassViewSignature(secret: string, passUuid: string, signature: string): boolean {
  const expected = Buffer.from(signPassView(secret, passUuid));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Contenido completo del código QR de un pase. */
export function buildPassQrPayload(secret: string, passUuid: string): string {
  return `${QR_PAYLOAD_PREFIX}${passUuid}?sig=${signPass(secret, passUuid)}`;
}

/** Separa el identificador y la firma de un contenido de QR, o `null` si no tiene el formato esperado. */
export function parsePassQrPayload(payload: string): { passUuid: string; signature: string } | null {
  const match = /^korum:\/\/v1\/pass\/([0-9a-f-]{36})\?sig=([A-Za-z0-9_-]{43})$/.exec(payload.trim());
  return match ? { passUuid: match[1]!, signature: match[2]! } : null;
}

/** Comprueba la firma en tiempo constante (sin revelar cuántos caracteres coinciden). */
export function verifyPassSignature(secret: string, passUuid: string, signature: string): boolean {
  const expected = Buffer.from(signPass(secret, passUuid));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
