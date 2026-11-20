'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { getEnv } from '@/config/env';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { trustedClientIp } from '@/lib/trusted-ip';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { executePartialRefund } from '@/services/payments/partial-refunds';
import { executePendingRefund } from '@/services/payments/payment-reversals';
import { claimVoucherRefund, VoucherRefundError, type VoucherRefundRejection } from '@/services/ticketing/voucher-refund.service';

/**
 * Devolución de una compra de vales desde su pase (Sprint 5.14c, QA-VAL04): la de 14 días o, tras acortarse la validez, la de lo no gastado. Qué compra es sale del enlace firmado del pase y de la base, nunca de lo
 * que envía el navegador. Se aprueba en el acto y, después de responder, se pide a Paycomet y sale el email «Devolución realizada»; si algo falla, la tarea
 * `MASS_REFUND` la completa como cualquier devolución pendiente.
 */

export type VoucherRefundResult = { status: 'OK'; refundedCents: number } | { status: 'ERROR'; reason: VoucherRefundRejection };

export async function claimVoucherRefundAction(payload: unknown): Promise<VoucherRefundResult> {
  const requestHeaders = await headers();
  const ip = trustedClientIp((name) => requestHeaders.get(name));
  const db = getPrisma();
  const env = getEnv();
  try {
    const receipt = await claimVoucherRefund(db, env.QR_HMAC_SECRET, env.DATA_HMAC_SECRET, payload, { ip });
    after(async () => {
      try {
        const deps = buildJobDeps(db);
        const provider = await deps.paymentProvider();
        const originalIp = await deps.refundOriginalIp();
        const result = receipt.partial ? await executePartialRefund(db, provider, receipt.contributionId, originalIp) : await executePendingRefund(db, provider, receipt.contributionId, originalIp);
        if (result.refunded) {
          const pending = await db.outboxMessage.findMany({ where: { idempotencyKey: `refund.issued:${receipt.contributionId}`, status: 'PENDING' }, select: { id: true } });
          if (pending.length > 0) await dispatchOutbox(db, buildOutboxDeps(db), { ids: pending.map((row) => row.id), limit: pending.length });
        }
      } catch (error) {
        reportError(error, { stage: 'voucher-refund-after-claim', contributionId: receipt.contributionId });
      }
    });
    return { status: 'OK', refundedCents: receipt.refundedCents };
  } catch (error) {
    if (error instanceof VoucherRefundError) return { status: 'ERROR', reason: error.reason };
    throw error;
  }
}
