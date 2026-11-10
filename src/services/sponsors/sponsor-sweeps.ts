import { resolveAlertsNotIn } from '@/core/jobs/ops-alerts';
import { ACTIVITY_FUND_DAY, DEFAULT_CREDIT_POOL_MAX_DAYS, effectiveCreditPoolMaxDays, RENEWAL_LINK_DAYS, renewalLinkValidUntil } from '@/core/sponsors/sponsor-reassignment-rules';
import { signRenewalToken } from '@/core/sponsors/sponsor-renewal-token';
import type { Db } from '@/lib/db';
import { inTransaction } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { moveToActivityFund } from './activity-fund.service';
import { FAILED_INITIATIVE_STATUSES } from './sponsor-money';
import { relocateSponsor } from './sponsor-reassignment.service';

/**
 * Lo que las tareas programadas hacen con el dinero de los comercios (Sprint 4.2d). Cada comercio en su propia transacción: el fallo de uno no
 * deja sin tratar a los demás (se informa y se reintenta en la siguiente ejecución).
 *
 * - `sweepSponsorMoney`: reasigna el dinero de campañas que fracasaron (también al terminar `MASS_REFUND`), la bolsa *Matching 2x* sobrante de una
 *   campaña que ya no recauda, y coloca lo que espera en la bolsa en cuanto hay campaña (salvo con la regla `MANUAL`, que decide el centro).
 * - `expireCreditPools`: la bolsa vencida **no se devuelve al comercio** (decisión del promotor, 2026-11-10: el dinero de un comercio admitido solo se
 *   devuelve si la entidad no lo admite): pasa al «Fondo de actividades» de la entidad (Sprint 4.2f), que lo liquida a su cuenta con doble firma.
 * - `queueRenewalLinks`: el día que vence el distintivo, el enlace de pago de la renovación (el preaviso de 30 días ya lo lleva).
 */

const COMPLETED_CHARGE = { paidAt: { not: null }, contribution: { status: 'COMPLETED' as const } };
const DAY_MS = 86_400_000;

async function creditPoolMaxDays(db: Db): Promise<number> {
  return effectiveCreditPoolMaxDays((await db.globalConfig.findUnique({ where: { id: 'GLOBAL' }, select: { creditPoolMaxDays: true } }))?.creditPoolMaxDays ?? DEFAULT_CREDIT_POOL_MAX_DAYS);
}

/**
 * Comercios cuyo dinero hay que mover. Cada consulta filtra en la base lo que de verdad queda por mover (y ordena): los ya movidos o vencidos no ocupan el
 * lote de los que esperan (auditoría financiera del 4.2d, I3).
 */
async function stranded(db: Db, limit: number, now: Date): Promise<number[]> {
  const maxDays = await creditPoolMaxDays(db);
  const notExpired = { creditPoolAt: { gt: new Date(now.getTime() - maxDays * DAY_MS) }, contribution: { status: 'COMPLETED' as const, createdAt: { gt: new Date(now.getTime() - ACTIVITY_FUND_DAY * DAY_MS) } } };
  const [fromFailed, matchingLeft, allocated, pooled, matchingOn] = await Promise.all([
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
    db.sponsor.findMany({ where: { paidAt: { not: null }, status: 'CREDIT_POOL', organization: { sponsorRenewalRule: { not: 'MANUAL' } }, ...notExpired }, orderBy: { id: 'asc' }, take: limit, select: { id: true } }),
    // Bolsa Matching aún encendida en una campaña que fracasó, aunque ya no quede dinero por mover: se apaga y el comercio deja de contar en su 💛.
    db.sponsor.findMany({
      where: { ...COMPLETED_CHARGE, status: { in: ['APPROVED', 'CREDIT_POOL'] }, isMatchingPool: true, initiative: { status: { in: [...FAILED_INITIATIVE_STATUSES] }, matchingPoolTotalCents: { gt: 0 } } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true }
    })
  ]);
  const ids = [...fromFailed.map((row) => row.id), ...matchingLeft.map((row) => row.id), ...allocated.map((row) => row.sponsorId), ...pooled.map((row) => row.id), ...matchingOn.map((row) => row.id)];
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
 * Bolsas vencidas (entrada en la bolsa o cobro pasados de plazo, buscados en la base): lo que queda en cada una pasa al Fondo de actividades de su
 * entidad, cada comercio en su transacción (el fallo de uno no deja a los demás). Las alertas `CREDIT_POOL_EXPIRED` que abría el 4.2d se cierran: ya
 * ningún comercio se queda en una bolsa vencida.
 */
export async function expireCreditPools(db: Db, now: Date, limit: number): Promise<{ expired: number; toFundCents: number; errors: number }> {
  const maxDays = await creditPoolMaxDays(db);
  const due = await db.sponsor.findMany({
    where: {
      status: 'CREDIT_POOL',
      paidAt: { not: null },
      contribution: { status: 'COMPLETED' },
      OR: [{ creditPoolAt: { lte: new Date(now.getTime() - maxDays * DAY_MS) } }, { contribution: { createdAt: { lte: new Date(now.getTime() - ACTIVITY_FUND_DAY * DAY_MS) } } }]
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true }
  });
  const result = { expired: 0, toFundCents: 0, errors: 0 };
  for (const { id } of due) {
    try {
      const { movedCents } = await inTransaction(db, (tx) => moveToActivityFund(tx, id, now));
      result.expired += 1;
      result.toFundCents += movedCents;
    } catch (error) {
      result.errors += 1;
      reportError(error, { stage: 'credit-pool-to-fund', sponsorId: id });
    }
  }
  await resolveAlertsNotIn(db, 'CREDIT_POOL_EXPIRED', [], now);
  return result;
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
