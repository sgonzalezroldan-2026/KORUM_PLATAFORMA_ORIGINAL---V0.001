import { runRescheduleNotices } from '@/services/notifications/event-reschedule-notices';
import { runSupporterBroadcasts } from '@/services/notifications/supporter-broadcast';
import type { JobHandler } from '../job-types';

/**
 * `SUPPORTER_BROADCAST` (Sprint 4.4a): reparte por lotes los avisos pendientes a quienes donaron a una iniciativa («¡Lo hemos conseguido!» y las fotos
 * Antes / Después). Escribe en la bandeja de salida; el envío es de `OUTBOX_DISPATCH`. Una difusión a medias sigue en la ejecución siguiente desde su cursor.
 * Desde el Sprint 5.13 reparte también los avisos de cambio de fecha de un evento a quienes compraron, cada uno con su enlace de devolución.
 */
export const supporterBroadcastHandler: JobHandler = async ({ db, now, batchSize, deadline, deps }) => {
  const hmacSecret = deps.hmacSecret();
  const result = await runSupporterBroadcasts(db, { now, batchSize, deadline, hmacSecret });
  if (result.hasMore) return { processed: result.processed, hasMore: true, detail: { queued: result.queued, rescheduleQueued: 0 } };
  const reschedules = await runRescheduleNotices(db, { now, batchSize, deadline, hmacSecret });
  return { processed: result.processed + reschedules.processed, hasMore: reschedules.hasMore, detail: { queued: result.queued, rescheduleQueued: reschedules.queued } };
};
