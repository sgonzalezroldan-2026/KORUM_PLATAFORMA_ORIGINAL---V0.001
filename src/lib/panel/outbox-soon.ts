import { after } from 'next/server';
import { reportError } from '@/lib/error-reporting';
import { revalidatePortalAfterPayout } from '@/lib/portal/revalidate-portal';
import type { KorumPrismaClient } from '@/lib/prisma';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { advanceRescheduleNoticesNow, EVENT_RESCHEDULED_TEMPLATE } from '@/services/notifications/event-reschedule-notices';
import { advanceSupporterBroadcastNow, type SupporterTemplate } from '@/services/notifications/supporter-broadcast';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { executePendingRefund } from '@/services/payments/payment-reversals';
import { approveCancelledVoucherRefunds, executePendingPartialRefunds } from '@/services/ticketing/voucher-cancel-refunds';

/**
 * Envía ya, después de responder (`after()`), unos mensajes concretos de la bandeja de salida: un enlace de firma o el aviso de una liquidación hecha no
 * esperan a la tarea de la bandeja (que en el plan gratuito de Vercel corre una vez al día). Si falla, la tarea los enviará igualmente.
 */
export function dispatchOutboxSoon(db: KorumPrismaClient, ids: readonly number[], stage: string): void {
  if (ids.length === 0) return;
  after(() =>
    dispatchOutbox(db, buildOutboxDeps(db), { ids: [...ids], limit: ids.length })
      .then(() => undefined)
      .catch((error: unknown) => reportError(error, { stage }))
  );
}

/** «Liquidación hecha» (`payout.executed`) a quienes firman, al momento (Sprint 4.4a). */
export async function dispatchPayoutExecutedSoon(db: KorumPrismaClient, payoutId: number): Promise<void> {
  const rows = await db.outboxMessage.findMany({ where: { templateKey: 'payout.executed', status: 'PENDING', idempotencyKey: { startsWith: `payout.executed:payout:${payoutId}:` } }, select: { id: true }, take: 4 });
  dispatchOutboxSoon(db, rows.map((row) => row.id), 'outbox-after-campaign-payout');
}

/**
 * Lo que se hace justo después de enviar una liquidación: avisar a quienes firman y regenerar el portal (la campaña pasa a «Logros conseguidos»). El dinero
 * ya ha salido: si algo de esto falla se anota y **no se devuelve un error a quien firma** (auditoría financiera del Sprint 5.6); el aviso lo enviará la tarea
 * de la bandeja y la página se regenera sola a los 60 segundos.
 */
export async function afterPayoutExecuted(db: KorumPrismaClient, payoutId: number): Promise<void> {
  try {
    await dispatchPayoutExecutedSoon(db, payoutId);
    await revalidatePortalAfterPayout(db, payoutId);
  } catch (error) {
    reportError(error, { stage: 'after-payout-executed', payoutId });
  }
}

/** Mensajes que se envían al momento tras repartir una difusión: los primeros; el resto, con la tarea de la bandeja. */
const BROADCAST_SOON_LIMIT = 100;
const BROADCAST_SOON_BUDGET_MS = 15_000;

/**
 * Reparte y envía ya, después de responder, el aviso a quienes donaron a una iniciativa (Sprint 4.4b: la votación de 7 días no puede perder uno esperando a
 * la tarea diaria del plan gratuito). Si falla o no termina, las tareas `SUPPORTER_BROADCAST` y `OUTBOX_DISPATCH` lo completan sin repetir a nadie.
 */
export function dispatchSupporterBroadcastSoon(db: KorumPrismaClient, hmacSecret: string, initiativeId: number, templateKey: SupporterTemplate): void {
  after(async () => {
    try {
      const now = new Date();
      await advanceSupporterBroadcastNow(db, initiativeId, templateKey, { now, batchSize: 200, deadline: Date.now() + BROADCAST_SOON_BUDGET_MS, hmacSecret });
      const rows = await db.outboxMessage.findMany({ where: { templateKey, status: 'PENDING', idempotencyKey: { startsWith: `${templateKey}:${initiativeId}:` } }, orderBy: { id: 'asc' }, select: { id: true }, take: BROADCAST_SOON_LIMIT });
      if (rows.length > 0) await dispatchOutbox(db, buildOutboxDeps(db), { ids: rows.map((row) => row.id), limit: rows.length });
    } catch (error) {
      reportError(error, { stage: 'supporter-broadcast-soon' });
    }
  });
}

/**
 * Reparte y envía ya, después de responder, el aviso de un cambio de fecha a quienes compraron (Sprint 5.13): el enlace de devolución dura 14 días y no debe
 * esperar a la tarea diaria. Si falla o no termina, `SUPPORTER_BROADCAST` y `OUTBOX_DISPATCH` lo completan sin repetir a nadie.
 */
export function dispatchRescheduleNoticesSoon(db: KorumPrismaClient, hmacSecret: string, rescheduleId: number): void {
  after(async () => {
    try {
      await advanceRescheduleNoticesNow(db, rescheduleId, { now: new Date(), batchSize: 200, deadline: Date.now() + BROADCAST_SOON_BUDGET_MS, hmacSecret });
      const rows = await db.outboxMessage.findMany({ where: { templateKey: EVENT_RESCHEDULED_TEMPLATE, status: 'PENDING', idempotencyKey: { startsWith: `${EVENT_RESCHEDULED_TEMPLATE}:${rescheduleId}:` } }, orderBy: { id: 'asc' }, select: { id: true }, take: BROADCAST_SOON_LIMIT });
      if (rows.length > 0) await dispatchOutbox(db, buildOutboxDeps(db), { ids: rows.map((row) => row.id), limit: rows.length });
    } catch (error) {
      reportError(error, { stage: 'reschedule-notices-soon' });
    }
  });
}

const VOUCHER_REFUNDS_SOON_BUDGET_MS = 20_000;

/**
 * Venta de vales cancelada antes de liquidarla (Sprint 5.14c, decisión 69): después de responder, aprueba y envía las devoluciones de lo no gastado y los avisos a
 * quienes compraron, sin esperar a la tarea diaria. Lo que no dé tiempo lo completa `MASS_REFUND` sin repetir nada.
 */
export function dispatchVoucherCancelRefundsSoon(db: KorumPrismaClient, hmacSecret: string, initiativeId: number): void {
  after(async () => {
    const deadline = Date.now() + VOUCHER_REFUNDS_SOON_BUDGET_MS;
    try {
      const now = new Date();
      await approveCancelledVoucherRefunds(db, { now, batchSize: 100, hmacSecret, deadline, initiativeId });
      const deps = buildJobDeps(db);
      const provider = await deps.paymentProvider();
      const originalIp = await deps.refundOriginalIp();
      const pending = await db.contribution.findMany({ where: { initiativeId, status: 'REFUND_PENDING', refundSendingAt: null }, orderBy: { id: 'asc' }, take: 100, select: { id: true } });
      for (const { id } of pending) {
        if (Date.now() > deadline) break;
        await executePendingRefund(db, provider, id, originalIp, now);
      }
      if (Date.now() <= deadline) await executePendingPartialRefunds(db, provider, originalIp, { now, batchSize: 100, deadline, initiativeId });
      const rows = await db.outboxMessage.findMany({ where: { status: 'PENDING', OR: [{ idempotencyKey: { startsWith: `voucher.cancelledBuyer:${initiativeId}:` } }, { templateKey: 'refund.issued', payloadJson: { path: ['initiativeId'], equals: initiativeId } }] }, orderBy: { id: 'asc' }, take: BROADCAST_SOON_LIMIT, select: { id: true } });
      if (rows.length > 0) await dispatchOutbox(db, buildOutboxDeps(db), { ids: rows.map((row) => row.id), limit: rows.length });
    } catch (error) {
      reportError(error, { stage: 'voucher-cancel-refunds-soon', initiativeId });
    }
  });
}
