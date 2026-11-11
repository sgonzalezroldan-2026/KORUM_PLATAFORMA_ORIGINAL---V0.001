import type { Db } from '@/lib/db';
import { getSetting } from '@/services/settings/settings.service';

/**
 * Lo que las personas firmantes ven de una rifa sorteada y cuántos premios pueden sustituir con una **ronda extra** (Sprint 4.6, ampliado en el 4.7). El motor
 * (`drawRaffle`) es quien decide de verdad y rechaza lo que no cabe; esto calcula los mismos límites para que la pantalla ofrezca solo lo posible y explique el
 * resto. Una ronda extra no es otra oportunidad de elegir ganador: sustituye **un número ganador concreto** (que consta en el acta) cuyo premio nadie reclama
 * (tras el plazo mínimo que fije la plataforma) o cuya papeleta se reembolsó.
 */

export type ExtraRoundReason = 'PRIZE_UNCLAIMED' | 'WINNER_REFUNDED';

export interface RaffleAdminRound {
  round: number;
  numbers: number[];
  /** `null` en una ronda normal. */
  reason: ExtraRoundReason | null;
  /** Solo en una ronda extra: los números ganadores que sustituyó. */
  replaced: number[];
  drawnAt: string;
}

/** Un número ganador que aún se puede sustituir. */
export interface ReplaceableWinner {
  number: number;
  /** Su papeleta ya no vale (reembolso o contracargo): puede sustituirse por el motivo «ganador reembolsado». */
  refunded: boolean;
  /** Mientras no llegue esta fecha (ISO) no se puede sustituir como **premio sin reclamar** (plazo mínimo desde la ronda en que ganó); `null` si ya se puede. */
  waitUntil: string | null;
}

export interface RaffleAdminView {
  prizeCount: number;
  /** Premios sorteados en rondas normales. */
  drawnPrizes: number;
  /** Premios ya sustituidos en rondas extra. */
  extraDrawn: number;
  /** Papeletas pagadas, no anuladas y que aún no han ganado. */
  entriesLeft: number;
  rounds: RaffleAdminRound[];
  /** Números ganadores que aún se pueden sustituir (no sustituidos ya). */
  replaceable: ReplaceableWinner[];
  /** Cuántos premios se pueden sustituir ahora por cada motivo (0: ese motivo no está disponible); el premio sin reclamar solo cuenta los números cuyo plazo ya pasó. */
  limits: Record<ExtraRoundReason, number>;
  /** La primera fecha (ISO) en que alguno de los números que aún esperan su plazo se podrá sustituir como premio sin reclamar; `null` si ninguno espera. */
  waitUntil: string | null;
}

export interface ExtraLimitInput {
  prizeCount: number;
  ordinaryDrawn: number;
  extraDrawn: number;
  /** Números ganadores aún sin sustituir y con el plazo ya cumplido (para el premio sin reclamar). */
  replaceable: number;
  /** De ellos, los de una papeleta que ya no vale. */
  replaceableRefunded: number;
  entriesLeft: number;
}

/** Los mismos topes que aplica `drawRaffle`: nunca más extras que premios ni que premios normales sorteados, ni que números sin sustituir, ni que papeletas libres. */
export function extraRoundLimits(input: ExtraLimitInput): Record<ExtraRoundReason, number> {
  const common = Math.max(0, Math.min(input.prizeCount - input.extraDrawn, input.ordinaryDrawn - input.extraDrawn, input.entriesLeft));
  return { PRIZE_UNCLAIMED: Math.min(common, input.replaceable), WINNER_REFUNDED: Math.min(common, input.replaceableRefunded) };
}

/** `null` si la rifa aún no se ha sorteado (o no tiene premios fijados): no hay nada que sustituir. */
export async function loadRaffleAdminView(db: Db, initiativeId: number, prizeCount: number | null, now: Date = new Date()): Promise<RaffleAdminView | null> {
  if (prizeCount === null) return null;
  const draws = await db.raffleDraw.findMany({ where: { initiativeId }, orderBy: { round: 'asc' }, select: { round: true, winningNumbers: true, replacedNumbers: true, extraRoundReason: true, drawnAt: true } });
  if (draws.length === 0) return null;
  const won = [...new Set(draws.flatMap((draw) => draw.winningNumbers))];
  const replacedSet = new Set(draws.flatMap((draw) => draw.replacedNumbers));
  const [held, entriesLeft, minHours] = await Promise.all([
    db.raffleNumber.findMany({ where: { initiativeId, number: { in: won }, ticketPass: { revokedAt: null } }, select: { number: true } }),
    db.raffleNumber.count({ where: { initiativeId, number: { notIn: won }, ticketPass: { revokedAt: null, contribution: { status: 'COMPLETED' } } } }),
    getSetting(db, 'raffle.extraRoundMinHours')
  ]);
  const heldSet = new Set(held.map((row) => row.number));
  const wonAt = (number: number) => Math.max(...draws.filter((draw) => draw.winningNumbers.includes(number)).map((draw) => draw.drawnAt.getTime()));
  const waitHours = minHours ?? 0;
  const replaceable: ReplaceableWinner[] = won
    .filter((number) => !replacedSet.has(number))
    .sort((a, b) => a - b)
    .map((number) => {
      const until = wonAt(number) + waitHours * 3_600_000;
      return { number, refunded: !heldSet.has(number), waitUntil: waitHours > 0 && now.getTime() < until ? new Date(until).toISOString() : null };
    });
  const count = (predicate: (reason: string | null) => boolean) => draws.filter((draw) => predicate(draw.extraRoundReason)).reduce((sum, draw) => sum + draw.winningNumbers.length, 0);
  const ordinaryDrawn = count((reason) => reason === null);
  const extraDrawn = count((reason) => reason !== null);
  const limits = extraRoundLimits({ prizeCount, ordinaryDrawn, extraDrawn, replaceable: replaceable.filter((winner) => winner.waitUntil === null).length, replaceableRefunded: replaceable.filter((winner) => winner.refunded).length, entriesLeft });
  return {
    prizeCount,
    drawnPrizes: ordinaryDrawn,
    extraDrawn,
    entriesLeft,
    rounds: draws.map((draw) => ({ round: draw.round, numbers: draw.winningNumbers, reason: draw.extraRoundReason as ExtraRoundReason | null, replaced: draw.replacedNumbers, drawnAt: draw.drawnAt.toISOString() })),
    replaceable,
    limits,
    waitUntil: replaceable.map((winner) => winner.waitUntil).filter((date): date is string => date !== null).sort()[0] ?? null
  };
}
