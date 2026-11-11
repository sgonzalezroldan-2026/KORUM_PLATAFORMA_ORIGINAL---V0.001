'use server';

import { getEnv } from '@/config/env';
import { checkInPass, getGateSummary } from '@/core/ticketing/check-in.service';
import { buildGateList } from '@/core/ticketing/gate-list.service';
import type { GateList, ScanOutcome } from '@/core/ticketing/gate-offline';
import { scanInputSchema, syncBatchSchema } from '@/core/ticketing/gate-rules';
import { GATE_REQUEST_RULE } from '@/lib/rate-limit-rules';
import { reserveUnits } from '@/lib/rate-limit';
import { gateRequestMeta } from './gate-request';
import { ipOf } from '@/core/ticketing/gate-limits';
import { syncGateScans, toScanOutcome, type SyncItemResult } from '@/core/ticketing/gate-sync.service';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { resolveGateAccess } from './gate-request';

/**
 * Lo que el móvil de un voluntario le pide al servidor en la puerta (Sprint 4.5): leer un QR, enviar lo leído sin red, descargar la lista de pases y
 * ver el aforo. Quién es y de qué evento sale de la cookie de sesión de portería, nunca de lo que envíe el navegador (que solo dice el `eventId` que
 * ve en pantalla, y que debe coincidir con el de la sesión).
 */

export type GateSummaryView = { checkedIn: number; capacity: number };
export type GateActionError = 'NO_SESSION' | 'BUSY' | 'INVALID_INPUT' | 'FAILED';

export type ScanActionResult = { status: 'OK'; outcome: ScanOutcome; summary: GateSummaryView } | { status: 'ERROR'; reason: GateActionError };
export type SyncActionResult = { status: 'OK'; results: SyncItemResult[]; ended: boolean; summary: GateSummaryView } | { status: 'ERROR'; reason: GateActionError };
export type ListActionResult = { status: 'OK'; list: GateList; summary: GateSummaryView } | { status: 'ERROR'; reason: GateActionError };
export type SummaryActionResult = { status: 'OK'; summary: GateSummaryView } | { status: 'ERROR'; reason: GateActionError };

/** Una sesión que ya no vale (cerrada desde el panel mientras se escanea) se comunica como tal; cualquier otra cosa se deja subir. */
const asNoSession = (error: unknown): { status: 'ERROR'; reason: 'NO_SESSION' } | null => (error instanceof TenantAccessError ? { status: 'ERROR', reason: 'NO_SESSION' } : null);

export async function scanPassAction(eventId: number, input: unknown): Promise<ScanActionResult> {
  const access = await resolveGateAccess(eventId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  const parsed = scanInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  try {
    const result = await checkInPass(access.db, getEnv().QR_HMAC_SECRET, access.actor, access.event, parsed.data.payload, parsed.data.quantity);
    return { status: 'OK', outcome: toScanOutcome(result), summary: await getGateSummary(access.db, access.actor, access.event) };
  } catch (error) {
    const ended = asNoSession(error);
    if (ended) return ended;
    throw error;
  }
}

export async function syncScansAction(eventId: number, input: unknown): Promise<SyncActionResult> {
  const access = await resolveGateAccess(eventId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  // Un lote mal formado no es un fallo del servidor: la cola local del móvil no se pierde.
  const parsed = syncBatchSchema.safeParse(input);
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  // Cada lectura del lote cuenta como una petición: 100 lecturas en una sola no esquivan el límite por minuto de la red.
  const meta = await gateRequestMeta();
  if (!(await reserveUnits(access.db, `${GATE_REQUEST_RULE.prefix}${ipOf(meta)}`, GATE_REQUEST_RULE, parsed.data.scans.length))) return { status: 'ERROR', reason: 'BUSY' };
  try {
    const { results, ended } = await syncGateScans(access.db, getEnv().QR_HMAC_SECRET, access.actor, access.event, parsed.data);
    return { status: 'OK', results, ended, summary: await getGateSummary(access.db, access.actor, access.event).catch(() => ({ checkedIn: 0, capacity: 0 })) };
  } catch (error) {
    const ended = asNoSession(error);
    if (ended) return ended;
    throw error;
  }
}

export async function loadGateListAction(eventId: number): Promise<ListActionResult> {
  const access = await resolveGateAccess(eventId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  try {
    return { status: 'OK', list: await buildGateList(access.db, access.actor, access.event), summary: await getGateSummary(access.db, access.actor, access.event) };
  } catch (error) {
    const ended = asNoSession(error);
    if (ended) return ended;
    throw error;
  }
}

export async function gateSummaryAction(eventId: number): Promise<SummaryActionResult> {
  const access = await resolveGateAccess(eventId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  try {
    return { status: 'OK', summary: await getGateSummary(access.db, access.actor, access.event) };
  } catch (error) {
    const ended = asNoSession(error);
    if (ended) return ended;
    throw error;
  }
}
