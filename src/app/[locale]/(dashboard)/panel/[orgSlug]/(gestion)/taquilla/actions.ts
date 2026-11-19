'use server';

import { getEnv } from '@/config/env';
import { GatePinNotAllowedError, GatePinRateLimitedError, revokeGateSession, rotateGateCode, setGatePin } from '@/core/ticketing/gate-session.service';
import { EventScheduleError, type EventScheduleRejection } from '@/core/ticketing/event-schedule-rules';
import { getSessionActor } from '@/lib/auth/session';
import { dispatchOutboxSoon, dispatchRescheduleNoticesSoon, dispatchSupporterBroadcastSoon } from '@/lib/panel/outbox-soon';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError } from '@/repositories/tenant-guard';
import { cancelEvent, rescheduleEvent, type EventChangeReceipt } from '@/services/ticketing/event-schedule.service';

/**
 * Acciones de la pantalla «Taquilla y portería» (Sprint 4.5). La entidad sale de su `orgSlug` y quien actúa, de la sesión con el segundo factor superado
 * (las acciones no pasan por el `layout`); el servicio comprueba el cargo (`DIRECTOR` o `COSIGNER`) y que la iniciativa o la sesión sean de esa entidad. La
 * caducidad del PIN no se pide aquí: sale de la fecha del evento guardada en la iniciativa. Desde el Sprint 5.13, también cancelar el evento y cambiar su fecha.
 */

export type GateAdminResult = { status: 'OK'; pin?: string; expiresAt?: string } | { status: 'ERROR'; reason: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'RATE_LIMITED' };

async function context(orgSlug: unknown) {
  if (typeof orgSlug !== 'string') return null;
  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug.slice(0, 64));
  if (!organizationId) return null;
  const actor = await getSessionActor();
  if (actor.kind !== 'user' || actor.secondFactor !== true) return null;
  return { db, organizationId, actor };
}

function failure(error: unknown): GateAdminResult {
  if (error instanceof GatePinNotAllowedError) return { status: 'ERROR', reason: 'NOT_ALLOWED' };
  if (error instanceof GatePinRateLimitedError) return { status: 'ERROR', reason: 'RATE_LIMITED' };
  if (error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'NOT_FOUND' };
  if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
  throw error;
}

/** Crea el PIN de un evento (o lo cambia: las sesiones abiertas con el anterior se cierran). El PIN solo se devuelve aquí, una vez. */
export async function setGatePinAction(orgSlug: string, initiativeId: number): Promise<GateAdminResult> {
  const ctx = await context(orgSlug);
  if (!ctx || !Number.isSafeInteger(initiativeId) || initiativeId <= 0) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const { pin, expiresAt } = await setGatePin(ctx.db, getEnv().DATA_HMAC_SECRET, ctx.actor, ctx.organizationId, initiativeId);
    return { status: 'OK', pin, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    return failure(error);
  }
}

/** Cambia el enlace de la portería de un evento (el anterior deja de funcionar). */
export async function rotateGateCodeAction(orgSlug: string, initiativeId: number): Promise<GateAdminResult> {
  const ctx = await context(orgSlug);
  if (!ctx || !Number.isSafeInteger(initiativeId) || initiativeId <= 0) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    await rotateGateCode(ctx.db, ctx.actor, ctx.organizationId, initiativeId);
    return { status: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeGateSessionAction(orgSlug: string, gateSessionId: string): Promise<GateAdminResult> {
  const ctx = await context(orgSlug);
  if (!ctx || typeof gateSessionId !== 'string' || gateSessionId.length > 40) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    await revokeGateSession(ctx.db, ctx.actor, ctx.organizationId, gateSessionId);
    return { status: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

export type EventChangeResult = { status: 'OK'; outcome: EventChangeReceipt['status']; newDate?: string; refundUntil?: string } | { status: 'ERROR'; reason: EventScheduleRejection | 'FORBIDDEN' };

/**
 * Cancelar o cambiar la fecha: el servicio comprueba el cargo y el segundo factor y **anota en la auditoría** cada intento denegado, también sin segundo
 * factor (Regla 01 §4; auditoría de seguridad del 5.13): por eso aquí solo se resuelve la entidad y se pasa quien llama tal cual.
 */
async function eventContext(orgSlug: unknown) {
  if (typeof orgSlug !== 'string') return null;
  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug.slice(0, 64));
  if (!organizationId) return null;
  return { db, organizationId, actor: await getSessionActor() };
}

async function runEventChange(orgSlug: unknown, operation: (ctx: NonNullable<Awaited<ReturnType<typeof eventContext>>>) => Promise<EventChangeReceipt>): Promise<EventChangeResult> {
  const ctx = await eventContext(orgSlug);
  if (!ctx) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const receipt = await operation(ctx);
    // Avisos al momento: a la otra persona firmante y, si hay compras, a quienes compraron (los primeros ya; el resto, por lotes con la tarea).
    const notices = await ctx.db.outboxMessage.findMany({ where: { templateKey: 'event.changed', organizationId: ctx.organizationId, status: 'PENDING', idempotencyKey: { startsWith: `event.changed:${receipt.initiativeId}:` } }, select: { id: true } });
    dispatchOutboxSoon(ctx.db, notices.map((notice) => notice.id), 'outbox-after-event-change');
    if (receipt.status === 'REFUNDING') dispatchSupporterBroadcastSoon(ctx.db, getEnv().DATA_HMAC_SECRET, receipt.initiativeId, 'event.cancelledBuyer');
    if (receipt.rescheduleId !== undefined) dispatchRescheduleNoticesSoon(ctx.db, getEnv().DATA_HMAC_SECRET, receipt.rescheduleId);
    return { status: 'OK', outcome: receipt.status, ...(receipt.newDate ? { newDate: receipt.newDate.toISOString() } : {}), ...(receipt.refundUntil ? { refundUntil: receipt.refundUntil.toISOString() } : {}) };
  } catch (error) {
    if (error instanceof EventScheduleError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

/** Cancela el evento: se devuelve el 100 % a todas las personas que compraron (Sprint 5.13). */
export async function cancelEventAction(orgSlug: string, payload: unknown): Promise<EventChangeResult> {
  return runEventChange(orgSlug, (ctx) => cancelEvent(ctx.db, ctx.actor, ctx.organizationId, payload));
}

/** Cambia la fecha del evento: cada persona que compró recibe un enlace para recuperar el 100 % durante 14 días (Sprint 5.13). */
export async function rescheduleEventAction(orgSlug: string, payload: unknown): Promise<EventChangeResult> {
  return runEventChange(orgSlug, (ctx) => rescheduleEvent(ctx.db, ctx.actor, ctx.organizationId, payload));
}
