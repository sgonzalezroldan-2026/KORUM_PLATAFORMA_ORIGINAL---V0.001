import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction, type Db } from '@/lib/db';
import { loadLockedContribution, RefundNotAllowedError, settleRefundInTx } from './payment-reversals';

/**
 * Resuelve una devolución de resultado desconocido, cuando una persona ya ha comprobado en Paycomet qué pasó. Queda en la auditoría.
 * Solo un Super-Admin verificado puede hacerlo (`VerifiedSuperadminActor`: sesión con TOTP de hace menos de 10 minutos, que solo emite la
 * capa de sesión): `refunded: true` asienta una devolución sin más prueba que la de esa persona.
 */
export async function resolveUnknownRefund(db: Db, actor: VerifiedSuperadminActor, contributionId: number, resolution: { refunded: boolean }, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'payment.resolve_unknown_refund', now);
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'payment.resolve_unknown_refund', now);
    const contribution = await loadLockedContribution(tx, { id: contributionId });
    if (contribution?.status !== 'REFUND_PENDING' || !contribution.refundSendingAt) throw new RefundNotAllowedError(contributionId, 'no tiene una devolución de resultado desconocido');
    if (resolution.refunded) await settleRefundInTx(tx, contributionId, now);
    else await tx.contribution.update({ where: { id: contributionId }, data: { refundSendingAt: null } });
    await tx.auditLog.create({
      data: { actorType: 'USER', actorUserId: actor.userId, organizationId: contribution.organizationId, action: 'payment.refund_resolved', targetType: 'Contribution', targetId: String(contributionId), metadataJson: { refunded: resolution.refunded } }
    });
  });
}
