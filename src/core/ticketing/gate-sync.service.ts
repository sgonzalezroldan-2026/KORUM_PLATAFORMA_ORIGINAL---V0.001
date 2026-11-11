import type { z } from 'zod';
import type { KorumPrismaClient } from '@/lib/prisma';
import { recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { checkInPass, type CheckInResult, type EventRef } from './check-in.service';
import type { ScanOutcome } from './gate-offline';
import { syncBatchSchema } from './gate-rules';

/**
 * Sincronización de las lecturas hechas sin cobertura (QA-S04). Cada una pasa por el mismo `checkInPass` que una lectura en directo, así que el servidor
 * decide: si otro móvil ya había dejado entrar ese pase, la lectura vuelve como conflicto (`EXHAUSTED`, `INSUFFICIENT`…) y el voluntario lo ve. Reenviar la
 * cola entera no deja entrar dos veces (`clientScanId`). Se procesan en orden: lo leído antes entra antes.
 */

export type SyncBatchInput = z.input<typeof syncBatchSchema>;

export interface SyncItemResult {
  clientScanId: string;
  outcome: ScanOutcome;
}

/** Del resultado del servidor a lo que se envía al móvil (fechas en milisegundos). */
export function toScanOutcome(result: CheckInResult): ScanOutcome {
  switch (result.status) {
    case 'ACCEPTED':
      return { status: 'ACCEPTED', entered: result.entered, remaining: result.remaining, quantity: result.quantity, serial: result.serialCode };
    case 'CHOOSE':
      return { status: 'CHOOSE', remaining: result.remaining, quantity: result.quantity, serial: result.serialCode };
    case 'INSUFFICIENT':
      return { status: 'INSUFFICIENT', remaining: result.remaining, quantity: result.quantity, firstAccessAt: result.firstAccessAt?.getTime() ?? null };
    case 'EXHAUSTED':
      return { status: 'EXHAUSTED', quantity: result.quantity, firstAccessAt: result.firstAccessAt?.getTime() ?? null };
    default:
      return result;
  }
}

export interface SyncBatchResult {
  results: SyncItemResult[];
  /** La sesión dejó de valer a mitad del lote: lo ya procesado se devuelve (y se quita de la cola del móvil), lo demás queda para enviarlo tras volver a entrar. */
  ended: boolean;
}

export async function syncGateScans(db: KorumPrismaClient, qrSecret: string, actor: SessionActor, event: EventRef, input: unknown, now: Date = new Date()): Promise<SyncBatchResult> {
  const batch = syncBatchSchema.parse(input);
  const results: SyncItemResult[] = [];
  let ended = false;
  for (const scan of batch.scans) {
    try {
      const result = await checkInPass(db, qrSecret, actor, event, scan.payload, scan.quantity, now, { clientScanId: scan.clientScanId, offline: true, scannedAt: new Date(scan.scannedAt) });
      results.push({ clientScanId: scan.clientScanId, outcome: toScanOutcome(result) });
    } catch (error) {
      // Una sesión cerrada a mitad de lote: lo ya anotado no se pierde (si la respuesta se perdiera, reenviarlo no cuenta dos veces: `clientScanId` vale en todo el evento).
      if (!(error instanceof TenantAccessError) || results.length === 0) throw error;
      ended = true;
      break;
    }
  }
  const conflicts = results.filter((item) => item.outcome.status !== 'ACCEPTED' && item.outcome.status !== 'DUPLICATE_SCAN').length;
  const accepted = results.filter((item) => item.outcome.status === 'ACCEPTED').length;
  // Un lote que solo repite lecturas ya recibidas (reenvío de la cola) no deja fila: la auditoría no se puede purgar.
  if (accepted > 0 || conflicts > 0 || ended) await recordAudit(db, actor, {
    action: 'gate.sync',
    organizationId: event.organizationId,
    targetType: 'Initiative',
    targetId: String(event.initiativeId),
    metadata: { scans: results.length, accepted, conflicts, ended, listGeneratedAt: batch.listGeneratedAt ?? null, listKnown: batch.listGeneratedAt !== undefined }
  });
  return { results, ended };
}
