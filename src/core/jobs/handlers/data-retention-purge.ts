import { alertOverduePrivacyRequests, eraseUnresponsiveAccounts, noticeInactiveAccounts, purgeExpiredFiles, retryCardDeletions } from '@/core/privacy/retention-accounts';
import {
  anonymizeOldIdeaSignatures,
  purgeExpiredDonorData,
  purgeExpiredSessions,
  purgeExpiredWebhooks,
  purgeNetworkHashes,
  purgeOldNotifications,
  purgeStaleDevices,
  purgeSupersededConsents
} from '@/core/privacy/retention-purge';
import type { JobHandler } from '../job-types';

const MAX_CONSENT_ROUNDS = 50;

/**
 * `DATA_RETENTION_PURGE` (semanal, QA-PRIV02): aplica los plazos de CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD §6 (`retention-policy.ts`). Cada paso
 * trata como mucho un lote; si alguno lo llena, la tarea devuelve `hasMore` y el procesador la vuelve a pasar en la misma llamada.
 * Nunca borra asientos, importes de aportaciones, facturas, firmas de liquidaciones ni la auditoría: de ellos solo anonimiza lo personal.
 *
 * **Cada paso es independiente:** si uno falla, los demás se ejecutan igual y al final la tarea falla con el primer error (reintento con
 * espera y, si persiste, alerta `JOB_FAILED`). La alerta de solicitudes RGPD fuera de plazo va la primera: es la que tiene plazo legal.
 */
export const dataRetentionPurgeHandler: JobHandler = async ({ db, now, batchSize, deadline, deps }) => {
  const detail: Record<string, number> = {};
  let processed = 0;
  let hasMore = false;
  let firstError: unknown = null;

  const step = async (name: string, run: () => Promise<number>, canFillBatch = true) => {
    try {
      const count = await run();
      detail[name] = count;
      processed += count;
      if (canFillBatch && count >= batchSize) hasMore = true;
    } catch (error) {
      detail[`${name}Failed`] = 1;
      firstError ??= error;
    }
  };

  await step('overduePrivacyRequests', () => alertOverduePrivacyRequests(db, now), false);
  await step('donorData', () => purgeExpiredDonorData(db, now, batchSize));
  await step('ideaSignatures', () => anonymizeOldIdeaSignatures(db, now, batchSize));
  await step('devices', () => purgeStaleDevices(db, now, batchSize));
  await step('networkHashes', () => purgeNetworkHashes(db, now, batchSize));
  await step('notifications', () => purgeOldNotifications(db, now, batchSize));
  await step('webhooks', () => purgeExpiredWebhooks(db, now, batchSize));
  await step('sessions', () => purgeExpiredSessions(db, now, batchSize));
  await step(
    'consents',
    async () => {
      let deleted = 0;
      let cursor = 0;
      for (let round = 0; round < MAX_CONSENT_ROUNDS; round += 1) {
        const result = await purgeSupersededConsents(db, now, batchSize, cursor);
        deleted += result.deleted;
        cursor = result.lastId;
        if (result.scanned < batchSize) break;
        if (round === MAX_CONSENT_ROUNDS - 1 || (deadline !== undefined && Date.now() > deadline)) hasMore = true;
      }
      return deleted;
    },
    false
  );

  await step('inactivityNotices', () => noticeInactiveAccounts(db, now, batchSize));
  const erasureDeps = { paymentProvider: deps.paymentProvider, keyring: deps.keyring(), hmacSecret: deps.hmacSecret() };
  await step(
    'inactiveErased',
    async () => {
      const result = await eraseUnresponsiveAccounts(db, erasureDeps, now, batchSize, deadline);
      detail.inactiveReturned = result.returned;
      detail.inactiveFailed = result.failed;
      return result.erased;
    },
    false
  );
  await step(
    'cardsDeleted',
    async () => {
      const result = await retryCardDeletions(db, erasureDeps, now, batchSize);
      detail.cardsFailed = result.failed;
      return result.deleted;
    },
    false
  );
  await step(
    'filesDeleted',
    async () => {
      const result = await purgeExpiredFiles(db, deps.storageProvider, now, batchSize);
      detail.filesFailed = result.failed;
      return result.deleted;
    },
    false
  );

  if (firstError !== null) throw firstError;
  return { processed, hasMore, detail };
};
