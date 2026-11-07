import type { Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { chargePledgeCycle } from '@/services/pledges/pledge-billing';
import { pledgeModeEnabled, retirePledgeCard } from '@/services/pledges/pledge.service';
import type { JobHandler } from '../job-types';
import { raiseAlert, resolveAlert } from '../ops-alerts';

/**
 * Tareas de cobros recurrentes (patrocinios y Mi Hucha). Mi Hucha cobra cada mes con la tarjeta guardada (Sprint 3.8). Los patrocinios aún
 * no mueven dinero aquí (renovación y bolsa vencida llegan con el Sprint 4.2): esas tareas detectan lo que ya ha vencido y lo dejan en una
 * alerta agregada para el Super-Admin, que desaparece sola cuando no queda nada.
 * Las alertas no llevan datos del comercio ni de la familia: solo recuentos y fechas.
 */

const DAY_MS = 86_400_000;
export const SPONSOR_NOTICE_DAYS = 30;
/** Un patrocinio en bolsa no puede pasar de aquí desde su cobro: la ventana de 90 días de Paycomet menos 5 de margen (skill de pagos §5). */
export const CREDIT_POOL_HARD_CAP_DAYS = 85;

async function syncAggregate(db: Db, input: { type: 'SPONSOR_RENEWAL_DUE' | 'CREDIT_POOL_EXPIRED' | 'MONTHLY_TOPUP_DUE'; severity: 'INFO' | 'WARNING' | 'CRITICAL'; count: number; detail: Record<string, string | number | null> }, now: Date): Promise<void> {
  const dedupeKey = `${input.type}:global`;
  if (input.count === 0) {
    await resolveAlert(db, dedupeKey, now);
    return;
  }
  await raiseAlert(db, { type: input.type, severity: input.severity, dedupeKey, detail: { due: input.count, ...input.detail } }, now);
}

/** `SPONSOR_RENEWAL_NOTICE`: a 30 días de caducar, avisa al comercio con renovación automática. Una sola vez por patrocinio y vencimiento. */
export const sponsorRenewalNoticeHandler: JobHandler = async ({ db, now, batchSize }) => {
  // Se recorren todos con cursor: ordenados por vencimiento y recortados, siempre serían los mismos los que ocuparan el lote y el resto se quedaría sin aviso.
  let cursor: number | undefined;
  let processed = 0;
  let notified = 0;
  for (;;) {
    const sponsors = await db.sponsor.findMany({
      where: { status: 'APPROVED', autoRenew: true, expiresAt: { gt: now, lte: new Date(now.getTime() + SPONSOR_NOTICE_DAYS * DAY_MS) } },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
      select: { id: true, organizationId: true, email: true, amountCents: true, expiresAt: true, organization: { select: { contentLocale: true } } }
    });
    const { count } = await db.outboxMessage.createMany({
      data: sponsors.map((sponsor) => ({
        idempotencyKey: `sponsor.renewalNotice:${sponsor.id}:${sponsor.expiresAt.toISOString().slice(0, 10)}`,
        templateKey: 'sponsor.renewalNotice',
        locale: sponsor.organization.contentLocale,
        toAddress: sponsor.email,
        organizationId: sponsor.organizationId,
        payloadJson: { sponsorId: sponsor.id, amountCents: sponsor.amountCents, expiresAt: sponsor.expiresAt.toISOString() }
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

/** `SPONSOR_RENEWAL_CHARGE`: patrocinios con renovación automática ya vencidos. El cobro de la renovación llega con el Sprint 4.2 (junto a la moderación de comercios): no hay tarjeta guardada, así que será un enlace de pago. */
export const sponsorRenewalChargeHandler: JobHandler = async ({ db, now }) => {
  const where = { status: 'APPROVED', autoRenew: true, expiresAt: { lte: now } } as const;
  const [due, oldest] = await Promise.all([db.sponsor.count({ where }), db.sponsor.findFirst({ where, orderBy: { expiresAt: 'asc' }, select: { expiresAt: true } })]);
  await syncAggregate(db, { type: 'SPONSOR_RENEWAL_DUE', severity: 'WARNING', count: due, detail: { oldestExpiresAt: oldest?.expiresAt.toISOString() ?? null } }, now);
  return { processed: due, hasMore: false };
};

/** `CREDIT_POOL_EXPIRY`: bolsas de patrocinio que superan el tope de la ventana de Paycomet. El reembolso al comercio llega con el Sprint 4.2. */
export const creditPoolExpiryHandler: JobHandler = async ({ db, now }) => {
  const where = { status: 'CREDIT_POOL', paidAt: { not: null, lte: new Date(now.getTime() - CREDIT_POOL_HARD_CAP_DAYS * DAY_MS) } } as const;
  const [due, oldest] = await Promise.all([db.sponsor.count({ where }), db.sponsor.findFirst({ where, orderBy: { paidAt: 'asc' }, select: { paidAt: true } })]);
  await syncAggregate(db, { type: 'CREDIT_POOL_EXPIRED', severity: 'CRITICAL', count: due, detail: { oldestPaidAt: oldest?.paidAt?.toISOString() ?? null } }, now);
  return { processed: due, hasMore: false };
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
