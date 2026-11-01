import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { MemberRole } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, type SessionActor } from '@/repositories/tenant-guard';
import { assertGateSessionLive } from './check-in.service';
import { canonicalEntries, hashAct, hashEntries, pickWinners, type DrawAct, type RaffleEntry } from './raffle-draw';

/**
 * Ejecuta un sorteo y guarda su acta, inmutable (QA-REG01). Solo con la venta cerrada (`GOAL_REACHED`): la lista de papeletas no puede cambiar
 * durante ni después. Los premios se fijan antes de vender (`rafflePrizeCount`), y nunca se sortean más: así no se puede repetir hasta que salga
 * quien se quiere. La misma clave devuelve la misma acta, para que un doble toque o un corte de red no saquen un ganador de más. Una ronda
 * extra (un premio sin reclamar, un ganador reembolsado) solo la hacen los firmantes, con motivo, y queda registrada aparte.
 */

const DRAW_ROLES: readonly MemberRole[] = ['GATEKEEPER', 'DIRECTOR', 'COSIGNER'];

export type RaffleDrawBlock = 'NOT_A_RAFFLE' | 'SALES_OPEN' | 'PRIZES_NOT_SET' | 'PRIZES_EXHAUSTED' | 'NOT_ENOUGH_ENTRIES' | 'EXTRA_NOT_JUSTIFIED' | 'KEY_REUSED';
export type ExtraRoundReason = 'PRIZE_UNCLAIMED' | 'WINNER_REFUNDED';

const EXTRA_ROUND_REASONS: ReadonlySet<string> = new Set<ExtraRoundReason>(['PRIZE_UNCLAIMED', 'WINNER_REFUNDED']);
const IDEMPOTENCY_KEY = /^[\w-]{1,128}$/;

export class RaffleDrawNotAllowedError extends Error {
  readonly reason: RaffleDrawBlock;

  constructor(reason: RaffleDrawBlock) {
    super(`No se puede sortear: ${reason}.`);
    this.name = 'RaffleDrawNotAllowedError';
    this.reason = reason;
  }
}

export interface RaffleDrawResult {
  act: DrawAct;
  actSha256: string;
  participants: RaffleEntry[];
}

export interface RaffleDrawRequest {
  winnersCount: number;
  /** La genera la pantalla al preparar el sorteo: reintentar con la misma clave no sortea otra vez. */
  idempotencyKey: string;
  extraRoundReason?: ExtraRoundReason;
  now?: Date;
  random?: (max: number) => number;
}

export async function drawRaffle(db: KorumPrismaClient, actor: SessionActor, event: { organizationId: string; initiativeId: number }, request: RaffleDrawRequest): Promise<RaffleDrawResult> {
  const { organizationId, initiativeId } = event;
  const { winnersCount, idempotencyKey, extraRoundReason, random } = request;
  const now = request.now ?? new Date();
  // Llega de fuera sin validar: el tipo de TypeScript no protege una tabla inmutable. `null` no puede colarse como ronda normal sin tope.
  const extra = extraRoundReason !== undefined && extraRoundReason !== null;
  if (extra && !EXTRA_ROUND_REASONS.has(extraRoundReason)) throw new RangeError('Motivo de ronda extra desconocido.');
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new RangeError('Clave de sorteo no válida.');
  await authorizeTenant(db, actor, organizationId, extra ? { roles: SIGNER_ROLES, action: 'raffle.draw_extra', targetType: 'Initiative', targetId: initiativeId, allowSuperadmin: false } : { roles: DRAW_ROLES, action: 'raffle.draw', targetType: 'Initiative', targetId: initiativeId });
  await assertGateSessionLive(db, actor, now);
  const owner = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: owner?.organizationId ?? null });

  return db.$transaction(async (tx) => {
    const initiative = await tx.initiative.update({ where: { id: initiativeId }, data: { ticketsHeld: { increment: 0 } }, select: { ticketSubtype: true, status: true, rafflePrizeCount: true } });
    const previous = await tx.raffleDraw.findMany({ where: { initiativeId }, orderBy: { round: 'asc' } });
    const repeated = previous.find((draw) => draw.idempotencyKey === idempotencyKey);
    if (repeated) {
      if (repeated.winningNumbers.length !== winnersCount || (repeated.extraRoundReason ?? null) !== (extra ? extraRoundReason : null)) throw new RaffleDrawNotAllowedError('KEY_REUSED');
      const participants = repeated.participantsJson as unknown as RaffleEntry[];
      return {
        act: { initiativeId, round: repeated.round, drawnAt: repeated.drawnAt.toISOString(), participantsSha256: repeated.participantsSha256, participantCount: participants.length, winningNumbers: repeated.winningNumbers },
        actSha256: repeated.actSha256,
        participants
      };
    }

    if (initiative.ticketSubtype !== 'RAFFLE') throw new RaffleDrawNotAllowedError('NOT_A_RAFFLE');
    if (initiative.status !== 'GOAL_REACHED') throw new RaffleDrawNotAllowedError('SALES_OPEN');
    if (initiative.rafflePrizeCount === null) throw new RaffleDrawNotAllowedError('PRIZES_NOT_SET');
    const countOf = (draws: typeof previous) => draws.reduce((sum, draw) => sum + draw.winningNumbers.length, 0);
    const pool = extra ? previous.filter((draw) => draw.extraRoundReason !== null) : previous.filter((draw) => draw.extraRoundReason === null);
    if (!Number.isSafeInteger(winnersCount) || winnersCount < 1 || countOf(pool) + winnersCount > initiative.rafflePrizeCount) throw new RaffleDrawNotAllowedError('PRIZES_EXHAUSTED');

    const alreadyWon = new Set(previous.flatMap((draw) => draw.winningNumbers));
    if (extra) {
      // Una ronda extra sustituye a un premio ya sorteado; no es otra oportunidad de elegir ganador.
      const extras = previous.filter((draw) => draw.extraRoundReason !== null);
      if (countOf(extras) + winnersCount > countOf(previous.filter((draw) => draw.extraRoundReason === null))) throw new RaffleDrawNotAllowedError('EXTRA_NOT_JUSTIFIED');
      if (extraRoundReason === 'WINNER_REFUNDED') {
        const stillHeld = await tx.raffleNumber.count({ where: { initiativeId, number: { in: [...alreadyWon] }, ticketPass: { revokedAt: null } } });
        const usedForRefunds = countOf(extras.filter((draw) => draw.extraRoundReason === 'WINNER_REFUNDED'));
        if (usedForRefunds + winnersCount > alreadyWon.size - stillHeld) throw new RaffleDrawNotAllowedError('EXTRA_NOT_JUSTIFIED');
      }
    }
    const rows = await tx.raffleNumber.findMany({
      where: { initiativeId, ticketPass: { revokedAt: null, contribution: { status: 'COMPLETED' } } },
      select: { number: true, ticketPass: { select: { serialCode: true } } }
    });
    const entries = canonicalEntries(rows.filter((row) => !alreadyWon.has(row.number)).map((row) => ({ number: row.number, serialCode: row.ticketPass.serialCode })));
    if (winnersCount > entries.length) throw new RaffleDrawNotAllowedError('NOT_ENOUGH_ENTRIES');

    const round = Math.max(0, ...previous.map((draw) => draw.round)) + 1;
    const winningNumbers = pickWinners(entries.map((entry) => entry.number), winnersCount, random);
    const act: DrawAct = { initiativeId, round, drawnAt: now.toISOString(), participantsSha256: hashEntries(entries), participantCount: entries.length, winningNumbers };
    const actSha256 = hashAct(act);
    const drawnByType = actor.kind === 'gate' ? 'GATE_SESSION' : 'USER';
    const drawnById = actor.kind === 'gate' ? actor.gateSessionId : actor.kind === 'user' ? actor.userId : 'anonymous';

    await tx.raffleDraw.create({
      data: { initiativeId, round, idempotencyKey, extraRoundReason: extra ? extraRoundReason : null, participantsJson: entries.map(({ number, serialCode }) => ({ number, serialCode })), participantsSha256: act.participantsSha256, winningNumbers, actSha256, drawnByType, drawnById, drawnAt: now }
    });
    const winners = await tx.raffleNumber.findMany({ where: { initiativeId, number: { in: winningNumbers } }, select: { ticketPassId: true } });
    await tx.ticketPass.updateMany({ where: { id: { in: winners.map((winner) => winner.ticketPassId) } }, data: { isWinner: true } });
    await tx.auditLog.create({
      data: { actorType: drawnByType === 'USER' ? 'USER' : 'GATE_SESSION', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'raffle.drawn', targetType: 'Initiative', targetId: String(initiativeId), metadataJson: { round, actSha256, winningNumbers, participantCount: entries.length, extraRoundReason: extra ? extraRoundReason : null } }
    });
    return { act, actSha256, participants: entries };
  });
}

/** Una rifa se liquida con todos sus premios sorteados, o sin más papeletas para sortearlos. Se lee dentro de la transacción de quien llama. */
export async function hasPendingPrizes(tx: Db, initiativeId: number, rafflePrizeCount: number): Promise<boolean> {
  const draws = await tx.raffleDraw.findMany({ where: { initiativeId }, select: { winningNumbers: true, extraRoundReason: true } });
  const drawnPrizes = draws.filter((draw) => draw.extraRoundReason === null).reduce((sum, draw) => sum + draw.winningNumbers.length, 0);
  if (drawnPrizes >= rafflePrizeCount) return false;
  const won = draws.flatMap((draw) => draw.winningNumbers);
  const remaining = await tx.raffleNumber.count({ where: { initiativeId, number: { notIn: won }, ticketPass: { revokedAt: null, contribution: { status: 'COMPLETED' } } } });
  return remaining > 0;
}
