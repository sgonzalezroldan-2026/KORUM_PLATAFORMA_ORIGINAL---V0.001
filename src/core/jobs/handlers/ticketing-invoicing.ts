import { releaseExpiredTicketHolds } from '@/core/ticketing/ticket-reservation.service';
import { submitPendingInvoices } from '@/services/invoicing/invoice.service';
import type { JobHandler } from '../job-types';
import { raiseAlert, resolveAlertsNotIn } from '../ops-alerts';

/** Una factura en `SENT` más tiempo que esto tiene un envío de resultado desconocido, y detiene el envío de todas las siguientes. */
export const STUCK_INVOICE_AFTER_MS = 3_600_000;

/** `TICKET_HOLD_RELEASE`: las plazas reservadas cuyo pago no llegó vuelven al aforo visible aunque nadie más compre. */
export const ticketHoldReleaseHandler: JobHandler = async ({ db, now }) => {
  const released = await releaseExpiredTicketHolds(db, now);
  return { processed: released, hasMore: false };
};

/**
 * `INVOICE_SUBMIT`: envía en orden las facturas `PENDING` a Veri*factu. Una que lleve tiempo en `SENT` abre una alerta crítica: hasta que
 * una persona la resuelva (`resolveUnknownInvoice`), las siguientes esperan.
 */
export const invoiceSubmitHandler: JobHandler = async ({ db, now, batchSize, deps, deadline }) => {
  const stuck = await db.invoice.findMany({ where: { verifactuStatus: 'SENT', sentAt: { lt: new Date(now.getTime() - STUCK_INVOICE_AFTER_MS) } }, select: { id: true, organizationId: true, invoiceNumber: true, sentAt: true } });
  for (const invoice of stuck) {
    await raiseAlert(db, { type: 'INVOICE_STUCK', severity: 'CRITICAL', dedupeKey: `INVOICE_STUCK:${invoice.id}`, organizationId: invoice.organizationId, targetType: 'Invoice', targetId: String(invoice.id), detail: { invoiceNumber: invoice.invoiceNumber, sentAt: invoice.sentAt?.toISOString() ?? null } }, now);
  }
  await resolveAlertsNotIn(db, 'INVOICE_STUCK', stuck.map((invoice) => `INVOICE_STUCK:${invoice.id}`), now);
  const pending = await db.invoice.count({ where: { verifactuStatus: 'PENDING' } });
  if (pending === 0) return { processed: 0, hasMore: false, detail: { stuck: stuck.length, stopped: 0 } };
  const { submitted, stoppedAt } = await submitPendingInvoices(db, deps.invoicingProvider(), { limit: batchSize, now, deadline });
  return { processed: submitted, hasMore: stoppedAt === null && pending > batchSize, detail: { stuck: stuck.length, stopped: stoppedAt === null ? 0 : 1 } };
};
