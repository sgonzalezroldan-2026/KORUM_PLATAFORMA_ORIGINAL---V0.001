import { z } from 'zod';
import { FOURTEEN_DAY_RULE_DAYS, fourteenDayDeadline } from '@/core/finance/fourteen-day-rule';
import { latestCloseOn } from '@/core/studio/studio-board';
import { endOfDayInMadrid, latestVoucherValidOn, madridIsoDate, VOUCHER_SALE_MAX_DAYS } from '@/core/studio/studio-draft';

/**
 * Reglas puras de una venta de vales después de publicarse (Sprint 5.14c; decisiones 32, 49, 66 y 67 del promotor y las tomadas al abrir el sprint, 2026-11-20).
 * Sin base de datos.
 *
 * - **Puesto:** el PIN vale hasta el final de la validez de los vales, nunca más de un año; cada móvil vuelve a teclearlo cada 48 h (como la portería).
 * - **Devolución de 14 días:** quien compró recupera el 100 % de una compra con un clic durante 14 días desde que recibió sus vales, si no ha gastado ninguno.
 *   Después, lo no gastado se queda en la entidad para su causa. Si la entidad **acorta la validez**, quien compró antes recupera lo no gastado durante 14 días
 *   desde ese cambio (decisión 69; condiciones de entradas y vales §4.5): el 100 % si no gastó nada, o la parte de lo pagado que corresponde a lo no gastado.
 * - **Cierre:** al llegar el día de cierre, con algo vendido la venta pasa a liquidable por lo vendido, con el mantenimiento en proporción a los vales vendidos
 *   sobre el tope o, sin tope, sobre el objetivo (decisión 66); sin nada, se cierra sin dinero. Se liquida cuando se han cerrado los 14 días de todas las compras.
 * - **Cancelar (decisiones 49 y 69):** los vales dejan de gastarse y nadie más compra. **Antes de liquidar**, la plataforma devuelve a cada persona lo que no haya
 *   gastado, con el dinero aún retenido (y desde el Sprint 5.20b la entidad paga a KORUM el coste); lo gastado se liquida a la entidad. **Después de liquidar**, el
 *   dinero ya está en la entidad: se avisa a quien tiene vales sin gastar de que se lo pida a ella.
 * - **Fechas:** cambiar el cierre (solo mientras se vende) no avisa a nadie; alargar la validez avisa a quien tiene vales; acortarla avisa y abre los 14 días para
 *   recuperar lo no gastado (la liquidación espera). Ya liquidada, la validez solo se alarga. Siempre dentro de los límites del Estudio: la venta, 60 días desde
 *   que se publicó; la validez, desde el cierre hasta 12 meses después. Los límites siguen la duración máxima del motor de reglas
 *   (`maxCampaignDays`, nunca más de 60 en vales) y los 14 días de un acortamiento no pasan de la venta más sus 14 días (con 60, el día 74; nunca del 75), para
 *   que siempre queden al menos 15 días de la ventana de 90 de PAYCOMET para liquidar.
 */

const DAY_MS = 86_400_000;
/** Mismo tope que la duración de una campaña (`MAX_CAMPAIGN_DAYS_LIMIT`): lo último que un plazo de devolución puede retrasar la liquidación. */
const LATEST_REFUND_DAY = 75;
/** Un PIN del puesto no vive más de esto, por lejana que sea la validez (la del Estudio puede llegar a 14 meses desde la publicación). */
export const VOUCHER_PIN_MAX_LIFETIME_MS = 365 * DAY_MS;
/** Días antes de que caduquen los vales en que se recuerda a quien aún tiene alguno (decisión 32). */
export const VOUCHER_REMINDER_DAYS = 7;

/** Hasta cuándo vale el PIN del puesto creado ahora: el final de la validez de los vales, como mucho un año (decisión del 2026-11-20). */
export function voucherPinExpiry(validUntil: Date, now: Date): Date {
  return new Date(Math.min(validUntil.getTime(), now.getTime() + VOUCHER_PIN_MAX_LIFETIME_MS));
}

/**
 * Mantenimiento de una venta de vales que se liquida (decisión 66): el publicado por `vendidos / tope` o, sin tope, `vendidos / objetivo`, hacia abajo; entero si
 * se vende el tope o el objetivo. Sin vales vendidos (solo aportaciones «sin producto», que solo existen con la venta agotada), nada. Nunca más que el publicado.
 */
export function voucherSaleMaintenanceCents(publishedMaintCents: number, sale: { ticketsSold: number; ticketMax: number | null; voucherTargetCount: number | null }): number {
  const measure = sale.ticketMax ?? sale.voucherTargetCount;
  if (publishedMaintCents <= 0 || sale.ticketsSold <= 0) return 0;
  if (measure === null || measure <= 0 || sale.ticketsSold >= measure) return publishedMaintCents;
  return Number((BigInt(publishedMaintCents) * BigInt(sale.ticketsSold)) / BigInt(measure));
}

/**
 * Parte de un importe que corresponde a los vales sin gastar de una compra (decisión 69: «el 100 % de lo no gastado»), redondeada al céntimo más cercano. Se
 * aplica línea a línea al cobro (vales y Gastos de gestión digital): nunca más que la línea ni menos que cero.
 */
export function unspentShareCents(lineCents: number, unspent: number, quantity: number): number {
  if (!Number.isSafeInteger(lineCents) || lineCents <= 0 || quantity <= 0 || unspent <= 0) return 0;
  if (unspent >= quantity) return lineCents;
  return Math.min(lineCents, Math.round((lineCents * unspent) / quantity));
}

/**
 * Las líneas que devuelve lo no gastado de una compra: cada línea al haber del cobro (la hucha, los Gastos de gestión digital y, si la hubiera, la aportación
 * voluntaria) pasa al debe en su proporción. La misma función la usan la aprobación y lo que enseña el pase, así que lo prometido es lo devuelto.
 */
export function unspentRefundLines<L extends { direction: 'DEBIT' | 'CREDIT'; amountCents: number }>(payinLines: readonly L[], unspent: number, quantity: number): Array<L & { direction: 'DEBIT' }> {
  return payinLines
    .filter((line) => line.direction === 'CREDIT')
    .map((line) => ({ ...line, direction: 'DEBIT' as const, amountCents: unspentShareCents(line.amountCents, unspent, quantity) }))
    .filter((line) => line.amountCents > 0);
}

/** Qué pasa al cerrar la venta: con dinero (vales o «sin producto») se liquida por lo vendido; sin nada, se cierra sin mover dinero. */
export const voucherOutcomeAtClose = (raisedCents: number, ticketsSold: number): 'SETTLE' | 'CLOSE_EMPTY' => (raisedCents > 0 || ticketsSold > 0 ? 'SETTLE' : 'CLOSE_EMPTY');

/** ¿Toca recordar que caducan? Una semana antes, mientras aún valen. */
export function voucherReminderDue(validUntil: Date, now: Date): boolean {
  const left = validUntil.getTime() - now.getTime();
  return left > 0 && left <= VOUCHER_REMINDER_DAYS * DAY_MS;
}

// --- Devolución de 14 días ------------------------------------------------------------------------------------------------------------------------

/** Hasta cuándo se puede devolver una compra: 14 días desde que KORUM emitió sus vales (`TicketPass.issuedAt`). */
export const voucherRefundDeadline = (issuedAt: Date): Date => fourteenDayDeadline(issuedAt);

export type VoucherRefundBlock = 'ALREADY_REFUNDED' | 'NOT_PAID' | 'SPENT' | 'WINDOW_CLOSED' | 'SETTLED';

export interface VoucherPurchaseState {
  contributionStatus: string;
  revokedAt: Date | null;
  quantity: number;
  checkedInCount: number;
  issuedAt: Date;
  /** Estado de la liquidación de la venta, si se ha pedido. */
  payoutStatus: string | null;
  /** Última vez que la entidad acortó la validez de los vales (decisión 69). */
  shortenedAt: Date | null;
}

/** `FULL`: el 100 % de la compra; `UNSPENT`: la parte de lo pagado que corresponde a los vales sin gastar. Hasta `until`. */
export interface VoucherRefundOffer {
  kind: 'FULL' | 'UNSPENT';
  until: Date;
}

/**
 * Qué devolución puede pedir ahora quien compró (o por qué no). Dos plazos: los 14 días desde que recibió sus vales, sin haber gastado ninguno (decisión 32); y
 * los 14 días desde que la entidad acortó la validez, si compró antes, por lo no gastado (decisión 69). El orden importa: lo ya devuelto se dice antes que un
 * plazo vencido, y la liquidación (que espera a que se cierren los plazos, así que no debería ocurrir) al final.
 */
export function voucherRefundOffer(purchase: VoucherPurchaseState, now: Date): VoucherRefundOffer | { block: VoucherRefundBlock } {
  if (purchase.contributionStatus === 'REFUND_PENDING' || purchase.contributionStatus === 'REFUNDED') return { block: 'ALREADY_REFUNDED' };
  if (purchase.contributionStatus !== 'COMPLETED' || purchase.revokedAt !== null) return { block: 'NOT_PAID' };
  const unspent = purchase.quantity - purchase.checkedInCount;
  if (unspent <= 0) return { block: 'SPENT' };
  const windows: Date[] = [];
  if (purchase.checkedInCount === 0) windows.push(voucherRefundDeadline(purchase.issuedAt));
  if (purchase.shortenedAt && purchase.issuedAt.getTime() < purchase.shortenedAt.getTime()) windows.push(voucherRefundDeadline(purchase.shortenedAt));
  const open = windows.filter((until) => until.getTime() > now.getTime()).sort((a, b) => b.getTime() - a.getTime());
  if (open.length === 0) return { block: purchase.checkedInCount > 0 && windows.length === 0 ? 'SPENT' : 'WINDOW_CLOSED' };
  if (purchase.payoutStatus !== null && purchase.payoutStatus !== 'PENDING_DOUBLE_CHECK') return { block: 'SETTLED' };
  return { kind: purchase.checkedInCount === 0 ? 'FULL' : 'UNSPENT', until: open[0]! };
}

// --- Cancelar y cambiar fechas --------------------------------------------------------------------------------------------------------------------

export type VoucherSaleRejection =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_A_VOUCHER_SALE'
  | 'WRONG_STATUS'
  | 'ALREADY_CANCELLED'
  | 'EXPIRED'
  | 'NO_CHANGE'
  | 'CLOSE_NOT_CHANGEABLE'
  | 'CLOSE_INVALID'
  | 'CLOSE_IN_PAST'
  | 'CLOSE_TOO_LATE'
  | 'VALIDITY_INVALID'
  | 'VALIDITY_BEFORE_CLOSE'
  | 'VALIDITY_IN_PAST'
  | 'VALIDITY_TOO_LATE'
  | 'VALIDITY_SHORTER_AFTER_PAYOUT'
  | 'SHORTEN_TOO_LATE'
  | 'RATE_LIMITED';

export class VoucherSaleChangeError extends Error {
  readonly reason: VoucherSaleRejection;

  constructor(reason: VoucherSaleRejection) {
    super(`La venta de vales no se puede cambiar: ${reason}.`);
    this.name = 'VoucherSaleChangeError';
    this.reason = reason;
  }
}

const initiativeId = z.number().int().positive().max(2_147_483_647);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const cancelVoucherSaleSchema = z.object({ initiativeId }).strict();
/** Los días como los elige la persona (`AAAA-MM-DD`, hora de España); el que no cambia puede faltar. */
export const changeVoucherDatesSchema = z.object({ initiativeId, closeDay: day.optional(), validDay: day.optional() }).strict();

/** Estados de una venta viva: vendiendo, cerrada sin liquidar o ya liquidada (sus vales siguen valiendo hasta su fecha). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['FUNDRAISING', 'GOAL_REACHED', 'CLOSED']);

export interface VoucherSaleState {
  ticketSubtype: string | null;
  status: string;
  voucherCancelledAt: Date | null;
  voucherValidUntil: Date | null;
}

/** ¿Se canceló cuando ya estaba liquidada (aprobada la liquidación antes que la cancelación)? Entonces responde la entidad; si no, devolvió la plataforma. */
export const cancelledAfterSettlement = (cancelledAt: Date | null, payoutApprovedAt: Date | null): boolean => cancelledAt !== null && payoutApprovedAt !== null && payoutApprovedAt.getTime() <= cancelledAt.getTime();

/** Días que puede durar una venta de vales según el motor de reglas (`maxCampaignDays`), nunca más de 60 (decisión 32). */
export const voucherSaleMaxDays = (maxCampaignDays: number): number => Math.min(maxCampaignDays, VOUCHER_SALE_MAX_DAYS);

/** Último día desde la publicación en que puede acabar un plazo de devolución: la venta más sus 14 días, nunca más de 75 (quedan 15 de los 90 de PAYCOMET). */
const latestRefundDay = (maxCampaignDays: number): number => Math.min(voucherSaleMaxDays(maxCampaignDays) + FOURTEEN_DAY_RULE_DAYS, LATEST_REFUND_DAY);

/** ¿Ya se liquidó? Una liquidación aprobada ya vació la hucha, aunque su envío se esté reintentando. */
export const isSettledPayout = (payoutStatus: string | null): boolean => payoutStatus !== null && payoutStatus !== 'PENDING_DOUBLE_CHECK';

/** Por qué no se puede cancelar ni cambiar de fechas esta venta, o `null` si se puede. Con los vales ya caducados no hay nada que cambiar. */
export function voucherSaleChangeProblem(sale: VoucherSaleState, now: Date): VoucherSaleRejection | null {
  if (sale.ticketSubtype !== 'VOUCHER') return 'NOT_A_VOUCHER_SALE';
  if (sale.voucherCancelledAt !== null) return 'ALREADY_CANCELLED';
  if (!LIVE_STATUSES.has(sale.status)) return 'WRONG_STATUS';
  if (sale.voucherValidUntil === null || sale.voucherValidUntil.getTime() <= now.getTime()) return 'EXPIRED';
  return null;
}

/**
 * Estado al cancelar: una venta abierta con algo vendido se cierra ya y pasa a liquidable por lo vendido; sin nada, se cierra sin dinero. Una venta cerrada o
 * liquidada no cambia de estado: solo dejan de valer sus vales.
 */
export function statusAfterVoucherCancel(sale: { status: string; raisedCents: number; ticketsSold: number }): 'GOAL_REACHED' | 'CANCELLED' | null {
  if (sale.status !== 'FUNDRAISING') return null;
  return voucherOutcomeAtClose(sale.raisedCents, sale.ticketsSold) === 'SETTLE' ? 'GOAL_REACHED' : 'CANCELLED';
}

export interface VoucherDatesPlan {
  closesAt: Date;
  validUntil: Date;
  closeChanged: boolean;
  validity: 'EXTENDED' | 'SHORTENED' | null;
}

/** Límites de las fechas que enseña el panel: hasta qué día se puede cerrar la venta y entre qué días puede valer. */
export function voucherDateBounds(sale: { publishedAt: Date; closesAt: Date }, now: Date, maxCampaignDays: number): { closeMaxDay: string; validMinDay: string; validMaxDay: string } {
  const closeDay = madridIsoDate(sale.closesAt);
  const today = madridIsoDate(now);
  return { closeMaxDay: latestCloseOn(sale.publishedAt, voucherSaleMaxDays(maxCampaignDays)), validMinDay: closeDay > today ? closeDay : today, validMaxDay: latestVoucherValidOn(closeDay) };
}

/**
 * Comprueba y convierte los días elegidos. El cierre solo cambia mientras la venta está abierta, a un día por venir y sin pasar de la duración máxima del motor de reglas
 * (`maxCampaignDays`, nunca más de 60) desde la publicación;
 * la validez, entre el cierre (y hoy) y 12 meses después del cierre; ya liquidada, solo se alarga.
 */
export function planVoucherDates(
  input: { closeDay?: string | undefined; validDay?: string | undefined },
  sale: { status: string; closesAt: Date; voucherValidUntil: Date; publishedAt: Date; settled: boolean; maxCampaignDays: number },
  now: Date
): VoucherDatesPlan | { problem: VoucherSaleRejection } {
  const currentCloseDay = madridIsoDate(sale.closesAt);
  const closeChanged = input.closeDay !== undefined && input.closeDay !== currentCloseDay;
  let closesAt = sale.closesAt;
  if (closeChanged) {
    if (sale.status !== 'FUNDRAISING') return { problem: 'CLOSE_NOT_CHANGEABLE' };
    const chosen = endOfDayInMadrid(input.closeDay!);
    if (!chosen) return { problem: 'CLOSE_INVALID' };
    if (chosen.getTime() <= now.getTime()) return { problem: 'CLOSE_IN_PAST' };
    if (input.closeDay! > latestCloseOn(sale.publishedAt, voucherSaleMaxDays(sale.maxCampaignDays))) return { problem: 'CLOSE_TOO_LATE' };
    closesAt = chosen;
  }
  const validDay = input.validDay ?? madridIsoDate(sale.voucherValidUntil);
  const validUntil = input.validDay !== undefined ? endOfDayInMadrid(validDay) : sale.voucherValidUntil;
  if (!validUntil) return { problem: 'VALIDITY_INVALID' };
  const closeDay = madridIsoDate(closesAt);
  if (validDay < closeDay) return { problem: 'VALIDITY_BEFORE_CLOSE' };
  if (validUntil.getTime() <= now.getTime()) return { problem: 'VALIDITY_IN_PAST' };
  if (validDay > latestVoucherValidOn(closeDay)) return { problem: 'VALIDITY_TOO_LATE' };
  const validityChanged = validUntil.getTime() !== sale.voucherValidUntil.getTime();
  const validity = !validityChanged ? null : validUntil > sale.voucherValidUntil ? 'EXTENDED' : 'SHORTENED';
  if (validity === 'SHORTENED' && sale.settled) return { problem: 'VALIDITY_SHORTER_AFTER_PAYOUT' };
  // Acortar abre 14 días de devolución y la liquidación espera: no pueden acabar después de la duración de la venta más 14 días
  // desde la publicación (nunca del día 75: quedan 15 de la ventana de 90).
  if (validity === 'SHORTENED' && voucherRefundDeadline(now).getTime() > sale.publishedAt.getTime() + latestRefundDay(sale.maxCampaignDays) * DAY_MS) return { problem: 'SHORTEN_TOO_LATE' };
  if (!closeChanged && validity === null) return { problem: 'NO_CHANGE' };
  return { closesAt, validUntil, closeChanged, validity };
}
