import { rotateEncryptedData } from '@/core/security/key-rotation';
import { FAILURE_WINDOW_MS } from '@/core/ticketing/gate-session.service';
import type { Db } from '@/lib/db';
import { purgeStaleAttempts, type PurgeRule } from '@/lib/rate-limit';
import { ACCOUNT_ERASURE_RULE, ACCOUNT_EXPORT_RULE, ACTIVITY_FUND_RULE, AUTH_EMAIL_RULE, AUTH_REQUEST_PURGE_RULE, AUTH_SECOND_FACTOR_FAILURE_RULE, AUTH_SECOND_FACTOR_RULE, CHECKOUT_RULE, CHECKOUT_SEATS_RULE, IDEA_CHAT_RULE, IDEA_PROPOSAL_RULE, ENTITY_IMAGE_UPLOAD_RULE, IDEA_SIGN_RULE, KYB_UPLOAD_RULE, REGISTRATION_RULE, SIGNATURE_REQUEST_RULE, SUPPORT_TICKET_DAILY_RULE, SUPPORT_TICKET_RULE, WEBHOOK_INVALID_RULE } from '@/lib/rate-limit-rules';
import type { JobHandler } from '../job-types';

const DAY_MS = 86_400_000;
const MAX_ROUNDS = 20;
/** Plazo de conservación de las notificaciones rechazadas (CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD §6). */
export const REJECTED_WEBHOOK_RETENTION_DAYS = 90;
/** Un desafío de firma caducado, consumido o revocado se conserva unos días más por si hay que explicar un rechazo. */
export const CHALLENGE_GRACE_DAYS = 7;

/** Contadores con ventana que hay que purgar. Los de `windowMs: null` (p. ej. `gate-pin:event:*`) no están aquí a propósito. */
export const RATE_LIMIT_PURGE_RULES: readonly PurgeRule[] = [{ prefix: 'gate-pin:ip:', windowMs: FAILURE_WINDOW_MS }, WEBHOOK_INVALID_RULE, SIGNATURE_REQUEST_RULE, AUTH_EMAIL_RULE, AUTH_REQUEST_PURGE_RULE, AUTH_SECOND_FACTOR_RULE, AUTH_SECOND_FACTOR_FAILURE_RULE, REGISTRATION_RULE, CHECKOUT_RULE, CHECKOUT_SEATS_RULE, IDEA_SIGN_RULE, IDEA_PROPOSAL_RULE, ACCOUNT_EXPORT_RULE, ACCOUNT_ERASURE_RULE, IDEA_CHAT_RULE, SUPPORT_TICKET_RULE, SUPPORT_TICKET_DAILY_RULE, KYB_UPLOAD_RULE, ENTITY_IMAGE_UPLOAD_RULE, ACTIVITY_FUND_RULE];

async function purgeRejectedWebhooks(db: Db, now: Date, limit: number): Promise<number> {
  const cutoff = new Date(now.getTime() - REJECTED_WEBHOOK_RETENTION_DAYS * DAY_MS);
  const stale = await db.webhookEvent.findMany({ where: { status: 'REJECTED', externalEventId: { startsWith: 'rejected:' }, receivedAt: { lt: cutoff } }, take: limit, select: { id: true } });
  if (stale.length === 0) return 0;
  const { count } = await db.webhookEvent.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  return count;
}

async function purgeSignatureChallenges(db: Db, now: Date, limit: number): Promise<number> {
  const cutoff = new Date(now.getTime() - CHALLENGE_GRACE_DAYS * DAY_MS);
  const stale = await db.doubleCheckChallenge.findMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] }, take: limit, select: { id: true } });
  if (stale.length === 0) return 0;
  const { count } = await db.doubleCheckChallenge.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  return count;
}

/**
 * `OPS_HOUSEKEEPING`: limpieza diaria de lo que crece sin parar y ya no sirve (QA-OPS01):
 *   - contadores de intentos por IP caducados;
 *   - notificaciones de pago rechazadas de más de 90 días;
 *   - desafíos de firma caducados, consumidos o revocados hace más de 7 días;
 *   - y, durante una rotación de clave, vuelve a cifrar con la actual lo cifrado con la anterior (`key-rotation.ts`).
 * Nunca toca asientos, facturas, auditoría ni webhooks de pago válidos (6 años de conservación). La purga de datos personales por plazos es
 * otra tarea (`DATA_RETENTION_PURGE`, semanal).
 */
export const housekeepingHandler: JobHandler = async ({ db, now, batchSize, deps }) => {
  const total = { rateLimits: 0, webhooks: 0, challenges: 0 };
  let hasMore = false;
  // Varias pasadas en la misma ejecución mientras alguna alcance el lote: la tarea es diaria y un flood de subredes distintas hace crecer la tabla más rápido que un lote al día.
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const rateLimits = await purgeStaleAttempts(db, RATE_LIMIT_PURGE_RULES, now, batchSize);
    const webhooks = await purgeRejectedWebhooks(db, now, batchSize);
    const challenges = await purgeSignatureChallenges(db, now, batchSize);
    total.rateLimits += rateLimits;
    total.webhooks += webhooks;
    total.challenges += challenges;
    hasMore = rateLimits >= batchSize || webhooks >= batchSize || challenges >= batchSize;
    if (!hasMore) break;
  }
  const rotation = await rotateEncryptedData(db, deps.keyring(), batchSize, now);
  const detail = { ...total, reencrypted: rotation.rotated, undecryptable: rotation.undecryptable };
  return { processed: total.rateLimits + total.webhooks + total.challenges + rotation.rotated, hasMore: hasMore || rotation.hasMore, detail };
};
