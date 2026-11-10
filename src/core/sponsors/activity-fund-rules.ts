import { z } from 'zod';
import { SPLIT_WINDOW_DAYS } from '@/core/finance/campaign-window';

/**
 * Fondo de actividades de la entidad (Sprint 4.2f, decisión del promotor del 2026-11-10). Funciones puras: el servicio bloquea, asienta y avisa.
 *
 * - **Qué entra:** lo que queda en la bolsa de un comercio **admitido** cuando vence sin campaña a la que llevarlo (día 70 desde su cobro como mucho).
 *   No se devuelve al comercio: es una aportación a fondo perdido y ya disfruta de su publicidad.
 * - **Cómo sale:** una liquidación a la cuenta de la entidad, con el destino escrito por la entidad (el justificante de uso) y la doble firma. Paycomet
 *   reparte cobro a cobro, así que cada comercio es un reparto desde su pedido original y con su ventana de 90 días: lo que ya la pasó no se puede
 *   incluir (lo resuelve el Super-Admin con Paycomet, alerta `ACTIVITY_FUND_WINDOW`).
 */

const DAY_MS = 86_400_000;
export const FUND_PURPOSE_MIN = 10;
export const FUND_PURPOSE_MAX = 500;
/** Días antes del final de la ventana de 90 días en que se recuerda a quienes firman que liquiden el Fondo (y se abre la alerta en la consola). */
export const FUND_REMINDER_DAYS = 10;

const id = z.number().int().positive().max(2_147_483_647);
/** Sin enlaces: el destino lo firman las dos personas y sale en el justificante; no es un sitio para dirigir a nadie a otra web. */
const purpose = z
  .string()
  .trim()
  .min(FUND_PURPOSE_MIN)
  .max(FUND_PURPOSE_MAX)
  .refine((value) => !/(https?:\/\/|www\.)/i.test(value), { message: 'NO_LINKS' });
export const requestFundPayoutSchema = z.object({ purpose });
export const fundPayoutIdSchema = z.object({ payoutId: id });

/** Lo que tiene un comercio en el Fondo y de qué cobro sale. */
export interface FundBalance {
  sponsorId: number;
  contributionId: number;
  chargedAt: Date;
  balanceCents: number;
  /** El cobro sigue confirmado y con su pedido y autorización de Paycomet: se puede repartir desde él. */
  splittable: boolean;
}

export interface FundPlan {
  /** Los repartos de la liquidación, del cobro más antiguo al más reciente (los primeros en caducar). */
  splits: Array<{ sponsorId: number; contributionId: number; amountCents: number; chargedAt: Date }>;
  amountCents: number;
  /** Fecha límite para que Paycomet reparta el primero de ellos: hasta entonces debe estar firmada y enviada. */
  deadline: Date | null;
  /** Dinero en el Fondo que ya no se puede repartir (ventana vencida o cobro deshecho): no entra en la liquidación. */
  stuckCents: number;
}

/** Último momento en que Paycomet repartirá un cobro (90 días desde él). */
export const splitDeadline = (chargedAt: Date): Date => new Date(chargedAt.getTime() + SPLIT_WINDOW_DAYS * DAY_MS);

/** La ventana del cobro sigue abierta en este momento (mismo criterio que `planPayoutSplits`). */
export const withinSplitWindow = (chargedAt: Date, now: Date): boolean => now.getTime() - chargedAt.getTime() <= SPLIT_WINDOW_DAYS * DAY_MS;

/** Qué se puede liquidar hoy del Fondo: cada comercio con saldo, dentro de su ventana y con su cobro repartible. Suma exacta al céntimo. */
export function planFundPayout(balances: readonly FundBalance[], now: Date): FundPlan {
  const ordered = [...balances].filter((entry) => entry.balanceCents > 0).sort((a, b) => a.chargedAt.getTime() - b.chargedAt.getTime() || a.sponsorId - b.sponsorId);
  const splits: FundPlan['splits'] = [];
  let stuckCents = 0;
  for (const entry of ordered) {
    if (!Number.isSafeInteger(entry.balanceCents)) throw new RangeError('El saldo del Fondo debe ser un entero de céntimos.');
    if (entry.splittable && withinSplitWindow(entry.chargedAt, now)) splits.push({ sponsorId: entry.sponsorId, contributionId: entry.contributionId, amountCents: entry.balanceCents, chargedAt: entry.chargedAt });
    else stuckCents += entry.balanceCents;
  }
  const first = splits[0];
  return { splits, amountCents: splits.reduce((sum, split) => sum + split.amountCents, 0), deadline: first ? splitDeadline(first.chargedAt) : null, stuckCents };
}

/** Hay que recordar la liquidación: el primer cobro del Fondo vence en `FUND_REMINDER_DAYS` días o menos. */
export function fundNeedsReminder(deadline: Date | null, now: Date): boolean {
  return deadline !== null && deadline.getTime() - now.getTime() <= FUND_REMINDER_DAYS * DAY_MS;
}

export type ActivityFundRejection =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  /** No hay nada que se pueda liquidar hoy (Fondo vacío, o todo fuera de la ventana de Paycomet). */
  | 'NOTHING_TO_PAY'
  /** Ya hay una liquidación esperando la doble firma: se firma esa o se retira. */
  | 'PAYOUT_PENDING'
  /** Sin los documentos del titular verificados no se paga a la entidad (`/ajustes#documentos`). */
  | 'KYB_NOT_VERIFIED'
  | 'DESTINATION_ACCOUNT_MISSING'
  /** La liquidación ya no está en el estado que permite esta operación (otra persona la retiró, se firmó o ya se envió). */
  | 'WRONG_STATUS'
  /** El Fondo cambió desde que se pidió (un contracargo de un comercio): se anula y hay que pedirla de nuevo. */
  | 'FUND_CHANGED'
  /** Algún cobro de la liquidación pasó su ventana de 90 días antes de completar la doble firma: se anula; lo que quede se pide de nuevo. */
  | 'WINDOW_EXPIRED'
  /** Demasiadas peticiones seguidas de la entidad (pedir, retirar y volver a pedir, o reintentar el envío). */
  | 'RATE_LIMITED';

export class ActivityFundError extends Error {
  readonly reason: ActivityFundRejection;

  constructor(reason: ActivityFundRejection) {
    super(`Fondo de actividades: ${reason}.`);
    this.name = 'ActivityFundError';
    this.reason = reason;
  }
}
