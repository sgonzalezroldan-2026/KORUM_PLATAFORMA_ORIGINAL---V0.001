import { releaseInitiativeQuotas } from '@/core/finance/quota-reservation';
import type { Db } from '@/lib/db';
import { recordStatusChange } from '@/services/audit/status-change-audit';
import { heldEventMaintenanceCents } from './event-schedule-rules';
import { isGoalMet } from './ticket-goal';
import { voucherSaleMaintenanceCents } from './voucher-lifecycle-rules';

/**
 * Un evento con entradas ya celebrado (su fecha pasó) que espera su liquidación por lo vendido (Sprint 5.13, decisión 30; auditoría financiera del sprint).
 * Lo vendido aún puede cambiar: un cobro que llega tarde, una devolución pedida con el enlace de un cambio de fecha o un contracargo. Tras cada uno, en la
 * misma transacción, se deja al día:
 *
 * - el **mantenimiento**, proporcional a lo vendido desde el publicado (entero si se agota), redondeando hacia abajo;
 * - y, si se queda **sin dinero**, se cierra como un evento sin ventas (`CANCELLED`) y devuelve sus cupos.
 *
 * Una liquidación ya aprobada fija las cifras: después no se toca.
 *
 * Una **venta de vales** cerrada (Sprint 5.14c) es lo mismo, con su propia medida: el mantenimiento va en proporción a los vales vendidos sobre el tope o el
 * objetivo (decisión 66), no al dinero, que incluye las aportaciones «sin producto».
 */

export const publishedMaintenanceCents = (event: { maintFeeCents: number; quotaReservedMaintCents: number }): number => (event.quotaReservedMaintCents > 0 ? event.quotaReservedMaintCents : event.maintFeeCents);

export interface HeldSale {
  format: string;
  ticketSubtype: string | null;
  raisedCents: number;
  goalCents: number;
  ticketsSold: number;
  ticketMax: number | null;
  voucherTargetCount: number | null;
  maintFeeCents: number;
  quotaReservedMaintCents: number;
}

/** Mantenimiento de un evento celebrado o de una venta de vales cerrada que se liquida por lo vendido, desde el publicado y hacia abajo. */
export function heldMaintenanceCents(sale: HeldSale, raisedCents: number = sale.raisedCents): number {
  const published = publishedMaintenanceCents(sale);
  if (sale.ticketSubtype === 'VOUCHER') return raisedCents > 0 ? voucherSaleMaintenanceCents(published, sale) : 0;
  return isGoalMet({ ...sale, raisedCents }) ? published : heldEventMaintenanceCents(published, raisedCents, sale.goalCents);
}

export async function syncHeldEvent(tx: Db, initiativeId: number, at: Date): Promise<void> {
  const event = await tx.initiative.findUniqueOrThrow({
    where: { id: initiativeId },
    select: { organizationId: true, format: true, ticketSubtype: true, status: true, closesAt: true, raisedCents: true, goalCents: true, ticketsSold: true, ticketMax: true, voucherTargetCount: true, maintFeeCents: true, quotaReservedMaintCents: true, payout: { select: { status: true } } }
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
  const maintFeeCents = heldMaintenanceCents(event);
  if (maintFeeCents !== event.maintFeeCents) await tx.initiative.update({ where: { id: initiativeId }, data: { maintFeeCents } });
}
