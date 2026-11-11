import { evaluateSplitWindow, SPLIT_WINDOW_DAYS, SPLIT_WINDOW_WARNING_DAYS } from '@/core/finance/campaign-window';
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
    select: { id: true, organizationId: true, walletEscrowId: true, firstPayinAt: true, raisedCents: true }
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
    await notifySigners(db, initiative.organizationId, window.expired ? 'split.windowExpired' : 'split.windowExpiring', String(initiative.id), {
      initiativeId: initiative.id,
      walletEscrowId: initiative.walletEscrowId,
      daysLeft: window.daysLeft
    });
  }
  await resolveAlertsNotIn(db, 'SPLIT_WINDOW_EXPIRING', activeKeys, now);
  return { processed: Math.min(activeKeys.length, batchSize), hasMore: false, detail: { warned: activeKeys.length, expired, payoutsExecuted: resumed.executed, payoutsPending: resumed.pending, payoutErrors: resumed.errors } };
};
