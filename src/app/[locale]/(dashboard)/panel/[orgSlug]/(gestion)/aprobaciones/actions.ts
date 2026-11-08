'use server';

import { after } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { approveIdeaForVoting, IdeaModerationError, rejectIdea, replyToIdea, revalidateSignature, type ModerationRejection } from '@/core/ideas/idea-moderation.service';
import { DoubleCheckNotAllowedError, requestSignature, type DoubleCheckBlock } from '@/core/security/double-check.service';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';

/**
 * Acciones de la bandeja de aprobaciones (Sprint 4.2a). La entidad sale de su `orgSlug` y quien actúa, de la sesión con el segundo factor
 * superado: las acciones no pasan por el `layout`, así que aquí se vuelve a exigir (auditoría del 3.2, M1). El servicio comprueba el cargo y que
 * la idea sea de esa entidad. Los emails de la operación se envían al momento desde `after()` (heredado del Sprint 2.6), sin esperar a la tarea.
 */

export type ApprovalActionResult =
  | { status: 'OK'; phase?: 'PUBLIC_VOTING' | 'DOUBLE_CHECK'; expiresAt?: string }
  | { status: 'ERROR'; reason: ModerationRejection | DoubleCheckBlock | 'FORBIDDEN' };

async function panelContext(orgSlug: string): Promise<{ actor: SessionActor; organizationId: string } | null> {
  const organizationId = await findOrganizationIdBySlug(getPrisma(), orgSlug.slice(0, 64));
  if (!organizationId) return null;
  const actor = await getSessionActor();
  if (actor.kind !== 'user' || actor.secondFactor !== true) return null;
  return { actor, organizationId };
}

function dispatchSoon(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getPrisma();
  after(() =>
    dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length })
      .then(() => undefined)
      .catch((error: unknown) => reportError(error, { stage: 'outbox-after-approval' }))
  );
}

/**
 * Avisos pendientes de esta idea (a la familia o a quienes firman), por su clave de idempotencia, que lleva la idea: no depende del reloj del
 * servidor frente al de la base (auditoría del 4.2a, M3). Lo que ya salió no está `PENDING`; lo que salga dos veces lo impide la propia bandeja.
 */
async function pendingIdeaEmails(organizationId: string, ideaId: number): Promise<number[]> {
  const rows = await getPrisma().outboxMessage.findMany({
    where: { organizationId, status: 'PENDING', OR: [{ idempotencyKey: { startsWith: `idea.centerReplied:${ideaId}:` } }, { idempotencyKey: { startsWith: `idea.quorumReached:idea:${ideaId}:` } }] },
    select: { id: true },
    take: 10
  });
  return rows.map((row) => row.id);
}

const ideaIdOf = (payload: unknown): number | null => {
  const value = (payload as { ideaId?: unknown } | null)?.ideaId;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
};

async function run(orgSlug: string, payload: unknown, operation: (context: { actor: SessionActor; organizationId: string }, db: ReturnType<typeof getPrisma>) => Promise<ApprovalActionResult>): Promise<ApprovalActionResult> {
  const context = await panelContext(orgSlug);
  if (!context) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const result = await operation(context, getPrisma());
    const ideaId = ideaIdOf(payload);
    if (ideaId !== null) dispatchSoon(await pendingIdeaEmails(context.organizationId, ideaId));
    return result;
  } catch (error) {
    if (error instanceof IdeaModerationError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof DoubleCheckNotAllowedError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'NOT_FOUND' };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

export async function approveIdeaAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => ({ status: 'OK', ...(await approveIdeaForVoting(db, actor, organizationId, payload)) }));
}

export async function rejectIdeaAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    await rejectIdea(db, actor, organizationId, payload);
    return { status: 'OK' };
  });
}

export async function replyIdeaAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    await replyToIdea(db, actor, organizationId, payload);
    return { status: 'OK' };
  });
}

export async function revalidateSignatureAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    const { quorumReached } = await revalidateSignature(db, actor, organizationId, payload);
    return { status: 'OK', ...(quorumReached ? { phase: 'DOUBLE_CHECK' as const } : {}) };
  });
}

const signPayload = z.object({ ideaId: z.number().int().positive().max(2_147_483_647) });

/** Pide el enlace de un solo uso y el código para firmar la idea. Solo vuelven a quien firma por email; aquí, únicamente hasta cuándo valen. */
export async function requestIdeaSignatureAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  const parsed = signPayload.safeParse(payload);
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    const receipt = await requestSignature(db, getEnv().DATA_HMAC_SECRET, actor, organizationId, { targetType: 'IDEA_APPROVAL', ideaId: parsed.data.ideaId });
    dispatchSoon([receipt.notificationId]);
    return { status: 'OK', expiresAt: receipt.expiresAt.toISOString() };
  });
}
