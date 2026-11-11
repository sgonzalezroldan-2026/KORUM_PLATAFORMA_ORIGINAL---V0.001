import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, type SessionActor } from '@/repositories/tenant-guard';
import { assertGateSessionLive, GATE_ROLES, type EventRef } from './check-in.service';
import { raffleOpensAt } from './gate-rules';
import type { RaffleEntry } from './raffle-draw';

/**
 * Lo que la pantalla proyectable del sorteo necesita saber, sin datos de nadie: cuántas papeletas valen, cuántos premios quedan, cuándo se abre el
 * sorteo y las actas de las rondas ya hechas (número de papeleta y huellas). Quién tiene cada papeleta no sale de aquí: se avisa por su número.
 */

export interface RaffleRoundView {
  round: number;
  drawnAt: number;
  winningNumbers: number[];
  actSha256: string;
  participantsSha256: string;
  participantCount: number;
  /** Ronda extra de los firmantes (premio sin reclamar o ganador reembolsado). */
  extra: boolean;
}

export interface RaffleView {
  title: string;
  isRaffle: boolean;
  status: string;
  prizeCount: number | null;
  /** Premios ya sorteados en rondas normales. */
  drawnPrizes: number;
  /** Papeletas pagadas y no anuladas. */
  validEntries: number;
  /** Desde cuándo se puede sortear (ms): el día del evento a las 00:00 en España. */
  opensAt: number;
  /** La hora del servidor al preparar esta vista (ms): la pantalla no se fía del reloj del móvil para decidir si el sorteo ya está abierto. */
  now: number;
  rounds: RaffleRoundView[];
}

async function authorizeRaffleRead(db: KorumPrismaClient, actor: SessionActor, event: EventRef, action: string, now: Date): Promise<void> {
  await authorizeTenant(db, actor, event.organizationId, { roles: GATE_ROLES, action, targetType: 'Initiative', targetId: event.initiativeId });
  await assertGateSessionLive(db, actor, now);
  const owner = await db.initiative.findUnique({ where: { id: event.initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId: event.organizationId, resourceType: 'Initiative', resourceId: event.initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: owner?.organizationId ?? null });
}

export async function loadRaffleView(db: KorumPrismaClient, actor: SessionActor, event: EventRef, now: Date = new Date()): Promise<RaffleView> {
  await authorizeRaffleRead(db, actor, event, 'raffle.view', now);
  const initiative = await db.initiative.findUniqueOrThrow({ where: { id: event.initiativeId }, select: { title: true, ticketSubtype: true, status: true, rafflePrizeCount: true, closesAt: true } });
  const [draws, validEntries] = await Promise.all([
    db.raffleDraw.findMany({ where: { initiativeId: event.initiativeId }, orderBy: { round: 'asc' }, select: { round: true, drawnAt: true, winningNumbers: true, actSha256: true, participantsSha256: true, participantsJson: true, extraRoundReason: true } }),
    db.raffleNumber.count({ where: { initiativeId: event.initiativeId, ticketPass: { revokedAt: null, contribution: { status: 'COMPLETED' } } } })
  ]);
  return {
    title: initiative.title,
    isRaffle: initiative.ticketSubtype === 'RAFFLE',
    status: initiative.status,
    prizeCount: initiative.rafflePrizeCount,
    drawnPrizes: draws.filter((draw) => draw.extraRoundReason === null).reduce((sum, draw) => sum + draw.winningNumbers.length, 0),
    validEntries,
    opensAt: raffleOpensAt(initiative.closesAt).getTime(),
    now: now.getTime(),
    rounds: draws.map((draw) => ({
      round: draw.round,
      drawnAt: draw.drawnAt.getTime(),
      winningNumbers: draw.winningNumbers,
      actSha256: draw.actSha256,
      participantsSha256: draw.participantsSha256,
      participantCount: (draw.participantsJson as unknown as RaffleEntry[]).length,
      extra: draw.extraRoundReason !== null
    }))
  };
}

export interface RaffleActFile {
  kind: 'korum-raffle-act';
  version: 1;
  initiativeId: number;
  round: number;
  drawnAt: string;
  winningNumbers: number[];
  participantCount: number;
  participantsSha256: string;
  actSha256: string;
  /** `null` en una ronda normal; en una ronda extra, el motivo que declaró quien la hizo. Consta en el registro del sorteo, no en las huellas. */
  extraRoundReason: 'PRIZE_UNCLAIMED' | 'WINNER_REFUNDED' | null;
  /** Quién sorteó: una persona firmante (`USER`) o una sesión de portería (`GATE_SESSION`), sin nombres. */
  drawnBy: string;
  /** Solo en una ronda extra: los números ganadores que sustituye (uno por premio nuevo). */
  replacedNumbers: number[];
  /** Papeletas que participaron: solo número y código de serie. Con ellas cualquiera recalcula las dos huellas. */
  participants: RaffleEntry[];
  verification: string;
}

/** Acta completa de una ronda, para descargarla o imprimirla. */
export async function loadRaffleActFile(db: KorumPrismaClient, actor: SessionActor, event: EventRef, round: number, now: Date = new Date()): Promise<RaffleActFile | null> {
  await authorizeRaffleRead(db, actor, event, 'raffle.act_read', now);
  const draw = await db.raffleDraw.findUnique({ where: { initiativeId_round: { initiativeId: event.initiativeId, round } } });
  if (!draw) return null;
  const participants = draw.participantsJson as unknown as RaffleEntry[];
  return {
    kind: 'korum-raffle-act',
    version: 1,
    initiativeId: draw.initiativeId,
    round: draw.round,
    drawnAt: draw.drawnAt.toISOString(),
    winningNumbers: draw.winningNumbers,
    participantCount: participants.length,
    participantsSha256: draw.participantsSha256,
    actSha256: draw.actSha256,
    extraRoundReason: draw.extraRoundReason as RaffleActFile['extraRoundReason'],
    drawnBy: draw.drawnByType,
    replacedNumbers: draw.replacedNumbers,
    participants,
    verification: 'participantsSha256 = SHA-256 (hex) de JSON.stringify(participants) ordenado por número; actSha256 = SHA-256 (hex) de JSON.stringify({initiativeId, round, drawnAt, participantsSha256, participantCount: participants.length, winningNumbers}). El motivo (extraRoundReason) y quien sorteó (drawnBy) constan en el registro del sorteo y no forman parte de las huellas.'
  };
}
