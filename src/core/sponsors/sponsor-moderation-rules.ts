import { z } from 'zod';
import { cleanSupportText } from '@/core/support/support-rules';
import { SPONSORSHIP_MONTHS } from './sponsorship-rules';

/**
 * Reglas de la moderación de comercios amigos (Sprint 4.2b, `function moderateSponsor` del prototipo). Funciones puras: el servicio
 * comprueba la sesión, bloquea la iniciativa y mueve el dinero.
 *
 * - **Aprobar** (`PENDING → APPROVED`): el distintivo vale 12 meses **desde la aprobación** (el comercio no pierde visibilidad mientras el centro
 *   tarda en revisarlo) y, si eligió la bolsa *Matching 2x*, la bolsa se activa en la misma transacción.
 * - **Rechazar** (`PENDING → REJECTED`): se le devuelve el 100 % de lo cobrado (nivel, fee e IVA) al medio de pago original y se rectifica la factura
 *   del fee. El motivo lo lee el comercio en su email: va con el cargo de la entidad, nunca con el nombre de quien decide.
 */

export const SPONSOR_REJECTION_REASON_MIN = 10;
export const SPONSOR_REJECTION_REASON_MAX = 400;
/** Comercios cerrados (rechazados o devueltos) que la bandeja enseña plegados: los más recientes. */
export const CLOSED_SPONSORS_SHOWN = 10;

const sponsorId = z.number().int().positive().max(2_147_483_647);

export const approveSponsorSchema = z.object({ sponsorId });

export const rejectSponsorSchema = z.object({
  sponsorId,
  // Va tal cual a un email externo: sin caracteres de control, de anchura cero ni de dirección del texto (como el chat y el soporte).
  reason: z.string().transform(cleanSupportText).pipe(z.string().min(SPONSOR_REJECTION_REASON_MIN).max(SPONSOR_REJECTION_REASON_MAX))
});

export type SponsorModerationRejection =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  /** El comercio ya no está pendiente (otra persona firmante lo decidió) o su pago no se completó. */
  | 'WRONG_STATUS'
  /** La bolsa Matching 2x de la iniciativa ya la tiene otro comercio aprobado. */
  | 'MATCHING_TAKEN'
  /** La iniciativa ya se liquidó: el dinero salió y no se puede devolver desde aquí. */
  | 'ALREADY_SETTLED'
  /** Falta el NIF emisor o la razón social en la consola: sin ellos no se puede rectificar la factura del fee. */
  | 'INVOICING_UNAVAILABLE';

export class SponsorModerationError extends Error {
  readonly reason: SponsorModerationRejection;

  constructor(reason: SponsorModerationRejection) {
    super(`No se puede moderar el comercio: ${reason}.`);
    this.name = 'SponsorModerationError';
    this.reason = reason;
  }
}

/** Fin del distintivo: doce meses naturales desde que el centro lo aprueba. */
export function badgeExpiryFrom(approvedAt: Date): Date {
  const expiry = new Date(approvedAt);
  expiry.setUTCMonth(expiry.getUTCMonth() + SPONSORSHIP_MONTHS);
  return expiry;
}

export type SponsorModerationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REFUNDED' | 'CREDIT_POOL';

/** Orden de la bandeja: primero lo que pide una decisión (pendientes), después los vigentes y por último los cerrados. */
const STATUS_ORDER: Record<SponsorModerationStatus, number> = { PENDING: 0, APPROVED: 1, CREDIT_POOL: 2, REJECTED: 3, REFUNDED: 3 };

export function sortForModeration<T extends { status: SponsorModerationStatus; paidAt: Date | string | null; id: number }>(sponsors: readonly T[]): T[] {
  const time = (value: Date | string | null) => (value === null ? 0 : new Date(value).getTime());
  return [...sponsors].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.status === 'PENDING' ? time(a.paidAt) - time(b.paidAt) : time(b.paidAt) - time(a.paidAt)) || a.id - b.id);
}

/** `true` si hace falta una decisión del centro: un comercio pendiente cuyo cobro ya entró. */
export const needsDecision = (sponsor: { status: string; paidAt: Date | string | null }): boolean => sponsor.status === 'PENDING' && sponsor.paidAt !== null;
