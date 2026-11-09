'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { z } from 'zod';
import { acceptInvitation, acceptInvitationWithSession, InvitationError, inspectInvitation, type InvitationView } from '@/core/onboarding/invitations';
import { getAuth } from '@/lib/auth/server';
import { getAuthSession } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';

/** Acciones de la página de invitación. El token llega del fragmento de la URL, que solo lee el navegador. */

const tokenSchema = z.string().min(40).max(120);

export type InvitationPageView = InvitationView & { signedInAsInvitee: boolean; signedInAsOther: boolean };

export async function inspectInvitationAction(token: string): Promise<InvitationPageView | null> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) return null;
  const view = await inspectInvitation(getPrisma(), parsed.data);
  if (!view) return null;
  const session = await getAuthSession();
  const { userId, ...publicView } = view;
  return { ...publicView, signedInAsInvitee: session?.userId === userId, signedInAsOther: session !== null && session.userId !== userId };
}

/** Relevo de firmantes completado (Sprint 4.2e): el aviso a quien sale y a quien sigue firmando sale ya, no con la tarea de la bandeja. */
async function dispatchHandoverNotices(handoverId: string | null): Promise<void> {
  if (!handoverId) return;
  const db = getPrisma();
  const pending = await db.outboxMessage.findMany({ where: { status: 'PENDING', idempotencyKey: { startsWith: `signer.handover:${handoverId}:COMPLETED:` } }, select: { id: true }, take: 5 });
  const ids = pending.map((row) => row.id);
  if (ids.length === 0) return;
  after(() =>
    dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length })
      .then(() => undefined)
      .catch((error: unknown) => reportError(error, { stage: 'outbox-after-handover' }))
  );
}

export type AcceptInvitationResult = { ok: true } | { ok: false; reason: InvitationError['reason'] | 'UNKNOWN' };

/** Cuenta sin contraseña: la crea, acepta el cargo y abre la sesión (el TOTP se activa en la página siguiente). */
export async function acceptInvitationAction(token: string, password: string): Promise<AcceptInvitationResult> {
  const input = z.object({ token: tokenSchema, password: z.string().max(128) }).safeParse({ token, password });
  if (!input.success) return { ok: false, reason: 'INVALID_LINK' };
  try {
    const { email, handoverId } = await acceptInvitation(getPrisma(), input.data.token, input.data.password);
    await dispatchHandoverNotices(handoverId);
    await getAuth().api.signInEmail({ body: { email, password: input.data.password }, headers: await headers() });
    return { ok: true };
  } catch (error) {
    if (error instanceof InvitationError) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** Cuenta con contraseña: acepta el cargo con la sesión de esa misma persona. */
export async function acceptInvitationWithSessionAction(token: string): Promise<AcceptInvitationResult> {
  const parsed = tokenSchema.safeParse(token);
  const session = await getAuthSession();
  if (!parsed.success || !session) return { ok: false, reason: 'INVALID_LINK' };
  try {
    const { handoverId } = await acceptInvitationWithSession(getPrisma(), parsed.data, session.userId);
    await dispatchHandoverNotices(handoverId);
    return { ok: true };
  } catch (error) {
    if (error instanceof InvitationError) return { ok: false, reason: error.reason };
    throw error;
  }
}
