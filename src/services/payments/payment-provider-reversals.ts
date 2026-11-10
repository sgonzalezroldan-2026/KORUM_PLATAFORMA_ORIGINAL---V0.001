import { postJournal } from '@/core/finance/ledger.service';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import { chargebackLines, type ChargebackMode } from '@/core/finance/payment-journals';
import { revokePassInTx } from '@/core/ticketing/ticket-issuance';
import type { Db } from '@/lib/db';
import { queueRefundIssued } from '@/services/email/outbox-writers';
import type { PaymentNotification } from './payment-provider';
import { approveRefundInTx, isSettled, loadLockedContribution, payinLinesOf, PaymentReconciliationError, removeFromInitiative, settleRefundInTx, type ContributionRow } from './payment-reversals';
import { korumLossDebits, rectifySponsorFeeAfterReversal, retireMatchingPool } from './sponsor-reversals';
import type { InvoicingContext } from './sponsorship-events';

/**
 * Lo que Paycomet avisa que ya ha pasado con un cobro (Sprint 2.1, separado de `payment-reversals.ts` en el 4.2b): una devolución hecha (pedida por
 * KORUM o desde su panel) y un contracargo. Mismas reglas: la fila de la iniciativa bloqueada y el asiento según dónde esté el dinero.
 */

/** `true` si el cobro es de un comercio que ya movió dinero fuera de su campaña de origen (reasignado o en la bolsa). */
async function isMovedSponsorship(tx: Db, contribution: Pick<ContributionRow, 'type' | 'sponsorId'>): Promise<boolean> {
  if (contribution.type !== 'SPONSORSHIP' || !contribution.sponsorId) return false;
  const sponsor = await tx.sponsor.findUnique({ where: { id: contribution.sponsorId }, select: { reassignedCents: true } });
  return (sponsor?.reassignedCents ?? 0) > 0;
}

/** Un patrocinio devuelto o contracargado ya no es un comercio amigo vigente, aunque la iniciativa ya estuviera liquidada; su bolsa, si tenía, se apaga. */
async function markSponsorRefunded(tx: Db, contribution: Pick<ContributionRow, 'type' | 'sponsorId' | 'initiativeId'>, at: Date): Promise<void> {
  if (contribution.type !== 'SPONSORSHIP' || !contribution.sponsorId) return;
  const sponsor = await tx.sponsor.findUniqueOrThrow({ where: { id: contribution.sponsorId }, select: { id: true, isMatchingPool: true, status: true } });
  await tx.sponsor.update({ where: { id: sponsor.id }, data: { status: 'REFUNDED', creditPoolAt: null } });
  await retireMatchingPool(tx, sponsor, contribution.initiativeId, at);
}

/** Asiento de un cobro que ya no está en la hucha (liquidado o ya devuelto): lo asume KORUM, salvo el sobrante de una bolsa Matching 2x, que sigue en la bolsa. */
async function korumLossLines(tx: Db, contribution: ContributionRow): Promise<JournalLine[]> {
  return [...(await korumLossDebits(tx, contribution)), { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: contribution.totalChargedCents, organizationId: contribution.organizationId }];
}

function assertMatchesCharge(contribution: ContributionRow, notification: Pick<PaymentNotification, 'order' | 'amountCents' | 'currency'>, label: string): void {
  if (notification.currency !== 'EUR') throw new PaymentReconciliationError(`${label} de ${notification.order} en ${notification.currency}: KORUM solo opera en euros.`);
  if (notification.amountCents !== contribution.totalChargedCents) {
    throw new PaymentReconciliationError(`${label} de ${notification.amountCents} sobre un cobro de ${contribution.totalChargedCents} (${notification.order}): los parciales se revisan a mano.`);
  }
}

/**
 * Momento que decide si un evento ya se celebró: el más tardío entre la fecha del banco y el instante en que se procesa. Un aviso atrasado o reintentado
 * con fecha anterior al evento, procesado después, no debe reabrir una campaña que `CAMPAIGN_EXPIRY` acabaría venciendo y devolviendo.
 */
const laterOf = (occurredAt: Date): Date => new Date(Math.max(occurredAt.getTime(), Date.now()));

/** Un reembolso que Paycomet confirma: el pedido por KORUM, o uno hecho desde su panel. Si ya se liquidó, el dinero ya ha salido y lo asume KORUM. */
export async function applyConfirmedRefundInTx(tx: Db, notification: PaymentNotification, occurredAt: Date, invoicing?: InvoicingContext): Promise<void> {
  const contribution = await loadLockedContribution(tx, { paycometOrder: notification.order });
  if (!contribution) throw new PaymentReconciliationError(`Reembolso de un pedido desconocido: ${notification.order}`);
  assertMatchesCharge(contribution, notification, 'Reembolso');
  // Un patrocinio reasignado (Sprint 4.2d) no sigue el camino «ya liquidada»: su dinero puede estar en la bolsa o en otras campañas, y sale de allí.
  if (contribution.status === 'COMPLETED' && isSettled(contribution.initiative.payout?.status) && !(await isMovedSponsorship(tx, contribution))) {
    await tx.contribution.update({ where: { id: contribution.id }, data: { status: 'REFUNDED', refundedCents: contribution.totalChargedCents, refundedAt: occurredAt } });
    // Ya liquidada, el aforo no se recalcula; pero el pase de quien ha recuperado su dinero deja de valer.
    await revokePassInTx(tx, contribution.id, occurredAt);
    // Antes de apagar la bolsa: el asiento necesita su sobrante tal como está.
    const lines = await korumLossLines(tx, contribution);
    await markSponsorRefunded(tx, contribution, occurredAt);
    await rectifySponsorFeeAfterReversal(tx, contribution, 'REFUND', invoicing, occurredAt);
    await postJournal(tx, {
      idempotencyKey: `payment:refund-after-settlement:${contribution.id}`,
      kind: 'ESCROW_REFUND_DONOR',
      description: `Reembolso tras liquidar de ${notification.order}: lo asume KORUM`,
      organizationId: contribution.organizationId,
      initiativeId: contribution.initiativeId,
      contributionId: contribution.id,
      paycometReference: notification.order,
      occurredAt,
      createdById: 'webhook',
      lines
    });
    await queueRefundIssued(tx, contribution.id);
    await tx.auditLog.create({
      data: { actorType: 'WEBHOOK', organizationId: contribution.organizationId, action: 'payment.refund_after_settlement', targetType: 'Contribution', targetId: String(contribution.id), metadataJson: { amountCents: contribution.totalChargedCents } }
    });
    return;
  }
  if (contribution.status === 'COMPLETED') {
    await approveRefundInTx(tx, contribution.id, { at: laterOf(occurredAt) });
    // Una devolución hecha fuera del rechazo del comercio (desde el panel de Paycomet) también anula la factura del fee.
    await rectifySponsorFeeAfterReversal(tx, contribution, 'REFUND', invoicing, occurredAt);
  }
  await settleRefundInTx(tx, contribution.id, occurredAt);
}

/** Contracargo: asiento, estado `CHARGEBACK` y progreso recalculado, según dónde esté el dinero. Repetirlo no hace nada. */
export async function applyChargebackInTx(tx: Db, notification: PaymentNotification, occurredAt: Date): Promise<boolean> {
  const { order } = notification;
  const contribution = await loadLockedContribution(tx, { paycometOrder: order });
  if (!contribution) throw new PaymentReconciliationError(`Contracargo de un cobro desconocido: ${order}`);
  assertMatchesCharge(contribution, notification, 'Contracargo');
  if (contribution.status !== 'COMPLETED' && contribution.status !== 'REFUND_PENDING' && contribution.status !== 'REFUNDED') return false;
  await tx.contribution.update({ where: { id: contribution.id }, data: { status: 'CHARGEBACK', refundSendingAt: null } });

  // Reasignado (Sprint 4.2d): la liquidación del origen no decide nada; el asiento sale de donde esté cada parte del dinero y lo ya liquidado es pérdida.
  const settled = isSettled(contribution.initiative.payout?.status) && !(await isMovedSponsorship(tx, contribution));
  const mode: ChargebackMode = contribution.status === 'REFUND_PENDING' ? 'REFUND_PENDING' : contribution.status === 'REFUNDED' || settled ? 'KORUM_LOSS' : 'IN_ESCROW';
  const payin = mode === 'IN_ESCROW' ? await payinLinesOf(tx, contribution, laterOf(occurredAt)) : { lines: [], poolReleasedCents: 0 };
  // Sin la hucha, lo asume KORUM; pero el sobrante de una bolsa Matching 2x sigue en la bolsa y sale de ella (antes de apagarla).
  const lossLines = mode === 'KORUM_LOSS' ? await korumLossLines(tx, contribution) : null;
  await postJournal(tx, {
    idempotencyKey: `payment:chargeback:${contribution.id}`,
    kind: 'CHARGEBACK',
    description: `Contracargo de ${order}`,
    organizationId: contribution.organizationId,
    initiativeId: contribution.initiativeId,
    contributionId: contribution.id,
    paycometReference: order,
    occurredAt,
    createdById: 'webhook',
    lines: lossLines ?? chargebackLines(mode, payin.lines, contribution.organizationId, contribution.totalChargedCents)
  });
  if (mode === 'IN_ESCROW') await removeFromInitiative(tx, contribution, laterOf(occurredAt), payin);
  else {
    await revokePassInTx(tx, contribution.id, occurredAt);
    await markSponsorRefunded(tx, contribution, occurredAt);
  }
  // La factura del fee de un contracargo no se rectifica sola: lo decide la asesoría fiscal (impago); queda la alerta para no perderla de vista.
  await rectifySponsorFeeAfterReversal(tx, contribution, 'CHARGEBACK', undefined, occurredAt);
  await tx.auditLog.create({
    data: { actorType: 'WEBHOOK', organizationId: contribution.organizationId, action: 'payment.chargeback', targetType: 'Contribution', targetId: String(contribution.id), metadataJson: { mode, amountCents: notification.amountCents, initiativeId: contribution.initiativeId } }
  });
  return true;
}
