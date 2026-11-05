import { dispatchOutbox } from '@/services/email/outbox-processor';
import type { JobHandler } from '../job-types';

/**
 * `OUTBOX_DISPATCH` (cada minuto con el plan Pro de Vercel; **una vez al día con el gratuito**): envía los mensajes de la bandeja de
 * salida que ya tocan. Con una sola llamada al día esta tarea es la red de seguridad: el recibo y las entradas QR salen en el propio flujo
 * del cobro (`dispatchAfterPayment`), y aquí se recogen los que fallaron, los de las tareas programadas y los que esperaban configuración.
 */
export const outboxDispatchHandler: JobHandler = async ({ db, now, batchSize, deadline, deps }) => {
  const result = await dispatchOutbox(db, deps.outbox, { now, limit: batchSize, ...(deadline === undefined ? {} : { deadline }) });
  return { processed: result.processed, hasMore: result.hasMore, detail: { sent: result.sent, retried: result.retried, failed: result.failed, cancelled: result.cancelled } };
};
