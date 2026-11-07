import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PLEDGE_LAST_CHARGE_DAY, PLEDGE_MAX_CENTS, PLEDGE_MIN_CENTS, PLEDGE_MONTH_OPTIONS } from './pledge-limits';

export { chargeDayOf, pledgeCommitmentCents, pledgeFeeCents } from './pledge-limits';

/**
 * Reglas de la aportación mensual de Mi Hucha (`PLEDGE`, skill de pagos §7). Funciones puras y deterministas: cuánto se cobra, qué día, a qué
 * campaña va cada mes y qué envía el navegador. Nunca hay saldo: cada mes es una donación a una campaña que está recaudando.
 */

const fiscalSchema = z.object({
  taxId: z.string().trim().min(5).max(20),
  /** Apellidos y nombre, en el orden del Modelo 182. */
  fullName: z.string().trim().min(3).max(120),
  provinceCode: z.string().regex(/^\d{2}$/)
});

export const pledgeInputSchema = z.object({
  orgSlug: z.string().min(1).max(80),
  /** `null`: cada mes, la campaña que antes cierre. */
  initiativeId: z.number().int().positive().nullable(),
  amountCents: z.number().int().min(PLEDGE_MIN_CENTS).max(PLEDGE_MAX_CENTS),
  months: z.number().int().refine((value) => (PLEDGE_MONTH_OPTIONS as readonly number[]).includes(value)),
  fiscal: fiscalSchema.nullable(),
  locale: z.enum(['es', 'ca', 'en'])
});

export type PledgeInput = z.infer<typeof pledgeInputSchema>;

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Fecha del calendario de España (año, mes 0-11 y día) de un instante. */
function madridDate(date: Date): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(MADRID_DATE.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}

/**
 * Siguiente cobro: el día `chargeDay` del primer mes **de España** en que ese día aún no ha llegado, a las 00:00 UTC (la tarea corre a las 07:00
 * UTC, ya ese mismo día en España). Todo se cuenta en el calendario de España, igual que `chargeDayOf`: un primer pago a las 00:30 del día 5
 * en Madrid (23:30 UTC del 4) deja el siguiente para el 5 del mes que viene, nunca para unas horas después (auditoría del Sprint 3.8, B1).
 * Siempre se calcula desde **ahora**: tras una pausa o un parón de la tarea no se cobran meses atrasados de golpe.
 */
export function nextChargeAt(after: Date, chargeDay: number): Date {
  if (!Number.isInteger(chargeDay) || chargeDay < 1 || chargeDay > PLEDGE_LAST_CHARGE_DAY) throw new RangeError(`Día de cobro fuera de rango: ${chargeDay}`);
  const today = madridDate(after);
  return new Date(Date.UTC(today.year, today.day < chargeDay ? today.month : today.month + 1, chargeDay));
}

export interface PledgeCampaign {
  id: number;
  closesAt: Date;
}

/**
 * Campaña de este mes: la preferida si sigue recaudando y, si no, la que antes cierre (a igualdad, la más antigua). `null` si la entidad no
 * tiene ninguna: ese mes no se cobra y se avisa a la familia.
 */
export function pickPledgeCampaign<T extends PledgeCampaign>(open: readonly T[], preferredId: number | null, now: Date): T | null {
  const live = open.filter((campaign) => campaign.closesAt > now);
  const preferred = preferredId === null ? undefined : live.find((campaign) => campaign.id === preferredId);
  if (preferred) return preferred;
  return [...live].sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime() || a.id - b.id)[0] ?? null;
}

/** Pedido de un cobro de Mi Hucha: aleatorio y sin datos de la persona. `KD` donación, `KT` entrada, `KS` patrocinio, `KH` Mi Hucha. */
export const newPledgeOrder = (): string => `KH${randomBytes(8).toString('hex').toUpperCase()}`;
