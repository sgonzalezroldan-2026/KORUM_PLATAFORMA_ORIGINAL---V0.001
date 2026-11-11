'use server';

import { getEnv } from '@/config/env';
import type { AnswerRejection } from '@/core/support/support-inbox-rules';
import { getSessionActor } from '@/lib/auth/session';
import { dispatchOutboxSoon } from '@/lib/panel/outbox-soon';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError } from '@/repositories/tenant-guard';
import { answerFamilyTicket, sendMessageToKorum } from '@/services/support/support-inbox.service';

/**
 * Acciones de la pantalla de soporte del centro (Sprint 4.4c). La entidad sale de su `orgSlug` y quien actúa, de la sesión con el segundo factor
 * (las acciones no pasan por el `layout`); el servicio comprueba el cargo y que la consulta sea de las familias de esa entidad. El aviso a la familia
 * («tienes una respuesta», sin copiar el texto) y el acuse de lo que se escribe a KORUM salen al momento.
 */

export type SupportActionResult =
  | { status: 'OK'; ticketCode: string; resolved?: boolean; notified?: boolean }
  | { status: 'ERROR'; reason: AnswerRejection | 'FORBIDDEN' | 'RATE_LIMITED' | 'CODE_EXHAUSTED' };

async function organizationOf(orgSlug: string) {
  return findOrganizationIdBySlug(getPrisma(), orgSlug.slice(0, 64));
}

/** Contestar una consulta de una familia y/o cambiar su estado. */
export async function answerTicketAction(orgSlug: string, payload: unknown): Promise<SupportActionResult> {
  if (typeof orgSlug !== 'string') return { status: 'ERROR', reason: 'FORBIDDEN' };
  const db = getPrisma();
  const organizationId = await organizationOf(orgSlug);
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const outcome = await answerFamilyTicket({ db }, await getSessionActor(), organizationId, payload);
    if (outcome.status === 'REJECTED') return { status: 'ERROR', reason: outcome.reason };
    if (outcome.outboxId !== null) dispatchOutboxSoon(db, [outcome.outboxId], 'outbox-after-support-reply');
    // `notified`: hay aviso por email a la familia (si la consulta ya no tiene dirección o la cuenta se suprimió, la respuesta solo se lee en su cuenta).
    return { status: 'OK', ticketCode: outcome.ticketCode, resolved: outcome.resolved, notified: outcome.outboxId !== null };
  } catch (error) {
    if (error instanceof TenantAccessError || error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

/** Escribir a KORUM desde el panel de la entidad (buzón prioritario). */
export async function sendToKorumAction(orgSlug: string, locale: string, payload: unknown): Promise<SupportActionResult> {
  if (typeof orgSlug !== 'string' || typeof locale !== 'string') return { status: 'ERROR', reason: 'FORBIDDEN' };
  const db = getPrisma();
  const organizationId = await organizationOf(orgSlug);
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const outcome = await sendMessageToKorum({ db, hmacSecret: getEnv().DATA_HMAC_SECRET }, await getSessionActor(), organizationId, { payload, locale: locale.slice(0, 5) });
    if (outcome.status === 'REJECTED') return { status: 'ERROR', reason: outcome.reason };
    dispatchOutboxSoon(db, [outcome.outboxId], 'outbox-after-support-korum-message');
    return { status: 'OK', ticketCode: outcome.ticketCode };
  } catch (error) {
    if (error instanceof TenantAccessError || error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}
