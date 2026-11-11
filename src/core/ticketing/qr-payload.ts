/**
 * Formato del contenido de un QR de pase, sin dependencias de servidor: lo comparten el servidor (que además comprueba la firma, `qr-signature.ts`) y el
 * lector del móvil, que solo separa el identificador y la firma para consultarlos en la lista descargada de la portería.
 */

export const QR_PAYLOAD_PREFIX = 'korum://v1/pass/';

/** Separa el identificador y la firma de un contenido de QR, o `null` si no tiene el formato esperado. */
export function parsePassQrPayload(payload: string): { passUuid: string; signature: string } | null {
  const match = /^korum:\/\/v1\/pass\/([0-9a-f-]{36})\?sig=([A-Za-z0-9_-]{43})$/.exec(payload.trim());
  return match ? { passUuid: match[1]!, signature: match[2]! } : null;
}
