import { creditPoolDeadline, DEFAULT_CREDIT_POOL_MAX_DAYS, isEligibleTarget, planPlacement, type Placement, type SponsorRenewalRule } from '@/core/sponsors/sponsor-reassignment-rules';
import type { Db } from '@/lib/db';
import { isFailedInitiative, lockInitiatives, moveOriginToPool, payoutSettled, placeFromPool, poolBalanceOf, withdrawAllocation, type MovableSponsor } from './sponsor-money';

/**
 * Reasignación del dinero de un comercio (Sprint 4.2d, Regla 02 §5): el patrocinio de una campaña que fracasa, lo que sobra de una bolsa *Matching 2x*
 * en una campaña ya liquidada (decisión del promotor, 2026-11-09: se reasigna) y una renovación anual pagada van a la bolsa del comercio y, desde ella,
 * a las campañas activas según la regla de la entidad. Si no hay campaña elegible (o la regla es `MANUAL`), espera en la bolsa con su plazo.
 *
 * Todo en la transacción de quien llama. La campaña de origen se bloquea la primera (como en los cobros, contracargos y liquidaciones) y después, en
 * orden, las demás que intervienen: lo que se lea ya no cambia hasta confirmar.
 */

export type RelocationOutcome =
  | { kind: 'NOTHING' }
  | { kind: 'PLACED'; titles: string[]; amountCents: number }
  | { kind: 'POOLED'; amountCents: number; deadline: Date; manual: boolean };

/** Aviso al comercio de cada paso: `MOVE` (salió de una campaña), `RENEWAL` (lo envía quien completa la renovación con su propio email) o ninguno. */
export type RelocationNotice = 'MOVE' | 'NONE';

const LOADED = {
  id: true,
  organizationId: true,
  initiativeId: true,
  status: true,
  email: true,
  amountCents: true,
  reassignedCents: true,
  isMatchingPool: true,
  paidAt: true,
  creditPoolAt: true,
  renewedFromId: true,
  organization: { select: { sponsorRenewalRule: true, contentLocale: true } },
  initiative: { select: { status: true, payout: { select: { status: true } } } },
  contribution: { select: { id: true, initiativeId: true, status: true, paycometOrder: true, createdAt: true, locale: true } },
  allocations: { where: { withdrawnAt: null }, select: { id: true, initiativeId: true, amountCents: true } }
} as const;

async function loadSponsor(tx: Db, sponsorId: number) {
  return tx.sponsor.findUnique({ where: { id: sponsorId }, select: LOADED });
}

type LoadedSponsor = NonNullable<Awaited<ReturnType<typeof loadSponsor>>>;

const movable = (sponsor: LoadedSponsor & { contribution: NonNullable<LoadedSponsor['contribution']> }): MovableSponsor => ({
  id: sponsor.id,
  organizationId: sponsor.organizationId,
  amountCents: sponsor.amountCents,
  reassignedCents: sponsor.reassignedCents,
  isMatchingPool: sponsor.isMatchingPool,
  contributionId: sponsor.contribution.id,
  paycometOrder: sponsor.contribution.paycometOrder,
  chargedAt: sponsor.contribution.createdAt
});

/** Campañas a las que puede ir el dinero ahora: activas, de presupuesto (las únicas que se patrocinan) y dentro de la ventana del cobro. */
async function eligibleTargets(tx: Db, organizationId: string, chargedAt: Date, exclude: number[], now: Date) {
  const rows = await tx.initiative.findMany({
    where: { organizationId, status: 'FUNDRAISING', format: 'BUDGET', closesAt: { gt: now }, id: { notIn: exclude } },
    select: { id: true, closesAt: true, goalCents: true, raisedCents: true, title: true }
  });
  return rows.filter((row) => isEligibleTarget(row, chargedAt, now));
}

/** ¿Hay que sacar dinero del origen? Si fracasó, sí (con bolsa Matching 2x, cuando ya no queda nada por devolver: los bonus vuelven antes a la bolsa). */
async function originToMove(tx: Db, sponsor: LoadedSponsor): Promise<{ move: boolean; failed: boolean }> {
  const origin = sponsor.contribution?.initiativeId;
  if (origin === undefined || sponsor.reassignedCents >= sponsor.amountCents || !sponsor.initiative) return { move: false, failed: false };
  const failed = isFailedInitiative(sponsor.initiative.status);
  if (!sponsor.isMatchingPool) return { move: failed, failed };
  if (!failed) return { move: sponsor.initiative.status === 'GOAL_REACHED' || sponsor.initiative.status === 'CLOSED' || payoutSettled(sponsor.initiative.payout), failed };
  const pendingRefunds = await tx.contribution.count({ where: { initiativeId: origin, OR: [{ status: 'REFUND_PENDING' }, { status: 'COMPLETED', type: { in: ['DONATION', 'TICKET'] } }] } });
  return { move: pendingRefunds === 0, failed };
}

/**
 * Pone en su sitio el dinero de un comercio: saca a la bolsa lo que está en campañas que ya no lo usarán y coloca la bolsa entera según la regla
 * (o en `manualTarget`, si el centro la eligió). Solo comercios aprobados o en la bolsa, con su cobro confirmado. Repetirla no mueve nada dos veces.
 */
export async function relocateSponsor(tx: Db, sponsorId: number, now: Date, options: { manualTarget?: number; notice?: RelocationNotice } = {}): Promise<RelocationOutcome> {
  const preview = await loadSponsor(tx, sponsorId);
  if (!preview?.contribution || preview.contribution.status !== 'COMPLETED' || preview.paidAt === null) return { kind: 'NOTHING' };
  const chargedAt = preview.contribution.createdAt;
  const candidates = options.manualTarget !== undefined ? [options.manualTarget] : (await eligibleTargets(tx, preview.organizationId, chargedAt, [], now)).map((row) => row.id);
  await lockInitiatives(tx, preview.contribution.initiativeId, [...preview.allocations.map((allocation) => allocation.initiativeId), ...candidates], now);

  const sponsor = await loadSponsor(tx, sponsorId);
  if (!sponsor?.contribution || sponsor.contribution.status !== 'COMPLETED' || sponsor.paidAt === null) return { kind: 'NOTHING' };
  if (sponsor.status !== 'APPROVED' && sponsor.status !== 'CREDIT_POOL') return { kind: 'NOTHING' };
  const money = movable({ ...sponsor, contribution: sponsor.contribution });

  const origin = await originToMove(tx, sponsor);
  if (origin.move) money.reassignedCents += await moveOriginToPool(tx, money, sponsor.contribution.initiativeId, origin.failed, now);
  const withdrawnFrom: number[] = [];
  if (sponsor.allocations.length > 0) {
    const targets = await tx.initiative.findMany({ where: { id: { in: sponsor.allocations.map((allocation) => allocation.initiativeId) } }, select: { id: true, status: true } });
    const failed = new Set(targets.filter((target) => isFailedInitiative(target.status)).map((target) => target.id));
    for (const allocation of sponsor.allocations) {
      if (!failed.has(allocation.initiativeId)) continue;
      await withdrawAllocation(tx, money, allocation, now);
      withdrawnFrom.push(allocation.initiativeId);
    }
  }

  const pool = await poolBalanceOf(tx, sponsor.organizationId, sponsor.id);
  if (pool <= 0) return { kind: 'NOTHING' };
  const rule = sponsor.organization.sponsorRenewalRule as SponsorRenewalRule;
  // Solo cuentan campañas que recaudan: el origen fracasado o liquidado nunca lo es, y la de referencia de una renovación sí puede recibirla.
  const locked = new Set(candidates);
  const targets = (await eligibleTargets(tx, sponsor.organizationId, chargedAt, withdrawnFrom, now)).filter((target) => locked.has(target.id));
  const maxDays = (await tx.globalConfig.findUnique({ where: { id: 'GLOBAL' }, select: { creditPoolMaxDays: true } }))?.creditPoolMaxDays ?? DEFAULT_CREDIT_POOL_MAX_DAYS;
  const creditPoolAt = sponsor.creditPoolAt ?? now;
  const deadline = creditPoolDeadline({ paidAt: chargedAt, creditPoolAt }, maxDays);
  const expired = deadline.getTime() <= now.getTime();
  let plan: Placement[];
  if (options.manualTarget !== undefined) {
    if (expired || !targets.some((target) => target.id === options.manualTarget)) return { kind: 'NOTHING' };
    plan = [{ initiativeId: options.manualTarget, amountCents: pool }];
  } else plan = expired ? [] : planPlacement(rule, pool, targets);

  const notice = options.notice ?? 'MOVE';
  if (plan.length > 0) {
    const titles = await placeFromPool(tx, money, plan, now);
    await tx.sponsor.update({ where: { id: sponsor.id }, data: { status: 'APPROVED', creditPoolAt: null } });
    if (notice === 'MOVE') await queueSponsorNotice(tx, sponsor, 'sponsor.reassigned', `${now.toISOString()}`, { sponsorId: sponsor.id, amountCents: pool, titles: titles.slice(0, 5), more: Math.max(0, titles.length - 5) });
    return { kind: 'PLACED', titles, amountCents: pool };
  }
  // Sin campaña: espera en la bolsa. Su plazo empieza al entrar; si ya estaba en ella (renovación de la regla, nada elegible aún), se mantiene.
  if (sponsor.status !== 'CREDIT_POOL') {
    await tx.sponsor.update({ where: { id: sponsor.id }, data: { status: 'CREDIT_POOL', creditPoolAt } });
    if (notice === 'MOVE') await queueSponsorNotice(tx, sponsor, 'sponsor.creditPool', creditPoolAt.toISOString(), { sponsorId: sponsor.id, amountCents: pool, deadline: deadline.toISOString(), manual: rule === 'MANUAL' });
  }
  return { kind: 'POOLED', amountCents: pool, deadline, manual: rule === 'MANUAL' };
}

/** Email al comercio, una vez por paso (la clave lleva el momento del paso). Sale en el idioma en que pagó. */
async function queueSponsorNotice(tx: Db, sponsor: LoadedSponsor, templateKey: string, step: string, payload: Record<string, string | number | boolean | string[]>): Promise<void> {
  await tx.outboxMessage.createMany({
    data: [{ idempotencyKey: `${templateKey}:${sponsor.id}:${step}`, templateKey, locale: sponsor.contribution?.locale ?? sponsor.organization.contentLocale, toAddress: sponsor.email, organizationId: sponsor.organizationId, payloadJson: payload }],
    skipDuplicates: true
  });
}
