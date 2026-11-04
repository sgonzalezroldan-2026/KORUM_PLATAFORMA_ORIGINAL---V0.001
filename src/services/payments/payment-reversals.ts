import { postJournal, reverseJournal } from '@/core/finance/ledger.service';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import { chargebackLines, PAYIN_KINDS, refundApprovalLines, refundExecutionLines, type ChargebackMode } from '@/core/finance/payment-journals';
import { isGoalMet } from '@/core/ticketing/ticket-goal';
import { revokePassInTx } from '@/core/ticketing/ticket-issuance';
import { inTransaction, type Db } from '@/lib/db';
import { PaymentProviderError, type PaymentNotification, type PaymentProvider } from './payment-provider';

/**
 * Lo que deshace un cobro: reembolsos al medio de pago original y contracargos (Regla 02 §7). El reembolso devuelve siempre el 100 % de
 * lo cobrado y solo al cobro original: el destino no es un dato que nadie pueda indicar (QA-P02). Toda decisión sobre dónde está el
 * dinero se toma con la fila de la iniciativa bloqueada, para que un contracargo y una aprobación simultáneos no se pisen.
 */

export class RefundNotAllowedError extends Error {
  constructor(contributionId: number, reason: string) {
    super(`La aportación ${contributionId} no se puede reembolsar: ${reason}.`);
    this.name = 'RefundNotAllowedError';
  }
}

export class PaymentReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentReconciliationError';
  }
}

/** Estados de iniciativa en los que se reembolsa: la campaña ha fallado o se ha cancelado. */
const REFUNDABLE_INITIATIVE_STATUSES = new Set(['REFUNDING', 'CANCELLED']);

/** Una liquidación aprobada ya vació la hucha, aunque su ejecución haya fallado y se vaya a reintentar. */
export const isSettled = (payoutStatus: string | undefined): boolean => payoutStatus !== undefined && payoutStatus !== 'PENDING_DOUBLE_CHECK';

export type ContributionRow = NonNullable<Awaited<ReturnType<typeof loadContribution>>>;

function loadContribution(db: Db, where: { id: number } | { paycometOrder: string }) {
  return db.contribution.findUnique({ where, include: { initiative: { select: { status: true, goalCents: true, payout: { select: { status: true } } } } } });
}

/** Bloquea la iniciativa del cobro y lo lee después: lo que se lea ya no puede cambiar hasta confirmar la transacción. */
export async function loadLockedContribution(tx: Db, where: { id: number } | { paycometOrder: string }): Promise<ContributionRow | null> {
  const reference = await tx.contribution.findUnique({ where, select: { initiativeId: true } });
  if (!reference) return null;
  await tx.initiative.update({ where: { id: reference.initiativeId }, data: { updatedAt: new Date() } });
  return loadContribution(tx, where);
}

async function payinLinesOf(db: Db, contribution: Pick<ContributionRow, 'id' | 'paycometOrder'>): Promise<JournalLine[]> {
  const journal = await db.ledgerJournal.findFirst({ where: { contributionId: contribution.id, kind: { in: [...PAYIN_KINDS] } }, include: { entries: true } });
  if (!journal) throw new PaymentReconciliationError(`El cobro ${contribution.paycometOrder ?? contribution.id} no tiene asiento: no se puede deshacer.`);
  return journal.entries.map((entry) => ({
    account: entry.account,
    direction: entry.direction,
    amountCents: entry.amountCents,
    organizationId: entry.organizationId,
    initiativeId: entry.initiativeId,
    userId: entry.userId,
    sponsorId: entry.sponsorId
  }));
}

/** Si la donación liberó bolsa Matching, ese bonus deja de existir: vuelve a la bolsa y se anula su asiento. */
async function undoMatchingBonus(tx: Db, contribution: ContributionRow): Promise<number> {
  if (contribution.matchedBonusCents === 0 || !contribution.paycometOrder) return 0;
  const release = await tx.contribution.findUnique({ where: { paycometOrder: `${contribution.paycometOrder}-match` } });
  if (!release || release.status !== 'COMPLETED') return 0;
  const journal = await tx.ledgerJournal.findFirst({ where: { contributionId: release.id, kind: 'MATCHING_RELEASE' }, select: { id: true } });
  if (!journal) throw new PaymentReconciliationError(`La liberación de bolsa de ${contribution.paycometOrder} no tiene asiento.`);
  await reverseJournal(tx, { journalId: journal.id, idempotencyKey: `payment:matching-undo:${release.id}`, description: `Anulación del bonus Matching 2x de ${contribution.paycometOrder}`, createdById: 'system' });
  await tx.contribution.update({ where: { id: release.id }, data: { status: 'REFUNDED', refundedCents: release.amountCents, refundedAt: new Date() } });
  await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { matchingPoolRemainingCents: { increment: release.amountCents } } });
  return release.amountCents;
}

/**
 * Quita el cobro de los contadores de la iniciativa, en la misma transacción que su asiento. Si baja de la meta antes de liquidar,
 * vuelve a recaudar: la liquidación pendiente no se aprobará porque ya no cuadra. Una rifa ya sorteada no se reabre: no puede volver a vender
 * y se quedaría sin salida; se liquida lo que queda. Tampoco se reabre un evento de taquilla cuya fecha ya pasó (`at` es el momento del
 * cobro deshecho): ya no puede revender, y `CAMPAIGN_EXPIRY` acabaría devolviendo el dinero a quienes asistieron (decisión del 01-11-2026).
 */
async function removeFromInitiative(tx: Db, contribution: ContributionRow, at: Date): Promise<void> {
  const bonusCents = await undoMatchingBonus(tx, contribution);
  const releasedTickets = await revokePassInTx(tx, contribution.id, at);
  const initiative = await tx.initiative.update({
    where: { id: contribution.initiativeId },
    data: { raisedCents: { decrement: contribution.amountCents + bonusCents }, totalContributions: { decrement: 1 }, ticketsSold: { decrement: releasedTickets } },
    select: { raisedCents: true, goalCents: true, status: true, format: true, closesAt: true, ticketsSold: true, ticketMax: true, _count: { select: { raffleDraws: true } } }
  });
  if (contribution.groupName) {
    await tx.initiativeCourseProgress.updateMany({ where: { initiativeId: contribution.initiativeId, groupName: contribution.groupName, familiesCount: { gt: 0 } }, data: { familiesCount: { decrement: 1 } } });
  }
  const eventAlreadyHeld = initiative.format === 'TICKETING' && initiative.closesAt <= at;
  if (initiative.status === 'GOAL_REACHED' && !isGoalMet(initiative) && initiative._count.raffleDraws === 0 && !eventAlreadyHeld) {
    await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { status: 'FUNDRAISING', stepIndex: 4 } });
  }
}

/**
 * Aprueba el reembolso dentro de la transacción de quien llama: asiento, contadores y estado. Repetirla no hace nada. Con `lateCharge`, el
 * cobro acaba de entrar y no formó parte de ninguna liquidación: se puede devolver aunque la iniciativa ya esté liquidada.
 */
export async function approveRefundInTx(tx: Db, contributionId: number, options: { lateCharge?: boolean; at?: Date } = {}): Promise<void> {
  const contribution = await loadLockedContribution(tx, { id: contributionId });
  if (!contribution) throw new RefundNotAllowedError(contributionId, 'no existe');
  if (contribution.status !== 'COMPLETED') return;
  if (!options.lateCharge && isSettled(contribution.initiative.payout?.status)) throw new RefundNotAllowedError(contributionId, 'la iniciativa ya está liquidada');

  await tx.contribution.update({ where: { id: contributionId }, data: { status: 'REFUND_PENDING' } });
  await postJournal(tx, {
    idempotencyKey: `payment:refund-approval:${contributionId}`,
    kind: 'ESCROW_REFUND_DONOR',
    description: `Reembolso aprobado de ${contribution.paycometOrder ?? contributionId}`,
    organizationId: contribution.organizationId,
    initiativeId: contribution.initiativeId,
    contributionId,
    paycometReference: contribution.paycometOrder,
    createdById: 'system',
    lines: refundApprovalLines(await payinLinesOf(tx, contribution), contribution.organizationId, contribution.totalChargedCents)
  });
  await removeFromInitiative(tx, contribution, options.at ?? new Date());
}

/** Registra que el dinero ya ha vuelto al medio de pago. Idempotente: lo pueden avisar la respuesta de la API y el webhook. */
export async function settleRefundInTx(tx: Db, contributionId: number, occurredAt: Date): Promise<boolean> {
  const contribution = await tx.contribution.findUniqueOrThrow({ where: { id: contributionId } });
  const { count } = await tx.contribution.updateMany({
    where: { id: contributionId, status: 'REFUND_PENDING' },
    data: { status: 'REFUNDED', refundedCents: contribution.totalChargedCents, refundedAt: occurredAt, refundSendingAt: null }
  });
  if (count === 0) return false;
  await postJournal(tx, {
    idempotencyKey: `payment:refund-execution:${contributionId}`,
    kind: 'ESCROW_REFUND_DONOR',
    description: `Reembolso ejecutado de ${contribution.paycometOrder ?? contributionId}`,
    organizationId: contribution.organizationId,
    initiativeId: contribution.initiativeId,
    contributionId,
    paycometReference: contribution.paycometOrder,
    occurredAt,
    createdById: 'system',
    lines: refundExecutionLines(contribution.organizationId, contribution.totalChargedCents)
  });
  return true;
}

/**
 * Paycomet confirma que una devolución falló: ya se puede volver a pedir. Solo si el fallo es posterior a la reserva: el aviso atrasado de
 * un intento anterior no dice nada del intento en curso. Sin fecha, la reserva sigue y lo resuelve una persona.
 */
export async function clearRefundClaimInTx(tx: Db, order: string, occurredAt: Date | null): Promise<void> {
  if (!occurredAt) return;
  await tx.contribution.updateMany({ where: { paycometOrder: order, status: 'REFUND_PENDING', refundSendingAt: { lte: occurredAt } }, data: { refundSendingAt: null } });
}

export type RefundOutcome = 'REFUNDED' | 'ALREADY_REFUNDED' | 'IN_PROGRESS' | 'REJECTED' | 'UNKNOWN';
export interface RefundResult {
  refunded: boolean;
  outcome: RefundOutcome;
  code?: string;
}

/**
 * Pide la devolución de un reembolso ya aprobado. Se reserva antes de llamar, así que dos ejecuciones no devuelven dos veces. Si Paycomet
 * la rechaza, se puede reintentar. Si se corta la conexión, no se sabe si se hizo y **no se reintenta**: queda reservada hasta que llegue
 * su notificación o una persona lo compruebe (`resolveUnknownRefund`).
 */
export async function executePendingRefund(db: Db, provider: PaymentProvider, contributionId: number, originalIp: string, now: Date = new Date()): Promise<RefundResult> {
  const contribution = await db.contribution.findUniqueOrThrow({ where: { id: contributionId } });
  if (contribution.status === 'REFUNDED') return { refunded: false, outcome: 'ALREADY_REFUNDED' };
  if (contribution.status !== 'REFUND_PENDING') throw new RefundNotAllowedError(contributionId, `está en estado ${contribution.status}`);
  if (!contribution.paycometOrder || !contribution.paycometAuthCode) throw new RefundNotAllowedError(contributionId, 'no tiene el cobro original');

  const claim = await db.contribution.updateMany({ where: { id: contributionId, status: 'REFUND_PENDING', refundSendingAt: null }, data: { refundSendingAt: now } });
  if (claim.count === 0) return { refunded: false, outcome: 'IN_PROGRESS' };

  const audit = (action: string, code: string) =>
    db.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: contribution.organizationId, action, targetType: 'Contribution', targetId: String(contributionId), metadataJson: { code, amountCents: contribution.totalChargedCents } } });
  try {
    await provider.refund({ order: contribution.paycometOrder, authCode: contribution.paycometAuthCode, amountCents: contribution.totalChargedCents, originalIp });
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    if (error.outcomeUnknown) {
      await audit('payment.refund_unknown', error.code);
      return { refunded: false, outcome: 'UNKNOWN', code: error.code };
    }
    await db.contribution.updateMany({ where: { id: contributionId, status: 'REFUND_PENDING' }, data: { refundSendingAt: null } });
    await audit('payment.refund_rejected', error.code);
    return { refunded: false, outcome: 'REJECTED', code: error.code };
  }
  await inTransaction(db, async (tx) => {
    await loadLockedContribution(tx, { id: contributionId });
    await settleRefundInTx(tx, contributionId, now);
  });
  return { refunded: true, outcome: 'REFUNDED' };
}

/** Reembolso completo de una donación o entrada de una campaña fallida o cancelada. Los patrocinios se reasignan, no se devuelven (Regla 02 §5). */
export async function refundContribution(db: Db, provider: PaymentProvider, contributionId: number, originalIp: string, now: Date = new Date()): Promise<RefundResult> {
  await inTransaction(db, async (tx) => {
    const contribution = await loadLockedContribution(tx, { id: contributionId });
    if (!contribution) throw new RefundNotAllowedError(contributionId, 'no existe');
    if (contribution.status === 'REFUND_PENDING' || contribution.status === 'REFUNDED') return;
    if (contribution.type !== 'DONATION' && contribution.type !== 'TICKET') throw new RefundNotAllowedError(contributionId, `las aportaciones de tipo ${contribution.type} no se reembolsan así`);
    if (!REFUNDABLE_INITIATIVE_STATUSES.has(contribution.initiative.status)) throw new RefundNotAllowedError(contributionId, `la iniciativa está en estado ${contribution.initiative.status}`);
    if (contribution.status !== 'COMPLETED') throw new RefundNotAllowedError(contributionId, `está en estado ${contribution.status}`);
    await approveRefundInTx(tx, contributionId, { at: now });
  });
  return executePendingRefund(db, provider, contributionId, originalIp, now);
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
export async function applyConfirmedRefundInTx(tx: Db, notification: PaymentNotification, occurredAt: Date): Promise<void> {
  const contribution = await loadLockedContribution(tx, { paycometOrder: notification.order });
  if (!contribution) throw new PaymentReconciliationError(`Reembolso de un pedido desconocido: ${notification.order}`);
  assertMatchesCharge(contribution, notification, 'Reembolso');
  if (contribution.status === 'COMPLETED' && isSettled(contribution.initiative.payout?.status)) {
    await tx.contribution.update({ where: { id: contribution.id }, data: { status: 'REFUNDED', refundedCents: contribution.totalChargedCents, refundedAt: occurredAt } });
    // Ya liquidada, el aforo no se recalcula; pero el pase de quien ha recuperado su dinero deja de valer.
    await revokePassInTx(tx, contribution.id, occurredAt);
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
      lines: chargebackLines('KORUM_LOSS', [], contribution.organizationId, contribution.totalChargedCents)
    });
    await tx.auditLog.create({
      data: { actorType: 'WEBHOOK', organizationId: contribution.organizationId, action: 'payment.refund_after_settlement', targetType: 'Contribution', targetId: String(contribution.id), metadataJson: { amountCents: contribution.totalChargedCents } }
    });
    return;
  }
  if (contribution.status === 'COMPLETED') await approveRefundInTx(tx, contribution.id, { at: laterOf(occurredAt) });
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

  const settled = isSettled(contribution.initiative.payout?.status);
  const mode: ChargebackMode = contribution.status === 'REFUND_PENDING' ? 'REFUND_PENDING' : contribution.status === 'REFUNDED' || settled ? 'KORUM_LOSS' : 'IN_ESCROW';
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
    lines: chargebackLines(mode, mode === 'IN_ESCROW' ? await payinLinesOf(tx, contribution) : [], contribution.organizationId, contribution.totalChargedCents)
  });
  if (mode === 'IN_ESCROW') await removeFromInitiative(tx, contribution, laterOf(occurredAt));
  else await revokePassInTx(tx, contribution.id, occurredAt);
  await tx.auditLog.create({
    data: { actorType: 'WEBHOOK', organizationId: contribution.organizationId, action: 'payment.chargeback', targetType: 'Contribution', targetId: String(contribution.id), metadataJson: { mode, amountCents: notification.amountCents, initiativeId: contribution.initiativeId } }
  });
  return true;
}
