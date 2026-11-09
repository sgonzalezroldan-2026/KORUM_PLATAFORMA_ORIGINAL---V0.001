import { postJournal, reverseJournal } from '@/core/finance/ledger.service';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import { PAYIN_KINDS, refundApprovalLines, refundExecutionLines } from '@/core/finance/payment-journals';
import { isGoalMet } from '@/core/ticketing/ticket-goal';
import { revokePassInTx } from '@/core/ticketing/ticket-issuance';
import { inTransaction, type Db } from '@/lib/db';
import { queueRefundIssued } from '@/services/email/outbox-writers';
import { PaymentProviderError, type PaymentProvider } from './payment-provider';
import { retireMatchingPool, splitReleasedPool, type PayinToUndo } from './sponsor-reversals';

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
  return db.contribution.findUnique({ where, include: { initiative: { select: { status: true, goalCents: true, closesAt: true, payout: { select: { status: true } } } } } });
}

/** Bloquea la iniciativa del cobro y lo lee después: lo que se lea ya no puede cambiar hasta confirmar la transacción. */
export async function loadLockedContribution(tx: Db, where: { id: number } | { paycometOrder: string }): Promise<ContributionRow | null> {
  const reference = await tx.contribution.findUnique({ where, select: { initiativeId: true } });
  if (!reference) return null;
  await tx.initiative.update({ where: { id: reference.initiativeId }, data: { updatedAt: new Date() } });
  return loadContribution(tx, where);
}

export async function payinLinesOf(db: Db, contribution: Pick<ContributionRow, 'id' | 'paycometOrder'>): Promise<PayinToUndo> {
  const journal = await db.ledgerJournal.findFirst({ where: { contributionId: contribution.id, kind: { in: [...PAYIN_KINDS] } }, include: { entries: true } });
  if (!journal) throw new PaymentReconciliationError(`El cobro ${contribution.paycometOrder ?? contribution.id} no tiene asiento: no se puede deshacer.`);
  const lines: JournalLine[] = journal.entries.map((entry) => ({
    account: entry.account,
    direction: entry.direction,
    amountCents: entry.amountCents,
    organizationId: entry.organizationId,
    initiativeId: entry.initiativeId,
    userId: entry.userId,
    sponsorId: entry.sponsorId
  }));
  return splitReleasedPool(db, lines);
}

/**
 * Si la donación liberó bolsa Matching, ese bonus deja de existir: vuelve a la bolsa y se anula su asiento. Si el comercio de la bolsa ya no está
 * aprobado (se le devolvió o hubo contracargo), lo liberado ya salió de la hucha con su devolución: no vuelve a ninguna bolsa ni se resta dos veces.
 */
async function undoMatchingBonus(tx: Db, contribution: ContributionRow): Promise<number> {
  if (contribution.matchedBonusCents === 0 || !contribution.paycometOrder) return 0;
  const release = await tx.contribution.findUnique({ where: { paycometOrder: `${contribution.paycometOrder}-match` } });
  if (!release || release.status !== 'COMPLETED') return 0;
  const journal = await tx.ledgerJournal.findFirst({ where: { contributionId: release.id, kind: 'MATCHING_RELEASE' }, select: { id: true, entries: { where: { account: 'MATCHING_POOL' }, select: { sponsorId: true } } } });
  if (!journal) throw new PaymentReconciliationError(`La liberación de bolsa de ${contribution.paycometOrder} no tiene asiento.`);
  const poolSponsorId = journal.entries[0]?.sponsorId;
  const poolSponsor = poolSponsorId ? await tx.sponsor.findUnique({ where: { id: poolSponsorId }, select: { status: true } }) : null;
  if (poolSponsor?.status !== 'APPROVED') return 0;
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
export async function removeFromInitiative(tx: Db, contribution: ContributionRow, at: Date, poolReleasedCents = 0): Promise<void> {
  const bonusCents = await undoMatchingBonus(tx, contribution);
  const releasedTickets = await revokePassInTx(tx, contribution.id, at);
  let leavesRaised = contribution.amountCents + bonusCents;
  if (contribution.type === 'SPONSORSHIP' && contribution.sponsorId) {
    const sponsor = await tx.sponsor.findUniqueOrThrow({ where: { id: contribution.sponsorId }, select: { id: true, isMatchingPool: true, status: true } });
    await tx.sponsor.update({ where: { id: contribution.sponsorId }, data: { status: 'REFUNDED' } });
    // De una bolsa Matching 2x solo había sumado a lo recaudado lo ya liberado. Se apaga: ninguna donación posterior la buscará.
    if (sponsor.isMatchingPool) {
      leavesRaised = poolReleasedCents;
      await retireMatchingPool(tx, sponsor, contribution.initiativeId, at);
    }
  }
  const initiative = await tx.initiative.update({
    where: { id: contribution.initiativeId },
    data: { raisedCents: { decrement: leavesRaised }, totalContributions: { decrement: 1 }, ticketsSold: { decrement: releasedTickets } },
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
  const payin = await payinLinesOf(tx, contribution);
  await postJournal(tx, {
    idempotencyKey: `payment:refund-approval:${contributionId}`,
    kind: 'ESCROW_REFUND_DONOR',
    description: `Reembolso aprobado de ${contribution.paycometOrder ?? contributionId}`,
    organizationId: contribution.organizationId,
    initiativeId: contribution.initiativeId,
    contributionId,
    paycometReference: contribution.paycometOrder,
    createdById: 'system',
    lines: refundApprovalLines(payin.lines, contribution.organizationId, contribution.totalChargedCents)
  });
  await removeFromInitiative(tx, contribution, options.at ?? new Date(), payin.poolReleasedCents);
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
  await queueRefundIssued(tx, contributionId);
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
