import type { JobType } from '@/generated/prisma/enums';

/**
 * Calendario de las tareas programadas (DECISIONES_TECNICAS §7). Funciones puras: el procesador y las rutas las usan, y `vercel.json`
 * se comprueba contra `JOB_SPECS` en un test, así que el calendario no puede divergir de lo que el código sabe ejecutar.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Plan de Vercel del despliegue. Hoy se usa el gratuito (Hobby): solo admite tareas **una vez al día**, con ±59 min de imprecisión, y
 * rechaza el despliegue si una expresión corre más a menudo. `cron` es la expresión desplegada hoy; `proCron`, la frecuencia buscada
 * en el plan Pro. Pasar a Pro = poner `VERCEL_PLAN = 'pro'`, copiar `proCron` en `cron` y regenerar `vercel.json` (un test comprueba que
 * coinciden y que, con `hobby`, ninguna expresión corre más de una vez al día). `slotMs` no cambia: es el hueco de idempotencia.
 */
export const VERCEL_PLAN: 'hobby' | 'pro' = 'hobby';

export interface JobSpec {
  /** Nombre en la URL: `/api/cron/<slug>`. */
  slug: string;
  /** Un hueco de tiempo = una ejecución. Una segunda llamada dentro del mismo hueco no hace nada. */
  slotMs: number;
  /** Expresión de Vercel Cron (UTC) desplegada hoy en `vercel.json`. */
  cron: string;
  /** Expresión que se usará al pasar al plan Pro de Vercel. */
  proCron: string;
  /** Registros que procesa cada ejecución: lo que sobra lo recoge la siguiente. */
  batchSize: number;
}

export const JOB_SPECS: Record<JobType, JobSpec> = {
  OUTBOX_DISPATCH: { slug: 'outbox-dispatch', slotMs: MINUTE_MS, cron: '0 2 * * *', proCron: '* * * * *', batchSize: 50 },
  MASS_REFUND: { slug: 'mass-refund', slotMs: 10 * MINUTE_MS, cron: '30 5 * * *', proCron: '*/10 * * * *', batchSize: 25 },
  TICKET_HOLD_RELEASE: { slug: 'ticket-hold-release', slotMs: 10 * MINUTE_MS, cron: '45 5 * * *', proCron: '5-55/10 * * * *', batchSize: 100 },
  INVOICE_SUBMIT: { slug: 'invoice-submit', slotMs: 10 * MINUTE_MS, cron: '50 5 * * *', proCron: '2-52/10 * * * *', batchSize: 20 },
  CAMPAIGN_EXPIRY: { slug: 'campaign-expiry', slotMs: HOUR_MS, cron: '0 5 * * *', proCron: '0 * * * *', batchSize: 100 },
  MONTHLY_TOPUP: { slug: 'monthly-topup', slotMs: DAY_MS, cron: '0 7 * * *', proCron: '0 7 * * *', batchSize: 100 },
  SPONSOR_RENEWAL_NOTICE: { slug: 'sponsor-renewal-notice', slotMs: DAY_MS, cron: '30 6 * * *', proCron: '30 6 * * *', batchSize: 100 },
  SPONSOR_RENEWAL_CHARGE: { slug: 'sponsor-renewal-charge', slotMs: DAY_MS, cron: '45 6 * * *', proCron: '45 6 * * *', batchSize: 100 },
  CREDIT_POOL_EXPIRY: { slug: 'credit-pool-expiry', slotMs: DAY_MS, cron: '15 7 * * *', proCron: '15 7 * * *', batchSize: 100 },
  SPLIT_WINDOW_GUARD: { slug: 'split-window-guard', slotMs: DAY_MS, cron: '0 6 * * *', proCron: '0 6 * * *', batchSize: 200 },
  PSP_RECONCILIATION: { slug: 'psp-reconciliation', slotMs: DAY_MS, cron: '30 3 * * *', proCron: '30 3 * * *', batchSize: 1000 },
  QUOTA_RENEWAL: { slug: 'quota-renewal', slotMs: DAY_MS, cron: '30 4 * * *', proCron: '30 4 * * *', batchSize: 100 },
  MODEL182_REMINDER: { slug: 'model182-reminder', slotMs: DAY_MS, cron: '0 8 2 1 *', proCron: '0 8 2 1 *', batchSize: 200 },
  DATA_RETENTION_PURGE: { slug: 'data-retention-purge', slotMs: 7 * DAY_MS, cron: '0 4 * * 0', proCron: '0 4 * * 0', batchSize: 1000 },
  OPS_HOUSEKEEPING: { slug: 'ops-housekeeping', slotMs: DAY_MS, cron: '15 3 * * *', proCron: '15 3 * * *', batchSize: 1000 },
  // Antes que la bandeja de salida del día (2:00 UTC) en el plan gratuito; cada minuto en Pro, para el aviso en ≤ 1 min de EXPERIENCIA §3.
  SUPPORTER_BROADCAST: { slug: 'supporter-broadcast', slotMs: MINUTE_MS, cron: '45 1 * * *', proCron: '* * * * *', batchSize: 500 }
};

export function jobTypeFromSlug(slug: string): JobType | null {
  const found = (Object.entries(JOB_SPECS) as [JobType, JobSpec][]).find(([, spec]) => spec.slug === slug);
  return found ? found[0] : null;
}

/** Clave estable de la ejecución de `type` en el hueco de tiempo que contiene `now` (UTC). */
export function slotKey(type: JobType, now: Date): string {
  const { slotMs } = JOB_SPECS[type];
  const slotStart = Math.floor(now.getTime() / slotMs) * slotMs;
  return `${type}:${new Date(slotStart).toISOString()}`;
}

const RETRY_BASE_MS = MINUTE_MS;
const RETRY_CAP_MS = 6 * HOUR_MS;

/** Espera antes del siguiente intento tras el fallo número `failedAttempts`: 1, 2, 4, 8… minutos con tope de 6 horas. */
export function retryDelayMs(failedAttempts: number, baseMs: number = RETRY_BASE_MS): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) throw new RangeError(`Número de fallos no válido: ${String(failedAttempts)}`);
  return Math.min(baseMs * 2 ** (failedAttempts - 1), RETRY_CAP_MS);
}
