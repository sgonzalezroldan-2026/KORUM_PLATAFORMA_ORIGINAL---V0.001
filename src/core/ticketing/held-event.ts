import { releaseInitiativeQuotas } from '@/core/finance/quota-reservation';
import type { Db } from '@/lib/db';
import { recordStatusChange } from '@/services/audit/status-change-audit';
import { heldEventMaintenanceCents } from './event-schedule-rules';
import { isGoalMet } from './ticket-goal';

/**
 * Un evento con entradas ya celebrado (su fecha pasó) que espera su liquidación por lo vendido (Sprint 5.13, decisión 30; auditoría financiera del sprint).
 * Lo vendido aún puede cambiar: un cobro que llega tarde, una devolución pedida con el enlace de un cambio de fecha o un contracargo. Tras cada uno, en la
 * misma transacción, se deja al día:
 *
 * - el **mantenimiento**, proporcional a lo vendido desde el publicado (entero si se agota), redondeando hacia abajo;
 * - y, si se queda **sin dinero**, se cierra como un evento sin ventas (`CANCELLED`) y devuelve sus cupos.
 *
 * Una liquidación ya aprobada fija las cifras: después no se toca.
 */

export const publishedMaintenanceCents = (event: { maintFeeCents: number; quotaReservedMaintCents: number }): number => (event.quotaReservedMaintCents > 0 ? event.quotaReservedMaintCents : event.maintFeeCents);

export async function syncHeldEvent(tx: Db, initiativeId: number, at: Date): Promise<void> {
  const event = await tx.initiative.findUniqueOrThrow({
    where: { id: initiativeId },
    select: { organizationId: true, format: true, status: true, closesAt: true, raisedCents: true, goalCents: true, ticketsSold: true, ticketMax: true, maintFeeCents: true, quotaReservedMaintCents: true, payout: { select: { status: true } } }
  });
  const settled = event.payout !== null && event.payout.status !== 'PENDING_DOUBLE_CHECK';
  if (event.format !== 'TICKETING' || event.status !== 'GOAL_REACHED' || event.closesAt > at || settled) return;
  if (event.raisedCents <= 0) {
    const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, status: 'GOAL_REACHED' }, data: { status: 'CANCELLED', maintFeeCents: 0 } });
    if (count !== 1) return;
    await recordStatusChange(tx, { initiativeId, organizationId: event.organizationId, from: 'GOAL_REACHED', to: 'CANCELLED', reason: 'EVENT_EMPTIED' });
    await releaseInitiativeQuotas(tx, initiativeId);
    return;
  }
  const published = publishedMaintenanceCents(event);
  const maintFeeCents = isGoalMet(event) ? published : heldEventMaintenanceCents(published, event.raisedCents, event.goalCents);
  if (maintFeeCents !== event.maintFeeCents) await tx.initiative.update({ where: { id: initiativeId }, data: { maintFeeCents } });
}
