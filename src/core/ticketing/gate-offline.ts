import { parsePassQrPayload } from './qr-payload';

/**
 * Validación sin cobertura (QA-S04, sin dependencias de servidor: se ejecuta en el móvil). Al abrir la portería el móvil descarga la **lista de pases del
 * evento**: por cada pase, su identificador, cuántas personas entran, cuántas ya han entrado y la **huella SHA-256 de su firma** (nunca la firma, para
 * que quien robe un móvil no pueda fabricar QR). Con ella el lector comprueba que el pase existe y que la firma del QR es la suya, y descuenta el uso
 * en local. Al volver la red, cada lectura se envía y el servidor decide: si otro móvil ya había dejado entrar ese pase, la lectura queda como conflicto.
 */

export interface GateListPass {
  /** Identificador del pase. */
  u: string;
  /** Personas que entran con el pase. */
  q: number;
  /** Personas que ya habían entrado al descargar la lista. */
  c: number;
  /** Huella de la firma del QR (`signatureDigest`). */
  h: string;
}

export interface GateList {
  eventId: number;
  generatedAt: number;
  passes: GateListPass[];
}

export interface LocalUse {
  /** Personas que han entrado desde este móvil sin red desde que se descargó la lista. */
  count: number;
  firstAt: number | null;
}

/**
 * Resultado de leer un QR que ve el voluntario, igual en línea y sin red (serializable: llega desde una acción de servidor). `serial` es el código del pase
 * (`#PASE-2026-XXXX`) o, sin red, el comienzo de su identificador; `firstAccessAt` son milisegundos desde 1970 (`null` si no se sabe).
 */
export type ScanOutcome =
  | { status: 'ACCEPTED'; entered: number; remaining: number; quantity: number; serial: string }
  /** Quedan varias plazas: hay que elegir cuántas personas entran ahora. */
  | { status: 'CHOOSE'; remaining: number; quantity: number; serial: string }
  | { status: 'INSUFFICIENT'; remaining: number; quantity: number; firstAccessAt: number | null }
  | { status: 'EXHAUSTED'; quantity: number; firstAccessAt: number | null }
  /** Sin red: no está en la lista (o su firma no coincide). Puede ser una compra posterior a la descarga o un pase falso; sin red no se puede saber. */
  | { status: 'UNKNOWN' }
  | { status: 'INVALID_FORMAT' }
  | { status: 'INVALID_SIGNATURE' | 'OTHER_EVENT' | 'REVOKED' | 'NOT_PAID' | 'NOT_APPLICABLE' | 'EVENT_CLOSED' }
  /** Solo al sincronizar: esa lectura ya había llegado. */
  | { status: 'DUPLICATE_SCAN'; accepted: boolean };

const toBase64Url = (bytes: ArrayBuffer): string => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** Huella de una firma de QR: los 22 primeros caracteres (132 bits) del SHA-256 en base64url. El servidor calcula la misma (`signatureDigest`). */
export async function digestSignature(signature: string): Promise<string> {
  const bytes = new TextEncoder().encode(signature);
  return toBase64Url(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 22);
}

/** Una lectura de pase de `EVENT`, decidida solo con la lista y lo ya admitido en este móvil. `quantity === 'ASK'` pregunta si queda más de una plaza. */
export async function decideOffline(list: GateList, local: Readonly<Record<string, LocalUse>>, payload: string, quantity: number | 'ASK'): Promise<ScanOutcome> {
  const parsed = parsePassQrPayload(payload);
  if (!parsed) return { status: 'INVALID_FORMAT' };
  const pass = list.passes.find((candidate) => candidate.u === parsed.passUuid);
  if (!pass || pass.h !== (await digestSignature(parsed.signature))) return { status: 'UNKNOWN' };
  const used = local[pass.u];
  const entered = pass.c + (used?.count ?? 0);
  const remaining = pass.q - entered;
  if (remaining <= 0) return { status: 'EXHAUSTED', quantity: pass.q, firstAccessAt: used?.firstAt ?? null };
  const serial = pass.u.slice(0, 8);
  if (quantity === 'ASK') {
    return remaining > 1 ? { status: 'CHOOSE', remaining, quantity: pass.q, serial } : { status: 'ACCEPTED', entered: 1, remaining: 0, quantity: pass.q, serial };
  }
  if (quantity > remaining) return { status: 'INSUFFICIENT', remaining, quantity: pass.q, firstAccessAt: used?.firstAt ?? null };
  return { status: 'ACCEPTED', entered: quantity, remaining: remaining - quantity, quantity: pass.q, serial };
}
