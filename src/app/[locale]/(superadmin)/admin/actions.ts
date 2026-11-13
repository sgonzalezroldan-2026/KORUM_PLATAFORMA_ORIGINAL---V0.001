'use server';

import { z } from 'zod';
import { splitResolutionSchema } from '@/core/admin/console-support-rules';
import { SelfBoostNotAllowedError } from '@/core/finance/self-boost';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { getSessionActor, requireVerifiedSuperadmin } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { getInitiativePopup } from '@/repositories/console.repository';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { requeueFailedEmails, resolveOpsAlertById, resolveOpsAlertWithNote, resolveStuckInvoice, resolveStuckRefund } from '@/services/admin/console-alerts.service';
import { resolveSplitToResolve } from '@/services/admin/payout-review.service';
import type { InitiativePopupView } from '@/services/admin/initiative-popup';
import { executeSelfBoost, fixNegativeReturnTariff, TariffFixNotNeededError } from '@/services/admin/self-boost.service';
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

export type RequeueActionResult = { status: 'REQUEUED'; requeued: number; skipped: number } | { status: 'NOT_OPEN' | 'NOT_REQUEUEABLE' | 'FORBIDDEN' | 'INVALID' };

/** «Volver a poner en cola» los mensajes fallidos de una plantilla (Sprint 5.2). Basta el Super-Admin con su segundo factor de esta sesión: no mueve dinero. */
export async function requeueEmailsAction(payload: unknown): Promise<RequeueActionResult> {
  const parsed = alertInput.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  try {
    return await requeueFailedEmails(getPrisma(), await getSessionActor(), parsed.data.alertId);
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'FORBIDDEN' };
    throw error;
  }
}

export type PopupLoadResult = { status: 'OK'; view: InitiativePopupView } | { status: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' };

const popupInput = z.object({ initiativeId: positiveId });

/** Datos de la ficha ejecutiva de una iniciativa. La pantalla los pide al pulsar una fila de las tablas. */
export async function loadInitiativePopupAction(payload: unknown): Promise<PopupLoadResult> {
  const parsed = popupInput.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  try {
    const view = await getInitiativePopup(getPrisma(), await getSessionActor(), parsed.data.initiativeId);
    return view ? { status: 'OK', view } : { status: 'NOT_FOUND' };
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'FORBIDDEN' };
    throw error;
  }
}

export type BoostActionResult = { status: 'DONE'; amountCents: number } | { status: 'AMOUNT_CHANGED' | 'NOT_PROFITABLE' | 'NOT_ALLOWED' | 'REAUTH_REQUIRED' | 'FORBIDDEN' | 'INVALID' };

const boostInput = z.object({ initiativeId: positiveId, expectedAmountCents: z.number().int().positive().max(2_147_483_647), publiclyDisclosed: z.boolean(), acceptLoss: z.boolean().optional() });

/**
 * Auto-Impulso: KORUM aporta lo que falta y completa la meta. Gasta dinero de KORUM, así que pide el Super-Admin verificado (TOTP de hace menos de 10
 * minutos) y la cifra que la persona tenía en pantalla: si cambió, no se ejecuta.
 */
export async function executeSelfBoostAction(payload: unknown): Promise<BoostActionResult> {
  const parsed = boostInput.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  try {
    const actor = await requireVerifiedSuperadmin('selfboost.execute');
    const result = await executeSelfBoost(getPrisma(), actor, parsed.data);
    return { status: 'DONE', amountCents: result.amountCents };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    if (error instanceof SelfBoostNotAllowedError) return { status: error.reason === 'AMOUNT_CHANGED' || error.reason === 'NOT_PROFITABLE' ? error.reason : 'NOT_ALLOWED' };
    throw error;
  }
}

export type FixActionResult = { status: 'FIXED'; organizationChanged: boolean } | { status: 'NOTHING_TO_FIX' | 'REAUTH_REQUIRED' | 'INVALID' };

const fixInput = z.object({ initiativeId: positiveId });

/** Corrección de tarifas en 1 clic, solo con lo no prometido (decisión del promotor, 2026-11-11). Cambia precios: pide el Super-Admin verificado. */
export async function fixTariffAction(payload: unknown): Promise<FixActionResult> {
  const parsed = fixInput.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  try {
    const actor = await requireVerifiedSuperadmin('tariff.fix_negative_return');
    const plan = await fixNegativeReturnTariff(getPrisma(), actor, parsed.data.initiativeId);
    return { status: 'FIXED', organizationChanged: Object.keys(plan.organization).length > 0 };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    if (error instanceof TariffFixNotNeededError) return { status: 'NOTHING_TO_FIX' };
    throw error;
  }
}

export type NoteResolveResult = { status: 'RESOLVED' | 'NOT_OPEN' | 'NOT_ALLOWED' | 'INVALID' | 'FORBIDDEN' };

/** Cierra con una nota una alerta de dinero que solo se arregla con Paycomet (`PAYOUT_BLOCKED`, `ACTIVITY_FUND_WINDOW`): sin nota no se cierra (Sprint 5.3). */
export async function resolveAlertWithNoteAction(payload: unknown): Promise<NoteResolveResult> {
  try {
    return await resolveOpsAlertWithNote(getPrisma(), await getSessionActor(), payload);
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'FORBIDDEN' };
    throw error;
  }
}

export type SplitActionResult = { status: 'RESOLVED'; done: boolean } | { status: 'NOT_SENDING' | 'INVALID' | 'REAUTH_REQUIRED' };

/**
 * Reparto de resultado desconocido (campaña o Fondo de actividades): una persona ya ha comprobado en Paycomet qué pasó. Mueve dinero en el libro mayor, así que pide
 * el Super-Admin verificado (TOTP de hace menos de 10 minutos).
 */
export async function resolveSplitAction(payload: unknown): Promise<SplitActionResult> {
  const parsed = splitResolutionSchema.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  try {
    const actor = await requireVerifiedSuperadmin(parsed.data.kind === 'CAMPAIGN' ? 'payout.resolve_unknown_split' : 'activity_fund.resolve_unknown_split');
    return await resolveSplitToResolve(getPrisma(), actor, parsed.data);
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    throw error;
  }
}
