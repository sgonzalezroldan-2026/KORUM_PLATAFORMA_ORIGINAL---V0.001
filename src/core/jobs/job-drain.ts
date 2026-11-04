import type { JobResult } from './job-types';

/**
 * Vaciado de lotes dentro de una misma ejecución. En el plan gratuito de Vercel cada tarea se llama una sola vez al día: si cada llamada
 * tratara un único lote, 25 devoluciones al día tardarían semanas en vaciar una campaña grande. Mientras el manejador diga que quedan
 * más (`hasMore`), haya avanzado en el último lote y quede tiempo, se le vuelve a llamar. Los manejadores ya son idempotentes por lote
 * (cada uno recoge lo que sigue pendiente), así que repetirlos es lo mismo que esperar a la siguiente llamada.
 */

/** Tope de lotes por ejecución: protege de un manejador que anunciase siempre «quedan más». */
export const MAX_BATCHES_PER_EXECUTION = 40;
/** Margen antes del límite de la llamada para no empezar un lote que no cabe. */
export const DRAIN_MARGIN_MS = 30_000;

function mergeDetail(total: Record<string, number> | undefined, next: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!total) return next;
  if (!next) return total;
  const merged = { ...total };
  for (const [key, value] of Object.entries(next)) merged[key] = (merged[key] ?? 0) + value;
  return merged;
}

export async function drainBatches(runBatch: () => Promise<JobResult>, deadline: number, clock: () => number = Date.now): Promise<JobResult> {
  let last = await runBatch();
  let processed = last.processed;
  let detail = last.detail;
  for (let batches = 1; last.hasMore && last.processed > 0 && batches < MAX_BATCHES_PER_EXECUTION && clock() < deadline - DRAIN_MARGIN_MS; batches += 1) {
    last = await runBatch();
    processed += last.processed;
    detail = mergeDetail(detail, last.detail);
  }
  return detail === undefined ? { processed, hasMore: last.hasMore } : { processed, hasMore: last.hasMore, detail };
}
