import { z } from 'zod';
import { fourteenDayDeadline } from '@/core/finance/fourteen-day-rule';
import { dataHmac, safeEqual } from '@/core/security/data-hmac';
import { endOfDayInMadrid, madridIsoDate } from '@/core/studio/studio-draft';

/**
 * Reglas puras de un evento con entradas cuando llega su fecha, se cancela o cambia de fecha (Sprint 5.13, decisión 30 del promotor; decisiones de
 * apertura del 2026-11-19). Sin base de datos.
 *
 * - **Llega la fecha:** con algo vendido, el evento pasa a liquidable por lo vendido (`GOAL_REACHED`), aunque no se haya llenado el aforo; sin nada, se
 *   cierra sin dinero que mover (`CANCELLED`). Nunca pasa a «vencido»: la entrada vale aunque no se llene.
 * - **Cancelar:** devuelve el 100 % a todas las personas (también los Gastos de gestión digital). Se puede mientras no se haya liquidado, también después
 *   de la fecha (un evento que no llegó a celebrarse).
 * - **Cambiar la fecha:** cada comprador de antes del cambio recibe un enlace para recuperar el 100 % durante 14 días; mientras alguno siga abierto, la
 *   entidad no puede liquidar. Se puede también después de la fecha (aplazamiento de última hora) mientras no se haya liquidado: la venta se reabre hasta
 *   la fecha nueva si queda aforo. La fecha nueva, y el final de los 14 días, no pasan del máximo de la campaña contado desde su publicación (60 días por
 *   defecto, nunca más de 75), para que siempre queden al menos 15 días de la ventana de 90 de Paycomet para liquidar.
 * - Lo hace una persona firmante con su segundo factor: ninguna de las dos cosas lleva dinero a la entidad (la liquidación sigue pidiendo sus firmas).
 */

const DAY_MS = 86_400_000;
/** Mismo tope que la duración de una campaña al publicarla (`MAX_CAMPAIGN_DAYS_LIMIT` de `campaign-window.ts`; aquí sin importar la base de datos). */
const MAX_EVENT_DAYS_LIMIT = 75;

export type EventScheduleRejection = 'INVALID_INPUT' | 'NOT_FOUND' | 'NOT_AN_EVENT' | 'WRONG_STATUS' | 'ALREADY_SETTLED' | 'DATE_INVALID' | 'DATE_IN_PAST' | 'SAME_DATE' | 'DATE_TOO_LATE' | 'RATE_LIMITED';

export class EventScheduleError extends Error {
  readonly reason: EventScheduleRejection;

  constructor(reason: EventScheduleRejection) {
    super(`El evento no se puede cambiar: ${reason}.`);
    this.name = 'EventScheduleError';
    this.reason = reason;
  }
}

const initiativeId = z.number().int().positive().max(2_147_483_647);
export const cancelEventSchema = z.object({ initiativeId }).strict();
/** El día nuevo como lo elige la persona (`AAAA-MM-DD`): el evento acaba al final de ese día en España, igual que en el Estudio. */
export const rescheduleEventSchema = z.object({ initiativeId, newDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

/** Estados en los que el evento sigue vivo: vendiendo, o agotado o celebrado y aún sin liquidar. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['FUNDRAISING', 'GOAL_REACHED']);

export interface EventState {
  format: string;
  /** Una venta de vales no es un evento: su cancelación y su cambio de fecha llegan en el Sprint 5.14c, con sus propias reglas (solo lo no gastado). */
  ticketSubtype?: string | null;
  status: string;
  /** Estado de su liquidación, si se ha pedido. Solo una pendiente de firmas deja cancelar o cambiar la fecha. */
  payoutStatus: string | null;
}

/** Por qué no se puede cancelar ni cambiar de fecha este evento, o `null` si se puede. */
export function eventChangeProblem(event: EventState): EventScheduleRejection | null {
  if (event.format !== 'TICKETING' || event.ticketSubtype === 'VOUCHER') return 'NOT_AN_EVENT';
  if (!LIVE_STATUSES.has(event.status)) return 'WRONG_STATUS';
  if (event.payoutStatus !== null && event.payoutStatus !== 'PENDING_DOUBLE_CHECK') return 'ALREADY_SETTLED';
  return null;
}

/** Último instante en que puede celebrarse el evento: el máximo de la campaña contado desde que se publicó. */
export function latestEventDate(publishedAt: Date, maxCampaignDays: number): Date {
  return new Date(publishedAt.getTime() + Math.min(maxCampaignDays, MAX_EVENT_DAYS_LIMIT) * DAY_MS);
}

/** Hasta cuándo vale el enlace de devolución de un cambio de fecha hecho ahora. */
export const rescheduleRefundUntil = (now: Date): Date => fourteenDayDeadline(now);

/**
 * Último día que se puede elegir (`AAAA-MM-DD`, hora de España), o `null` si ya no cabe ningún cambio de fecha porque los 14 días de devolución
 * terminarían después del máximo.
 */
export function latestRescheduleDay(latest: Date, now: Date): string | null {
  if (rescheduleRefundUntil(now) > latest) return null;
  let day = madridIsoDate(latest);
  const end = endOfDayInMadrid(day);
  if (end && end > latest) day = madridIsoDate(new Date(end.getTime() - DAY_MS));
  const chosen = endOfDayInMadrid(day);
  return chosen && chosen > now ? day : null;
}

/** El día elegido convertido en la fecha del evento, o el motivo por el que no vale. */
export function rescheduleDateFor(newDay: string, current: Date, latest: Date, now: Date): { newDate: Date } | { problem: EventScheduleRejection } {
  const newDate = endOfDayInMadrid(newDay);
  if (!newDate) return { problem: 'DATE_INVALID' };
  if (newDate <= now) return { problem: 'DATE_IN_PAST' };
  if (newDate.getTime() === current.getTime()) return { problem: 'SAME_DATE' };
  if (newDate > latest || rescheduleRefundUntil(now) > latest) return { problem: 'DATE_TOO_LATE' };
  return { newDate };
}

/** Qué pasa al llegar la fecha: con dinero de entradas se liquida por lo vendido; sin nada, se cierra sin mover dinero. */
export const eventOutcomeAtDate = (raisedCents: number): 'SETTLE' | 'CLOSE_EMPTY' => (raisedCents > 0 ? 'SETTLE' : 'CLOSE_EMPTY');

/**
 * Mantenimiento de un evento que se liquida por lo vendido sin agotar el aforo (decisión del promotor del 2026-11-19): el cargo fijo de la campaña se
 * multiplica por `vendido / meta` y se redondea hacia abajo, como las comisiones de una campaña redimensionada por votación. Nunca más que el publicado.
 */
export function heldEventMaintenanceCents(publishedMaintCents: number, raisedCents: number, goalCents: number): number {
  if (publishedMaintCents <= 0 || raisedCents <= 0 || goalCents <= 0) return 0;
  if (raisedCents >= goalCents) return publishedMaintCents;
  return Number((BigInt(publishedMaintCents) * BigInt(raisedCents)) / BigInt(goalCents));
}

/** Tras cambiar la fecha: agotado sigue liquidable; si no, vuelve a vender hasta la fecha nueva. */
export const statusAfterReschedule = (soldOutOrGoalMet: boolean): 'GOAL_REACHED' | 'FUNDRAISING' => (soldOutOrGoalMet ? 'GOAL_REACHED' : 'FUNDRAISING');

const TOKEN_PURPOSE = 'event-reschedule-refund:v1';
const TOKEN_PATTERN = /^([1-9]\d{0,9})\.([1-9]\d{0,9})\.([0-9a-f]{64})$/;

/** Enlace personal de devolución de un cambio de fecha: firma el cambio y una compra de la persona (de la compra sale quién es). */
export function signEventRefundToken(secret: string, rescheduleId: number, contributionId: number): string {
  const payload = `${rescheduleId}.${contributionId}`;
  return `${payload}.${dataHmac(secret, TOKEN_PURPOSE, payload)}`;
}

export function readEventRefundToken(secret: string, token: string): { rescheduleId: number; contributionId: number } | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const payload = `${match[1]}.${match[2]}`;
  if (!safeEqual(dataHmac(secret, TOKEN_PURPOSE, payload), match[3])) return null;
  const rescheduleId = Number(match[1]);
  const contributionId = Number(match[2]);
  return rescheduleId <= 2_147_483_647 && contributionId <= 2_147_483_647 ? { rescheduleId, contributionId } : null;
}

export const eventRefundTokenSchema = z.object({ orgSlug: z.string().min(1).max(64), token: z.string().min(10).max(120) }).strict();
