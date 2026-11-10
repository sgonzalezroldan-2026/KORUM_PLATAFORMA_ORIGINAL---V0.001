import { raiseAlert, resolveAlertsNotIn } from '@/core/jobs/ops-alerts';
import { CREDIT_POOL_HARD_CAP_DAYS, creditPoolDeadline, DEFAULT_CREDIT_POOL_MAX_DAYS, RENEWAL_LINK_DAYS, renewalLinkValidUntil } from '@/core/sponsors/sponsor-reassignment-rules';
import { signRenewalToken } from '@/core/sponsors/sponsor-renewal-token';
import type { Db } from '@/lib/db';
import { inTransaction } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { FAILED_INITIATIVE_STATUSES, poolBalanceOf } from './sponsor-money';
import { relocateSponsor } from './sponsor-reassignment.service';

/**
 * Lo que las tareas programadas hacen con el dinero de los comercios (Sprint 4.2d). Cada comercio en su propia transacción: el fallo de uno no
 * deja sin tratar a los demás (se informa y se reintenta en la siguiente ejecución).
 *
 * - `sweepSponsorMoney`: reasigna el dinero de campañas que fracasaron (también al terminar `MASS_REFUND`), la bolsa *Matching 2x* sobrante de una
 *   campaña que ya no recauda, y coloca lo que espera en la bolsa en cuanto hay campaña (salvo con la regla `MANUAL`, que decide el centro).
 * - `expireCreditPools`: la bolsa vencida **no se devuelve al comercio** (decisión del promotor, 2026-11-10: el dinero de un comercio admitido solo se
 *   devuelve si la entidad no lo admite). Pasará a la entidad para sus actividades con el «Fondo de actividades» del Sprint 4.2f; hasta entonces espera
 *   con una alerta `CREDIT_POOL_EXPIRED` por comercio.
 * - `queueRenewalLinks`: el día que vence el distintivo, el enlace de pago de la renovación (el preaviso de 30 días ya lo lleva).
 */

const COMPLETED_CHARGE = { paidAt: { not: null }, contribution: { status: 'COMPLETED' as const } };
const DAY_MS = 86_400_000;

async function creditPoolMaxDays(db: Db): Promise<number> {
  return (await db.globalConfig.findUnique({ where: { id: 'GLOBAL' }, select: { creditPoolMaxDays: true } }))?.creditPoolMaxDays ?? DEFAULT_CREDIT_POOL_MAX_DAYS;
}

/**
 * Comercios cuyo dinero hay que mover. Cada consulta filtra en la base lo que de verdad queda por mover (y ordena): los ya movidos o vencidos no ocupan el
 * lote de los que esperan (auditoría financiera del 4.2d, I3).
 */
async function stranded(db: Db, limit: number, now: Date): Promise<number[]> {
  const maxDays = await creditPoolMaxDays(db);
  const notExpired = { creditPoolAt: { gt: new Date(now.getTime() - maxDays * DAY_MS) }, contribution: { status: 'COMPLETED' as const, createdAt: { gt: new Date(now.getTime() - CREDIT_POOL_HARD_CAP_DAYS * DAY_MS) } } };
  const [fromFailed, matchingLeft, allocated, pooled] = await Promise.all([
    db.sponsor.findMany({
      where: { ...COMPLETED_CHARGE, status: 'APPROVED', reassignedCents: { lt: db.sponsor.fields.amountCents }, initiative: { status: { in: [...FAILED_INITIATIVE_STATUSES] } } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true }
    }),
    // Bolsa Matching 2x de una campaña que ya no recauda (meta lograda o cerrada): lo que sobre se reasigna (decisión del promotor, 2026-11-09).
    db.sponsor.findMany({
      where: {
        ...COMPLETED_CHARGE,
        status: 'APPROVED',
        isMatchingPool: true,
        reassignedCents: 0,
        initiative: { status: { in: ['GOAL_REACHED', 'CLOSED'] }, OR: [{ matchingPoolRemainingCents: { gt: 0 } }, { matchingPoolTotalCents: 0 }] }
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true }
    }),
    db.sponsorAllocation.findMany({ where: { withdrawnAt: null, initiative: { status: { in: [...FAILED_INITIATIVE_STATUSES] } } }, distinct: ['sponsorId'], orderBy: { sponsorId: 'asc' }, take: limit, select: { sponsorId: true } }),
    db.sponsor.findMany({ where: { paidAt: { not: null }, status: 'CREDIT_POOL', organization: { sponsorRenewalRule: { not: 'MANUAL' } }, ...notExpired }, orderBy: { id: 'asc' }, take: limit, select: { id: true } })
  ]);
  const ids = [...fromFailed.map((row) => row.id), ...matchingLeft.map((row) => row.id), ...allocated.map((row) => row.sponsorId), ...pooled.map((row) => row.id)];
  return [...new Set(ids)].slice(0, limit);
}

export async function sweepSponsorMoney(db: Db, now: Date, limit: number): Promise<{ placed: number; pooled: number; errors: number }> {
  const result = { placed: 0, pooled: 0, errors: 0 };
  for (const id of await stranded(db, limit, now)) {
    try {
      const outcome = await inTransaction(db, (tx) => relocateSponsor(tx, id, now));
      if (outcome.kind === 'PLACED') result.placed += 1;
      else if (outcome.kind === 'POOLED') result.pooled += 1;
    } catch (error) {
      result.errors += 1;
      reportError(error, { stage: 'sponsor-sweep', sponsorId: id });
    }
  }
  return result;
}

/**
 * Bolsas vencidas: una alerta por comercio con lo que queda en su bolsa (lo resolverá el Fondo de actividades del 4.2f). El vencimiento se busca en la
 * base (entrada en la bolsa o cobro pasados de plazo), así que las ya avisadas no tapan a las nuevas. Las alertas de comercios que ya no están en la
 * bolsa se cierran solas, y también la antigua alerta agregada.
 */
export async function expireCreditPools(db: Db, now: Date, limit: number): Promise<{ expired: number }> {
  const maxDays = await creditPoolMaxDays(db);
  const alerted = (await db.opsAlert.findMany({ where: { type: 'CREDIT_POOL_EXPIRED', status: 'OPEN', targetType: 'Sponsor' }, select: { targetId: true } })).flatMap((row) => (row.targetId ? [Number(row.targetId)] : []));
  const due = await db.sponsor.findMany({
    where: {
      id: { notIn: alerted },
      status: 'CREDIT_POOL',
      paidAt: { not: null },
      contribution: { status: 'COMPLETED' },
      OR: [{ creditPoolAt: { lte: new Date(now.getTime() - maxDays * DAY_MS) } }, { contribution: { createdAt: { lte: new Date(now.getTime() - CREDIT_POOL_HARD_CAP_DAYS * DAY_MS) } } }]
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true, organizationId: true, amountCents: true, creditPoolAt: true, contribution: { select: { createdAt: true } } }
  });
  let expired = 0;
  for (const sponsor of due) {
    if (!sponsor.creditPoolAt || !sponsor.contribution) continue;
    const deadline = creditPoolDeadline({ paidAt: sponsor.contribution.createdAt, creditPoolAt: sponsor.creditPoolAt }, maxDays);
    const poolCents = await poolBalanceOf(db, sponsor.organizationId, sponsor.id);
    await raiseAlert(
      db,
      { type: 'CREDIT_POOL_EXPIRED', severity: 'CRITICAL', dedupeKey: `CREDIT_POOL_EXPIRED:${sponsor.id}`, organizationId: sponsor.organizationId, targetType: 'Sponsor', targetId: String(sponsor.id), detail: { poolCents, amountCents: sponsor.amountCents, deadline: deadline.toISOString() } },
      now
    );
    expired += 1;
  }
  const stillPooled = await db.sponsor.findMany({ where: { status: 'CREDIT_POOL' }, select: { id: true } });
  await resolveAlertsNotIn(db, 'CREDIT_POOL_EXPIRED', stillPooled.map((row) => `CREDIT_POOL_EXPIRED:${row.id}`), now);
  return { expired };
}

/** Enlaces de pago de la renovación el día que vence el distintivo, una vez por vencimiento. Sin datos de pago: el comercio paga en la página de Paycomet. */
export async function queueRenewalLinks(db: Db, now: Date, limit: number, secret: string): Promise<number> {
  const sponsors = await db.sponsor.findMany({
    where: {
      status: { in: ['APPROVED', 'CREDIT_POOL'] },
      autoRenew: true,
      paidAt: { not: null },
      organization: { archivedAt: null },
      expiresAt: { lte: now, gt: new Date(now.getTime() - RENEWAL_LINK_DAYS * DAY_MS) },
      renewals: { none: { paidAt: { not: null } } }
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true, organizationId: true, email: true, amountCents: true, expiresAt: true, organization: { select: { contentLocale: true } }, contribution: { select: { locale: true } } }
  });
  const { count } = await db.outboxMessage.createMany({
    data: sponsors.map((sponsor) => ({
      idempotencyKey: `sponsor.renewalLink:${sponsor.id}:${sponsor.expiresAt.toISOString().slice(0, 10)}`,
      templateKey: 'sponsor.renewalLink',
      locale: sponsor.contribution?.locale ?? sponsor.organization.contentLocale,
      toAddress: sponsor.email,
      organizationId: sponsor.organizationId,
      payloadJson: renewalLinkPayload(secret, sponsor)
    })),
    skipDuplicates: true
  });
  return count;
}

/** Lo que lleva cualquier email con el enlace de renovación. `expiresAt` es hasta cuándo vale el enlace (la bandeja no envía uno caducado). */
export function renewalLinkPayload(secret: string, sponsor: { id: number; amountCents: number; expiresAt: Date }) {
  return { sponsorId: sponsor.id, amountCents: sponsor.amountCents, badgeExpiresAt: sponsor.expiresAt.toISOString(), expiresAt: renewalLinkValidUntil(sponsor.expiresAt).toISOString(), token: signRenewalToken(secret, sponsor.id, sponsor.expiresAt) };
}
