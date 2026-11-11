import { runSupporterBroadcasts } from '@/services/notifications/supporter-broadcast';
import type { JobHandler } from '../job-types';

/**
 * `SUPPORTER_BROADCAST` (Sprint 4.4a): reparte por lotes los avisos pendientes a quienes donaron a una iniciativa («¡Lo hemos conseguido!» y las fotos
 * Antes / Después). Escribe en la bandeja de salida; el envío es de `OUTBOX_DISPATCH`. Una difusión a medias sigue en la ejecución siguiente desde su cursor.
 */
export const supporterBroadcastHandler: JobHandler = async ({ db, now, batchSize, deadline, deps }) => {
  const result = await runSupporterBroadcasts(db, { now, batchSize, deadline, hmacSecret: deps.hmacSecret() });
  return { processed: result.processed, hasMore: result.hasMore, detail: { queued: result.queued } };
};
