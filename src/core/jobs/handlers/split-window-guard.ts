import { evaluateSplitWindow, SPLIT_WINDOW_DAYS, SPLIT_WINDOW_WARNING_DAYS } from '@/core/finance/campaign-window';
import { planExpiredReminder, VOTE_CLOSING_NOTICE_DAYS } from '@/core/resize/expired-reminder';
import { RESIZE_MIN_WINDOW_DAYS, windowDaysLeft } from '@/core/resize/resize-rules';
import type { Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { resumeCampaignPayouts } from '@/services/payments/campaign-payout-settlement';
import type { JobHandler } from '../job-types';
import { notifySigners } from '../notify';
import { raiseAlert, resolveAlertsNotIn } from '../ops-alerts';

const DAY_MS = 86_400_000;
/** Iniciativas cuyo dinero aún puede acabar repartido a la entidad: una vez liquidada o devuelta, la ventana ya no importa. */
const AT_RISK_STATUSES = ['FUNDRAISING', 'GOAL_REACHED', 'EXPIRED', 'RESIZE_VOTING'] as const;

/**
 * `SPLIT_WINDOW_GUARD` (QA-P04): Paycomet solo reparte fondos durante 90 días desde cada cobro. Cuando faltan 15 o menos para que venza la
 * del primer cobro de una iniciativa sin liquidar, se avisa a la entidad (una vez) y se abre una alerta para el Super-Admin; si ya venció,
 * la alerta es crítica. La alerta se cierra sola cuando la iniciativa se liquida, se devuelve o se cancela.
 *
 * Antes, reanuda las liquidaciones de campaña pendientes (Sprint 4.4a): aprueba las que tienen dos firmas, replanifica los repartos bloqueados y reenvía.
 *
 * Una campaña vencida (`EXPIRED`) no se liquida: se decide (votar o devolver). Desde el Sprint 5.5b no recibe el aviso genérico «liquidad ya», sino el recordatorio
 * escalado de `remindExpiredDecisions` (y su alerta `EXPIRED_DECISION_PENDING` en la consola), que sigue abajo.
 */
export const splitWindowGuardHandler: JobHandler = async ({ db, now, batchSize, deps }) => {
  const pendingPayouts = await db.escrowPayout.count({ where: { OR: [{ status: { in: ['APPROVED', 'PROCESSING', 'FAILED'] } }, { status: 'PENDING_DOUBLE_CHECK', signatures: { some: {} } }] } });
  let resumed = { executed: 0, pending: 0, errors: 0 };
  // Un fallo al reanudar (Paycomet sin configurar, un error inesperado) se informa y no impide los avisos de la ventana, que son lo urgente.
  if (pendingPayouts > 0) {
    try {
      resumed = await resumeCampaignPayouts(db, await deps.paymentProvider(), { secret: deps.hmacSecret(), keyring: deps.keyring() }, now, batchSize);
    } catch (error) {
      reportError(error, { stage: 'split-window-guard-resume' });
      resumed.errors += 1;
    }
  }
  const threshold = new Date(now.getTime() - (SPLIT_WINDOW_DAYS - SPLIT_WINDOW_WARNING_DAYS) * DAY_MS);
  const initiatives = await db.initiative.findMany({
    where: { status: { in: [...AT_RISK_STATUSES] }, firstPayinAt: { not: null, lte: threshold }, NOT: { payout: { is: { status: 'EXECUTED' } } } },
    orderBy: { firstPayinAt: 'asc' },
    select: { id: true, organizationId: true, status: true, walletEscrowId: true, firstPayinAt: true, raisedCents: true }
  });

  const activeKeys: string[] = [];
  let expired = 0;
  for (const initiative of initiatives) {
    if (!initiative.firstPayinAt) continue;
    const window = evaluateSplitWindow(initiative.firstPayinAt, now);
    if (!window.shouldWarn) continue;
    const dedupeKey = `SPLIT_WINDOW_EXPIRING:${initiative.id}`;
    activeKeys.push(dedupeKey);
    if (window.expired) expired += 1;
    await raiseAlert(
      db,
      { type: 'SPLIT_WINDOW_EXPIRING', severity: window.expired ? 'CRITICAL' : 'WARNING', dedupeKey, organizationId: initiative.organizationId, targetType: 'Initiative', targetId: String(initiative.id), detail: { daysLeft: window.daysLeft, expired: window.expired, raisedCents: initiative.raisedCents } },
      now
    );
    if (initiative.status === 'EXPIRED') continue;
    await notifySigners(db, initiative.organizationId, window.expired ? 'split.windowExpired' : 'split.windowExpiring', String(initiative.id), {
      initiativeId: initiative.id,
      walletEscrowId: initiative.walletEscrowId,
      daysLeft: window.daysLeft
    });
  }
  await resolveAlertsNotIn(db, 'SPLIT_WINDOW_EXPIRING', activeKeys, now);
  const reminders = await remindExpiredDecisions(db, now);
  return {
    processed: Math.min(activeKeys.length, batchSize),
    hasMore: false,
    detail: { warned: activeKeys.length, expired, payoutsExecuted: resumed.executed, payoutsPending: resumed.pending, payoutErrors: resumed.errors, expiredReminders: reminders.reminded, expiredAlerts: reminders.alerts }
  };
};

/**
 * Recordatorio escalado de las campañas vencidas sin decidir (Sprint 5.5b, heredado del 4.4b): a quienes firman, una vez por etapa (`expired.decisionReminder`),
 * y alerta para el Super-Admin a 14 días (crítica a 7). La alerta se cierra sola en cuanto la entidad decide (la campaña deja de estar `EXPIRED`).
 */
export async function remindExpiredDecisions(db: Db, now: Date): Promise<{ reminded: number; alerts: number }> {
  // Desde aquí puede tocar algún aviso: el de «últimos días para votar» llega antes que la alerta de la ventana.
  const horizon = new Date(now.getTime() - (SPLIT_WINDOW_DAYS - (RESIZE_MIN_WINDOW_DAYS + VOTE_CLOSING_NOTICE_DAYS)) * DAY_MS);
  const initiatives = await db.initiative.findMany({
    where: { status: 'EXPIRED', firstPayinAt: { not: null, lte: horizon } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      organizationId: true,
      format: true,
      walletEscrowId: true,
      firstPayinAt: true,
      resizePoll: { select: { id: true } },
      _count: { select: { contributions: { where: { type: 'DONATION', status: 'COMPLETED' } } } }
    }
  });
  const activeKeys: string[] = [];
  let reminded = 0;
  for (const initiative of initiatives) {
    if (!initiative.firstPayinAt) continue;
    const expiredAudit = await db.auditLog.findFirst({ where: { action: 'initiative.expired', targetType: 'Initiative', targetId: String(initiative.id) }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } });
    const daysLeft = windowDaysLeft(initiative.firstPayinAt, now);
    const plan = planExpiredReminder({
      windowDaysLeft: daysLeft,
      voteEligible: initiative.format === 'BUDGET' && initiative.resizePoll === null && initiative._count.contributions > 0,
      expiredAt: expiredAudit?.occurredAt ?? null,
      now
    });
    if (plan.alert !== 'NONE') {
      const dedupeKey = `EXPIRED_DECISION_PENDING:${initiative.id}`;
      activeKeys.push(dedupeKey);
      await raiseAlert(
        db,
        { type: 'EXPIRED_DECISION_PENDING', severity: plan.alert, dedupeKey, organizationId: initiative.organizationId, targetType: 'Initiative', targetId: String(initiative.id), detail: { daysLeft } },
        now
      );
    }
    if (plan.stage === null) continue;
    reminded += await notifySigners(db, initiative.organizationId, 'expired.decisionReminder', `${initiative.id}:${plan.stage}`, {
      initiativeId: initiative.id,
      walletEscrowId: initiative.walletEscrowId,
      daysLeft,
      canVote: plan.canVote,
      voteDaysLeft: plan.voteDaysLeft ?? 0,
      urgent: plan.alert === 'CRITICAL'
    });
  }
  await resolveAlertsNotIn(db, 'EXPIRED_DECISION_PENDING', activeKeys, now);
  return { reminded, alerts: activeKeys.length };
}
