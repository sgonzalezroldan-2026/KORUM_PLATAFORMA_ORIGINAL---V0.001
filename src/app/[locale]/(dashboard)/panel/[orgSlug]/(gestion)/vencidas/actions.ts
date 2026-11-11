'use server';

import { getEnv } from '@/config/env';
import { ExpiredCampaignError, type ExpiredRejection } from '@/core/resize/resize-rules';
import { getSessionActor } from '@/lib/auth/session';
import { dispatchOutboxSoon, dispatchSupporterBroadcastSoon } from '@/lib/panel/outbox-soon';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { decideRefund, launchResizeVote, type DecisionReceipt } from '@/services/resize/expired-decision.service';

/**
 * Acciones de la pantalla de campañas vencidas (Sprint 4.4b). La entidad sale de su `orgSlug` y quien decide, de la sesión con el segundo factor superado
 * (las acciones no pasan por el `layout`); el servicio comprueba el cargo y que la campaña sea de esa entidad. El aviso a la otra persona firmante sale
 * al momento, y los de quienes donaron empiezan a salir también (los primeros al momento; el resto, por lotes con la tarea).
 */

export type ExpiredActionResult = { status: 'OK'; decision: DecisionReceipt['status']; closesAt?: string } | { status: 'ERROR'; reason: ExpiredRejection | 'FORBIDDEN' };

async function run(orgSlug: string, operation: (db: ReturnType<typeof getPrisma>, organizationId: string) => Promise<DecisionReceipt>): Promise<ExpiredActionResult> {
  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug.slice(0, 64));
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const receipt = await operation(db, organizationId);
    const notices = await db.outboxMessage.findMany({ where: { templateKey: 'initiative.expiredDecided', organizationId, status: 'PENDING', idempotencyKey: { startsWith: `initiative.expiredDecided:${receipt.initiativeId}:` } }, select: { id: true } });
    dispatchOutboxSoon(db, notices.map((notice) => notice.id), 'outbox-after-expired-decision');
    dispatchSupporterBroadcastSoon(db, getEnv().DATA_HMAC_SECRET, receipt.initiativeId, receipt.status === 'RESIZE_VOTING' ? 'initiative.resizePoll' : 'initiative.refundingSupporter');
    return { status: 'OK', decision: receipt.status, ...(receipt.closesAt ? { closesAt: receipt.closesAt.toISOString() } : {}) };
  } catch (error) {
    if (error instanceof ExpiredCampaignError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

/** Devolver el 100 % a todas las personas que aportaron (lo envía la tarea `MASS_REFUND`). */
export async function decideRefundAction(orgSlug: string, payload: unknown): Promise<ExpiredActionResult> {
  const actor = await getSessionActor();
  return run(orgSlug, (db, organizationId) => decideRefund(db, actor, organizationId, payload));
}

/** Lanzar la votación de 7 días con las opciones de la entidad. */
export async function launchResizeVoteAction(orgSlug: string, payload: unknown): Promise<ExpiredActionResult> {
  const actor = await getSessionActor();
  return run(orgSlug, (db, organizationId) => launchResizeVote(db, actor, organizationId, payload));
}
