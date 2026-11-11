import { createHmac, timingSafeEqual } from 'node:crypto';
import { QR_PAYLOAD_PREFIX } from './qr-payload';

export { parsePassQrPayload, QR_PAYLOAD_PREFIX } from './qr-payload';

/**
 * Firma de los pases QR (skill korum-ticketing-qr §4): `korum://v1/pass/{passUuid}?sig={hmac}`.
 * La firma es HMAC-SHA256 en base64url de `v1:{passUuid}` con `QR_HMAC_SECRET`; una fotocopia es válida, pero un pase
 * inventado o alterado no, y el aforo y el uso los controla el servidor al leerlo. En el Sprint 2.3 se amplía con el
 * resto del motor de taquilla.
 */

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

/** Comprueba la firma en tiempo constante (sin revelar cuántos caracteres coinciden). */
export function verifyPassSignature(secret: string, passUuid: string, signature: string): boolean {
  const expected = Buffer.from(signPass(secret, passUuid));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
