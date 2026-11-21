import { runRescheduleNotices } from '@/services/notifications/event-reschedule-notices';
import { runPrivacyPolicyNotices } from '@/services/notifications/privacy-policy-notices';
import { runSupporterBroadcasts } from '@/services/notifications/supporter-broadcast';
import { queueDueVoucherReminders } from '@/services/notifications/voucher-broadcasts';
import type { JobHandler } from '../job-types';

/**
 * `SUPPORTER_BROADCAST` (Sprint 4.4a): reparte por lotes los avisos pendientes a quienes donaron a una iniciativa («¡Lo hemos conseguido!» y las fotos
 * Antes / Después). Escribe en la bandeja de salida; el envío es de `OUTBOX_DISPATCH`. Una difusión a medias sigue en la ejecución siguiente desde su cursor.
 * Desde el Sprint 5.13 reparte también los avisos de cambio de fecha de un evento a quienes compraron, cada uno con su enlace de devolución. Desde el 5.14c,
 * antes de repartir deja pendiente el recordatorio de las ventas de vales que caducan en 7 días o menos (`queueDueVoucherReminders`). Desde el 5.10b, al final,
 * el email de un cambio importante de la política de privacidad a todas las cuentas (`runPrivacyPolicyNotices`).
 */
export const supporterBroadcastHandler: JobHandler = async ({ db, now, batchSize, deadline, deps }) => {
  const hmacSecret = deps.hmacSecret();
  await queueDueVoucherReminders(db, now, batchSize);
  const result = await runSupporterBroadcasts(db, { now, batchSize, deadline, hmacSecret });
  if (result.hasMore) return { processed: result.processed, hasMore: true, detail: { queued: result.queued, rescheduleQueued: 0, privacyQueued: 0 } };
  const reschedules = await runRescheduleNotices(db, { now, batchSize, deadline, hmacSecret });
  if (reschedules.hasMore) return { processed: result.processed + reschedules.processed, hasMore: true, detail: { queued: result.queued, rescheduleQueued: reschedules.queued, privacyQueued: 0 } };
  const privacy = await runPrivacyPolicyNotices(db, { now, batchSize, deadline });
  return {
    processed: result.processed + reschedules.processed + privacy.processed,
    hasMore: privacy.hasMore,
    detail: { queued: result.queued, rescheduleQueued: reschedules.queued, privacyQueued: privacy.queued }
  };
};
