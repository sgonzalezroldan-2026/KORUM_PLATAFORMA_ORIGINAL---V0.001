import { notifySigners } from '@/core/jobs/notify';
import { raiseAlert, resolveAlertsNotIn } from '@/core/jobs/ops-alerts';
import { fundNeedsReminder, planFundPayout, splitDeadline } from '@/core/sponsors/activity-fund-rules';
import { ACTIVITY_FUND_DAY } from '@/core/sponsors/sponsor-reassignment-rules';
import { getAccountBalance } from '@/core/finance/ledger-balances';
import { inTransaction, type Db } from '@/lib/db';
import { BLOCKED_SPLIT_MESSAGES } from '@/services/payments/activity-fund-payout.service';
import { cancelPendingFundPayout, fundBalancesOf } from './activity-fund.service';
import { FAILED_INITIATIVE_STATUSES } from './sponsor-money';

/**
 * Vigilancia diaria del dinero de comercios que puede quedarse sin salida (Sprint 4.2f). Las alertas no llevan datos del comercio: identificadores,
 * importes y fechas.
 *
 * - `checkActivityFunds`: cada Fondo con saldo. Si el primer cobro vence en `FUND_REMINDER_DAYS` días o menos, recordatorio a quienes firman (una vez
 *   por fecha límite) y alerta `ACTIVITY_FUND_WINDOW` en la consola; crítica si hay dinero que ya no se puede repartir. Anula la liquidación pendiente
 *   cuyo Fondo cambió (contracargo), para que la entidad la pida de nuevo con lo que haya.
 * - `checkBlockedSponsorMoney` (heredado del 4.2d, puntos 2 y 3): un comercio cobrado que la entidad no ha admitido ni rechazado en una campaña que ya no
 *   recauda (o cuyo pago llegó con ella cerrada), y una bolsa Matching 2x de una campaña fallida que espera a devoluciones sin terminar. Su reloj corre:
 *   aviso a quienes firman la primera vez, y alerta `SPONSOR_MONEY_BLOCKED` en los últimos 20 días antes del día del Fondo.
 */

const DAY_MS = 86_400_000;
/** Días antes del día del Fondo (70 desde el cobro) en que el dinero bloqueado pasa a ser alerta en la consola. */
const BLOCKED_ALERT_DAYS = 20;

export async function checkActivityFunds(db: Db, now: Date): Promise<{ funds: number; reminded: number; cancelled: number }> {
  const rows = await db.escrowLedgerEntry.groupBy({ by: ['organizationId'], where: { account: 'ORG_ACTIVITY_FUND', organizationId: { not: null } }, _sum: { amountCents: true } });
  const result = { funds: 0, reminded: 0, cancelled: 0 };
  const active: string[] = [];
  for (const { organizationId } of rows) {
    if (organizationId === null) continue;
    const balances = await fundBalancesOf(db, organizationId);
    result.cancelled += await cancelChangedPayout(db, organizationId, balances, now);
    const plan = planFundPayout(balances, now);
    if (plan.amountCents <= 0 && plan.stuckCents <= 0) continue;
    result.funds += 1;
    if (plan.stuckCents > 0 || fundNeedsReminder(plan.deadline, now)) {
      const dedupeKey = `ACTIVITY_FUND_WINDOW:${organizationId}`;
      active.push(dedupeKey);
      await raiseAlert(
        db,
        { type: 'ACTIVITY_FUND_WINDOW', severity: plan.stuckCents > 0 ? 'CRITICAL' : 'WARNING', dedupeKey, organizationId, targetType: 'Organization', targetId: organizationId, detail: { availableCents: plan.amountCents, stuckCents: plan.stuckCents, deadline: plan.deadline?.toISOString() ?? null } },
        now
      );
    }
    if (plan.deadline && plan.amountCents > 0 && fundNeedsReminder(plan.deadline, now)) {
      const deadline = plan.deadline.toISOString();
      result.reminded += await notifySigners(db, organizationId, 'activityFund.reminder', `reminder:${deadline.slice(0, 10)}`, { amountCents: plan.amountCents, deadline });
    }
  }
  // Una liquidación ya aprobada con un reparto que reintentar no arregla (cobro contracargado o fuera de su ventana): su dinero está debido a la entidad
  // y no puede salir. Lo resuelve el Super-Admin con Paycomet (auditoría financiera del 4.2f, I1).
  const blocked = await db.activityFundPayout.findMany({
    where: { status: { in: ['APPROVED', 'PROCESSING', 'FAILED'] }, splits: { some: { status: 'FAILED', OR: BLOCKED_SPLIT_MESSAGES.map((message) => ({ errorMessage: { startsWith: message } })) } } },
    select: { id: true, organizationId: true, amountCents: true, splits: { where: { status: 'FAILED' }, select: { amountCents: true } } }
  });
  for (const payout of blocked) {
    const dedupeKey = `ACTIVITY_FUND_WINDOW:payout:${payout.id}`;
    active.push(dedupeKey);
    await raiseAlert(
      db,
      { type: 'ACTIVITY_FUND_WINDOW', severity: 'CRITICAL', dedupeKey, organizationId: payout.organizationId, targetType: 'ActivityFundPayout', targetId: String(payout.id), detail: { reason: 'SPLIT_BLOCKED', amountCents: payout.amountCents, blockedCents: payout.splits.reduce((sum, split) => sum + split.amountCents, 0) } },
      now
    );
  }
  // Firmada con las firmas que exige la entidad (las dos, o solo la de Dirección con firma única) pero sin aprobar (el KYB dejó de estar verificado, falta
  // la cuenta destino): la tarea lo reintenta cada día, pero el día 90 se acerca. Con la misma antelación que el recordatorio, alerta en la consola
  // (reauditoría financiera del 4.2f). Mismo criterio que `resumeFundPayouts`.
  const signedWaiting = await db.activityFundPayout.findMany({
    where: {
      status: 'PENDING_DOUBLE_CHECK',
      signatures: { some: { signerRole: 'DIRECTOR' } },
      OR: [{ organization: { signatureMode: 'SINGLE' } }, { signatures: { some: { signerRole: 'COSIGNER' } } }]
    },
    select: { id: true, organizationId: true, amountCents: true, splits: { select: { contribution: { select: { createdAt: true } } } } }
  });
  for (const payout of signedWaiting) {
    const first = Math.min(...payout.splits.map((split) => split.contribution.createdAt.getTime()));
    const deadline = Number.isFinite(first) ? splitDeadline(new Date(first)) : null;
    if (!fundNeedsReminder(deadline, now)) continue;
    const dedupeKey = `ACTIVITY_FUND_WINDOW:payout:${payout.id}`;
    active.push(dedupeKey);
    await raiseAlert(
      db,
      { type: 'ACTIVITY_FUND_WINDOW', severity: 'CRITICAL', dedupeKey, organizationId: payout.organizationId, targetType: 'ActivityFundPayout', targetId: String(payout.id), detail: { reason: 'SIGNED_NOT_APPROVED', amountCents: payout.amountCents, deadline: deadline?.toISOString() ?? null } },
      now
    );
  }
  await resolveAlertsNotIn(db, 'ACTIVITY_FUND_WINDOW', active, now);
  return result;
}

/** Una liquidación que espera la doble firma y cuyo Fondo ya no tiene lo que se pidió (un contracargo) se anula: no se podría aprobar. */
async function cancelChangedPayout(db: Db, organizationId: string, balances: Awaited<ReturnType<typeof fundBalancesOf>>, now: Date): Promise<number> {
  const pending = await db.activityFundPayout.findFirst({ where: { organizationId, status: 'PENDING_DOUBLE_CHECK' }, select: { id: true, splits: { select: { sponsorId: true, amountCents: true } } } });
  if (!pending) return 0;
  const bySponsor = new Map(balances.map((entry) => [entry.sponsorId, entry.balanceCents]));
  if (pending.splits.every((split) => (bySponsor.get(split.sponsorId) ?? 0) >= split.amountCents)) return 0;
  const cancelled = await inTransaction(db, async (tx) => {
    if (!(await cancelPendingFundPayout(tx, pending.id, 'FUND_CHANGED', now))) return false;
    await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId, action: 'activity_fund.payout_cancelled', targetType: 'ActivityFundPayout', targetId: String(pending.id), metadataJson: { reason: 'FUND_CHANGED' } } });
    return true;
  });
  return cancelled ? 1 : 0;
}

export async function checkBlockedSponsorMoney(db: Db, now: Date, limit: number): Promise<{ awaiting: number; alerts: number }> {
  const charged = { paidAt: { not: null }, contribution: { status: 'COMPLETED' as const } };
  const [undecided, matching] = await Promise.all([
    // Cobrados sin decidir con la campaña ya fuera de juego, o con el pago llegado con ella cerrada (su dinero ya está en la bolsa).
    db.sponsor.findMany({
      where: { ...charged, status: 'PENDING', OR: [{ initiative: { status: { in: [...FAILED_INITIATIVE_STATUSES] } } }, { reassignedCents: { gt: 0 } }] },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, organizationId: true, amountCents: true, contribution: { select: { createdAt: true } } }
    }),
    db.sponsor.findMany({
      where: {
        ...charged,
        status: 'APPROVED',
        isMatchingPool: true,
        reassignedCents: { lt: db.sponsor.fields.amountCents },
        initiative: { status: { in: [...FAILED_INITIATIVE_STATUSES] }, contributions: { some: { OR: [{ status: 'REFUND_PENDING' }, { status: 'COMPLETED', type: { in: ['DONATION', 'TICKET'] } }] } } }
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, organizationId: true, initiativeId: true, amountCents: true, contribution: { select: { createdAt: true } } }
    })
  ]);
  const active: string[] = [];
  let awaiting = 0;
  const nearFundDay = (chargedAt: Date) => now.getTime() >= chargedAt.getTime() + (ACTIVITY_FUND_DAY - BLOCKED_ALERT_DAYS) * DAY_MS;
  for (const sponsor of undecided) {
    if (!sponsor.contribution) continue;
    const deadline = new Date(sponsor.contribution.createdAt.getTime() + ACTIVITY_FUND_DAY * DAY_MS).toISOString();
    awaiting += await notifySigners(db, sponsor.organizationId, 'sponsor.awaitingDecision', `sponsor:${sponsor.id}`, { sponsorId: sponsor.id, amountCents: sponsor.amountCents, deadline });
    if (!nearFundDay(sponsor.contribution.createdAt)) continue;
    const dedupeKey = `SPONSOR_MONEY_BLOCKED:${sponsor.id}`;
    active.push(dedupeKey);
    // Pasado el día del Fondo, decidir ya solo deja días de firma muy justos (o ninguno): crítica.
    const severity = now.getTime() >= new Date(deadline).getTime() ? 'CRITICAL' : 'WARNING';
    await raiseAlert(db, { type: 'SPONSOR_MONEY_BLOCKED', severity, dedupeKey, organizationId: sponsor.organizationId, targetType: 'Sponsor', targetId: String(sponsor.id), detail: { reason: 'AWAITING_DECISION', amountCents: sponsor.amountCents, deadline } }, now);
  }
  for (const sponsor of matching) {
    if (!sponsor.contribution || sponsor.initiativeId === null || !nearFundDay(sponsor.contribution.createdAt)) continue;
    const { balanceCents } = await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: sponsor.initiativeId, sponsorId: sponsor.id });
    if (balanceCents <= 0) continue;
    const dedupeKey = `SPONSOR_MONEY_BLOCKED:${sponsor.id}`;
    active.push(dedupeKey);
    await raiseAlert(
      db,
      { type: 'SPONSOR_MONEY_BLOCKED', severity: 'WARNING', dedupeKey, organizationId: sponsor.organizationId, targetType: 'Sponsor', targetId: String(sponsor.id), detail: { reason: 'REFUNDS_PENDING', matchingCents: balanceCents, initiativeId: sponsor.initiativeId } },
      now
    );
  }
  // Con los lotes llenos, la lista no está completa: no se cierra nada que pueda seguir bloqueado.
  if (undecided.length < limit && matching.length < limit) await resolveAlertsNotIn(db, 'SPONSOR_MONEY_BLOCKED', active, now);
  return { awaiting, alerts: active.length };
}
