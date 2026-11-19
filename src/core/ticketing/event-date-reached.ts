import { releaseInitiativeQuotas } from '@/core/finance/quota-reservation';
import { returnSelfBoostToKorum } from '@/core/finance/self-boost-return';
import { notifySigners } from '@/core/jobs/notify';
import type { Db } from '@/lib/db';
import { recordStatusChange } from '@/services/audit/status-change-audit';
import { eventOutcomeAtDate, heldEventMaintenanceCents } from './event-schedule-rules';
import { publishedMaintenanceCents } from './held-event';

/**
 * Un evento con entradas que llega a su fecha sin agotar el aforo (Sprint 5.13, decisión 30 del promotor). Antes pasaba a «vencido» y solo se podía
 * devolver, aunque la gente ya tuviera su entrada y el evento se celebrara: ahora **se liquida por lo vendido**.
 *
 * - Con dinero de entradas: `GOAL_REACHED`, liquidable con la doble firma de siempre (`approvePayout` ya admite un evento celebrado sin la meta). El
 *   mantenimiento baja en proporción a lo vendido (decisión del 2026-11-19); después lo mantiene al día `syncHeldEvent`.
 * - Sin nada vendido: `CANCELLED`, sin dinero que mover, y los cupos vuelven a la entidad. Si queda un pago **en curso** (una reserva de plaza que aún no
 *   ha caducado), se espera a la ejecución siguiente: esa persona pagó antes de la fecha y su entrada debe valer (auditoría financiera del 5.13).
 * - El Auto-Impulso que quedara (una campaña completada por KORUM y reabierta por un contracargo) vuelve a KORUM, como al vencer cualquier campaña: KORUM
 *   aportó para completar una meta que el evento no tiene.
 *
 * Lo llama `CAMPAIGN_EXPIRY` dentro de su transacción, con la fila bloqueada y ya comprobado que está `FUNDRAISING`, su fecha ha pasado y no está agotado.
 */

export interface DueEvent {
  id: number;
  organizationId: string;
  raisedCents: number;
  goalCents: number;
  ticketsSold: number;
  maintFeeCents: number;
  quotaReservedMaintCents: number;
  walletEscrowId: string;
}

export async function closeEventAtDate(tx: Db, event: DueEvent, now: Date): Promise<'SETTLE' | 'CLOSE_EMPTY' | null> {
  if (event.ticketsSold === 0) {
    const paying = await tx.contribution.count({ where: { initiativeId: event.id, type: 'TICKET', status: 'PENDING', ticketHoldUntil: { gt: now } } });
    if (paying > 0) return null;
  }
  const selfBoostReturnedCents = await returnSelfBoostToKorum(tx, event.id, now, 'EVENT_HELD');
  const raisedCents = event.raisedCents - selfBoostReturnedCents;
  const outcome = eventOutcomeAtDate(raisedCents);
  const to = outcome === 'SETTLE' ? 'GOAL_REACHED' : 'CANCELLED';
  const maintFeeCents = heldEventMaintenanceCents(publishedMaintenanceCents(event), raisedCents, event.goalCents);
  const { count } = await tx.initiative.updateMany({
    where: { id: event.id, status: 'FUNDRAISING' },
    data: { status: to, stepIndex: outcome === 'SETTLE' ? 5 : 4, maintFeeCents: outcome === 'SETTLE' ? maintFeeCents : event.maintFeeCents }
  });
  // Quien llama tiene la fila bloqueada y comprobada: si no cambia, algo va mal y nada de lo anterior (el Auto-Impulso devuelto) debe quedar.
  if (count !== 1) throw new Error(`El evento ${event.id} ha cambiado de estado mientras llegaba su fecha.`);
  await recordStatusChange(tx, { initiativeId: event.id, organizationId: event.organizationId, from: 'FUNDRAISING', to, reason: 'EVENT_DATE_REACHED' });
  if (outcome === 'CLOSE_EMPTY') await releaseInitiativeQuotas(tx, event.id);
  await tx.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      organizationId: event.organizationId,
      action: 'event.date_reached',
      targetType: 'Initiative',
      targetId: String(event.id),
      metadataJson: { outcome, ticketsSold: event.ticketsSold, raisedCents, goalCents: event.goalCents, maintFeeCents: outcome === 'SETTLE' ? maintFeeCents : 0, selfBoostReturnedCents }
    }
  });
  await notifySigners(tx, event.organizationId, 'event.dateReached', String(event.id), { initiativeId: event.id, walletEscrowId: event.walletEscrowId, outcome, ticketsSold: event.ticketsSold, raisedCents });
  return outcome;
}
