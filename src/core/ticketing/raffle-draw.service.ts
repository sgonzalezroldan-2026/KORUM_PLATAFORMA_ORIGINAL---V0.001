import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { MemberRole } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { safeDisplayText } from '@/core/security/safe-text';
import { getSetting } from '@/services/settings/settings.service';
import { assertGateSessionLive } from './check-in.service';
import { raffleOpensAt } from './gate-rules';
import { canonicalEntries, hashAct, hashEntries, pickWinners, type DrawAct, type RaffleEntry } from './raffle-draw';

/**
 * Ejecuta un sorteo y guarda su acta, inmutable (QA-REG01). Solo con la venta cerrada (`GOAL_REACHED`): la lista de papeletas no puede cambiar
 * durante ni después. Los premios se fijan antes de vender (`rafflePrizeCount`), y nunca se sortean más: así no se puede repetir hasta que salga
 * quien se quiere, ni antes del día del evento. La misma clave devuelve la misma acta, para que un doble toque o un corte de red no saquen un ganador de más. Una ronda
 * extra (un premio sin reclamar, un ganador reembolsado) solo la hacen los firmantes, con motivo, y queda registrada aparte.
 */

const DRAW_ROLES: readonly MemberRole[] = ['GATEKEEPER', 'DIRECTOR', 'COSIGNER'];

export type RaffleDrawBlock = 'NOT_A_RAFFLE' | 'SALES_OPEN' | 'TOO_EARLY' | 'PRIZES_NOT_SET' | 'PRIZES_EXHAUSTED' | 'NOT_ENOUGH_ENTRIES' | 'EXTRA_NOT_JUSTIFIED' | 'EXTRA_TOO_SOON' | 'REPLACED_INVALID' | 'KEY_REUSED';
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
  /** Avisos a la otra persona firmante de una ronda extra (para enviarlos al momento); vacío en una ronda normal o repetida. */
  outboxIds: number[];
  /** A cuántas personas firmantes se ha avisado de esta ronda extra (0 si no hay otra persona firmante activa, o si no es una ronda extra). */
  notified: number;
}

export interface RaffleDrawRequest {
  winnersCount: number;
  /** La genera la pantalla al preparar el sorteo: reintentar con la misma clave no sortea otra vez. */
  idempotencyKey: string;
  extraRoundReason?: ExtraRoundReason;
  /** Solo en una ronda extra: qué números ganadores sustituye (uno por premio nuevo). Cada uno debe ser un ganador que aún no se haya sustituido; con el reembolso, uno cuya papeleta ya no vale. */
  replacesNumbers?: number[];
  now?: Date;
  random?: (max: number) => number;
}

export async function drawRaffle(db: KorumPrismaClient, actor: SessionActor, event: { organizationId: string; initiativeId: number }, request: RaffleDrawRequest): Promise<RaffleDrawResult> {
  const { organizationId, initiativeId } = event;
  const { winnersCount, idempotencyKey, extraRoundReason, random } = request;
  const replaces = [...(request.replacesNumbers ?? [])];
  const now = request.now ?? new Date();
  // Llega de fuera sin validar: el tipo de TypeScript no protege una tabla inmutable. `null` no puede colarse como ronda normal sin tope.
  const extra = extraRoundReason !== undefined && extraRoundReason !== null;
  if (extra && !EXTRA_ROUND_REASONS.has(extraRoundReason)) throw new RangeError('Motivo de ronda extra desconocido.');
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new RangeError('Clave de sorteo no válida.');
  if (replaces.some((number) => !Number.isSafeInteger(number) || number < 1)) throw new RangeError('Números sustituidos no válidos.');
  await authorizeTenant(db, actor, organizationId, extra ? { roles: SIGNER_ROLES, action: 'raffle.draw_extra', targetType: 'Initiative', targetId: initiativeId, allowSuperadmin: false } : { roles: DRAW_ROLES, action: 'raffle.draw', targetType: 'Initiative', targetId: initiativeId });
  // La ronda extra la hace una sola persona firmante, y eso exige su segundo factor también aquí (no solo en la acción del panel).
  if (extra && actor.kind === 'user' && actor.secondFactor !== true) throw new TenantAccessError('ROLE_NOT_ALLOWED');
  await assertGateSessionLive(db, actor, now);
  const owner = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: owner?.organizationId ?? null });

  return db.$transaction(async (tx) => {
    const initiative = await tx.initiative.update({ where: { id: initiativeId }, data: { ticketsHeld: { increment: 0 } }, select: { ticketSubtype: true, status: true, rafflePrizeCount: true, closesAt: true } });
    const previous = await tx.raffleDraw.findMany({ where: { initiativeId }, orderBy: { round: 'asc' } });
    const repeated = previous.find((draw) => draw.idempotencyKey === idempotencyKey);
    if (repeated) {
      const sameReplaced = [...repeated.replacedNumbers].sort((a, b) => a - b).join(',') === [...replaces].sort((a, b) => a - b).join(',');
      if (repeated.winningNumbers.length !== winnersCount || (repeated.extraRoundReason ?? null) !== (extra ? extraRoundReason : null) || (extra && !sameReplaced)) throw new RaffleDrawNotAllowedError('KEY_REUSED');
      const participants = repeated.participantsJson as unknown as RaffleEntry[];
      return {
        act: { initiativeId, round: repeated.round, drawnAt: repeated.drawnAt.toISOString(), participantsSha256: repeated.participantsSha256, participantCount: participants.length, winningNumbers: repeated.winningNumbers },
        actSha256: repeated.actSha256,
        participants,
        outboxIds: [],
        notified: await tx.outboxMessage.count({ where: { idempotencyKey: { startsWith: `raffle.extraRound:${initiativeId}:${repeated.round}:` } } })
      };
    }

    if (initiative.ticketSubtype !== 'RAFFLE') throw new RaffleDrawNotAllowedError('NOT_A_RAFFLE');
    if (initiative.status !== 'GOAL_REACHED') throw new RaffleDrawNotAllowedError('SALES_OPEN');
    // Con la rifa agotada antes de tiempo cualquiera con el PIN podría sortear antes del acto: el sorteo se abre el día del evento, guardado en la iniciativa (QA-SEC09).
    if (now < raffleOpensAt(initiative.closesAt)) throw new RaffleDrawNotAllowedError('TOO_EARLY');
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
      // Qué premios se sustituyen: ganadores reales y no sustituidos ya, uno por premio nuevo (la otra persona firmante puede comprobarlo en el acta).
      const replacedAlready = new Set(previous.flatMap((draw) => draw.replacedNumbers));
      if (replaces.length !== winnersCount || new Set(replaces).size !== replaces.length || replaces.some((number) => !alreadyWon.has(number) || replacedAlready.has(number))) throw new RaffleDrawNotAllowedError('REPLACED_INVALID');
      // Con el reembolso, cada número sustituido debe ser de una papeleta que ya no vale.
      if (extraRoundReason === 'WINNER_REFUNDED' && (await tx.raffleNumber.count({ where: { initiativeId, number: { in: replaces }, ticketPass: { revokedAt: null } } })) > 0) throw new RaffleDrawNotAllowedError('REPLACED_INVALID');
      // Un premio sin reclamar no se sustituye antes del plazo mínimo que fija la plataforma (0 = sin espera); el reembolso no espera.
      if (extraRoundReason === 'PRIZE_UNCLAIMED') {
        const minHours = (await getSetting(tx, 'raffle.extraRoundMinHours')) ?? 0;
        // El plazo corre desde la ronda en la que **ganó** cada número que se sustituye (no desde el sorteo normal): quien ganó como sustituta también tiene plazo para reclamar.
        const wonAt = (number: number) => Math.max(...previous.filter((draw) => draw.winningNumbers.includes(number)).map((draw) => draw.drawnAt.getTime()));
        if (minHours > 0 && replaces.some((number) => now.getTime() < wonAt(number) + minHours * 3_600_000)) throw new RaffleDrawNotAllowedError('EXTRA_TOO_SOON');
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
      data: { initiativeId, round, idempotencyKey, extraRoundReason: extra ? extraRoundReason : null, participantsJson: entries.map(({ number, serialCode }) => ({ number, serialCode })), participantsSha256: act.participantsSha256, winningNumbers, replacedNumbers: extra ? replaces : [], actSha256, drawnByType, drawnById, drawnAt: now }
    });
    const winners = await tx.raffleNumber.findMany({ where: { initiativeId, number: { in: winningNumbers } }, select: { ticketPassId: true } });
    await tx.ticketPass.updateMany({ where: { id: { in: winners.map((winner) => winner.ticketPassId) } }, data: { isWinner: true } });
    await tx.auditLog.create({
      data: { actorType: drawnByType === 'USER' ? 'USER' : 'GATE_SESSION', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'raffle.drawn', targetType: 'Initiative', targetId: String(initiativeId), metadataJson: { round, actSha256, winningNumbers, replacedNumbers: extra ? replaces : [], participantCount: entries.length, extraRoundReason: extra ? extraRoundReason : null } }
    });
    // La ronda extra la hace una sola persona firmante (decisión del promotor, 2026-11-11): la otra queda avisada y la ronda, en el acta y en la auditoría.
    const outboxIds: number[] = [];
    if (extra && actor.kind === 'user') {
      const author = safeDisplayText((await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? '') || undefined;
      const others = await tx.organizationMember.findMany({ where: { organizationId, role: { in: [...SIGNER_ROLES] }, userId: { not: actor.userId }, user: { gdprAnonymizedAt: null, isSuperadmin: false } }, select: { userId: true, user: { select: { email: true, locale: true } } } });
      for (const other of others) {
        const row = await tx.outboxMessage.create({
          data: { idempotencyKey: `raffle.extraRound:${initiativeId}:${round}:${other.userId}`, templateKey: 'raffle.extraRound', locale: other.user.locale, toAddress: other.user.email, userId: other.userId, organizationId, payloadJson: { initiativeId, round, prizes: winningNumbers.length, reason: extraRoundReason, numbers: winningNumbers, replaced: replaces, ...(author ? { by: author } : {}), byUserId: actor.userId } },
          select: { id: true }
        });
        outboxIds.push(row.id);
      }
    }
    return { act, actSha256, participants: entries, outboxIds, notified: outboxIds.length };
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
