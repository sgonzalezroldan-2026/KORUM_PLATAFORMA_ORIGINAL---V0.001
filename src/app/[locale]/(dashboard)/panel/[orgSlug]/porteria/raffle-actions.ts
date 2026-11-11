'use server';

import { z } from 'zod';
import { RaffleDrawNotAllowedError, drawRaffle, type RaffleDrawBlock } from '@/core/ticketing/raffle-draw.service';
import { loadRaffleActFile, loadRaffleView, type RaffleActFile, type RaffleView } from '@/core/ticketing/raffle-state.service';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { resolveGateAccess } from './gate-request';
import type { GateActionError } from './scan-actions';

/** Pantalla del sorteo certificado (Sprint 4.5). El sorteo lo hace el servidor con `crypto.randomInt`; la pantalla solo lo pide y lo enseña. */

export type RaffleViewResult = { status: 'OK'; view: RaffleView } | { status: 'ERROR'; reason: GateActionError };
export type RaffleDrawResult = { status: 'OK'; view: RaffleView; round: number } | { status: 'BLOCKED'; reason: RaffleDrawBlock } | { status: 'ERROR'; reason: GateActionError };
export type RaffleActResult = { status: 'OK'; act: RaffleActFile } | { status: 'ERROR'; reason: GateActionError | 'NOT_FOUND' };

const drawInput = z.object({ winnersCount: z.number().int().min(1).max(100), idempotencyKey: z.string().regex(/^[\w-]{8,128}$/) });

export async function loadRaffleViewAction(eventId: number): Promise<RaffleViewResult> {
  const access = await resolveGateAccess(eventId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  try {
    return { status: 'OK', view: await loadRaffleView(access.db, access.actor, access.event) };
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'NO_SESSION' };
    throw error;
  }
}

/** La clave de idempotencia la genera la pantalla al preparar cada ronda: un doble toque o un corte de red devuelven la misma acta, nunca otro ganador. */
export async function drawRaffleAction(eventId: number, input: unknown): Promise<RaffleDrawResult> {
  const access = await resolveGateAccess(eventId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  const parsed = drawInput.safeParse(input);
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  try {
    const result = await drawRaffle(access.db, access.actor, access.event, parsed.data);
    return { status: 'OK', view: await loadRaffleView(access.db, access.actor, access.event), round: result.act.round };
  } catch (error) {
    if (error instanceof RaffleDrawNotAllowedError) return { status: 'BLOCKED', reason: error.reason };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'NO_SESSION' };
    throw error;
  }
}

export async function loadRaffleActAction(eventId: number, round: number): Promise<RaffleActResult> {
  const access = await resolveGateAccess(eventId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  if (!Number.isSafeInteger(round) || round < 1) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  try {
    const act = await loadRaffleActFile(access.db, access.actor, access.event, round);
    return act ? { status: 'OK', act } : { status: 'ERROR', reason: 'NOT_FOUND' };
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'NO_SESSION' };
    throw error;
  }
}
