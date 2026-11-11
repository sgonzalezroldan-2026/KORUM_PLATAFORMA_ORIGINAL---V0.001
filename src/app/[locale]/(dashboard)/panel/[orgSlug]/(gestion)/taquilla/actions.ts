'use server';

import { getEnv } from '@/config/env';
import { GatePinNotAllowedError, revokeGateSession, rotateGateCode, setGatePin } from '@/core/ticketing/gate-session.service';
import { drawRaffle, RaffleDrawNotAllowedError, type RaffleDrawBlock } from '@/core/ticketing/raffle-draw.service';
import { loadRaffleActFile, type RaffleActFile } from '@/core/ticketing/raffle-state.service';
import { dispatchOutboxSoon } from '@/lib/panel/outbox-soon';
import { z } from 'zod';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError } from '@/repositories/tenant-guard';

/**
 * Acciones de la pantalla «Taquilla y portería» (Sprint 4.5). La entidad sale de su `orgSlug` y quien actúa, de la sesión con el segundo factor superado
 * (las acciones no pasan por el `layout`); el servicio comprueba el cargo (`DIRECTOR` o `COSIGNER`) y que la iniciativa o la sesión sean de esa entidad. La
 * caducidad del PIN no se pide aquí: sale de la fecha del evento guardada en la iniciativa.
 */

export type GateAdminResult = { status: 'OK'; pin?: string; expiresAt?: string } | { status: 'ERROR'; reason: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_ALLOWED' };

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

const extraInput = z.object({ reason: z.enum(['PRIZE_UNCLAIMED', 'WINNER_REFUNDED']), replacesNumbers: z.array(z.number().int().positive()).min(1).max(100), idempotencyKey: z.string().regex(/^[\w-]{8,128}$/) });

export type ExtraRoundResult = { status: 'OK'; round: number; numbers: number[]; notified: number } | { status: 'BLOCKED'; reason: RaffleDrawBlock } | { status: 'ERROR'; reason: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_INPUT' };

/**
 * Ronda extra de una rifa (Sprint 4.6): sustituye un premio sin reclamar o el de un ganador reembolsado. La hace **una sola** persona firmante con segundo factor
 * (decisión del promotor, 2026-11-11: sin doble firma); el motor comprueba cargo, entidad, motivo y límites, y la otra persona firmante recibe un aviso. La clave de
 * idempotencia la genera la pantalla al preparar la ronda: un doble toque devuelve la misma acta.
 */
export async function drawExtraRoundAction(orgSlug: string, initiativeId: number, input: unknown): Promise<ExtraRoundResult> {
  const ctx = await context(orgSlug);
  const parsed = extraInput.safeParse(input);
  if (!ctx || !Number.isSafeInteger(initiativeId) || initiativeId <= 0) return { status: 'ERROR', reason: 'FORBIDDEN' };
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  try {
    const result = await drawRaffle(ctx.db, ctx.actor, { organizationId: ctx.organizationId, initiativeId }, { winnersCount: parsed.data.replacesNumbers.length, replacesNumbers: parsed.data.replacesNumbers, idempotencyKey: parsed.data.idempotencyKey, extraRoundReason: parsed.data.reason });
    dispatchOutboxSoon(ctx.db, result.outboxIds, 'outbox-after-raffle-extra-round');
    return { status: 'OK', round: result.act.round, numbers: result.act.winningNumbers, notified: result.notified };
  } catch (error) {
    if (error instanceof RaffleDrawNotAllowedError) return { status: 'BLOCKED', reason: error.reason };
    if (error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'NOT_FOUND' };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

export type RaffleActFileResult = { status: 'OK'; act: RaffleActFile } | { status: 'ERROR'; reason: 'FORBIDDEN' | 'NOT_FOUND' };

/** El acta de una ronda (normal o extra) para descargarla desde el panel: solo números y series, sin datos de nadie. */
export async function downloadRaffleActAction(orgSlug: string, initiativeId: number, round: number): Promise<RaffleActFileResult> {
  const ctx = await context(orgSlug);
  if (!ctx || !Number.isSafeInteger(initiativeId) || initiativeId <= 0 || !Number.isSafeInteger(round) || round < 1) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const act = await loadRaffleActFile(ctx.db, ctx.actor, { organizationId: ctx.organizationId, initiativeId }, round);
    return act ? { status: 'OK', act } : { status: 'ERROR', reason: 'NOT_FOUND' };
  } catch (error) {
    if (error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'NOT_FOUND' };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}
