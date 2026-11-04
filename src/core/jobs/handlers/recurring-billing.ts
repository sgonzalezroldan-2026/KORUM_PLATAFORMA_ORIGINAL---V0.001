import type { Db } from '@/lib/db';
import type { JobHandler } from '../job-types';
import { raiseAlert, resolveAlert } from '../ops-alerts';

/**
 * Tareas de cobros recurrentes (patrocinios y Mi Hucha). Los cobros y reembolsos reales dependen de piezas que aún no existen —el
 * checkout y las tarjetas guardadas (Sprint 3.4), la confirmación de patrocinios con su factura (3.5) y Mi Hucha (3.7)—, y el cobro de
 * un patrocinio hoy se rechaza a propósito. Por eso aquí **no se mueve dinero**: cada tarea detecta lo que ya ha vencido y lo deja en
 * una alerta agregada para el Super-Admin, que desaparece sola cuando no queda nada. Solo el preaviso de renovación es completo.
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

/** `SPONSOR_RENEWAL_CHARGE`: patrocinios con renovación automática ya vencidos. El cobro llega con el Sprint 3.5. */
export const sponsorRenewalChargeHandler: JobHandler = async ({ db, now }) => {
  const where = { status: 'APPROVED', autoRenew: true, expiresAt: { lte: now } } as const;
  const [due, oldest] = await Promise.all([db.sponsor.count({ where }), db.sponsor.findFirst({ where, orderBy: { expiresAt: 'asc' }, select: { expiresAt: true } })]);
  await syncAggregate(db, { type: 'SPONSOR_RENEWAL_DUE', severity: 'WARNING', count: due, detail: { oldestExpiresAt: oldest?.expiresAt.toISOString() ?? null } }, now);
  return { processed: due, hasMore: false };
};

/** `CREDIT_POOL_EXPIRY`: bolsas de patrocinio que superan el tope de la ventana de Paycomet. El reembolso al comercio llega con el Sprint 3.5. */
export const creditPoolExpiryHandler: JobHandler = async ({ db, now }) => {
  const where = { status: 'CREDIT_POOL', paidAt: { not: null, lte: new Date(now.getTime() - CREDIT_POOL_HARD_CAP_DAYS * DAY_MS) } } as const;
  const [due, oldest] = await Promise.all([db.sponsor.count({ where }), db.sponsor.findFirst({ where, orderBy: { paidAt: 'asc' }, select: { paidAt: true } })]);
  await syncAggregate(db, { type: 'CREDIT_POOL_EXPIRED', severity: 'CRITICAL', count: due, detail: { oldestPaidAt: oldest?.paidAt?.toISOString() ?? null } }, now);
  return { processed: due, hasMore: false };
};

/** `MONTHLY_TOPUP`: aportaciones mensuales programadas con fecha cumplida. El cobro llega con Mi Hucha (Sprint 3.7). */
export const monthlyTopupHandler: JobHandler = async ({ db, now }) => {
  const due = await db.walletSubscription.findMany({ where: { active: true, nextChargeAt: { lte: now } }, select: { executedMonths: true, totalMonths: true } });
  const pending = due.filter((subscription) => subscription.executedMonths < subscription.totalMonths).length;
  await syncAggregate(db, { type: 'MONTHLY_TOPUP_DUE', severity: 'INFO', count: pending, detail: {} }, now);
  return { processed: pending, hasMore: false };
};
