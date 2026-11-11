import { after } from 'next/server';
import { reportError } from '@/lib/error-reporting';
import type { KorumPrismaClient } from '@/lib/prisma';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';

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
