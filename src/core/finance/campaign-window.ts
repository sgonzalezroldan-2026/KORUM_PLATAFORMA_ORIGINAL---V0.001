import { inTransaction, type Db } from '@/lib/db';
import { reserveInitiativeQuotas } from './quota-reservation';

/**
 * Ventana de 90 días de Paycomet y duración de las campañas (Regla 02 §4): solo se puede repartir un cobro durante los 90 días
 * siguientes a ese cobro, así que las campañas duran como máximo `maxCampaignDays` (60 por defecto, nunca más de 75).
 */

export const SPLIT_WINDOW_DAYS = 90;
export const SPLIT_WINDOW_WARNING_DAYS = 15;
export const MAX_CAMPAIGN_DAYS_LIMIT = 75;
const DAY_MS = 86_400_000;

export class CampaignDurationError extends Error {
  readonly maxDays: number;
  readonly requestedDays: number;

  constructor(requestedDays: number, maxDays: number) {
    super(`La campaña duraría ${requestedDays} días y el máximo son ${maxDays}: elige una fecha de cierre anterior.`);
    this.name = 'CampaignDurationError';
    this.requestedDays = requestedDays;
    this.maxDays = maxDays;
  }
}

export class InitiativeNotPublishableError extends Error {
  constructor(initiativeId: number, reason: string) {
    super(`La iniciativa ${initiativeId} no se puede publicar: ${reason}.`);
    this.name = 'InitiativeNotPublishableError';
  }
}

export class SplitWindowExpiredError extends Error {
  readonly missingCents: number;

  constructor(missingCents: number) {
    super(`Faltan ${missingCents} céntimos por repartir: los cobros de esta iniciativa que siguen dentro de la ventana de ${SPLIT_WINDOW_DAYS} días de Paycomet no alcanzan.`);
    this.name = 'SplitWindowExpiredError';
    this.missingCents = missingCents;
  }
}

/** Días de campaña contados desde la publicación, redondeando hacia arriba: un día empezado cuenta entero. */
export function campaignDays(publishedAt: Date, closesAt: Date): number {
  return Math.ceil((closesAt.getTime() - publishedAt.getTime()) / DAY_MS);
}

/** Lanza si la campaña dura más de lo permitido. El límite de 75 días no se puede subir ni desde el motor de reglas. */
export function assertCampaignDuration(publishedAt: Date, closesAt: Date, maxCampaignDays: number): void {
  const maxDays = Math.min(maxCampaignDays, MAX_CAMPAIGN_DAYS_LIMIT);
  const requestedDays = campaignDays(publishedAt, closesAt);
  if (requestedDays > maxDays) throw new CampaignDurationError(requestedDays, maxDays);
}

/** Estado de la ventana del primer cobro de una iniciativa sin liquidar (lo usa la tarea `SPLIT_WINDOW_GUARD`). */
export function evaluateSplitWindow(firstPayinAt: Date, now: Date): { daysElapsed: number; daysLeft: number; shouldWarn: boolean; expired: boolean } {
  const daysElapsed = Math.floor((now.getTime() - firstPayinAt.getTime()) / DAY_MS);
  const daysLeft = SPLIT_WINDOW_DAYS - daysElapsed;
  return { daysElapsed, daysLeft, shouldWarn: daysLeft <= SPLIT_WINDOW_WARNING_DAYS, expired: now.getTime() - firstPayinAt.getTime() > SPLIT_WINDOW_DAYS * DAY_MS };
}

export interface SplitCandidate {
  contributionId: number;
  totalChargedCents: number;
  chargedAt: Date;
}

export interface PlannedSplit {
  contributionId: number;
  amountCents: number;
}

/**
 * Reparte el neto de una liquidación entre los cobros de la iniciativa, porque Paycomet reparte cobro a cobro y cada uno con su propia
 * ventana. Empieza por los más antiguos, que son los primeros en caducar. Lanza si lo que queda dentro de la ventana no alcanza.
 */
export function planPayoutSplits(candidates: readonly SplitCandidate[], netCents: number, now: Date): PlannedSplit[] {
  const usable = candidates
    .filter((candidate) => candidate.totalChargedCents > 0 && (now.getTime() - candidate.chargedAt.getTime()) / DAY_MS <= SPLIT_WINDOW_DAYS)
    .sort((a, b) => a.chargedAt.getTime() - b.chargedAt.getTime() || a.contributionId - b.contributionId);
  const splits: PlannedSplit[] = [];
  let missing = netCents;
  for (const candidate of usable) {
    if (missing === 0) break;
    const amountCents = Math.min(candidate.totalChargedCents, missing);
    splits.push({ contributionId: candidate.contributionId, amountCents });
    missing -= amountCents;
  }
  if (missing > 0) throw new SplitWindowExpiredError(missing);
  return splits;
}

/** Publica una campaña: comprueba la duración, reserva sus cupos y la pasa a `FUNDRAISING`, todo o nada. Repetirla no hace nada. */
export async function publishInitiative(db: Db, initiativeId: number, now: Date = new Date()): Promise<{ published: boolean }> {
  return inTransaction(db, async (tx) => {
    const initiative = await tx.initiative.findUniqueOrThrow({ where: { id: initiativeId }, select: { status: true, closesAt: true, ticketSubtype: true, rafflePrizeCount: true, ticketMax: true } });
    if (initiative.status === 'FUNDRAISING') return { published: false };
    if (initiative.status !== 'BUDGETING') throw new InitiativeNotPublishableError(initiativeId, `está en estado ${initiative.status}`);
    if (initiative.closesAt.getTime() <= now.getTime()) throw new InitiativeNotPublishableError(initiativeId, 'su fecha de cierre ya ha pasado');
    // Publicada, los premios ya no se pueden cambiar: sin ellos la rifa vendería y luego no podría sortearse ni liquidarse.
    if (initiative.ticketSubtype === 'RAFFLE' && (initiative.rafflePrizeCount === null || initiative.ticketMax === null || initiative.rafflePrizeCount > initiative.ticketMax)) {
      throw new InitiativeNotPublishableError(initiativeId, 'una rifa necesita un número de premios, y no más que papeletas');
    }
    const config = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { maxCampaignDays: true } });
    assertCampaignDuration(now, initiative.closesAt, config.maxCampaignDays);

    await reserveInitiativeQuotas(tx, initiativeId);
    const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, status: 'BUDGETING' }, data: { status: 'FUNDRAISING', stepIndex: 4 } });
    if (count === 0) throw new InitiativeNotPublishableError(initiativeId, 'ha cambiado de estado mientras se publicaba');
    return { published: true };
  });
}
