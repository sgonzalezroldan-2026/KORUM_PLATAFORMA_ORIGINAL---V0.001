import type { JobType } from '@/generated/prisma/enums';
import { campaignExpiryHandler } from './handlers/campaign-expiry';
import { dataRetentionPurgeHandler } from './handlers/data-retention-purge';
import { housekeepingHandler } from './handlers/housekeeping';
import { massRefundHandler } from './handlers/mass-refund';
import { model182ReminderHandler } from './handlers/model182-reminder';
import { pspReconciliationHandler } from './handlers/psp-reconciliation';
import { quotaRenewalHandler } from './handlers/quota-renewal';
import { creditPoolExpiryHandler, monthlyTopupHandler, sponsorRenewalChargeHandler, sponsorRenewalNoticeHandler } from './handlers/recurring-billing';
import { splitWindowGuardHandler } from './handlers/split-window-guard';
import { invoiceSubmitHandler, ticketHoldReleaseHandler } from './handlers/ticketing-invoicing';
import type { JobHandler } from './job-types';

/**
 * Tipo de tarea → quien la ejecuta. `OUTBOX_DISPATCH` (Sprint 2.6) existe en el calendario pero aún no tiene manejador: la ruta responde
 * `404` y no figura en `vercel.json`. Un test comprueba que lo programado y lo registrado coinciden.
 */
export const JOB_HANDLERS: Partial<Record<JobType, JobHandler>> = {
  CAMPAIGN_EXPIRY: campaignExpiryHandler,
  MASS_REFUND: massRefundHandler,
  MONTHLY_TOPUP: monthlyTopupHandler,
  SPONSOR_RENEWAL_NOTICE: sponsorRenewalNoticeHandler,
  SPONSOR_RENEWAL_CHARGE: sponsorRenewalChargeHandler,
  CREDIT_POOL_EXPIRY: creditPoolExpiryHandler,
  SPLIT_WINDOW_GUARD: splitWindowGuardHandler,
  PSP_RECONCILIATION: pspReconciliationHandler,
  MODEL182_REMINDER: model182ReminderHandler,
  QUOTA_RENEWAL: quotaRenewalHandler,
  TICKET_HOLD_RELEASE: ticketHoldReleaseHandler,
  INVOICE_SUBMIT: invoiceSubmitHandler,
  OPS_HOUSEKEEPING: housekeepingHandler,
  DATA_RETENTION_PURGE: dataRetentionPurgeHandler
};
