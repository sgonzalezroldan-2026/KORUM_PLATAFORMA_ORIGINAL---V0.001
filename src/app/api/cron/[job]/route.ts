import { createHash, timingSafeEqual } from 'node:crypto';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { JOB_HANDLERS } from '@/core/jobs/job-registry';
import { runJob } from '@/core/jobs/job-runner';
import { jobTypeFromSlug } from '@/core/jobs/job-schedule';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';

/**
 * Tareas programadas (`/api/cron/<tarea>`). Vercel Cron llama por `GET` con `Authorization: Bearer <CRON_SECRET>`. Sin ese secreto, o con
 * uno distinto, responde `401` **antes** de tocar la base de datos o el entorno (QA-OPS01). La respuesta solo lleva recuentos y claves
 * técnicas de cada ejecución, nunca datos de personas.
 */

/** Segundos que Vercel deja vivir a la función. `MASS_REFUND` deja de empezar devoluciones a los 240 s (`REFUND_TIME_BUDGET_MS`) para terminar antes. */
export const maxDuration = 300;

const digest = (value: string) => createHash('sha256').update(value).digest();

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization');
  if (!secret || secret.length < 32 || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export async function GET(request: Request, context: { params: Promise<{ job: string }> }): Promise<Response> {
  if (!isAuthorized(request)) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });

  const { job } = await context.params;
  const type = jobTypeFromSlug(job);
  const handler = type ? JOB_HANDLERS[type] : undefined;
  if (!type || !handler) return new Response(null, { status: 404 });

  const db = getPrisma();
  const executions = await runJob({
    db,
    type,
    handler,
    deps: buildJobDeps(db),
    onError: (error, failure) => reportError(error, { job: failure.type, attempt: failure.attempt })
  });
  return Response.json({ job: type, executions: executions.map(({ key, outcome, processed, hasMore }) => ({ key, outcome, processed, hasMore })) }, { headers: { 'Cache-Control': 'no-store' } });
}
