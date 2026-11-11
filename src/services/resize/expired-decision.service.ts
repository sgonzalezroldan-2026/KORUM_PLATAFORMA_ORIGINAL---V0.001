import { notifySigners } from '@/core/jobs/notify';
import {
  decideRefundSchema,
  ExpiredCampaignError,
  hasDuplicateOptions,
  launchResizeVoteSchema,
  pollClosesAt,
  resizeVoteBlockers
} from '@/core/resize/resize-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { Prisma } from '@/generated/prisma/client';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { EXPIRED_DECISION_RULE } from '@/lib/rate-limit-rules';
import { authorizeTenant, recordAudit, recordCrossTenantAttempt, recordMissingResourceProbe, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { queueSupporterBroadcast } from '@/services/notifications/supporter-broadcast';

/**
 * Qué hacer con una campaña que venció sin llegar a la meta (Sprint 4.4b, prototipo `sendResizePollToDonors` y `executeAutomaticRefundAndSponsorReassign`).
 * Lo decide una persona firmante de la entidad con su segundo factor (el cron nunca decide por ella, heredado del 2.4):
 *
 * - **Reembolsar el 100 %** (`EXPIRED → REFUNDING`): la tarea `MASS_REFUND` devuelve cada donación y entrada a su medio de pago original, los comercios
 *   se reasignan con la regla de la entidad (o van a su bolsa) y, sin nada pendiente, la campaña pasa a `REFUNDED` con los cupos devueltos.
 * - **Lanzar la votación** (`EXPIRED → RESIZE_VOTING`): 7 días, solo campañas de presupuesto con donaciones y con margen en la ventana de 90 días.
 *
 * Ninguna de las dos saca dinero hacia la entidad (eso exige después la doble firma de la liquidación), así que basta una persona firmante; la otra recibe
 * el aviso. Las dos quedan en la auditoría y avisan a quienes donaron por lotes.
 */

type Action = 'expired.refund' | 'expired.resize_vote';
type UserActor = Extract<SessionActor, { kind: 'user' }>;

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ExpiredCampaignError('INVALID_INPUT');
  return parsed.data;
}

/** Solo `DIRECTOR` o `COSIGNER` de **esa** entidad, con el segundo factor en esta sesión, y solo sobre sus campañas (otra entidad = inexistente). */
async function authorizeDecision(db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: Action, initiativeId: number): Promise<UserActor> {
  const target = { targetType: 'Initiative', targetId: String(initiativeId) };
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, ...target, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action, targetType: 'Initiative', targetId: initiativeId, allowSuperadmin: false });
  const owner = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  const probe = { organizationId, resourceType: 'Initiative', resourceId: initiativeId };
  if (!owner) {
    await recordMissingResourceProbe(db, actor, probe);
    throw new ExpiredCampaignError('NOT_FOUND');
  }
  if (owner.organizationId !== organizationId) {
    await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: owner.organizationId });
    throw new ExpiredCampaignError('NOT_FOUND');
  }
  if (!(await reserveAttempt(db, `${EXPIRED_DECISION_RULE.prefix}${organizationId}:${actor.userId}`, EXPIRED_DECISION_RULE, new Date()))) {
    await recordAudit(db, actor, { action: 'expired.rate_limited', organizationId, ...target, metadata: { attempted: action, limit: EXPIRED_DECISION_RULE.limit } });
    throw new ExpiredCampaignError('RATE_LIMITED');
  }
  return actor;
}

/** Bloquea la fila de la iniciativa (un cobro tardío o un contracargo simultáneos esperan) y comprueba que siga vencida y sin decidir. */
async function lockExpired(tx: Db, initiativeId: number) {
  await tx.initiative.updateMany({ where: { id: initiativeId }, data: { ticketsHeld: { increment: 0 } } });
  const initiative = await tx.initiative.findUniqueOrThrow({
    where: { id: initiativeId },
    select: { id: true, organizationId: true, status: true, format: true, firstPayinAt: true, raisedCents: true, goalCents: true, walletEscrowId: true, resizePoll: { select: { id: true } } }
  });
  if (initiative.status !== 'EXPIRED') throw new ExpiredCampaignError('WRONG_STATUS');
  return initiative;
}

const auditData = (actor: UserActor, organizationId: string, initiativeId: number, action: string, metadata: Prisma.InputJsonObject) => ({
  actorType: 'USER' as const,
  actorUserId: actor.userId,
  organizationId,
  action,
  targetType: 'Initiative',
  targetId: String(initiativeId),
  metadataJson: metadata
});

export interface DecisionReceipt {
  initiativeId: number;
  status: 'REFUNDING' | 'RESIZE_VOTING';
  closesAt?: Date;
}

/** Reembolsar el 100 % a todas las personas. Repetirlo (doble clic, dos pestañas) no hace nada distinto: la segunda vez la campaña ya no está vencida. */
export async function decideRefund(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<DecisionReceipt> {
  const { initiativeId } = parse(decideRefundSchema, payload);
  const user = await authorizeDecision(db, actor, organizationId, 'expired.refund', initiativeId);
  return inTransaction(db, async (tx) => {
    const initiative = await lockExpired(tx, initiativeId);
    await tx.initiative.update({ where: { id: initiativeId }, data: { status: 'REFUNDING' } });
    await tx.auditLog.create({ data: auditData(user, organizationId, initiativeId, 'initiative.refund_decided', { raisedCents: initiative.raisedCents, goalCents: initiative.goalCents }) });
    await notifySigners(tx, organizationId, 'initiative.expiredDecided', `${initiativeId}:refund`, { initiativeId, decision: 'REFUND' });
    await queueSupporterBroadcast(tx, initiativeId, 'initiative.refundingSupporter', now);
    return { initiativeId, status: 'REFUNDING' };
  });
}

/** Lanza la votación de 7 días con las opciones de la entidad. Una campaña tiene una sola votación: si sale sin proyecto, se reembolsa. */
export async function launchResizeVote(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<DecisionReceipt> {
  const input = parse(launchResizeVoteSchema, payload);
  if (hasDuplicateOptions(input.options)) throw new ExpiredCampaignError('DUPLICATE_OPTIONS');
  const user = await authorizeDecision(db, actor, organizationId, 'expired.resize_vote', input.initiativeId);
  return inTransaction(db, async (tx) => {
    const initiative = await lockExpired(tx, input.initiativeId);
    const donations = await tx.contribution.count({ where: { initiativeId: initiative.id, type: 'DONATION', status: 'COMPLETED' } });
    const [blocker] = resizeVoteBlockers({ format: initiative.format, firstPayinAt: initiative.firstPayinAt, donations, hasPoll: initiative.resizePoll !== null }, now);
    if (blocker) throw new ExpiredCampaignError(blocker);
    if (initiative.raisedCents <= 0) throw new ExpiredCampaignError('NO_DONATIONS');
    const closesAt = pollClosesAt(now);
    const poll = await tx.resizePoll.create({
      data: { initiativeId: initiative.id, optionsJson: input.options, closesAt, createdAt: now, createdById: user.userId, originalGoalCents: initiative.goalCents, raisedAtLaunchCents: initiative.raisedCents },
      select: { id: true }
    });
    await tx.initiative.update({ where: { id: initiative.id }, data: { status: 'RESIZE_VOTING' } });
    await tx.auditLog.create({ data: auditData(user, organizationId, initiative.id, 'initiative.resize_vote_launched', { pollId: poll.id, options: input.options.length, raisedCents: initiative.raisedCents, goalCents: initiative.goalCents, closesAt: closesAt.toISOString() }) });
    await notifySigners(tx, organizationId, 'initiative.expiredDecided', `${initiative.id}:vote`, { initiativeId: initiative.id, decision: 'RESIZE_VOTE', closesAt: closesAt.toISOString() });
    await queueSupporterBroadcast(tx, initiative.id, 'initiative.resizePoll', now);
    return { initiativeId: initiative.id, status: 'RESIZE_VOTING', closesAt };
  });
}
