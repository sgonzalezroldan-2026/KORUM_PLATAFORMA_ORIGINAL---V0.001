import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { JobType } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import { redactText } from '@/lib/redact';
import { drainBatches } from './job-drain';
import { JOB_SPECS, retryDelayMs, slotKey } from './job-schedule';
import type { JobDeps, JobHandler } from './job-types';
import { raiseAlert } from './ops-alerts';

/**
 * Procesador de la cola `Job` (QA-OPS01). Cada tipo de tarea tiene una ejecución por hueco de tiempo (`slotKey`): llamar dos veces
 * seguidas dentro del mismo hueco no repite el trabajo. Cada llamada:
 *   1. da de alta la ejecución del hueco actual (idempotente por clave);
 *   2. reclama las ejecuciones vencidas de ese tipo, también reintentos de huecos anteriores y las que se quedaron «en marcha» por
 *      una caída, con una actualización condicional: dos servidores a la vez no ejecutan lo mismo;
 *   3. procesa lotes mientras queden y haya tiempo (`drainBatches`); si falla, espera cada vez más (`retryDelayMs`) y, al agotar `maxAttempts`, queda en `FAILED` y abre una alerta.
 * Quien reclama firma con un testigo propio: si el bloqueo caducó y otro lo tomó, el resultado de la ejecución lenta no lo pisa.
 */

/** Pasado este tiempo, una ejecución «en marcha» se da por perdida y se puede reclamar. */
export const JOB_LOCK_TTL_MS = 15 * 60_000;
/** Cuántas ejecuciones atrasadas de un mismo tipo se atienden en una llamada. */
const MAX_JOBS_PER_CALL = 3;
const MAX_ERROR_LENGTH = 500;
/** Tiempo de una llamada entera (todas sus ejecuciones) antes de dejar de empezar trabajo: la función de Vercel vive 300 s. */
export const CALL_BUDGET_MS = 240_000;

export interface JobExecution {
  key: string;
  outcome: 'DONE' | 'RETRY' | 'FAILED' | 'LOST_LOCK';
  processed: number;
  hasMore: boolean;
  error?: string;
}

export interface RunJobOptions {
  db: Db;
  type: JobType;
  handler: JobHandler;
  deps: JobDeps;
  now?: Date;
  /** Se llama con el error original de cada fallo (para enviarlo a la observabilidad). */
  onError?: (error: unknown, context: { type: JobType; key: string; attempt: number }) => void;
}

const claimable = (now: Date): Prisma.JobWhereInput => ({
  OR: [{ status: 'PENDING', runAt: { lte: now } }, { status: 'RUNNING', lockedAt: { lt: new Date(now.getTime() - JOB_LOCK_TTL_MS) } }]
});

/** El texto del error acaba en `Job.lastError` y en la alerta: se limpia por si el mensaje repite un email, un NIF u otro dato de una persona. */
const describeError = (error: unknown): string => redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, MAX_ERROR_LENGTH);

export async function runJob(options: RunJobOptions): Promise<JobExecution[]> {
  const { db, type, handler, deps, onError } = options;
  const now = options.now ?? new Date();
  const spec = JOB_SPECS[type];
  const deadline = Date.now() + CALL_BUDGET_MS;

  await db.job.createMany({ data: [{ idempotencyKey: slotKey(type, now), type, payloadJson: {}, runAt: now }], skipDuplicates: true });
  const due = await db.job.findMany({ where: { type, ...claimable(now) }, orderBy: { runAt: 'asc' }, take: MAX_JOBS_PER_CALL, select: { id: true } });

  const executions: JobExecution[] = [];
  for (const { id } of due) {
    // Una ejecución atrasada que no cabe en el tiempo de esta llamada espera a la siguiente.
    if (Date.now() > deadline && executions.length > 0) break;
    const token = `cron:${randomUUID()}`;
    const { count } = await db.job.updateMany({ where: { id, ...claimable(now) }, data: { status: 'RUNNING', lockedAt: now, lockedBy: token, attempts: { increment: 1 } } });
    if (count !== 1) continue;
    const job = await db.job.findUniqueOrThrow({ where: { id }, select: { idempotencyKey: true, attempts: true, maxAttempts: true } });

    try {
      const result = await drainBatches(() => handler({ db, now, batchSize: spec.batchSize, deps, deadline }), deadline);
      const { count: finished } = await db.job.updateMany({
        where: { id, status: 'RUNNING', lockedBy: token },
        data: { status: 'DONE', lockedAt: null, lockedBy: null, lastError: null, payloadJson: { processed: result.processed, hasMore: result.hasMore, ...result.detail } }
      });
      if (finished !== 1) {
        executions.push({ key: job.idempotencyKey, outcome: 'LOST_LOCK', processed: result.processed, hasMore: result.hasMore });
        continue;
      }
      if (result.processed > 0) await db.auditLog.create({ data: { actorType: 'SYSTEM', action: 'job.completed', targetType: 'Job', targetId: String(id), metadataJson: { type, processed: result.processed, hasMore: result.hasMore, ...result.detail } } });
      executions.push({ key: job.idempotencyKey, outcome: 'DONE', processed: result.processed, hasMore: result.hasMore });
    } catch (error) {
      onError?.(error, { type, key: job.idempotencyKey, attempt: job.attempts });
      executions.push(await recordFailure(db, { id, token, key: job.idempotencyKey, type, attempts: job.attempts, maxAttempts: job.maxAttempts, error: describeError(error) }, now));
    }
  }
  return executions;
}

interface FailureInput {
  id: number;
  token: string;
  key: string;
  type: JobType;
  attempts: number;
  maxAttempts: number;
  error: string;
}

async function recordFailure(db: Db, input: FailureInput, now: Date): Promise<JobExecution> {
  const { id, token, key, type, attempts, maxAttempts, error } = input;
  const exhausted = attempts >= maxAttempts;
  const { count } = await db.job.updateMany({
    where: { id, status: 'RUNNING', lockedBy: token },
    data: exhausted ? { status: 'FAILED', lockedAt: null, lockedBy: null, lastError: error } : { status: 'PENDING', lockedAt: null, lockedBy: null, lastError: error, runAt: new Date(now.getTime() + retryDelayMs(attempts)) }
  });
  if (count !== 1) return { key, outcome: 'LOST_LOCK', processed: 0, hasMore: false, error };
  if (!exhausted) return { key, outcome: 'RETRY', processed: 0, hasMore: false, error };
  await raiseAlert(db, { type: 'JOB_FAILED', severity: 'CRITICAL', dedupeKey: `JOB_FAILED:${key}`, targetType: 'Job', targetId: String(id), detail: { jobType: type, key, attempts, lastError: error } }, now);
  await db.auditLog.create({ data: { actorType: 'SYSTEM', action: 'job.failed', targetType: 'Job', targetId: String(id), metadataJson: { type, key, attempts } } });
  return { key, outcome: 'FAILED', processed: 0, hasMore: false, error };
}
