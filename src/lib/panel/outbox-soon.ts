import { after } from 'next/server';
import { reportError } from '@/lib/error-reporting';
import type { KorumPrismaClient } from '@/lib/prisma';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { advanceSupporterBroadcastNow, type SupporterTemplate } from '@/services/notifications/supporter-broadcast';

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
