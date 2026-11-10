'use server';

import { after } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { approveIdeaForVoting, IdeaModerationError, rejectIdea, replyToIdea, revalidateSignature, type ModerationRejection } from '@/core/ideas/idea-moderation.service';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { DoubleCheckNotAllowedError, requestSignature, type DoubleCheckBlock } from '@/core/security/double-check.service';
import { SponsorModerationError, type SponsorModerationRejection } from '@/core/sponsors/sponsor-moderation-rules';
import { SponsorReassignmentError, type SponsorReassignmentRejection } from '@/core/sponsors/sponsor-reassignment-rules';
import { getSessionActor } from '@/lib/auth/session';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { loadInvoicingContext } from '@/services/invoicing/invoicing-context';
import { executePendingRefund } from '@/services/payments/payment-reversals';
import { approveSponsor, rejectSponsor } from '@/services/sponsors/sponsor-moderation.service';
import { assignPooledSponsor, saveSponsorRenewalRule, sendRenewalLink } from '@/services/sponsors/sponsor-renewal-panel.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Acciones de la bandeja de aprobaciones (Sprint 4.2a). La entidad sale de su `orgSlug` y quien actúa, de la sesión con el segundo factor
 * superado: las acciones no pasan por el `layout`, así que aquí se vuelve a exigir (auditoría del 3.2, M1). El servicio comprueba el cargo y que
 * la idea sea de esa entidad. Los emails de la operación se envían al momento desde `after()` (heredado del Sprint 2.6), sin esperar a la tarea.
 */

export type ApprovalActionResult =
  | { status: 'OK'; phase?: 'PUBLIC_VOTING' | 'DOUBLE_CHECK'; expiresAt?: string; placed?: number; title?: string }
  | { status: 'ERROR'; reason: ModerationRejection | DoubleCheckBlock | SponsorModerationRejection | SponsorReassignmentRejection | 'FORBIDDEN' };

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
    if (error instanceof SponsorModerationError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof SponsorReassignmentError) return { status: 'ERROR', reason: error.reason };
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

/** Email del comercio (bienvenida o no admisión) al momento, por su clave de idempotencia. */
async function pendingSponsorEmails(organizationId: string, sponsorId: number): Promise<number[]> {
  const rows = await getPrisma().outboxMessage.findMany({
    where: { organizationId, status: 'PENDING', idempotencyKey: { in: [`sponsor.welcome:${sponsorId}`, `sponsor.rejected:${sponsorId}`] } },
    select: { id: true },
    take: 2
  });
  return rows.map((row) => row.id);
}

const sponsorIdOf = (payload: unknown): number | null => {
  const value = (payload as { sponsorId?: unknown } | null)?.sponsorId;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
};

/** Aprueba un comercio cobrado: sale en el directorio y, si eligió la bolsa Matching 2x, la bolsa se activa. Le llega su bienvenida con los documentos. */
export async function approveSponsorAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    await approveSponsor(db, actor, organizationId, payload, { hmacSecret: getEnv().DATA_HMAC_SECRET });
    revalidatePortal(orgSlug.slice(0, 64));
    const sponsorId = sponsorIdOf(payload);
    // Un comercio cuyo pago llegó tarde se coloca al aprobarlo (Sprint 4.2f): sus avisos de reasignación salen también al momento.
    if (sponsorId !== null) dispatchSoon([...(await pendingSponsorEmails(organizationId, sponsorId)), ...(await pendingReassignmentEmails(organizationId))]);
    return { status: 'OK' };
  });
}

/**
 * Rechaza un comercio cobrado: devolución del 100 % aprobada y factura rectificada en una transacción. La devolución se pide a Paycomet justo
 * después, desde `after()`; si no se puede (resultado desconocido, Paycomet caído), la recoge la tarea `MASS_REFUND` como cualquier `REFUND_PENDING`.
 */
export async function rejectSponsorAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    const { contributionId, retiredLogo } = await rejectSponsor(db, actor, organizationId, payload, { hmacSecret: getEnv().DATA_HMAC_SECRET, invoicing: await loadInvoicingContext(db) });
    revalidatePortal(orgSlug.slice(0, 64));
    const sponsorId = sponsorIdOf(payload);
    if (sponsorId !== null) dispatchSoon(await pendingSponsorEmails(organizationId, sponsorId));
    after(async () => {
      if (retiredLogo) await getStorageProvider().remove(retiredLogo.bucket, retiredLogo.objectKey).catch((error: unknown) => reportError(error, { stage: 'sponsor-logo-remove' }));
      try {
        const deps = buildJobDeps(db);
        const result = await executePendingRefund(db, await deps.paymentProvider(), contributionId, await deps.refundOriginalIp());
        // «Devolución realizada» también sale al momento, no con la tarea de la bandeja.
        if (result.refunded) {
          const pending = await db.outboxMessage.findMany({ where: { idempotencyKey: `refund.issued:${contributionId}`, status: 'PENDING' }, select: { id: true } });
          if (pending.length > 0) await dispatchOutbox(db, buildOutboxDeps(db), { ids: pending.map((row) => row.id), limit: pending.length });
        }
      } catch (error) {
        reportError(error, { stage: 'sponsor-refund-after-reject', contributionId });
      }
    });
    return { status: 'OK' };
  });
}

/**
 * Regla de la entidad para el dinero de las renovaciones y de las campañas que no salen (Sprint 4.2d, `function saveSponsorRenewalRule`). Lo que ya esperaba
 * en la bolsa se coloca al momento con la regla nueva, y su comercio recibe el aviso.
 */
export async function saveSponsorRenewalRuleAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    const { placed } = await saveSponsorRenewalRule(db, actor, organizationId, payload);
    if (placed > 0) {
      revalidatePortal(orgSlug.slice(0, 64));
      dispatchSoon(await pendingReassignmentEmails(organizationId));
    }
    return { status: 'OK', placed };
  });
}

/** Lleva a la campaña elegida lo que un comercio tiene en la bolsa (regla `MANUAL`, o cuando el centro prefiere otra). Su aviso sale al momento. */
export async function assignPooledSponsorAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    const { title } = await assignPooledSponsor(db, actor, organizationId, payload);
    revalidatePortal(orgSlug.slice(0, 64));
    dispatchSoon(await pendingReassignmentEmails(organizationId));
    return { status: 'OK', title };
  });
}

/** Envía al comercio el enlace de pago de su renovación (el prototipo lo «simulaba»: aquí lo paga él en la página de Paycomet). */
export async function sendSponsorRenewalLinkAction(orgSlug: string, payload: unknown): Promise<ApprovalActionResult> {
  return run(orgSlug, payload, async ({ actor, organizationId }, db) => {
    const { messageId } = await sendRenewalLink(db, actor, organizationId, payload, getEnv().DATA_HMAC_SECRET);
    if (messageId !== null) dispatchSoon([messageId]);
    return { status: 'OK' };
  });
}

/** Avisos de reasignación de la entidad aún por enviar (los acaba de escribir la operación). */
async function pendingReassignmentEmails(organizationId: string): Promise<number[]> {
  const rows = await getPrisma().outboxMessage.findMany({ where: { organizationId, status: 'PENDING', templateKey: { in: ['sponsor.reassigned', 'sponsor.creditPool', 'initiative.goalReached'] } }, select: { id: true }, take: 50 });
  return rows.map((row) => row.id);
}
