import type { Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { chargePledgeCycle } from '@/services/pledges/pledge-billing';
import { pledgeModeEnabled, retirePledgeCard } from '@/services/pledges/pledge.service';
import { expireCreditPools, queueRenewalLinks, renewalLinkPayload, sweepSponsorMoney } from '@/services/sponsors/sponsor-sweeps';
import type { JobHandler } from '../job-types';
import { raiseAlert, resolveAlert } from '../ops-alerts';

/**
 * Tareas de cobros recurrentes (patrocinios y Mi Hucha). Mi Hucha cobra cada mes con la tarjeta guardada (Sprint 3.8). Los comercios (Sprint 4.2d)
 * renuevan con un enlace de pago (sin tarjeta guardada: el checkout usa la página de Paycomet), su dinero se reasigna o espera en la bolsa con su
 * plazo, y la bolsa vencida se devuelve. Las alertas no llevan datos del comercio ni de la familia: solo recuentos, fechas e identificadores.
 */

const DAY_MS = 86_400_000;
export const SPONSOR_NOTICE_DAYS = 30;

async function syncAggregate(db: Db, input: { type: 'SPONSOR_RENEWAL_DUE' | 'MONTHLY_TOPUP_DUE'; severity: 'INFO' | 'WARNING' | 'CRITICAL'; count: number; detail: Record<string, string | number | null> }, now: Date): Promise<void> {
  const dedupeKey = `${input.type}:global`;
  if (input.count === 0) {
    await resolveAlert(db, dedupeKey, now);
    return;
  }
  await raiseAlert(db, { type: input.type, severity: input.severity, dedupeKey, detail: { due: input.count, ...input.detail } }, now);
}

/** `SPONSOR_RENEWAL_NOTICE`: a 30 días de caducar, avisa al comercio con renovación automática. Una sola vez por patrocinio y vencimiento. */
export const sponsorRenewalNoticeHandler: JobHandler = async ({ db, now, batchSize, deps }) => {
  const secret = deps.hmacSecret();
  // Se recorren todos con cursor: ordenados por vencimiento y recortados, siempre serían los mismos los que ocuparan el lote y el resto se quedaría sin aviso.
  let cursor: number | undefined;
  let processed = 0;
  let notified = 0;
  for (;;) {
    const sponsors = await db.sponsor.findMany({
      where: { status: { in: ['APPROVED', 'CREDIT_POOL'] }, autoRenew: true, paidAt: { not: null }, renewals: { none: { paidAt: { not: null } } }, organization: { archivedAt: null }, expiresAt: { gt: now, lte: new Date(now.getTime() + SPONSOR_NOTICE_DAYS * DAY_MS) } },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
      select: { id: true, organizationId: true, email: true, amountCents: true, expiresAt: true, organization: { select: { contentLocale: true } }, contribution: { select: { locale: true } } }
    });
    const { count } = await db.outboxMessage.createMany({
      data: sponsors.map((sponsor) => ({
        idempotencyKey: `sponsor.renewalNotice:${sponsor.id}:${sponsor.expiresAt.toISOString().slice(0, 10)}`,
        templateKey: 'sponsor.renewalNotice',
        // En el idioma en que pagó el comercio, como el resto de sus emails.
        locale: sponsor.contribution?.locale ?? sponsor.organization.contentLocale,
        toAddress: sponsor.email,
        organizationId: sponsor.organizationId,
        // Con el enlace de pago de la renovación (Sprint 4.2d): el comercio puede renovar desde hoy sin perder días de distintivo.
        payloadJson: renewalLinkPayload(secret, sponsor)
      })),
      skipDuplicates: true
    });
    notified += count;
    processed += sponsors.length;
    const last = sponsors.at(-1);
    if (!last || sponsors.length < batchSize) break;
    cursor = last.id;
  }
  return { processed, hasMore: false, detail: { notified } };
};

/**
 * `SPONSOR_RENEWAL_CHARGE`: el día que vence el distintivo, el enlace de pago de la renovación (Sprint 4.2d; antes solo se detectaba). No hay cobro
 * automático: el comercio paga en la página de Paycomet. La antigua alerta agregada `SPONSOR_RENEWAL_DUE` ya no tiene sentido y se cierra.
 */
export const sponsorRenewalChargeHandler: JobHandler = async ({ db, now, batchSize, deps }) => {
  const sent = await queueRenewalLinks(db, now, batchSize, deps.hmacSecret());
  await syncAggregate(db, { type: 'SPONSOR_RENEWAL_DUE', severity: 'WARNING', count: 0, detail: {} }, now);
  return { processed: sent, hasMore: sent === batchSize, detail: { sent } };
};

/**
 * `CREDIT_POOL_EXPIRY` (Sprint 4.2d): reasigna el dinero de comercios que espera (bolsa sobrante de campañas liquidadas, campañas que fracasaron, bolsa
 * con campañas nuevas) y avisa de las bolsas vencidas (`expireCreditPools`: no se devuelven, decisión del promotor del 2026-11-10; pasarán a la entidad
 * con el Fondo de actividades del 4.2f). La alerta agregada antigua se sustituye por una por comercio.
 */
export const creditPoolExpiryHandler: JobHandler = async ({ db, now, batchSize }) => {
  const sweep = await sweepSponsorMoney(db, now, batchSize);
  const expiry = await expireCreditPools(db, now, batchSize);
  await resolveAlert(db, 'CREDIT_POOL_EXPIRED:global', now);
  return { processed: sweep.placed + sweep.pooled + expiry.expired, hasMore: false, detail: { ...sweep, ...expiry } };
};

/** Un cobro mensual sin confirmar pasado este tiempo (resultado desconocido) se avisa en la consola: alguien tiene que mirarlo en Paycomet. */
export const PLEDGE_UNCONFIRMED_AFTER_MS = 2 * 3_600_000;
/** Pasado este tiempo de ejecución no se empiezan más cobros: la función de Vercel tiene un límite. */
export const PLEDGE_TIME_BUDGET_MS = 240_000;
/**
 * Plazo máximo de una aportación en pausa (6 meses): pasado, se cancela y se borra la tarjeta guardada. Sin plazo, una pausa olvidada (una
 * tarjeta caducada) conservaría la tarjeta y la cuenta para siempre (minimización, CUMPLIMIENTO §6). A validar por el abogado.
 */
export const PLEDGE_MAX_PAUSE_DAYS = 180;

/** Cancela las aportaciones en pausa desde hace más del plazo y pide borrar sus tarjetas. */
async function expireLongPauses(db: Db, deps: Parameters<JobHandler>[0]['deps'], now: Date, batchSize: number): Promise<number> {
  const expired = await db.walletSubscription.findMany({
    where: { status: 'PAUSED', statusChangedAt: { lt: new Date(now.getTime() - PLEDGE_MAX_PAUSE_DAYS * 86_400_000) } },
    take: batchSize,
    select: { id: true, paymentMethodTokenId: true }
  });
  for (const pledge of expired) {
    const { count } = await db.walletSubscription.updateMany({ where: { id: pledge.id, status: 'PAUSED' }, data: { status: 'CANCELLED', statusReason: 'PAUSE_EXPIRED', statusChangedAt: now } });
    if (count === 1 && pledge.paymentMethodTokenId !== null) await retirePledgeCard({ db, keyring: deps.keyring(), paymentProvider: deps.paymentProvider }, pledge.paymentMethodTokenId, now);
  }
  return expired.length;
}

/**
 * `MONTHLY_TOPUP` (Sprint 3.8): cobra el mes de cada aportación mensual de Mi Hucha que ha vencido (`chargePledgeCycle`). Solo en modo
 * `PLEDGE`: si el Super-Admin desactiva Mi Hucha, no se cobra nada, y al reactivarla no se cobran los meses atrasados (cada mes se calcula desde
 * hoy). Paycomet, la IP del servidor y el llavero se resuelven antes de reservar ningún mes. La alerta `MONTHLY_TOPUP_DUE` cuenta los cobros con
 * resultado desconocido que siguen sin confirmar, sin datos de las familias.
 */
export const monthlyTopupHandler: JobHandler = async ({ db, now, batchSize, deadline, deps }) => {
  const detail = { charged: 0, skipped: 0, failed: 0, unknown: 0, errors: 0, pauseExpired: 0 };
  let processed = 0;
  let hasMore = false;
  if (await pledgeModeEnabled(db)) {
    const due = await db.walletSubscription.findMany({ where: { status: 'ACTIVE', nextChargeAt: { lte: now } }, orderBy: [{ nextChargeAt: 'asc' }, { id: 'asc' }], take: batchSize, select: { id: true } });
    if (due.length > 0) {
      const billing = { db, provider: await deps.paymentProvider(), keyring: deps.keyring(), originalIp: await deps.refundOriginalIp() };
      const stopAt = Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + PLEDGE_TIME_BUDGET_MS);
      let lastError: unknown = null;
      for (const { id } of due) {
        if (Date.now() > stopAt) {
          hasMore = true;
          break;
        }
        // Un fallo inesperado en una aportación no deja sin cobrar a las demás (como `MASS_REFUND`). Su mes ya está reservado o no se tocó.
        try {
          const outcome = await chargePledgeCycle(billing, id, now);
          if (outcome === 'NOT_DUE') continue;
          processed += 1;
          detail[outcome === 'CHARGED' ? 'charged' : outcome === 'SKIPPED' ? 'skipped' : outcome === 'FAILED' ? 'failed' : 'unknown'] += 1;
        } catch (error) {
          detail.errors += 1;
          lastError = error;
          reportError(error, { stage: 'monthly-topup', pledgeId: id });
        }
      }
      // Solo falla la tarea si nada avanzó: apunta a un problema general (base de datos, configuración).
      if (lastError && processed === 0) throw lastError;
      hasMore ||= due.length === batchSize;
    }
  }
  detail.pauseExpired = await expireLongPauses(db, deps, now, batchSize);
  const unconfirmed = await db.contribution.count({ where: { status: 'PENDING', pledgeCycle: { gt: 1 }, createdAt: { lte: new Date(now.getTime() - PLEDGE_UNCONFIRMED_AFTER_MS) } } });
  await syncAggregate(db, { type: 'MONTHLY_TOPUP_DUE', severity: 'WARNING', count: unconfirmed + detail.errors, detail: {} }, now);
  return { processed, hasMore, detail };
};
