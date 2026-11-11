'use server';

import { z } from 'zod';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { getSessionActor, requireVerifiedSuperadmin } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { resolveOpsAlertById, resolveStuckInvoice, resolveStuckRefund } from '@/services/admin/console-alerts.service';
import { InvoiceNotAllowedError } from '@/services/invoicing/invoice.service';
import { RefundNotAllowedError } from '@/services/payments/payment-reversals';

/**
 * Acciones de la consola del Super-Admin (Sprint 5.1). Quien actúa sale siempre de la sesión y la página es dinámica, así que el cliente se limita
 * a recargarla. Las respuestas no cuentan nada de la causa de un rechazo (un 403 genérico): solo dicen si hay que volver a pasar el segundo factor.
 */

export type AlertActionResult = { status: 'RESOLVED' | 'NOT_OPEN' | 'USE_RESOLVER' | 'FORBIDDEN' | 'INVALID' | 'REAUTH_REQUIRED' | 'NOT_ALLOWED' };

const alertInput = z.object({ alertId: z.string().trim().min(1).max(40) });

export async function resolveAlertAction(payload: unknown): Promise<AlertActionResult> {
  const parsed = alertInput.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  try {
    return await resolveOpsAlertById(getPrisma(), await getSessionActor(), parsed.data.alertId);
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'FORBIDDEN' };
    throw error;
  }
}

const positiveId = z.number().int().positive().max(2_147_483_647);
const stuckInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('REFUND'), contributionId: positiveId, refunded: z.boolean() }),
  z.object({ kind: z.literal('INVOICE_RETRY'), invoiceId: positiveId }),
  z.object({ kind: z.literal('INVOICE_REGISTERED'), invoiceId: positiveId, status: z.enum(['ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'REJECTED']), providerReference: z.string().trim().max(120).nullable() })
]);

/** Devolución o factura de resultado desconocido. Pide el Super-Admin verificado (TOTP de hace menos de 10 minutos). */
export async function resolveStuckAction(payload: unknown): Promise<AlertActionResult> {
  const parsed = stuckInput.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  const input = parsed.data;
  try {
    const db = getPrisma();
    const actor = await requireVerifiedSuperadmin(input.kind === 'REFUND' ? 'payment.resolve_unknown_refund' : 'invoice.resolve_unknown');
    if (input.kind === 'REFUND') await resolveStuckRefund(db, actor, input.contributionId, input.refunded);
    else if (input.kind === 'INVOICE_RETRY') await resolveStuckInvoice(db, actor, input.invoiceId, { registered: false });
    else await resolveStuckInvoice(db, actor, input.invoiceId, { registered: true, status: input.status, providerReference: input.providerReference?.length ? input.providerReference : null });
    return { status: 'RESOLVED' };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    if (error instanceof RefundNotAllowedError || error instanceof InvoiceNotAllowedError) return { status: 'NOT_ALLOWED' };
    throw error;
  }
}
