import { planPayoutSplits, SPLIT_WINDOW_DAYS } from '@/core/finance/campaign-window';
import { getAccountBalance, postJournal } from '@/core/finance/ledger.service';
import { payoutApprovalLines, splitTransferLines } from '@/core/finance/payment-journals';
import { hasPendingPrizes } from '@/core/ticketing/raffle-draw.service';
import { isGoalMet } from '@/core/ticketing/ticket-goal';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { evaluateDoubleCheck, type SignatureInvalidReason } from '@/core/security/double-check-evaluation';
import { payoutTargetDigest } from '@/core/security/signature-hash';
import { inTransaction, type Db } from '@/lib/db';
import { PaymentProviderError, type PaymentProvider } from './payment-provider';

/**
 * Liquidación con doble firma (skill korum-escrow-payments §8). Paycomet reparte cobro a cobro (`/v1/marketplace/split-transfer` exige el
 * pedido original), así que una liquidación son muchos repartos, cada uno con su propia ventana de 90 días. Se registra cada uno antes de
 * enviarlo, para reanudar sin repetir: si se corta la conexión, ese reparto queda en `SENDING` y una persona comprueba qué pasó, porque
 * reenviarlo a ciegas podría pagar dos veces. La cuenta destino se fija al aprobar: las firmas valen para esa cuenta y no para otra.
 *
 * Solo paga a la cuenta destino de la entidad. Pagar directamente a un proveedor está pendiente de Paycomet (tarea aplazada).
 */

export class PayoutNotAllowedError extends Error {
  constructor(payoutId: number, reason: string) {
    super(`La liquidación ${payoutId} no se puede ejecutar: ${reason}.`);
    this.name = 'PayoutNotAllowedError';
  }
}

/** Hay firmas guardadas que no superan la comprobación: manipuladas, sin OTP, de otro importe o de quien ya no tiene el rol. */
class PayoutSignaturesRejectedError extends PayoutNotAllowedError {
  constructor(
    payoutId: number,
    readonly organizationId: string,
    readonly reasons: SignatureInvalidReason[]
  ) {
    super(payoutId, `faltan dos firmas válidas de DIRECTOR y COSIGNER, dos personas distintas (${reasons.join(', ')})`);
  }
}

const DAY_MS = 86_400_000;

function assertVerifiedOrganization(payoutId: number, organization: { kybStatus: string; archivedAt: Date | null }): void {
  if (organization.kybStatus !== 'VERIFIED') throw new PayoutNotAllowedError(payoutId, 'la entidad no ha superado la verificación (KYB)');
  if (organization.archivedAt) throw new PayoutNotAllowedError(payoutId, 'la entidad está archivada');
}

/**
 * Comprueba las dos firmas y que las cifras cuadran, reparte el neto entre los cobros y mueve el dinero de la hucha a lo debido a la entidad.
 * Las firmas se verifican aquí, en la misma transacción que mueve el dinero: huella, OTP y que cada firmante sigue teniendo su rol.
 */
export async function approvePayout(db: Db, payoutId: number, signatureSecret: string, now: Date = new Date()): Promise<{ approved: boolean; splits: number }> {
  try {
    return await approveSignedPayout(db, payoutId, signatureSecret, now);
  } catch (error) {
    if (error instanceof PayoutSignaturesRejectedError && error.reasons.length > 0) {
      await db.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: error.organizationId, action: 'payout.signatures_rejected', targetType: 'EscrowPayout', targetId: String(payoutId), metadataJson: { reasons: error.reasons } } });
    }
    throw error;
  }
}

async function approveSignedPayout(db: Db, payoutId: number, signatureSecret: string, now: Date): Promise<{ approved: boolean; splits: number }> {
  return inTransaction(db, async (tx) => {
    const { initiativeId } = await tx.escrowPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { initiativeId: true } });
    // Se bloquea la iniciativa antes de leer nada: un contracargo simultáneo espera, y después ya la verá liquidada.
    const initiative = await tx.initiative.update({ where: { id: initiativeId }, data: { updatedAt: now }, include: { _count: { select: { raffleDraws: true } } } });
    const { count } = await tx.escrowPayout.updateMany({ where: { id: payoutId, status: 'PENDING_DOUBLE_CHECK' }, data: { status: 'APPROVED' } });
    if (count === 0) return { approved: false, splits: 0 };

    const payout = await tx.escrowPayout.findUniqueOrThrow({ where: { id: payoutId }, include: { signatures: true, organization: { select: { paycometSplitId: true, kybStatus: true, archivedAt: true } } } });
    if (payout.destinationType !== 'ORGANIZATION') throw new PayoutNotAllowedError(payoutId, 'pagar directamente a un proveedor está pendiente de confirmar con Paycomet');
    const targetDigest = payoutTargetDigest(signatureSecret, payout, payout.organization.paycometSplitId);
    const doubleCheck = await evaluateDoubleCheck(tx, signatureSecret, { organizationId: payout.organizationId, targetType: 'ESCROW_PAYOUT', targetId: payoutId, targetDigest }, payout.signatures);
    if (!doubleCheck.complete) throw new PayoutSignaturesRejectedError(payoutId, payout.organizationId, doubleCheck.invalid.map((entry) => entry.reason));
    assertVerifiedOrganization(payoutId, payout.organization);
    if (!payout.organization.paycometSplitId) throw new PayoutNotAllowedError(payoutId, 'la entidad no tiene cuenta destino en Paycomet');

    const drawn = initiative._count.raffleDraws > 0;
    // Una rifa sorteada y un evento cuya fecha ya pasó se liquidan aunque un contracargo los baje de la meta: ya no pueden vender más.
    // Y una rifa sin sorteo completo no se liquida (comprobación siguiente).
    const eventHeld = initiative.format === 'TICKETING' && initiative.closesAt <= now;
    if (initiative.status !== 'GOAL_REACHED' || !(isGoalMet(initiative) || drawn || eventHeld)) throw new PayoutNotAllowedError(payoutId, 'la iniciativa no ha alcanzado la meta');
    if (initiative.ticketSubtype === 'RAFFLE' && (!drawn || initiative.rafflePrizeCount === null || (await hasPendingPrizes(tx, initiativeId, initiative.rafflePrizeCount)))) {
      throw new PayoutNotAllowedError(payoutId, 'la rifa aún no se ha sorteado por completo');
    }
    const gatewayInGoalCents = initiative.absorbsGatewayCostByKorum ? 0 : initiative.gatewayFeeCents;
    const korumFeeCents = initiative.bracketFeeCents + initiative.maintFeeCents;
    if (payout.korumFeeSettledCents !== korumFeeCents || payout.netPaidCents + korumFeeCents + gatewayInGoalCents !== initiative.raisedCents) {
      throw new PayoutNotAllowedError(payoutId, 'el reparto no suma lo recaudado; hay que recalcularlo');
    }
    const scope = { organizationId: payout.organizationId, initiativeId: payout.initiativeId };
    const escrow = (await getAccountBalance(tx, 'INITIATIVE_ESCROW', scope)).balanceCents;
    if (escrow !== initiative.raisedCents) throw new PayoutNotAllowedError(payoutId, `la hucha tiene ${escrow} céntimos y lo recaudado es ${initiative.raisedCents}`);

    const charges = await tx.contribution.findMany({
      where: { initiativeId: payout.initiativeId, status: 'COMPLETED', totalChargedCents: { gt: 0 }, paycometOrder: { not: null }, paycometAuthCode: { not: null } },
      select: { id: true, totalChargedCents: true, createdAt: true }
    });
    const plan = planPayoutSplits(
      charges.map((charge) => ({ contributionId: charge.id, totalChargedCents: charge.totalChargedCents, chargedAt: charge.createdAt })),
      payout.netPaidCents,
      now
    );
    await tx.escrowPayoutSplit.createMany({ data: plan.map((split) => ({ payoutId, contributionId: split.contributionId, amountCents: split.amountCents })) });
    await tx.escrowPayout.update({ where: { id: payoutId }, data: { destinationSplitId: payout.organization.paycometSplitId } });
    await postJournal(tx, {
      ...scope,
      payoutId,
      idempotencyKey: `payment:payout-approval:${payoutId}`,
      kind: 'PAYOUT_APPROVAL',
      description: `Liquidación aprobada con doble firma: ${initiative.title}`,
      occurredAt: now,
      createdById: 'system',
      lines: payoutApprovalLines(scope, { raisedCents: initiative.raisedCents, netPaidCents: payout.netPaidCents, bracketFeeCents: initiative.bracketFeeCents, maintFeeCents: initiative.maintFeeCents, gatewayInGoalCents })
    });
    return { approved: true, splits: plan.length };
  });
}

async function recordSplitDone(db: Db, split: { id: number; payoutId: number; amountCents: number; contributionId: number }, payout: { organizationId: string; initiativeId: number }, splitAuthCode: string, now: Date): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const { count } = await tx.escrowPayoutSplit.updateMany({ where: { id: split.id, status: 'SENDING' }, data: { status: 'DONE', splitAuthCode, executedAt: now, errorMessage: null } });
    if (count === 0) return false;
    await postJournal(tx, {
      ...payout,
      payoutId: split.payoutId,
      contributionId: split.contributionId,
      idempotencyKey: `payment:split:${split.id}`,
      kind: 'SPLIT_PAYOUT_ORGANIZATION',
      description: `Reparto a la entidad del cobro ${split.contributionId}`,
      paycometReference: splitAuthCode,
      occurredAt: now,
      createdById: 'system',
      lines: splitTransferLines(payout.organizationId, split.amountCents)
    });
    return true;
  });
}

export type PayoutExecutionStatus = 'EXECUTED' | 'FAILED' | 'NEEDS_REVIEW';

/**
 * Ejecuta los repartos pendientes de una liquidación aprobada. Se puede repetir: lo ya hecho no se envía otra vez. Un reparto cuyo cobro ya
 * no vale (contracargado o fuera de la ventana) no se envía y queda para revisión: hay que replanificarlo, y reintentar no lo arreglaría.
 */
export async function executeApprovedPayout(db: Db, provider: PaymentProvider, payoutId: number, now: Date = new Date()): Promise<{ status: PayoutExecutionStatus; doneCents: number }> {
  const payout = await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId }, include: { organization: { select: { kybStatus: true, archivedAt: true } } } });
  if (payout.status === 'EXECUTED') return { status: 'EXECUTED', doneCents: payout.netPaidCents };
  if (payout.status === 'PENDING_DOUBLE_CHECK') throw new PayoutNotAllowedError(payoutId, 'aún no está aprobada');
  assertVerifiedOrganization(payoutId, payout.organization);
  const { destinationSplitId } = payout;
  if (!destinationSplitId) throw new PayoutNotAllowedError(payoutId, 'no tiene una cuenta destino fijada al aprobar');
  const scope = { organizationId: payout.organizationId, initiativeId: payout.initiativeId };

  await db.escrowPayout.updateMany({ where: { id: payoutId, status: { in: ['APPROVED', 'FAILED'] } }, data: { status: 'PROCESSING' } });
  const splits = await db.escrowPayoutSplit.findMany({ where: { payoutId }, orderBy: { id: 'asc' }, include: { contribution: { select: { paycometOrder: true, paycometAuthCode: true, createdAt: true, status: true } } } });

  let blocked = false;
  for (const split of splits) {
    if (split.status === 'DONE' || split.status === 'SENDING') continue;
    const { contribution } = split;
    const expired = (now.getTime() - contribution.createdAt.getTime()) / DAY_MS > SPLIT_WINDOW_DAYS;
    if (expired || contribution.status !== 'COMPLETED' || !contribution.paycometOrder || !contribution.paycometAuthCode) {
      const reason = expired ? `Fuera de la ventana de ${SPLIT_WINDOW_DAYS} días` : `El cobro está en estado ${contribution.status}`;
      await db.escrowPayoutSplit.updateMany({ where: { id: split.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'FAILED', errorMessage: reason } });
      blocked = true;
      continue;
    }
    // Quien se queda esta fila es el único que envía el reparto, aunque haya dos ejecuciones a la vez.
    const claim = await db.escrowPayoutSplit.updateMany({ where: { id: split.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'SENDING', sentAt: now, attempts: { increment: 1 } } });
    if (claim.count === 0) continue;
    try {
      const { splitAuthCode } = await provider.splitTransfer({ order: contribution.paycometOrder, authCode: contribution.paycometAuthCode, splitId: destinationSplitId, amountCents: split.amountCents });
      await recordSplitDone(db, split, scope, splitAuthCode, now);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      // Con el resultado desconocido se queda en SENDING; con un rechazo definitivo, en FAILED para reintentarlo.
      await db.escrowPayoutSplit.update({ where: { id: split.id }, data: error.outcomeUnknown ? { errorMessage: error.message.slice(0, 500) } : { status: 'FAILED', errorMessage: error.message.slice(0, 500) } });
      break;
    }
  }

  // El estado sale de lo que hay en la base, no de esta ejecución: otra puede seguir enviando a la vez.
  const current = await db.escrowPayoutSplit.findMany({ where: { payoutId }, orderBy: { id: 'asc' }, select: { status: true, amountCents: true, splitAuthCode: true } });
  const done = current.filter((split) => split.status === 'DONE');
  const doneCents = done.reduce((total, split) => total + split.amountCents, 0);
  if (blocked || current.some((split) => split.status === 'SENDING')) return { status: 'NEEDS_REVIEW', doneCents };
  if (done.length !== current.length || doneCents !== payout.netPaidCents) {
    await db.escrowPayout.updateMany({ where: { id: payoutId, status: 'PROCESSING' }, data: { status: 'FAILED' } });
    return { status: 'FAILED', doneCents };
  }
  // También desde FAILED: otra ejecución pudo marcarla así en el instante entre dos repartos.
  await db.escrowPayout.updateMany({ where: { id: payoutId, status: { in: ['PROCESSING', 'FAILED'] } }, data: { status: 'EXECUTED', executedAt: now, paycometTransferId: done[0]?.splitAuthCode ?? null } });
  return { status: 'EXECUTED', doneCents };
}

/**
 * Resuelve un reparto de resultado desconocido, cuando una persona ya ha comprobado en Paycomet qué pasó: con `splitAuthCode` se hizo; con
 * `null`, no se hizo y vuelve a estar pendiente. Solo actúa si sigue en `SENDING`: dos resoluciones cruzadas no pueden pagar dos veces.
 */
/** Solo un Super-Admin verificado (`VerifiedSuperadminActor`) puede resolverlo, como `resolveUnknownRefund`. */
export async function resolveUnknownSplit(db: Db, actor: VerifiedSuperadminActor, splitId: number, resolution: { splitAuthCode: string | null }, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'payout.resolve_unknown_split', now);
  const code = resolution.splitAuthCode;
  if (code !== null && code.trim() === '') throw new RangeError('El código de autorización del reparto no puede estar vacío');
  const split = await db.escrowPayoutSplit.findUniqueOrThrow({ where: { id: splitId }, include: { payout: { select: { organizationId: true, initiativeId: true } } } });
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'payout.resolve_unknown_split', now);
    const applied = code !== null ? await recordSplitDone(tx, split, split.payout, code, now) : (await tx.escrowPayoutSplit.updateMany({ where: { id: splitId, status: 'SENDING' }, data: { status: 'PENDING', errorMessage: null } })).count === 1;
    if (!applied) throw new PayoutNotAllowedError(split.payoutId, `el reparto ${splitId} ya no tiene un resultado desconocido`);
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: actor.userId,
        organizationId: split.payout.organizationId,
        action: 'payout.split_resolved',
        targetType: 'EscrowPayoutSplit',
        targetId: String(splitId),
        metadataJson: { done: code !== null, amountCents: split.amountCents }
      }
    });
  });
}
