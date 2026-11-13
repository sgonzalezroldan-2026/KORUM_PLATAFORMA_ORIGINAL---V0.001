'use server';

import { z } from 'zod';
import { getEnv } from '@/config/env';
import type { AnswerRejection } from '@/core/support/support-inbox-rules';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { currentRequestMeta, getSessionActor, requireVerifiedSuperadmin } from '@/lib/auth/session';
import { dispatchOutboxSoon } from '@/lib/panel/outbox-soon';
import { getPrisma } from '@/lib/prisma';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { answerPlatformTicket, closeRectificationRequest, rectifyAccountName, sendDirectEmailToOrganization } from '@/services/admin/console-support.service';

/**
 * Acciones de la bandeja de soporte de KORUM y del email directo a una entidad (Sprint 5.3). Contestar pide el Super-Admin con su segundo factor de esta sesión (no mueve
 * dinero); cerrar o corregir una solicitud RGPD y escribir a una entidad con el nombre de KORUM piden el TOTP de hace menos de 10 minutos. Quien actúa sale siempre de la sesión.
 * El aviso «tienes una respuesta» (sin copiar el texto) y el email directo salen al momento.
 */

export type PlatformTicketResult = { status: 'OK'; ticketCode: string; resolved: boolean; notified: boolean } | { status: 'ERROR'; reason: AnswerRejection | 'FORBIDDEN' };

export async function answerPlatformTicketAction(payload: unknown): Promise<PlatformTicketResult> {
  try {
    const db = getPrisma();
    const outcome = await answerPlatformTicket(db, await getSessionActor(), payload);
    if (outcome.status === 'REJECTED') return { status: 'ERROR', reason: outcome.reason };
    if (outcome.outboxId !== null) dispatchOutboxSoon(db, [outcome.outboxId], 'outbox-after-platform-support-reply');
    return { status: 'OK', ticketCode: outcome.ticketCode, resolved: outcome.resolved, notified: outcome.outboxId !== null };
  } catch (error) {
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

export type RectificationActionResult = { status: 'CLOSED' | 'NOT_FOUND' | 'ALREADY_CLOSED' | 'INVALID' | 'REAUTH_REQUIRED' };

export async function closeRectificationAction(payload: unknown): Promise<RectificationActionResult> {
  try {
    const actor = await requireVerifiedSuperadmin('privacy.request_close');
    return await closeRectificationRequest(getPrisma(), actor, payload);
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    throw error;
  }
}

export type RectifyNameActionResult = { status: 'DONE' | 'INVALID' | 'NOT_FOUND' | 'NO_ACCOUNT' | 'REAUTH_REQUIRED' };

/** Corregir el nombre de la cuenta de quien pidió la rectificación. El cambio de email no se hace desde la consola (hace falta comprobar que la persona controla el nuevo). */
export async function rectifyNameAction(payload: unknown): Promise<RectifyNameActionResult> {
  try {
    const actor = await requireVerifiedSuperadmin('privacy.rectify_name');
    return await rectifyAccountName(getPrisma(), actor, payload, new Date(), await currentRequestMeta());
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    throw error;
  }
}

export type DirectEmailActionResult = { status: 'SENT'; recipients: number } | { status: 'ERROR'; reason: 'INVALID_INPUT' | 'NOT_FOUND' | 'RATE_LIMITED' | 'NO_RECIPIENTS' | 'REAUTH_REQUIRED' };

const directInput = z.object({ organizationId: z.string().trim().min(1).max(80), email: z.unknown() });

export async function sendDirectEmailAction(payload: unknown): Promise<DirectEmailActionResult> {
  const parsed = directInput.safeParse(payload);
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  try {
    const db = getPrisma();
    const actor = await requireVerifiedSuperadmin('support.direct_email');
    const outcome = await sendDirectEmailToOrganization(db, actor, getEnv().DATA_HMAC_SECRET, parsed.data.organizationId, parsed.data.email, new Date(), await currentRequestMeta());
    if (outcome.status === 'REJECTED') return { status: 'ERROR', reason: outcome.reason };
    dispatchOutboxSoon(db, outcome.outboxIds, 'outbox-after-direct-email');
    return { status: 'SENT', recipients: outcome.recipients };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'ERROR', reason: 'REAUTH_REQUIRED' };
    throw error;
  }
}
