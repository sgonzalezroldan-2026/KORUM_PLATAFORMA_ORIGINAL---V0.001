import { releaseInitiativeQuotas } from '@/core/finance/quota-reservation';
import { returnSelfBoostToKorum } from '@/core/finance/self-boost-return';
import { notifySigners } from '@/core/jobs/notify';
import {
  cancelEventSchema,
  EventScheduleError,
  eventChangeProblem,
  latestEventDate,
  rescheduleDateFor,
  rescheduleEventSchema,
  rescheduleRefundUntil,
  statusAfterReschedule
} from '@/core/ticketing/event-schedule-rules';
import { publishedMaintenanceCents } from '@/core/ticketing/held-event';
import { gatePinExpiry } from '@/core/ticketing/gate-rules';
import { isGoalMet } from '@/core/ticketing/ticket-goal';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { SessionActor } from '@/repositories/tenant-guard';
import { recordStatusChange } from '@/services/audit/status-change-audit';
import { queueSupporterBroadcast } from '@/services/notifications/supporter-broadcast';
import { authorizeSaleChange } from './sale-change-auth';

/**
 * Cancelar un evento con entradas o cambiar su fecha (Sprint 5.13, decisión 30 del promotor; reglas en `event-schedule-rules.ts`). Lo hace una persona
 * firmante de **esa** entidad con su segundo factor; ninguna de las dos cosas lleva dinero a la entidad, así que basta una firma y la otra persona recibe
 * el aviso. Las dos bloquean la fila del evento: un cobro, un contracargo o el vencimiento que lleguen a la vez esperan su turno.
 *
 * - **Cancelar:** el Auto-Impulso que hubiera vuelve a KORUM; la portería se cierra (PIN y móviles); con ventas, `REFUNDING` y la tarea `MASS_REFUND`
 *   devuelve el 100 % de cada compra al medio de pago original, con un aviso a cada persona; sin ventas, `CANCELLED` y sus cupos de vuelta.
 * - **Cambiar la fecha:** queda el cambio (`EventReschedule`, que no se reescribe), el aviso con el enlace de devolución de 14 días sale por lotes a quien
 *   compró antes, el PIN de la portería caduca con la fecha nueva y, si no está agotado, el evento vuelve a vender hasta ella.
 */

type Action = 'event.cancel' | 'event.reschedule';

export interface EventChangeReceipt {
  initiativeId: number;
  status: 'REFUNDING' | 'CANCELLED' | 'FUNDRAISING' | 'GOAL_REACHED';
  rescheduleId?: number;
  newDate?: Date;
  refundUntil?: Date;
}

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new EventScheduleError('INVALID_INPUT');
  return parsed.data;
}

/** Solo `DIRECTOR` o `COSIGNER` de esa entidad, con el segundo factor, y solo sobre sus eventos (`sale-change-auth.ts`, compartido con las ventas de vales). */
const authorizeChange = (db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: Action, initiativeId: number, now: Date) =>
  authorizeSaleChange(db, actor, organizationId, action, initiativeId, now, (reason) => new EventScheduleError(reason));

/** Bloquea la fila del evento y comprueba que aún se pueda cambiar (evento vivo y sin liquidar). */
async function lockEvent(tx: Db, initiativeId: number) {
  await tx.initiative.updateMany({ where: { id: initiativeId }, data: { ticketsHeld: { increment: 0 } } });
  const event = await tx.initiative.findUniqueOrThrow({
    where: { id: initiativeId },
    select: {
      id: true,
      organizationId: true,
      format: true,
      ticketSubtype: true,
      status: true,
      closesAt: true,
      raisedCents: true,
      goalCents: true,
      ticketsSold: true,
      ticketMax: true,
      gatePinHash: true,
      maintFeeCents: true,
      quotaReservedMaintCents: true,
      quotaReservedAt: true,
      createdAt: true,
      payout: { select: { status: true } }
    }
  });
  const problem = eventChangeProblem({ format: event.format, ticketSubtype: event.ticketSubtype, status: event.status, payoutStatus: event.payout?.status ?? null });
  if (problem) throw new EventScheduleError(problem);
  return event as typeof event & { status: 'FUNDRAISING' | 'GOAL_REACHED' };
}

/** Cancela el evento: devuelve el 100 % a todas las personas (o lo cierra sin más si no vendió nada). Repetirlo no hace nada distinto. */
export async function cancelEvent(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<EventChangeReceipt> {
  const { initiativeId } = parse(cancelEventSchema, payload);
  const user = await authorizeChange(db, actor, organizationId, 'event.cancel', initiativeId, now);
  return inTransaction(db, async (tx) => {
    const event = await lockEvent(tx, initiativeId);
    // El Auto-Impulso no es de ninguna persona: vuelve a KORUM antes de devolver lo de quienes compraron (como al vencer una campaña).
    const selfBoostReturnedCents = await returnSelfBoostToKorum(tx, initiativeId, now, 'EVENT_CANCELLED');
    const raisedCents = event.raisedCents - selfBoostReturnedCents;
    const withSales = raisedCents > 0 || event.ticketsSold > 0;
    const to = withSales ? 'REFUNDING' : 'CANCELLED';
    const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, status: event.status }, data: { status: to, gatePinHash: null, gatePinExpiresAt: null } });
    if (count !== 1) throw new EventScheduleError('WRONG_STATUS');
    // Nadie vuelve a abrir la portería de un evento cancelado: los móviles que estaban dentro salen.
    await tx.gateSession.updateMany({ where: { initiativeId, revokedAt: null }, data: { revokedAt: now } });
    await recordStatusChange(tx, { initiativeId, organizationId, from: event.status, to, reason: 'EVENT_CANCELLED', actorUserId: user.userId });
    // Sin ventas no hay nada que devolver: los cupos se liberan ya (con ventas lo hace `MASS_REFUND` al terminar de devolver).
    if (!withSales) await releaseInitiativeQuotas(tx, initiativeId);
    await tx.auditLog.create({
      data: { actorType: 'USER', actorUserId: user.userId, organizationId, action: 'event.cancelled', targetType: 'Initiative', targetId: String(initiativeId), metadataJson: { ticketsSold: event.ticketsSold, raisedCents, selfBoostReturnedCents } }
    });
    await notifySigners(tx, organizationId, 'event.changed', `${initiativeId}:cancel`, { initiativeId, change: 'CANCELLED', ticketsSold: event.ticketsSold });
    if (withSales) await queueSupporterBroadcast(tx, initiativeId, 'event.cancelledBuyer', now);
    return { initiativeId, status: to };
  });
}

/** Cambia la fecha del evento. Cada comprador de antes del cambio recibe un enlace para recuperar el 100 % durante 14 días. */
export async function rescheduleEvent(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<EventChangeReceipt> {
  const input = parse(rescheduleEventSchema, payload);
  const user = await authorizeChange(db, actor, organizationId, 'event.reschedule', input.initiativeId, now);
  return inTransaction(db, async (tx) => {
    const event = await lockEvent(tx, input.initiativeId);
    const config = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { maxCampaignDays: true } });
    // Se publicó al reservar sus cupos (`publishInitiative`); un evento de antes de esa marca cuenta desde que se creó, que es antes: el límite es más estricto, nunca más laxo.
    const latest = latestEventDate(event.quotaReservedAt ?? event.createdAt, config.maxCampaignDays);
    const chosen = rescheduleDateFor(input.newDay, event.closesAt, latest, now);
    if ('problem' in chosen) throw new EventScheduleError(chosen.problem);
    const { newDate } = chosen;
    const refundUntil = rescheduleRefundUntil(now);
    const to = statusAfterReschedule(isGoalMet(event));
    const pinExpiresAt = event.gatePinHash ? gatePinExpiry(newDate) : null;
    await tx.initiative.update({
      where: { id: event.id },
      // Si vuelve a vender (un evento celebrado sin agotar que se aplaza), recupera el mantenimiento con el que se publicó: se ajustará otra vez al llegar la fecha nueva.
      data: { closesAt: newDate, status: to, stepIndex: to === 'GOAL_REACHED' ? 5 : 4, maintFeeCents: to === 'FUNDRAISING' ? publishedMaintenanceCents(event) : event.maintFeeCents, gatePinExpiresAt: pinExpiresAt ?? undefined }
    });
    // Con la fecha adelantada, ningún móvil sigue dentro más allá de lo que vale el PIN nuevo.
    if (pinExpiresAt) await tx.gateSession.updateMany({ where: { initiativeId: event.id, revokedAt: null, expiresAt: { gt: pinExpiresAt } }, data: { expiresAt: pinExpiresAt } });
    if (to !== event.status) await recordStatusChange(tx, { initiativeId: event.id, organizationId, from: event.status, to, reason: 'EVENT_RESCHEDULED', actorUserId: user.userId });
    const buyers = await tx.contribution.count({ where: { initiativeId: event.id, type: 'TICKET', status: 'COMPLETED' } });
    const reschedule = await tx.eventReschedule.create({
      data: { initiativeId: event.id, previousDate: event.closesAt, newDate, refundUntil, createdById: user.userId, createdAt: now },
      select: { id: true }
    });
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: user.userId,
        organizationId,
        action: 'event.rescheduled',
        targetType: 'Initiative',
        targetId: String(event.id),
        metadataJson: { rescheduleId: reschedule.id, previousDate: event.closesAt.toISOString(), newDate: newDate.toISOString(), refundUntil: refundUntil.toISOString(), purchases: buyers }
      }
    });
    await notifySigners(tx, organizationId, 'event.changed', `${event.id}:reschedule:${reschedule.id}`, { initiativeId: event.id, change: 'RESCHEDULED', newDate: newDate.toISOString(), refundUntil: refundUntil.toISOString() });
    return { initiativeId: event.id, status: to, rescheduleId: reschedule.id, newDate, refundUntil };
  });
}
