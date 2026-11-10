import { getAccountBalance, postJournal } from '@/core/finance/ledger.service';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import { splitTransferLines } from '@/core/finance/payment-journals';
import { notifySigners } from '@/core/jobs/notify';
import { evaluateDoubleCheck } from '@/core/security/double-check-evaluation';
import { activityFundTargetDigest } from '@/core/security/signature-hash';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { ActivityFundError, fundPayoutIdSchema, withinSplitWindow } from '@/core/sponsors/activity-fund-rules';
import { inTransaction, type Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { SessionActor } from '@/repositories/tenant-guard';
import { authorizeFundAction, cancelPendingFundPayout, parseFundPayload, reserveFundAttempt } from '@/services/sponsors/activity-fund.service';
import { lockInitiatives } from '@/services/sponsors/sponsor-money';
import { PaymentProviderError, type PaymentProvider } from './payment-provider';

/**
 * Liquidación del Fondo de actividades (Sprint 4.2f) a la cuenta de la entidad, con doble firma, como una liquidación de campaña (skill de pagos §8):
 * se aprueba en una transacción que vuelve a comprobar las firmas, la entidad y que cada comercio sigue teniendo su parte en el Fondo; después se envía
 * cada reparto desde el cobro original de su comercio, registrado antes de enviarlo para reanudar sin repetir. Uno de resultado desconocido queda en
 * `SENDING` hasta que el Super-Admin comprueba qué pasó (`resolveUnknownFundSplit`).
 */

/** Lo repartido de un cobro en otras liquidaciones (de campaña o del Fondo, sin las retiradas): un cobro nunca se reparte por encima de lo cobrado. */
export async function splitUsageOf(tx: Db, contributionIds: readonly number[], excludeFundPayoutId?: number): Promise<Map<number, number>> {
  // Una detrás de otra: dentro de una transacción solo hay una conexión.
  const escrow = await tx.escrowPayoutSplit.groupBy({ by: ['contributionId'], where: { contributionId: { in: [...contributionIds] } }, _sum: { amountCents: true } });
  const fund = await tx.activityFundSplit.groupBy({
    by: ['contributionId'],
    where: { contributionId: { in: [...contributionIds] }, payout: { status: { not: 'CANCELLED' } }, ...(excludeFundPayoutId === undefined ? {} : { payoutId: { not: excludeFundPayoutId } }) },
    _sum: { amountCents: true }
  });
  const used = new Map<number, number>();
  for (const row of [...escrow, ...fund]) used.set(row.contributionId, (used.get(row.contributionId) ?? 0) + (row._sum.amountCents ?? 0));
  return used;
}

/** Firmas guardadas que no superan la comprobación (manipuladas, de otra cuenta destino, de quien perdió el cargo): su auditoría va fuera de la transacción. */
class FundSignaturesRejectedError extends ActivityFundError {
  constructor(
    readonly organizationId: string,
    readonly reasons: string[]
  ) {
    super('WRONG_STATUS');
  }
}

/**
 * Aprueba la liquidación con sus dos firmas: mueve cada parte del Fondo a lo debido a la entidad y fija la cuenta destino. Si el Fondo ya no tiene lo que
 * se firmó (un contracargo de un comercio, `FUND_CHANGED`) o algún cobro ya pasó su ventana de 90 días (`WINDOW_EXPIRED`), se anula, para que la entidad
 * la pida de nuevo con lo que haya. Devuelve `approved: false` si ya no esperaba la doble firma (otra ejecución la aprobó o se retiró).
 */
export async function approveFundPayout(db: Db, payoutId: number, signatureSecret: string, now: Date = new Date()): Promise<{ approved: boolean }> {
  try {
    return await inTransaction(db, (tx) => approveInTx(tx, payoutId, signatureSecret, now));
  } catch (error) {
    // La transacción de la aprobación se deshace entera: el rastro de unas firmas rechazadas se escribe aparte, como en `approvePayout`.
    // Una vez por liquidación: la tarea diaria vuelve a intentarlo y no debe llenar la auditoría con el mismo rechazo (reauditoría financiera del 4.2f).
    const alreadyAudited = error instanceof FundSignaturesRejectedError && (await db.auditLog.count({ where: { action: 'activity_fund.signatures_rejected', targetType: 'ActivityFundPayout', targetId: String(payoutId) } })) > 0;
    if (error instanceof FundSignaturesRejectedError && error.reasons.length > 0 && !alreadyAudited) {
      await db.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: error.organizationId, action: 'activity_fund.signatures_rejected', targetType: 'ActivityFundPayout', targetId: String(payoutId), metadataJson: { reasons: error.reasons } } });
    }
    if (error instanceof ActivityFundError && (error.reason === 'FUND_CHANGED' || error.reason === 'WINDOW_EXPIRED')) {
      const reason = error.reason;
      await inTransaction(db, async (tx) => {
        if (await cancelPendingFundPayout(tx, payoutId, reason, now)) {
          const { organizationId } = await tx.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { organizationId: true } });
          await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId, action: 'activity_fund.payout_cancelled', targetType: 'ActivityFundPayout', targetId: String(payoutId), metadataJson: { reason } } });
        }
      });
    }
    throw error;
  }
}

async function approveInTx(tx: Db, payoutId: number, signatureSecret: string, now: Date): Promise<{ approved: boolean }> {
  // Primero las campañas de los cobros de cada reparto, en orden de id: son las filas que bloquean los contracargos (`applyChargebackInTx`,
  // `movedPayinLines`) y el paso de la bolsa al Fondo. Así una aprobación y un contracargo simultáneos se ordenan y nunca leen los dos el mismo saldo
  // del Fondo (auditoría financiera del 4.2f, B1). Después, la fila de la entidad (frente a una petición nueva) y la de la liquidación.
  const { organizationId, splits: planned } = await tx.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { organizationId: true, splits: { select: { contribution: { select: { initiativeId: true } } } } } });
  const origins = [...new Set(planned.map((split) => split.contribution.initiativeId))].sort((a, b) => a - b);
  const [first, ...rest] = origins;
  if (first !== undefined) await lockInitiatives(tx, first, rest, now);
  const organization = await tx.organization.update({ where: { id: organizationId }, data: { updatedAt: now }, select: { kybStatus: true, archivedAt: true, paycometSplitId: true } });
  const payout = await tx.activityFundPayout.update({
    where: { id: payoutId },
    data: { amountCents: { increment: 0 } },
    include: { signatures: true, splits: { include: { contribution: { select: { id: true, status: true, createdAt: true, totalChargedCents: true, paycometOrder: true, paycometAuthCode: true } } } } }
  });
  if (payout.status !== 'PENDING_DOUBLE_CHECK') return { approved: false };
  const account = organization.paycometSplitId;
  const doubleCheck = await evaluateDoubleCheck(tx, signatureSecret, { organizationId, targetType: 'ACTIVITY_FUND_PAYOUT', targetId: payoutId, targetDigest: activityFundTargetDigest(signatureSecret, payout, account) }, payout.signatures);
  if (!doubleCheck.complete) throw new FundSignaturesRejectedError(organizationId, doubleCheck.invalid.map((entry) => entry.reason));
  if (organization.kybStatus !== 'VERIFIED' || organization.archivedAt) throw new ActivityFundError('KYB_NOT_VERIFIED');
  if (!account) throw new ActivityFundError('DESTINATION_ACCOUNT_MISSING');

  const total = payout.splits.reduce((sum, split) => sum + split.amountCents, 0);
  if (total !== payout.amountCents) throw new ActivityFundError('FUND_CHANGED');
  const used = await splitUsageOf(tx, payout.splits.map((split) => split.contributionId), payoutId);
  for (const split of payout.splits) {
    const { contribution } = split;
    const { balanceCents } = await getAccountBalance(tx, 'ORG_ACTIVITY_FUND', { organizationId, sponsorId: split.sponsorId });
    const capacity = contribution.totalChargedCents - (used.get(contribution.id) ?? 0);
    const usable = contribution.status === 'COMPLETED' && contribution.paycometOrder !== null && contribution.paycometAuthCode !== null;
    if (!usable || balanceCents < split.amountCents || capacity < split.amountCents) throw new ActivityFundError('FUND_CHANGED');
    if (!withinSplitWindow(contribution.createdAt, now)) throw new ActivityFundError('WINDOW_EXPIRED');
  }

  const lines: JournalLine[] = payout.splits.map((split) => ({ account: 'ORG_ACTIVITY_FUND', direction: 'DEBIT', amountCents: split.amountCents, organizationId, sponsorId: split.sponsorId }));
  lines.push({ account: 'ORG_PAYABLE', direction: 'CREDIT', amountCents: payout.amountCents, organizationId });
  await postJournal(tx, {
    idempotencyKey: `fund:payout-approval:${payoutId}`,
    kind: 'ACTIVITY_FUND_PAYOUT_APPROVAL',
    description: `Liquidación ${payoutId} del Fondo de actividades aprobada con doble firma`,
    organizationId,
    occurredAt: now,
    createdById: 'system',
    lines
  });
  await tx.activityFundPayout.update({ where: { id: payoutId }, data: { status: 'APPROVED', approvedAt: now, destinationSplitId: account } });
  await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId, action: 'activity_fund.payout_approved', targetType: 'ActivityFundPayout', targetId: String(payoutId), metadataJson: { amountCents: payout.amountCents, splits: payout.splits.length } } });
  return { approved: true };
}

async function recordFundSplitDone(db: Db, split: { id: number; payoutId: number; amountCents: number; contributionId: number }, organizationId: string, splitAuthCode: string, now: Date): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const { count } = await tx.activityFundSplit.updateMany({ where: { id: split.id, status: 'SENDING' }, data: { status: 'DONE', splitAuthCode, executedAt: now, errorMessage: null } });
    if (count === 0) return false;
    await postJournal(tx, {
      organizationId,
      contributionId: split.contributionId,
      idempotencyKey: `fund:split:${split.id}`,
      kind: 'SPLIT_PAYOUT_ORGANIZATION',
      description: `Reparto a la entidad del Fondo de actividades desde el cobro ${split.contributionId}`,
      paycometReference: splitAuthCode,
      occurredAt: now,
      createdById: 'system',
      lines: splitTransferLines(organizationId, split.amountCents)
    });
    return true;
  });
}

export type FundExecutionStatus = 'EXECUTED' | 'FAILED' | 'NEEDS_REVIEW';
const DAY_LIMIT_MESSAGE = 'Fuera de la ventana de 90 días';

/**
 * Envía los repartos pendientes de una liquidación aprobada. Se puede repetir: lo hecho no se envía otra vez. Un reparto cuyo cobro ya no vale
 * (contracargado o fuera de la ventana) no se envía y queda para revisión del Super-Admin: reintentar no lo arreglaría.
 */
export async function executeFundPayout(db: Db, provider: PaymentProvider, payoutId: number, now: Date = new Date()): Promise<{ status: FundExecutionStatus; doneCents: number }> {
  const payout = await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { id: true, organizationId: true, status: true, amountCents: true, destinationSplitId: true, organization: { select: { kybStatus: true, archivedAt: true } } } });
  if (payout.status === 'EXECUTED') return { status: 'EXECUTED', doneCents: payout.amountCents };
  if (payout.status === 'PENDING_DOUBLE_CHECK' || payout.status === 'CANCELLED') throw new ActivityFundError('WRONG_STATUS');
  if (payout.organization.kybStatus !== 'VERIFIED' || payout.organization.archivedAt) throw new ActivityFundError('KYB_NOT_VERIFIED');
  const destination = payout.destinationSplitId;
  if (!destination) throw new ActivityFundError('DESTINATION_ACCOUNT_MISSING');

  await db.activityFundPayout.updateMany({ where: { id: payoutId, status: { in: ['APPROVED', 'FAILED'] } }, data: { status: 'PROCESSING' } });
  const splits = await db.activityFundSplit.findMany({ where: { payoutId }, orderBy: { id: 'asc' }, include: { contribution: { select: { paycometOrder: true, paycometAuthCode: true, createdAt: true, status: true } } } });
  let blocked = false;
  for (const split of splits) {
    if (split.status === 'DONE' || split.status === 'SENDING') continue;
    const { contribution } = split;
    const expired = !withinSplitWindow(contribution.createdAt, now);
    if (expired || contribution.status !== 'COMPLETED' || !contribution.paycometOrder || !contribution.paycometAuthCode) {
      await db.activityFundSplit.updateMany({ where: { id: split.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'FAILED', errorMessage: expired ? DAY_LIMIT_MESSAGE : `El cobro está en estado ${contribution.status}` } });
      blocked = true;
      continue;
    }
    // Quien se queda la fila es el único que envía el reparto, aunque haya dos ejecuciones a la vez.
    const claim = await db.activityFundSplit.updateMany({ where: { id: split.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'SENDING', sentAt: now, attempts: { increment: 1 } } });
    if (claim.count === 0) continue;
    try {
      const { splitAuthCode } = await provider.splitTransfer({ order: contribution.paycometOrder, authCode: contribution.paycometAuthCode, splitId: destination, amountCents: split.amountCents });
      await recordFundSplitDone(db, split, payout.organizationId, splitAuthCode, now);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      await db.activityFundSplit.update({ where: { id: split.id }, data: error.outcomeUnknown ? { errorMessage: error.message.slice(0, 500) } : { status: 'FAILED', errorMessage: error.message.slice(0, 500) } });
      break;
    }
  }

  // El estado sale de la base, no de esta ejecución: otra puede seguir enviando a la vez.
  const current = await db.activityFundSplit.findMany({ where: { payoutId }, select: { status: true, amountCents: true } });
  const doneCents = current.filter((split) => split.status === 'DONE').reduce((sum, split) => sum + split.amountCents, 0);
  if (blocked || current.some((split) => split.status === 'SENDING')) return { status: 'NEEDS_REVIEW', doneCents };
  if (doneCents !== payout.amountCents || current.some((split) => split.status !== 'DONE')) {
    await db.activityFundPayout.updateMany({ where: { id: payoutId, status: 'PROCESSING' }, data: { status: 'FAILED' } });
    return { status: 'FAILED', doneCents };
  }
  await inTransaction(db, async (tx) => {
    const { count } = await tx.activityFundPayout.updateMany({ where: { id: payoutId, status: { in: ['PROCESSING', 'FAILED'] } }, data: { status: 'EXECUTED', executedAt: now } });
    if (count === 1) await notifySigners(tx, payout.organizationId, 'activityFund.paid', `payout:${payoutId}`, { payoutId, amountCents: payout.amountCents });
  });
  return { status: 'EXECUTED', doneCents };
}

export type FundSettlement = { status: FundExecutionStatus } | { status: 'NOT_APPROVED'; reason: ActivityFundError['reason'] };

/** Tras la segunda firma: aprueba y envía en el acto. Si el envío falla, la tarea diaria lo reanuda; si no se aprueba, se dice por qué. */
export async function settleSignedFundPayout(db: Db, provider: () => Promise<PaymentProvider>, payoutId: number, signatureSecret: string, now: Date = new Date()): Promise<FundSettlement> {
  try {
    const { approved } = await approveFundPayout(db, payoutId, signatureSecret, now);
    // Ya no esperaba la doble firma: o la aprobó otra ejecución (se sigue con el envío) o se retiró (no hay nada que enviar).
    if (!approved) {
      const { status } = await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { status: true } });
      if (status === 'CANCELLED' || status === 'PENDING_DOUBLE_CHECK') return { status: 'NOT_APPROVED', reason: 'WRONG_STATUS' };
    }
  } catch (error) {
    if (error instanceof ActivityFundError) return { status: 'NOT_APPROVED', reason: error.reason };
    throw error;
  }
  const { status } = await executeFundPayout(db, await provider(), payoutId, now);
  return { status };
}

/** Una persona firmante reintenta ya el envío de su liquidación firmada que Paycomet no terminó (la tarea diaria también lo hace). */
export async function retryFundPayout(db: KorumPrismaClient, provider: () => Promise<PaymentProvider>, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<{ status: FundExecutionStatus }> {
  const { payoutId } = parseFundPayload(fundPayoutIdSchema, payload);
  await authorizeFundAction(db, actor, organizationId, 'activity_fund.retry', payoutId);
  await reserveFundAttempt(db, actor, organizationId, 'retry', now);
  const { status } = await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { status: true } });
  if (status !== 'APPROVED' && status !== 'PROCESSING' && status !== 'FAILED') throw new ActivityFundError('WRONG_STATUS');
  return { status: (await executeFundPayout(db, await provider(), payoutId, now)).status };
}

/** Mensajes de un reparto que reintentar no arregla (cobro fuera de su ventana o deshecho): lo resuelve el Super-Admin. */
export const BLOCKED_SPLIT_MESSAGES = [DAY_LIMIT_MESSAGE, 'El cobro está en estado'] as const;
const blockedSplit = { status: 'FAILED' as const, OR: BLOCKED_SPLIT_MESSAGES.map((message) => ({ errorMessage: { startsWith: message } })) };

/**
 * Tarea diaria (Sprint 4.2f, auditoría financiera I2 e I3), cada liquidación por separado: el fallo de una se informa y no deja sin tratar a las demás.
 * - Las que tienen las dos firmas pero no se pudieron aprobar al firmar (un error pasajero, el KYB pendiente) se aprueban ahora; las que no tienen las
 *   dos firmas siguen esperando.
 * - Las aprobadas que no terminaron (un rechazo pasajero de Paycomet, o un reparto desconocido ya resuelto) se reanudan. Las que tienen un reparto de
 *   resultado desconocido o bloqueado esperan a que lo resuelva el Super-Admin (alerta `ACTIVITY_FUND_WINDOW`).
 */
export async function resumeFundPayouts(db: Db, provider: PaymentProvider, now: Date, limit: number, signatureSecret?: string): Promise<{ executed: number; pending: number; approved: number; errors: number }> {
  const result = { executed: 0, pending: 0, approved: 0, errors: 0 };
  if (signatureSecret) {
    const waiting = await db.activityFundPayout.findMany({ where: { status: 'PENDING_DOUBLE_CHECK', signatures: { some: {} } }, orderBy: { id: 'asc' }, take: limit, select: { id: true, _count: { select: { signatures: true } } } });
    for (const { id, _count } of waiting) {
      if (_count.signatures < 2) continue;
      try {
        if ((await approveFundPayout(db, id, signatureSecret, now)).approved) result.approved += 1;
      } catch (error) {
        if (!(error instanceof ActivityFundError)) {
          result.errors += 1;
          reportError(error, { stage: 'activity-fund-approve', payoutId: id });
        }
      }
    }
  }
  const open = await db.activityFundPayout.findMany({
    where: { status: { in: ['APPROVED', 'PROCESSING', 'FAILED'] }, splits: { none: { OR: [{ status: 'SENDING' }, blockedSplit] } } },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true }
  });
  for (const { id } of open) {
    try {
      if ((await executeFundPayout(db, provider, id, now)).status === 'EXECUTED') result.executed += 1;
      else result.pending += 1;
    } catch (error) {
      result.errors += 1;
      result.pending += 1;
      reportError(error, { stage: 'activity-fund-resume', payoutId: id });
    }
  }
  return result;
}

/**
 * Resuelve un reparto del Fondo de resultado desconocido, cuando el Super-Admin ya ha comprobado en Paycomet qué pasó: con `splitAuthCode` se hizo; con
 * `null`, no se hizo y vuelve a estar pendiente. Solo si sigue en `SENDING`: dos resoluciones cruzadas no pueden pagar dos veces.
 */
export async function resolveUnknownFundSplit(db: Db, actor: VerifiedSuperadminActor, splitId: number, resolution: { splitAuthCode: string | null }, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'activity_fund.resolve_unknown_split', now);
  const code = resolution.splitAuthCode;
  if (code !== null && code.trim() === '') throw new RangeError('El código de autorización del reparto no puede estar vacío');
  const split = await db.activityFundSplit.findUniqueOrThrow({ where: { id: splitId }, include: { payout: { select: { organizationId: true } } } });
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'activity_fund.resolve_unknown_split', now);
    const applied =
      code !== null
        ? await recordFundSplitDone(tx, split, split.payout.organizationId, code, now)
        : (await tx.activityFundSplit.updateMany({ where: { id: splitId, status: 'SENDING' }, data: { status: 'PENDING', errorMessage: null } })).count === 1;
    if (!applied) throw new ActivityFundError('WRONG_STATUS');
    await tx.auditLog.create({
      data: { actorType: 'USER', actorUserId: actor.userId, organizationId: split.payout.organizationId, action: 'activity_fund.split_resolved', targetType: 'ActivityFundSplit', targetId: String(splitId), metadataJson: { done: code !== null, amountCents: split.amountCents } }
    });
  });
}
