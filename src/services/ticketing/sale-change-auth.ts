import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { EVENT_CHANGE_RULE } from '@/lib/rate-limit-rules';
import { authorizeTenant, recordAudit, recordCrossTenantAttempt, recordMissingResourceProbe, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';

/**
 * Quién puede cancelar o cambiar las fechas de una taquilla: un evento con entradas (Sprint 5.13) o una venta de vales (Sprint 5.14c). Una persona firmante de
 * **esa** entidad (`DIRECTOR` o `COSIGNER`) con su segundo factor, solo sobre sus taquillas (la de otra entidad responde como inexistente), y con un tope de cambios
 * por persona y hora. Ni el Super-Admin (`L-125`) ni una cuenta de voluntario. Cada intento denegado queda en la auditoría, también sin segundo factor.
 */

export type SaleChangeAction = 'event.cancel' | 'event.reschedule' | 'voucher.cancel' | 'voucher.change_dates';
export type UserActor = Extract<SessionActor, { kind: 'user' }>;

export async function authorizeSaleChange(
  db: KorumPrismaClient,
  actor: SessionActor,
  organizationId: string,
  action: SaleChangeAction,
  initiativeId: number,
  now: Date,
  fail: (reason: 'NOT_FOUND' | 'RATE_LIMITED') => Error
): Promise<UserActor> {
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
    throw fail('NOT_FOUND');
  }
  if (owner.organizationId !== organizationId) {
    await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: owner.organizationId });
    throw fail('NOT_FOUND');
  }
  // El mismo tope por persona y hora para eventos y vales: es el mismo gesto (cambiar una taquilla) y avisa a quienes compraron.
  if (!(await reserveAttempt(db, `${EVENT_CHANGE_RULE.prefix}${organizationId}:${actor.userId}`, EVENT_CHANGE_RULE, now))) {
    await recordAudit(db, actor, { action: action.startsWith('voucher.') ? 'voucher.rate_limited' : 'event.rate_limited', organizationId, ...target, metadata: { attempted: action, limit: EVENT_CHANGE_RULE.limit } });
    throw fail('RATE_LIMITED');
  }
  return actor;
}
