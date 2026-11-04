import { assertSuperadminWithTwoFactor } from '@/core/security/superadmin-guard';
import { inTransaction, type Db } from '@/lib/db';
import { loadLockedContribution, RefundNotAllowedError, settleRefundInTx } from './payment-reversals';

/**
 * Resuelve una devolución de resultado desconocido, cuando una persona ya ha comprobado en Paycomet qué pasó. Queda en la auditoría.
 * Solo una cuenta de Super-Admin con la verificación en dos pasos activada puede hacerlo (`assertSuperadminWithTwoFactor`): `refunded: true`
 * asienta una devolución sin más prueba que la de esa persona.
 */
export async function resolveUnknownRefund(db: Db, contributionId: number, resolution: { refunded: boolean; resolvedById: string }, now: Date = new Date()): Promise<void> {
  await assertSuperadminWithTwoFactor(db, resolution.resolvedById, 'payment.resolve_unknown_refund', String(contributionId));
  await inTransaction(db, async (tx) => {
    const contribution = await loadLockedContribution(tx, { id: contributionId });
    if (contribution?.status !== 'REFUND_PENDING' || !contribution.refundSendingAt) throw new RefundNotAllowedError(contributionId, 'no tiene una devolución de resultado desconocido');
    if (resolution.refunded) await settleRefundInTx(tx, contributionId, now);
    else await tx.contribution.update({ where: { id: contributionId }, data: { refundSendingAt: null } });
    await tx.auditLog.create({
      data: { actorType: 'USER', actorUserId: resolution.resolvedById, organizationId: contribution.organizationId, action: 'payment.refund_resolved', targetType: 'Contribution', targetId: String(contributionId), metadataJson: { refunded: resolution.refunded } }
    });
  });
}
