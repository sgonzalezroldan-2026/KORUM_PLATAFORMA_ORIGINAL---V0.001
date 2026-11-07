import { bpsOf } from '@/core/finance/money';

/**
 * Límites y cálculos de la aportación mensual de Mi Hucha (`PLEDGE`, Sprint 3.8) que necesitan a la vez el servidor y el formulario del
 * navegador. Sin dependencias de servidor: se puede importar desde un componente de cliente, y el resumen que ve la familia sale de las mismas
 * funciones que el cobro.
 */

/** Por debajo, la gestión fija se comería buena parte del cobro (prototipo: mínimo 2 €). */
export const PLEDGE_MIN_CENTS = 200;
/** Tope mensual (200 €, como el prototipo): una cifra mayor casi siempre es un error al teclear. */
export const PLEDGE_MAX_CENTS = 20_000;
/** Importes rápidos del selector. */
export const PLEDGE_AMOUNT_PRESETS = [500, 1_000, 2_000] as const;
export const PLEDGE_DEFAULT_CENTS = 1_000;
/** Duraciones: trimestre, medio curso, curso escolar (por defecto) y año. */
export const PLEDGE_MONTH_OPTIONS = [3, 6, 9, 12] as const;
export const PLEDGE_DEFAULT_MONTHS = 9;
/** Último día del mes que se puede elegir para cobrar: así todos los meses lo tienen. */
export const PLEDGE_LAST_CHARGE_DAY = 28;

/** Gestión de Mi Hucha por cargo (`GlobalConfig.topupFeeCents` + `topupFeeBps`), que se suma encima de la donación: la campaña recibe el 100 %. */
export function pledgeFeeCents(amountCents: number, rules: { topupFeeCents: number; topupFeeBps: number }): number {
  const fee = rules.topupFeeCents + bpsOf(amountCents, rules.topupFeeBps);
  if (!Number.isSafeInteger(fee) || fee < 0) throw new RangeError('La gestión de Mi Hucha debe ser un entero no negativo de céntimos');
  return fee;
}

/** Total que se habrá cobrado si se cumplen todos los meses (para el resumen antes de pagar). */
export const pledgeCommitmentCents = (amountCents: number, feeCents: number, months: number): number => (amountCents + feeCents) * months;

const madridDay = (date: Date): number => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', day: 'numeric' }).format(date));

/** Día de cobro: el del primer pago en hora de España, sin pasar del 28 (así existe en todos los meses). */
export const chargeDayOf = (firstPayment: Date): number => Math.min(madridDay(firstPayment), PLEDGE_LAST_CHARGE_DAY);
