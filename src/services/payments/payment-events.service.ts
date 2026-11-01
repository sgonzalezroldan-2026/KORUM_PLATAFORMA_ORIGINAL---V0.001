import { postJournal } from '@/core/finance/ledger.service';
import { bpsOf } from '@/core/finance/money';
import { donationOrTicketPayinLines, gatewayFeeLines, matchingReleaseLines } from '@/core/finance/payment-journals';
import { settleTicketSeatInTx } from '@/core/ticketing/ticket-issuance';
import { releaseTicketHoldInTx } from '@/core/ticketing/ticket-reservation.service';
import type { Db } from '@/lib/db';
import { applyChargebackInTx, applyConfirmedRefundInTx, approveRefundInTx, clearRefundClaimInTx, isSettled, loadLockedContribution, PaymentReconciliationError } from './payment-reversals';
import type { PaymentNotification } from './payment-provider';

/**
 * Efecto de cada notificación de la entidad de pago, dentro de la transacción del webhook: el asiento y los contadores se confirman
 * juntos o no se confirma nada. Toda cifra que no cuadre con el cobro registrado lanza: no se acredita dinero que no se esperaba.
 */

async function releaseMatching(
  tx: Db,
  contribution: { id: number; organizationId: string; initiativeId: number; amountCents: number; locale: 'es' | 'ca' | 'en'; fiscalYear: number },
  order: string,
  occurredAt: Date
): Promise<number> {
  // La fila de la iniciativa ya está bloqueada por el `update` de los contadores: dos donaciones nunca gastan la misma bolsa.
  const initiative = await tx.initiative.findUniqueOrThrow({ where: { id: contribution.initiativeId }, select: { matchingPoolRemainingCents: true } });
  const bonusCents = Math.min(contribution.amountCents, initiative.matchingPoolRemainingCents);
  if (bonusCents === 0) return 0;
  const pool = await tx.sponsor.findFirst({ where: { initiativeId: contribution.initiativeId, isMatchingPool: true, status: 'APPROVED' }, select: { id: true } });
  if (!pool) throw new PaymentReconciliationError(`La iniciativa ${contribution.initiativeId} tiene bolsa Matching sin patrocinador.`);

  const release = await tx.contribution.create({
    data: {
      organizationId: contribution.organizationId,
      initiativeId: contribution.initiativeId,
      locale: contribution.locale,
      fiscalYear: contribution.fiscalYear,
      type: 'MATCHING_FUND',
      amountCents: bonusCents,
      totalChargedCents: 0,
      paymentMethod: 'PLATFORM',
      paycometOrder: `${order}-match`,
      status: 'COMPLETED',
      createdAt: occurredAt
    }
  });
  const scope = { organizationId: contribution.organizationId, initiativeId: contribution.initiativeId };
  await postJournal(tx, {
    ...scope,
    idempotencyKey: `payment:matching:${order}`,
    kind: 'MATCHING_RELEASE',
    description: `Liberación de la bolsa Matching 2x por ${order}`,
    contributionId: release.id,
    occurredAt,
    createdById: 'webhook',
    lines: matchingReleaseLines(scope, pool.id, bonusCents)
  });
  await tx.contribution.update({ where: { id: contribution.id }, data: { matchedBonusCents: bonusCents } });
  await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { matchingPoolRemainingCents: { decrement: bonusCents }, raisedCents: { increment: bonusCents } } });
  return bonusCents;
}

/** Lo que necesita el webhook además de la notificación. El secreto del QR va aparte: sin él, una entrada falla y se reintenta. */
export interface PaymentEventOptions {
  qrSecret?: string;
}

async function completePayment(tx: Db, notification: PaymentNotification, occurredAt: Date, options: PaymentEventOptions): Promise<void> {
  const { order } = notification;
  // Bloquea la iniciativa: dos notificaciones del mismo pedido, o un cobro y una aprobación simultáneos, van uno detrás de otro.
  const contribution = await loadLockedContribution(tx, { paycometOrder: order });
  if (!contribution) throw new PaymentReconciliationError(`Cobro confirmado de un pedido desconocido: ${order}`);
  if (!notification.authCode) throw new PaymentReconciliationError(`Cobro ${order} confirmado sin código de autorización: no se podría devolver ni repartir.`);
  if (notification.currency !== 'EUR') throw new PaymentReconciliationError(`Cobro ${order} en ${notification.currency}: KORUM solo opera en euros.`);
  if (notification.amountCents !== contribution.totalChargedCents) {
    throw new PaymentReconciliationError(`Cobro ${order} confirmado por ${notification.amountCents} y se esperaban ${contribution.totalChargedCents}.`);
  }
  if (contribution.type !== 'DONATION' && contribution.type !== 'TICKET') {
    throw new PaymentReconciliationError(`Cobro ${order} de tipo ${contribution.type}: este tipo se confirma con su propio flujo (patrocinios, Sprint 3.5).`);
  }
  const serviceFeeCents = contribution.totalChargedCents - contribution.amountCents - contribution.guaranteeContributionCents;
  if (serviceFeeCents < 0 || (contribution.type === 'DONATION' && serviceFeeCents !== 0)) {
    throw new PaymentReconciliationError(`Cobro ${order}: el total no cuadra con el importe y la aportación voluntaria.`);
  }

  // Dos notificaciones distintas del mismo pedido no pueden acreditarlo dos veces.
  const { count } = await tx.contribution.updateMany({
    where: { id: contribution.id, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'COMPLETED', paycometAuthCode: notification.authCode }
  });
  if (count === 0) return;

  const scope = { organizationId: contribution.organizationId, initiativeId: contribution.initiativeId };
  const common = { ...scope, contributionId: contribution.id, paycometReference: order, occurredAt, createdById: 'webhook' };
  await postJournal(tx, {
    ...common,
    idempotencyKey: `payment:payin:${order}`,
    kind: contribution.type === 'DONATION' ? 'PAYIN_DONATION' : 'PAYIN_TICKET',
    description: `Cobro ${order}`,
    lines: donationOrTicketPayinLines(scope, {
      type: contribution.type,
      amountCents: contribution.amountCents,
      guaranteeCents: contribution.guaranteeContributionCents,
      serviceFeeCents,
      totalChargedCents: contribution.totalChargedCents
    })
  });

  const config = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { gatewayPctBps: true, gatewayFixedCents: true } });
  const gatewayFeeCents = bpsOf(contribution.totalChargedCents, config.gatewayPctBps) + config.gatewayFixedCents;
  if (gatewayFeeCents > 0) {
    await postJournal(tx, { ...common, idempotencyKey: `payment:gateway:${order}`, kind: 'GATEWAY_FEE', description: `Comisión de Paycomet de ${order}`, lines: gatewayFeeLines(contribution.organizationId, gatewayFeeCents) });
  }

  const initiative = await tx.initiative.update({
    where: { id: contribution.initiativeId },
    data: { raisedCents: { increment: contribution.amountCents }, totalContributions: { increment: 1 } },
    select: { status: true, goalCents: true, firstPayinAt: true, raisedCents: true }
  });
  if (!initiative.firstPayinAt) await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { firstPayinAt: occurredAt } });
  if (contribution.groupName) {
    await tx.initiativeCourseProgress.updateMany({ where: { initiativeId: contribution.initiativeId, groupName: contribution.groupName }, data: { familiesCount: { increment: 1 } } });
  }

  // Suma a la campaña mientras recauda o, lograda la meta, hasta aprobar la liquidación: es el excedente de la entidad (Regla 02 §1).
  // Después ya no cabe en ninguna liquidación: el dinero entró, así que se devuelve entero.
  const accepting = initiative.status === 'FUNDRAISING' || (initiative.status === 'GOAL_REACHED' && !isSettled(contribution.initiative.payout?.status));
  if (!accepting) {
    if (contribution.type === 'TICKET') await releaseTicketHoldInTx(tx, contribution);
    await approveRefundInTx(tx, contribution.id, { lateCharge: true });
    return;
  }
  let capacityFull = false;
  if (contribution.type === 'TICKET') {
    if (!options.qrSecret) throw new PaymentReconciliationError(`Cobro ${order}: falta el secreto del QR para emitir el pase.`);
    const seat = await settleTicketSeatInTx(tx, contribution, options.qrSecret, occurredAt);
    if (!seat.issued) {
      // Pago tardío sin plaza, o rifa ya sorteada: el dinero entró, así que se devuelve entero. No llegó a contar en el aforo.
      await approveRefundInTx(tx, contribution.id, { lateCharge: true });
      return;
    }
    capacityFull = seat.capacityFull;
  }
  const bonusCents = contribution.type === 'DONATION' ? await releaseMatching(tx, contribution, order, occurredAt) : 0;
  if (initiative.status === 'FUNDRAISING' && (capacityFull || initiative.raisedCents + bonusCents >= initiative.goalCents)) {
    await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { status: 'GOAL_REACHED', stepIndex: 5 } });
  }
}

export async function applyPaymentNotification(tx: Db, notification: PaymentNotification, receivedAt: Date, options: PaymentEventOptions = {}): Promise<void> {
  const occurredAt = notification.occurredAt ?? receivedAt;
  switch (notification.kind) {
    case 'PAYMENT_COMPLETED':
      await completePayment(tx, notification, occurredAt, options);
      return;
    case 'PAYMENT_FAILED': {
      // Se bloquea primero la iniciativa, en el mismo orden que un cobro: un fallo y un cobro simultáneos no se quedan esperándose.
      const contribution = await loadLockedContribution(tx, { paycometOrder: notification.order });
      const { count } = await tx.contribution.updateMany({ where: { paycometOrder: notification.order, status: 'PENDING' }, data: { status: 'FAILED' } });
      if (count === 1 && contribution?.type === 'TICKET') await releaseTicketHoldInTx(tx, contribution);
      return;
    }
    case 'REFUND_COMPLETED':
      await applyConfirmedRefundInTx(tx, notification, occurredAt);
      return;
    case 'CHARGEBACK':
      await applyChargebackInTx(tx, notification, occurredAt);
      return;
    case 'REFUND_FAILED':
      // Sigue en `REFUND_PENDING`, y ahora se sabe que no se hizo: ya se puede volver a pedir.
      await clearRefundClaimInTx(tx, notification.order, notification.occurredAt);
      return;
    case 'IGNORED':
      return;
  }
}
