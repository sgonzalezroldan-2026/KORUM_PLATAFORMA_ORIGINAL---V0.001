import { postJournal } from '@/core/finance/ledger.service';
import { raiseAlert } from '@/core/jobs/ops-alerts';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import { refundExecutionLines } from '@/core/finance/payment-journals';
import { syncHeldEvent } from '@/core/ticketing/held-event';
import { unspentRefundLines } from '@/core/ticketing/voucher-lifecycle-rules';
import { inTransaction, type Db } from '@/lib/db';
import { queueRefundIssued } from '@/services/email/outbox-writers';
import { PaymentProviderError, type PaymentNotification, type PaymentProvider } from './payment-provider';
import { isSettled, loadLockedContribution, payinLinesOf, PaymentReconciliationError, RefundNotAllowedError, type RefundResult } from './payment-reversals';

/**
 * Devolución de **lo no gastado** de una compra de vales en la que ya se gastó algún vale (Sprint 5.14c, decisión 69; condiciones de entradas y vales §4.5). La
 * entidad cancela la venta antes de liquidarla, o acorta la validez y la persona lo pide: vuelve la parte de lo pagado que corresponde a los vales sin gastar,
 * línea a línea (vales a la hucha y Gastos de gestión digital), redondeada al céntimo; lo gastado se queda y se liquida a la entidad. Una compra sin ningún
 * vale gastado se devuelve entera por el camino de siempre (`approveRefundInTx`).
 *
 * - **Aprobar** (en la transacción de quien llama, con la venta y el pase bloqueados): fila `PartialRefund`, asiento `ESCROW_REFUND_DONOR` (la hucha y la gestión
 *   al pasivo de devoluciones), el pase deja de valer y lo vendido baja en los vales devueltos. La compra sigue `COMPLETED`: lo gastado sigue siendo suyo.
 * - **Enviar** a Paycomet (`executePartialRefund`): se reserva antes de llamar (dos ejecuciones no devuelven dos veces); con el resultado desconocido no se
 *   reintenta; rechazada, se puede volver a pedir.
 * - **Confirmar** (`settlePartialRefundInTx`): por la respuesta de la API o por la notificación de Paycomet, con su asiento de ejecución y el email «Devolución
 *   realizada» por el importe devuelto. Repetirlo no hace nada.
 *
 * Un contracargo o una devolución por otro importe de un cobro con devolución parcial no se adivinan: se revisan a mano (`assertNoPartialRefund`). Mientras,
 * la devolución parcial que aún no se había enviado queda **retenida** (`ON_HOLD`, `holdPartialRefundForReview`): no se envía nunca sola, porque el banco
 * podría haber retirado ya el cobro entero.
 */

/** El cobro de una devolución parcial recibió un contracargo o una devolución por otro importe: lo revisa una persona y la devolución pendiente se retiene. */
export class PartialRefundReviewError extends PaymentReconciliationError {
  readonly contributionId: number;

  constructor(contributionId: number, message: string) {
    super(message);
    this.name = 'PartialRefundReviewError';
    this.contributionId = contributionId;
  }
}

export type PartialRefundReason = 'VOUCHER_SALE_CANCELLED' | 'VOUCHER_VALIDITY_SHORTENED';

export interface PartialRefundApproval {
  amountCents: number;
  vouchers: number;
}

/**
 * Aprueba la devolución de los vales sin gastar de una compra. `null` si no hay nada que devolver por esta vía: compra no cobrada, pase anulado, todo gastado o
 * nada gastado (esa va entera por `approveRefundInTx`). Lanza si la venta ya está liquidada: el dinero ya no está en la hucha.
 */
export async function approvePartialRefundInTx(tx: Db, contributionId: number, options: { reason: PartialRefundReason; at: Date }): Promise<PartialRefundApproval | null> {
  const contribution = await loadLockedContribution(tx, { id: contributionId });
  if (!contribution || contribution.status !== 'COMPLETED') return null;
  if (isSettled(contribution.initiative.payout?.status)) throw new RefundNotAllowedError(contributionId, 'la venta ya está liquidada');
  // El pase se bloquea como lo bloquea el puesto al canjear: un canje simultáneo espera y después lo ve anulado.
  const pass = await tx.ticketPass.updateMany({ where: { contributionId }, data: { checkedInCount: { increment: 0 } } });
  if (pass.count !== 1) return null;
  const { quantity, checkedInCount, revokedAt } = await tx.ticketPass.findUniqueOrThrow({ where: { contributionId }, select: { quantity: true, checkedInCount: true, revokedAt: true } });
  const unspent = quantity - checkedInCount;
  if (revokedAt !== null || checkedInCount === 0 || unspent <= 0) return null;
  if ((await tx.partialRefund.count({ where: { contributionId } })) > 0) return null;

  const payin = await payinLinesOf(tx, contribution, options.at);
  // Cada línea del cobro en proporción a los vales sin gastar: lo que salió a la hucha y lo que se quedó KORUM vuelve en la misma proporción.
  const lines: JournalLine[] = unspentRefundLines(payin.lines, unspent, quantity);
  const escrowCents = lines.filter((line) => line.account === 'INITIATIVE_ESCROW').reduce((total, line) => total + line.amountCents, 0);
  const amountCents = lines.reduce((total, line) => total + line.amountCents, 0);
  if (amountCents <= 0) return null;

  await tx.partialRefund.create({
    data: { contributionId, initiativeId: contribution.initiativeId, organizationId: contribution.organizationId, reason: options.reason, vouchers: unspent, amountCents, escrowCents, feeCents: amountCents - escrowCents, createdAt: options.at }
  });
  await postJournal(tx, {
    idempotencyKey: `payment:partial-refund-approval:${contributionId}`,
    kind: 'ESCROW_REFUND_DONOR',
    description: `Devolución aprobada de ${unspent} vales sin gastar de ${contribution.paycometOrder ?? contributionId}`,
    organizationId: contribution.organizationId,
    initiativeId: contribution.initiativeId,
    contributionId,
    paycometReference: contribution.paycometOrder,
    occurredAt: options.at,
    createdById: 'system',
    lines: [...lines, { account: 'REFUNDS_PAYABLE', direction: 'CREDIT', amountCents, organizationId: contribution.organizationId }]
  });
  // Los vales que quedaban dejan de valer; los gastados siguen contando como vendidos (y en el mantenimiento proporcional).
  await tx.ticketPass.update({ where: { contributionId }, data: { revokedAt: options.at } });
  await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { raisedCents: { decrement: escrowCents }, ticketsSold: { decrement: unspent } } });
  await syncHeldEvent(tx, contribution.initiativeId, options.at);
  return { amountCents, vouchers: unspent };
}

/** Registra que lo no gastado ya ha vuelto al medio de pago, con su asiento y el email. Idempotente: lo pueden avisar la API y el webhook. */
export async function settlePartialRefundInTx(tx: Db, contributionId: number, occurredAt: Date): Promise<boolean> {
  // También una retenida: si Paycomet confirma que la devolvió, el dinero salió y hay que asentarlo.
  const { count } = await tx.partialRefund.updateMany({ where: { contributionId, status: { in: ['PENDING', 'ON_HOLD'] } }, data: { status: 'REFUNDED', refundedAt: occurredAt, sendingAt: null } });
  if (count === 0) return false;
  const refund = await tx.partialRefund.findUniqueOrThrow({ where: { contributionId }, select: { amountCents: true, organizationId: true, initiativeId: true, contribution: { select: { paycometOrder: true } } } });
  await tx.contribution.update({ where: { id: contributionId }, data: { refundedCents: refund.amountCents, refundedAt: occurredAt } });
  await postJournal(tx, {
    idempotencyKey: `payment:partial-refund-execution:${contributionId}`,
    kind: 'ESCROW_REFUND_DONOR',
    description: `Devolución ejecutada de los vales sin gastar de ${refund.contribution.paycometOrder ?? contributionId}`,
    organizationId: refund.organizationId,
    initiativeId: refund.initiativeId,
    contributionId,
    paycometReference: refund.contribution.paycometOrder,
    occurredAt,
    createdById: 'system',
    lines: refundExecutionLines(refund.organizationId, refund.amountCents)
  });
  await queueRefundIssued(tx, contributionId, refund.amountCents);
  return true;
}

/** Pide a Paycomet una devolución parcial ya aprobada. Como `executePendingRefund`: reserva antes de llamar y, con el resultado desconocido, no reintenta. */
export async function executePartialRefund(db: Db, provider: PaymentProvider, contributionId: number, originalIp: string, now: Date = new Date()): Promise<RefundResult> {
  const refund = await db.partialRefund.findUnique({ where: { contributionId }, select: { status: true, amountCents: true, organizationId: true, contribution: { select: { paycometOrder: true, paycometAuthCode: true } } } });
  if (!refund) throw new RefundNotAllowedError(contributionId, 'no tiene una devolución parcial aprobada');
  if (refund.status === 'REFUNDED') return { refunded: false, outcome: 'ALREADY_REFUNDED' };
  const { paycometOrder, paycometAuthCode } = refund.contribution;
  if (!paycometOrder || !paycometAuthCode) throw new RefundNotAllowedError(contributionId, 'no tiene el cobro original');
  const claim = await db.partialRefund.updateMany({ where: { contributionId, status: 'PENDING', sendingAt: null }, data: { sendingAt: now } });
  if (claim.count === 0) return { refunded: false, outcome: 'IN_PROGRESS' };

  const audit = (action: string, code: string) =>
    db.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: refund.organizationId, action, targetType: 'Contribution', targetId: String(contributionId), metadataJson: { code, amountCents: refund.amountCents, partial: true } } });
  try {
    await provider.refund({ order: paycometOrder, authCode: paycometAuthCode, amountCents: refund.amountCents, originalIp });
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    if (error.outcomeUnknown) {
      await audit('payment.refund_unknown', error.code);
      return { refunded: false, outcome: 'UNKNOWN', code: error.code };
    }
    await db.partialRefund.updateMany({ where: { contributionId, status: 'PENDING' }, data: { sendingAt: null } });
    await audit('payment.refund_rejected', error.code);
    return { refunded: false, outcome: 'REJECTED', code: error.code };
  }
  await inTransaction(db, async (tx) => {
    await loadLockedContribution(tx, { id: contributionId });
    await settlePartialRefundInTx(tx, contributionId, now);
  });
  return { refunded: true, outcome: 'REFUNDED' };
}

/**
 * Notificación de Paycomet de una devolución confirmada: si es la de una devolución parcial pendiente (mismo importe), se confirma y devuelve `true`. Si el
 * cobro tiene una devolución parcial y la notificación es de otro importe, no se adivina: se revisa a mano.
 */
export async function applyConfirmedPartialRefundInTx(tx: Db, contributionId: number, notification: Pick<PaymentNotification, 'order' | 'amountCents' | 'currency'>, occurredAt: Date): Promise<boolean> {
  const refund = await tx.partialRefund.findUnique({ where: { contributionId }, select: { amountCents: true } });
  if (!refund) return false;
  if (notification.currency !== 'EUR' || notification.amountCents !== refund.amountCents) {
    throw new PartialRefundReviewError(contributionId, `Devolución de ${notification.amountCents} sobre un cobro con una devolución parcial de ${refund.amountCents} (${notification.order}): se revisa a mano.`);
  }
  await settlePartialRefundInTx(tx, contributionId, occurredAt);
  return true;
}

/** Un contracargo de un cobro ya devuelto en parte no se asienta a ciegas (el banco puede retirar el total o lo que queda): se revisa a mano. */
export async function assertNoPartialRefund(tx: Db, contributionId: number, order: string, label: string): Promise<void> {
  if ((await tx.partialRefund.count({ where: { contributionId } })) > 0) throw new PartialRefundReviewError(contributionId, `${label} de ${order}, un cobro con una devolución parcial de vales: se revisa a mano.`);
}

/**
 * Retiene la devolución parcial de un cobro que hay que revisar a mano (fuera de la transacción del aviso, que se deshizo) y abre la alerta crítica para el
 * Super-Admin. Repetirlo no hace nada distinto. Una ya devuelta no cambia, pero también avisa: el banco pudo retirar el cobro entero.
 */
export async function holdPartialRefundForReview(db: Db, contributionId: number, now: Date): Promise<void> {
  await db.partialRefund.updateMany({ where: { contributionId, status: 'PENDING' }, data: { status: 'ON_HOLD' } });
  const refund = await db.partialRefund.findUnique({ where: { contributionId }, select: { organizationId: true, initiativeId: true, amountCents: true, status: true } });
  if (!refund) return;
  await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey: `PARTIAL_REFUND_HELD:${contributionId}`, organizationId: refund.organizationId, targetType: 'Contribution', targetId: String(contributionId), detail: { initiativeId: refund.initiativeId, amountCents: refund.amountCents, status: refund.status, partial: true } }, now);
}

/** Paycomet confirma que una devolución parcial falló: se puede volver a pedir (solo si el fallo es posterior a la reserva). */
export async function clearPartialRefundClaimInTx(tx: Db, order: string, occurredAt: Date | null): Promise<void> {
  if (!occurredAt) return;
  await tx.partialRefund.updateMany({ where: { contribution: { paycometOrder: order }, status: 'PENDING', sendingAt: { lte: occurredAt } }, data: { sendingAt: null } });
}
