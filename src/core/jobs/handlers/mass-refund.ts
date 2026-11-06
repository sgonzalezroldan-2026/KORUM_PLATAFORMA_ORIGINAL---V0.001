import { getAccountBalance } from '@/core/finance/ledger-balances';
import { releaseInitiativeQuotas } from '@/core/finance/quota-reservation';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction, type Db } from '@/lib/db';
import { refundContribution, RefundNotAllowedError } from '@/services/payments/payment-reversals';
import { retryDelayMs } from '../job-schedule';
import type { JobHandler } from '../job-types';
import { raiseAlert, resolveAlert, resolveAlertsNotIn } from '../ops-alerts';

/**
 * `MASS_REFUND`: devuelve el 100 % de lo cobrado, al medio de pago original, en lotes idempotentes (QA-OPS01, QA-P02). Recoge:
 *   - todo `REFUND_PENDING` sin devolución en curso, también los cobros tardíos que llegaron a una campaña ya cerrada;
 *   - las donaciones y entradas `COMPLETED` de iniciativas en `REFUNDING` o `CANCELLED`.
 * Los patrocinios no se devuelven aquí (se reasignan, Regla 02 §5). Un resultado desconocido no se reintenta: lo resuelve una persona.
 *
 * Una devolución **rechazada por Paycomet** se reintenta con espera creciente en múltiplos del intervalo de la tarea (10, 20, 40 y 80 min entre los 5
 * intentos, unas 2,5 horas en total; como la tarea corre cada 10 min con unos segundos de variación, una espera puede alargarse hasta el siguiente
 * hueco, nunca acortarse). Cada fallo cuenta en su alerta y con `MAX_REFUND_ATTEMPTS` se deja en la consola sin volver a intentarlo hasta que una persona
 * la reactive (`reactivateRejectedRefund`). Un fallo interno de una aportación concreta también cuenta como intento suyo (así una sola aportación
 * rota se aparta tras 5 y no hace fallar la tarea para siempre); la tarea solo falla si **ninguna** avanzó, que apunta a un problema general
 * (base de datos caída). Los fallos de configuración (IP del servidor) ocurren antes de empezar y no gastan intentos de nadie. Al quedar una iniciativa `REFUNDING` sin nada pendiente, pasa a `REFUNDED` y libera sus cupos.
 */

export const MAX_REFUND_ATTEMPTS = 5;
/** La espera entre intentos de una devolución parte del intervalo de la tarea (10 min): una menor se cumpliría siempre y no esperaría nada. */
export const REFUND_RETRY_BASE_MS = 10 * 60_000;
/** Una devolución reservada hace más de esto sin resolverse se avisa: una caída entre la reserva y la llamada la deja así para siempre. */
export const STUCK_REFUND_AFTER_MS = 2 * 3_600_000;
/** Pasado este tiempo de ejecución no se empiezan más devoluciones: la función de Vercel tiene un límite y cortar una a medias deja la reserva puesta. */
export const REFUND_TIME_BUDGET_MS = 240_000;
const FETCH_FACTOR = 4;
const REFUNDABLE_TYPES = ['DONATION', 'TICKET'] as const;
const rejectedKey = (contributionId: number) => `REFUND_REJECTED:${contributionId}`;

async function loadCandidates(db: Db, limit: number, excludedIds: number[]): Promise<number[]> {
  const exclude = excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {};
  const pending = await db.contribution.findMany({
    where: { ...exclude, status: 'REFUND_PENDING', refundSendingAt: null, type: { in: [...REFUNDABLE_TYPES] }, paycometOrder: { not: null } },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true }
  });
  const room = limit - pending.length;
  if (room <= 0) return pending.map((row) => row.id);
  const approvable = await db.contribution.findMany({
    where: { ...exclude, status: 'COMPLETED', type: { in: [...REFUNDABLE_TYPES] }, initiative: { status: { in: ['REFUNDING', 'CANCELLED'] } } },
    orderBy: { id: 'asc' },
    take: room,
    select: { id: true }
  });
  return [...pending, ...approvable].map((row) => row.id);
}

async function flagStuckReservations(db: Db, now: Date): Promise<number> {
  // Normalmente hay pocas con la reserva puesta (solo las que están a mitad de llamada o sin resolver), así que se leen todas.
  const reserved = await db.contribution.findMany({
    where: { status: 'REFUND_PENDING', refundSendingAt: { not: null } },
    select: { id: true, organizationId: true, initiativeId: true, totalChargedCents: true, refundSendingAt: true }
  });
  const limit = now.getTime() - STUCK_REFUND_AFTER_MS;
  const stuck = reserved.filter((row) => row.refundSendingAt !== null && row.refundSendingAt.getTime() < limit);
  for (const row of stuck) {
    await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: `REFUND_STUCK:${row.id}`, organizationId: row.organizationId, targetType: 'Contribution', targetId: String(row.id), detail: { initiativeId: row.initiativeId, amountCents: row.totalChargedCents, reservedAt: row.refundSendingAt?.toISOString() ?? null } }, now);
  }
  // Las alertas de las que ya se resolvieron (la reserva se liberó o se devolvió) se cierran solas.
  await resolveAlertsNotIn(db, 'REFUND_STUCK', reserved.map((row) => `REFUND_STUCK:${row.id}`), now);
  return stuck.length;
}

/** Cierra las alertas de rechazo de devoluciones que ya no están pendientes: se hicieron por otra vía (el panel de Paycomet, su notificación). */
async function closeSettledRejections(db: Db, now: Date): Promise<void> {
  const open = await db.opsAlert.findMany({ where: { type: 'REFUND_REJECTED', status: 'OPEN' }, select: { targetId: true }, take: 1_000 });
  const ids = open.flatMap((alert) => (alert.targetId ? [Number(alert.targetId)] : []));
  if (ids.length === 0) return;
  // «Sigue pendiente» incluye `COMPLETED`: una aportación cuyo reembolso ni siquiera llegó a aprobarse (fallo interno) sigue por devolver, y cerrar
  // su alerta borraría el recuento de intentos y la volvería a intentar sin fin.
  const stillPending = new Set((await db.contribution.findMany({ where: { id: { in: ids }, status: { in: ['REFUND_PENDING', 'COMPLETED'] } }, select: { id: true } })).map((row) => row.id));
  for (const id of ids) if (!stillPending.has(id)) await resolveAlert(db, rejectedKey(id), now);
}

/** Cierra las iniciativas `REFUNDING` sin nada que devolver: `REFUNDED` y cupos de vuelta. Si en su hucha queda dinero (patrocinio, Auto-Impulso), avisa. */
async function closeFinishedRefunds(db: Db, limit: number, now: Date): Promise<number> {
  const nothingToRefund = { none: { OR: [{ status: 'REFUND_PENDING' as const }, { status: 'COMPLETED' as const, type: { in: [...REFUNDABLE_TYPES] } }] } };
  const finished = await db.initiative.findMany({ where: { status: 'REFUNDING', contributions: nothingToRefund }, take: limit, select: { id: true } });
  let closed = 0;
  for (const { id } of finished) {
    const done = await inTransaction(db, async (tx) => {
      await tx.initiative.updateMany({ where: { id }, data: { ticketsHeld: { increment: 0 } } });
      const { count } = await tx.initiative.updateMany({ where: { id, status: 'REFUNDING', contributions: nothingToRefund }, data: { status: 'REFUNDED' } });
      if (count !== 1) return false;
      await releaseInitiativeQuotas(tx, id);
      const initiative = await tx.initiative.findUniqueOrThrow({ where: { id }, select: { organizationId: true } });
      await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: initiative.organizationId, action: 'initiative.refunded', targetType: 'Initiative', targetId: String(id), metadataJson: {} } });
      // Un patrocinio o un Auto-Impulso no se devuelven con esta tarea y siguen en la hucha: que nadie lo pierda de vista. Se avisa en la misma
      // transacción que el cierre, para que no pueda quedar cerrada sin el aviso.
      const { balanceCents } = await getAccountBalance(tx, 'INITIATIVE_ESCROW', { initiativeId: id });
      if (balanceCents > 0) {
        await raiseAlert(tx, { type: 'ESCROW_LEFTOVER', severity: 'CRITICAL', dedupeKey: `ESCROW_LEFTOVER:${id}`, organizationId: initiative.organizationId, targetType: 'Initiative', targetId: String(id), detail: { balanceCents } }, now);
      }
      return true;
    });
    if (done) closed += 1;
  }
  return closed;
}

export const massRefundHandler: JobHandler = async ({ db, now, batchSize, deps, deadline: callDeadline }) => {
  const exhausted = await db.opsAlert.findMany({ where: { type: 'REFUND_REJECTED', status: 'OPEN', occurrences: { gte: MAX_REFUND_ATTEMPTS } }, select: { targetId: true } });
  const exhaustedIds = exhausted.flatMap((alert) => (alert.targetId ? [Number(alert.targetId)] : []));
  const fetched = await loadCandidates(db, batchSize * FETCH_FACTOR, exhaustedIds);

  // Las que esperan su turno se apartan antes de recortar el lote: no deben ocupar los huecos de las que sí toca devolver.
  const waiting = await db.opsAlert.findMany({ where: { dedupeKey: { in: fetched.map(rejectedKey) }, status: 'OPEN' }, select: { targetId: true, occurrences: true, lastSeenAt: true } });
  const waitingUntil = new Map(waiting.map((alert) => [Number(alert.targetId), alert.lastSeenAt.getTime() + retryDelayMs(Math.max(1, alert.occurrences), REFUND_RETRY_BASE_MS)]));
  const due = fetched.filter((id) => (waitingUntil.get(id) ?? 0) <= now.getTime());
  const batch = due.slice(0, batchSize);

  const counts = { refunded: 0, rejected: 0, unknown: 0, inProgress: 0, notAllowed: 0, waiting: fetched.length - due.length, failed: 0 };
  const failures: unknown[] = [];
  const deadline = callDeadline ?? Date.now() + REFUND_TIME_BUDGET_MS;
  let started = 0;
  if (batch.length > 0) {
    // Antes de empezar: sin la IP del servidor (sandbox o live sin configurar) la tarea falla entera y no gasta intentos de ninguna devolución.
    const originalIp = await deps.refundOriginalIp();
    const provider = await deps.paymentProvider();
    for (const id of batch) {
      if (Date.now() > deadline) break;
      started += 1;
      try {
        const result = await refundContribution(db, provider, id, originalIp, now);
        if (result.outcome === 'REFUNDED' || result.outcome === 'ALREADY_REFUNDED') {
          counts.refunded += 1;
          await resolveAlert(db, rejectedKey(id), now);
        } else if (result.outcome === 'IN_PROGRESS') counts.inProgress += 1;
        else if (result.outcome === 'UNKNOWN') {
          counts.unknown += 1;
          await flagUnknown(db, id, result.code ?? 'UNKNOWN', now);
        } else {
          counts.rejected += 1;
          await flagRejected(db, id, result.code ?? 'REJECTED', now);
        }
      } catch (error) {
        // Solo un rechazo definitivo (o una aportación que no se puede devolver) cuenta como intento. Un fallo propio se relanza al final.
        if (error instanceof RefundNotAllowedError) counts.notAllowed += 1;
        else {
          counts.failed += 1;
          failures.push(error);
        }
        // Que no se pueda ni anotar el fallo (base de datos caída) no debe cortar el resto del lote.
        await flagRejected(db, id, error instanceof Error ? error.name : 'ERROR', now).catch(() => undefined);
      }
    }
  }
  const stuck = await flagStuckReservations(db, now);
  await closeSettledRejections(db, now);
  const closed = await closeFinishedRefunds(db, batchSize, now);
  // Si alguna avanzó, el fallo de otra es cosa suya (ya cuenta como intento de esa aportación). Si ninguna avanzó, apunta a algo general: la tarea falla y se reintenta.
  const progressed = counts.refunded + counts.rejected + counts.unknown + counts.inProgress + counts.notAllowed;
  const firstFailure = failures[0];
  if (firstFailure !== undefined && progressed === 0) throw firstFailure;
  return { processed: started, hasMore: due.length > started || fetched.length >= batchSize * FETCH_FACTOR, detail: { ...counts, stuck, closed } };
};

/**
 * Vuelve a dar a una devolución agotada sus intentos (lo decide una persona, p. ej. tras arreglar algo con Paycomet). Queda en la auditoría.
 * Solo un Super-Admin verificado puede hacerlo (`VerifiedSuperadminActor`, emitido por la capa de sesión).
 */
export async function reactivateRejectedRefund(db: Db, actor: VerifiedSuperadminActor, contributionId: number, now: Date = new Date()): Promise<boolean> {
  assertVerifiedSuperadmin(actor, 'payment.reactivate_refund', now);
  return inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'payment.reactivate_refund', now);
    const contribution = await tx.contribution.findUniqueOrThrow({ where: { id: contributionId }, select: { organizationId: true } });
    const { count } = await tx.opsAlert.updateMany({ where: { dedupeKey: rejectedKey(contributionId), status: 'OPEN' }, data: { occurrences: 0, lastSeenAt: new Date(now.getTime() - 24 * 3_600_000) } });
    if (count === 0) return false;
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: actor.userId, organizationId: contribution.organizationId, action: 'payment.refund_reactivated', targetType: 'Contribution', targetId: String(contributionId), metadataJson: {} } });
    return true;
  });
}

async function contributionScope(db: Db, id: number) {
  return db.contribution.findUniqueOrThrow({ where: { id }, select: { organizationId: true, initiativeId: true, totalChargedCents: true } });
}

async function flagRejected(db: Db, id: number, code: string, now: Date): Promise<void> {
  const row = await contributionScope(db, id);
  await raiseAlert(db, { type: 'REFUND_REJECTED', severity: 'WARNING', dedupeKey: rejectedKey(id), organizationId: row.organizationId, targetType: 'Contribution', targetId: String(id), detail: { initiativeId: row.initiativeId, amountCents: row.totalChargedCents, code } }, now);
}

async function flagUnknown(db: Db, id: number, code: string, now: Date): Promise<void> {
  const row = await contributionScope(db, id);
  await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: `REFUND_STUCK:${id}`, organizationId: row.organizationId, targetType: 'Contribution', targetId: String(id), detail: { initiativeId: row.initiativeId, amountCents: row.totalChargedCents, code, unknown: true } }, now);
}
