import { dataHmac } from '@/core/security/data-hmac';
import { signEventRefundToken } from '@/core/ticketing/event-schedule-rules';
import { inTransaction, type Db } from '@/lib/db';
import { DONOR_RECIPIENT_SELECT, donorRecipient } from './donor-recipient';

/**
 * Aviso de un cambio de fecha a quien compró entradas (Sprint 5.13, decisión 30; plantilla `event.rescheduledBuyer`). Como los avisos a quienes donan
 * (`supporter-broadcast.ts`), no cabe en la transacción del cambio: queda la fila del cambio (`EventReschedule`) y esto la reparte por lotes desde su cursor.
 *
 * - A cada persona que compró **antes** del cambio (empezó a comprar antes; si terminaba de pagar en ese momento, le llega al completar el pago), una vez por cambio aunque comprara varias veces: la clave de la bandeja lleva el
 *   HMAC de su email canónico.
 * - El mensaje lleva su enlace personal de devolución (firmado con el cambio y una de sus compras; campo secreto de la bandeja), que vale hasta el final de
 *   los 14 días. Desde él recupera el 100 % de todas sus entradas de antes del cambio que no se hayan usado.
 * - El reparto sigue abierto hasta el final del plazo, para quien termine de pagar después del cambio. Se cierra, o se descarta, cuando el plazo terminó, el evento se canceló o se liquidó, o hubo después **otro** cambio de fecha (que lleva su
 *   propio aviso y su propio plazo).
 */

export const EVENT_RESCHEDULED_TEMPLATE = 'event.rescheduledBuyer';

interface NoticeRun {
  now: Date;
  batchSize: number;
  deadline?: number;
  hmacSecret: string;
}

const LIVE_STATUSES = new Set(['FUNDRAISING', 'GOAL_REACHED']);

async function advance(db: Db, rescheduleId: number, run: NoticeRun): Promise<{ queued: number; done: boolean }> {
  return inTransaction(db, async (tx) => {
    // Bloquea la fila: dos ejecuciones a la vez no tratan el mismo lote (y aunque lo hicieran, la clave de la bandeja no lo duplicaría).
    const reschedule = await tx.eventReschedule.update({
      where: { id: rescheduleId },
      data: { cursorId: { increment: 0 } },
      select: { id: true, initiativeId: true, previousDate: true, newDate: true, refundUntil: true, createdAt: true, cursorId: true, noticesCompletedAt: true }
    });
    if (reschedule.noticesCompletedAt) return { queued: 0, done: true };
    const initiative = await tx.initiative.findUniqueOrThrow({ where: { id: reschedule.initiativeId }, select: { id: true, organizationId: true, walletEscrowId: true, status: true, payout: { select: { status: true } } } });
    const newer = await tx.eventReschedule.count({ where: { initiativeId: reschedule.initiativeId, id: { gt: reschedule.id } } });
    const settled = initiative.payout !== null && initiative.payout.status !== 'PENDING_DOUBLE_CHECK';
    if (newer > 0 || settled || !LIVE_STATUSES.has(initiative.status) || reschedule.refundUntil <= run.now) {
      await tx.eventReschedule.update({ where: { id: reschedule.id }, data: { noticesCompletedAt: run.now } });
      return { queued: 0, done: true };
    }
    const where = { initiativeId: reschedule.initiativeId, type: 'TICKET' as const, status: 'COMPLETED' as const, createdAt: { lte: reschedule.createdAt } };
    const rows = await tx.contribution.findMany({ where: { ...where, id: { gt: reschedule.cursorId } }, orderBy: { id: 'asc' }, take: run.batchSize, select: { id: true, locale: true, ...DONOR_RECIPIENT_SELECT } });
    const done = rows.length < run.batchSize;
    // Quien estaba pagando al cambiar la fecha termina después y su compra puede quedar por debajo del cursor: al acabar cada vuelta se miran las compras de
    // antes del cambio cuyo pase se emitió después (`issuedAt`, la hora de proceso; la del banco puede ser anterior). La clave de la bandeja evita avisar dos veces. Por eso el reparto sigue abierto hasta el final del
    // plazo, que lo cierra arriba (auditorías de seguridad del 5.13).
    // Por páginas, hasta el final: son pocas (las que estaban pagando al cambiar la fecha), pero ninguna se puede quedar sin su enlace (auditoría financiera del 5.13).
    const late: typeof rows = [];
    for (let after = 0; done; ) {
      const page = await tx.contribution.findMany({ where: { ...where, ticketPass: { issuedAt: { gt: reschedule.createdAt } }, id: { gt: after } }, orderBy: { id: 'asc' }, take: run.batchSize, select: { id: true, locale: true, ...DONOR_RECIPIENT_SELECT } });
      late.push(...page);
      const lastLate = page[page.length - 1];
      if (!lastLate || page.length < run.batchSize) break;
      after = lastLate.id;
    }
    const data = [...rows, ...late].flatMap((row) => {
      const recipient = donorRecipient(row);
      if (!recipient) return [];
      return [
        {
          idempotencyKey: `${EVENT_RESCHEDULED_TEMPLATE}:${reschedule.id}:${dataHmac(run.hmacSecret, 'supporter-notice', recipient.canonical)}`,
          templateKey: EVENT_RESCHEDULED_TEMPLATE,
          locale: row.locale,
          toAddress: recipient.toAddress,
          organizationId: initiative.organizationId,
          payloadJson: {
            initiativeId: initiative.id,
            walletEscrowId: initiative.walletEscrowId,
            rescheduleId: reschedule.id,
            previousDate: reschedule.previousDate.toISOString(),
            newDate: reschedule.newDate.toISOString(),
            refundUntil: reschedule.refundUntil.toISOString(),
            // Sin `expiresAt`, la bandeja daría el enlace por caducado a la hora: vale hasta el final del plazo.
            expiresAt: reschedule.refundUntil.toISOString(),
            refundToken: signEventRefundToken(run.hmacSecret, reschedule.id, row.id)
          }
        }
      ];
    });
    const { count } = data.length > 0 ? await tx.outboxMessage.createMany({ data, skipDuplicates: true }) : { count: 0 };
    const last = rows[rows.length - 1];
    await tx.eventReschedule.update({ where: { id: reschedule.id }, data: { cursorId: last?.id ?? reschedule.cursorId, queuedCount: { increment: count } } });
    return { queued: count, done };
  });
}

/** Parte de la tarea `SUPPORTER_BROADCAST`: recorre los cambios de fecha con avisos pendientes, el más antiguo primero, hasta acabarlos o hasta el límite de tiempo. */
export async function runRescheduleNotices(db: Db, run: NoticeRun): Promise<{ processed: number; queued: number; hasMore: boolean }> {
  let processed = 0;
  let queued = 0;
  let cursor = 0;
  for (;;) {
    const page = await db.eventReschedule.findMany({ where: { noticesCompletedAt: null, id: { gt: cursor } }, orderBy: { id: 'asc' }, take: 50, select: { id: true } });
    for (const { id } of page) {
      for (;;) {
        if (run.deadline !== undefined && Date.now() > run.deadline) return { processed, queued, hasMore: true };
        const step = await advance(db, id, run);
        queued += step.queued;
        if (step.done) break;
      }
      processed += 1;
    }
    const last = page[page.length - 1];
    if (!last || page.length < 50) return { processed, queued, hasMore: false };
    cursor = last.id;
  }
}

/** Reparte ya, sin esperar a la tarea, el aviso de un cambio de fecha (el plazo es de 14 días y la tarea puede correr una vez al día). Lo que falte sigue en la tarea. */
export async function advanceRescheduleNoticesNow(db: Db, rescheduleId: number, run: NoticeRun): Promise<number> {
  let queued = 0;
  for (;;) {
    if (run.deadline !== undefined && Date.now() > run.deadline) return queued;
    const step = await advance(db, rescheduleId, run);
    queued += step.queued;
    if (step.done) return queued;
  }
}
