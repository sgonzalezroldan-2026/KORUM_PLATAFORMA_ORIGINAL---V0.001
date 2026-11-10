import { z } from 'zod';
import { SPONSORSHIP_MONTHS } from './sponsorship-rules';

/**
 * Reglas de la renovación y la reasignación de comercios amigos (Sprint 4.2d, `function saveSponsorRenewalRule` y
 * `function simulateSponsorAutomaticRenewal` del prototipo). Funciones puras: el servicio bloquea, asienta y avisa.
 *
 * - **Regla de la entidad** (`Organization.sponsorRenewalRule`): a dónde va el dinero de un patrocinio que se renueva o cuya campaña fracasa.
 *   `SOONEST`, todo a la campaña activa que cierra antes; `PROPORTIONAL`, repartido entre las activas en proporción a lo que le falta a cada una;
 *   `MANUAL`, espera en la bolsa a que el centro elija.
 * - **Bolsa** (`CREDIT_POOL`): si no hay campaña a la que llevarlo, espera como mucho `min(creditPoolMaxDays desde la entrada, 70 días desde el
 *   cobro)` (Regla 02 §4, ventana de 90 días de Paycomet) y después pasa al Fondo de actividades de la entidad (Sprint 4.2f): nunca se devuelve al
 *   comercio admitido. Los 20 días que quedan hasta el 90 son para firmar y ejecutar la liquidación del Fondo.
 * - **Campaña elegible:** activa, de la misma entidad, de presupuesto, y que cierra antes de que venza la ventana de su cobro: la liquidación reparte
 *   desde ese cobro, y pasado el día 85 ya no podría hacerlo.
 */

const DAY_MS = 86_400_000;
/** Un patrocinio no puede colocarse en una campaña que cierre más allá de esto desde su cobro: la ventana de 90 días de Paycomet menos 5 de margen (skill de pagos §5). */
export const CREDIT_POOL_HARD_CAP_DAYS = 85;
/**
 * Día (desde el cobro) en que la bolsa pasa como muy tarde al Fondo de actividades (Sprint 4.2f): deja 20 días de la ventana de 90 de Paycomet para que
 * las dos personas firmantes liquiden el Fondo. También es el máximo de `creditPoolMaxDays` (la base de datos lo impide con un `CHECK`).
 */
export const ACTIVITY_FUND_DAY = 70;
/** Días que vale el enlace de pago de una renovación desde que vence el distintivo (el preaviso sale 30 días antes con el mismo enlace). */
export const RENEWAL_LINK_DAYS = 30;
/** Máximo en la bolsa si la consola aún no tiene su valor (`GlobalConfig.creditPoolMaxDays`, mismo valor por defecto). */
export const DEFAULT_CREDIT_POOL_MAX_DAYS = 60;

export const SPONSOR_RENEWAL_RULES = ['SOONEST', 'PROPORTIONAL', 'MANUAL'] as const;
export type SponsorRenewalRule = (typeof SPONSOR_RENEWAL_RULES)[number];

const id = z.number().int().positive().max(2_147_483_647);
export const renewalRuleSchema = z.object({ rule: z.enum(SPONSOR_RENEWAL_RULES) });
export const assignPooledSchema = z.object({ sponsorId: id, initiativeId: id });
export const renewalLinkSchema = z.object({ sponsorId: id });

/** El máximo de la consola nunca pasa del día del Fondo (aunque una base antigua guardara más). */
export const effectiveCreditPoolMaxDays = (creditPoolMaxDays: number): number => Math.min(Math.max(0, creditPoolMaxDays), ACTIVITY_FUND_DAY);

/** Fin del plazo en la bolsa: lo que antes llegue entre el máximo de la consola desde la entrada y el día 70 desde el cobro (pasa al Fondo). */
export function creditPoolDeadline(sponsor: { paidAt: Date; creditPoolAt: Date }, creditPoolMaxDays: number): Date {
  const byPool = sponsor.creditPoolAt.getTime() + effectiveCreditPoolMaxDays(creditPoolMaxDays) * DAY_MS;
  const byCharge = sponsor.paidAt.getTime() + ACTIVITY_FUND_DAY * DAY_MS;
  return new Date(Math.min(byPool, byCharge));
}

export interface PlacementTarget {
  id: number;
  closesAt: Date;
  goalCents: number;
  raisedCents: number;
}

/** Una campaña puede recibir el dinero si sigue abierta y cierra antes de que venza la ventana del cobro del que sale. */
export function isEligibleTarget(target: Pick<PlacementTarget, 'closesAt'>, chargedAt: Date, now: Date): boolean {
  return target.closesAt.getTime() > now.getTime() && target.closesAt.getTime() <= chargedAt.getTime() + CREDIT_POOL_HARD_CAP_DAYS * DAY_MS;
}

export interface Placement {
  initiativeId: number;
  amountCents: number;
}

/**
 * Reparte `amountCents` según la regla entre las campañas elegibles (ya filtradas). Sin campañas, o con `MANUAL`, no coloca nada: el dinero espera
 * en la bolsa. `PROPORTIONAL` reparte por lo que le falta a cada campaña (si a ninguna le falta, a partes iguales) con el método del mayor resto,
 * así que la suma es exacta al céntimo y ninguna campaña recibe 0.
 */
export function planPlacement(rule: SponsorRenewalRule, amountCents: number, targets: readonly PlacementTarget[]): Placement[] {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new RangeError('El importe a colocar debe ser un entero positivo de céntimos.');
  const ordered = [...targets].sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime() || a.id - b.id);
  if (rule === 'MANUAL' || ordered.length === 0) return [];
  const first = ordered[0];
  if (rule === 'SOONEST' || !first) return first ? [{ initiativeId: first.id, amountCents }] : [];
  // Nunca más partes que céntimos: cada campaña recibe al menos uno.
  const shareable = ordered.slice(0, Math.min(ordered.length, amountCents));
  const missing = shareable.map((target) => Math.max(0, target.goalCents - target.raisedCents));
  const totalMissing = missing.reduce((sum, value) => sum + value, 0);
  const weights = totalMissing > 0 ? missing.map((value) => Math.max(value, 1)) : shareable.map(() => 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const exact = weights.map((weight) => (amountCents * weight) / totalWeight);
  const shares = exact.map((value) => Math.max(1, Math.floor(value)));
  let rest = amountCents - shares.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let step = 0; rest !== 0; step += 1) {
    const slot = byRemainder[step % byRemainder.length];
    if (!slot) break;
    const current = shares[slot.index] ?? 0;
    // Si el mínimo de 1 céntimo dejó la suma por encima, se descuenta de las mayores (nunca por debajo de 1).
    if (rest > 0) {
      shares[slot.index] = current + 1;
      rest -= 1;
    } else if (current > 1) {
      shares[slot.index] = current - 1;
      rest += 1;
    }
  }
  return shareable.map((target, index) => ({ initiativeId: target.id, amountCents: shares[index] ?? 0 })).filter((placement) => placement.amountCents > 0);
}

/** El distintivo renovado sigue al anterior sin perder días: doce meses desde lo último entre el fin del anterior y el pago de la renovación. */
export function renewalExpiry(previousExpiresAt: Date, paidAt: Date): Date {
  const expiry = new Date(Math.max(previousExpiresAt.getTime(), paidAt.getTime()));
  expiry.setUTCMonth(expiry.getUTCMonth() + SPONSORSHIP_MONTHS);
  return expiry;
}

/** Hasta cuándo vale el enlace de pago de la renovación de un distintivo que vence en `expiresAt`. */
export const renewalLinkValidUntil = (expiresAt: Date): Date => new Date(expiresAt.getTime() + RENEWAL_LINK_DAYS * DAY_MS);

/** El enlace se puede usar desde el preaviso (30 días antes) hasta 30 días después del vencimiento. */
export function renewalWindowOpen(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime() - RENEWAL_LINK_DAYS * DAY_MS && now.getTime() <= renewalLinkValidUntil(expiresAt).getTime();
}

export type SponsorReassignmentRejection =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  /** El comercio ya no está en la bolsa: otra persona firmante lo colocó o la tarea diaria lo llevó a una campaña. */
  | 'POOL_CHANGED'
  /** La campaña no puede recibirlo: cerrada, de otra entidad o fuera de la ventana de 90 días de su cobro. */
  | 'TARGET_NOT_ELIGIBLE'
  /** El distintivo no está en el plazo de la renovación (o ya está renovado). */
  | 'RENEWAL_NOT_OPEN'
  /** Ya se le envió la invitación a renovar de este año (Sprint 4.2f): solo una por año a quien no marcó «renovar cada año». */
  | 'ALREADY_INVITED';

export class SponsorReassignmentError extends Error {
  readonly reason: SponsorReassignmentRejection;

  constructor(reason: SponsorReassignmentRejection) {
    super(`No se puede reasignar el patrocinio: ${reason}.`);
    this.name = 'SponsorReassignmentError';
    this.reason = reason;
  }
}
