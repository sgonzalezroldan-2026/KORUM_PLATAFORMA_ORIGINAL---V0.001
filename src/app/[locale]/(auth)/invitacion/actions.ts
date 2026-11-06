'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { acceptInvitation, acceptInvitationWithSession, InvitationError, inspectInvitation, type InvitationView } from '@/core/onboarding/invitations';
import { getAuth } from '@/lib/auth/server';
import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';

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

export type AcceptInvitationResult = { ok: true } | { ok: false; reason: InvitationError['reason'] | 'UNKNOWN' };

/** Cuenta sin contraseña: la crea, acepta el cargo y abre la sesión (el TOTP se activa en la página siguiente). */
export async function acceptInvitationAction(token: string, password: string): Promise<AcceptInvitationResult> {
  const input = z.object({ token: tokenSchema, password: z.string().max(128) }).safeParse({ token, password });
  if (!input.success) return { ok: false, reason: 'INVALID_LINK' };
  try {
    const { email } = await acceptInvitation(getPrisma(), input.data.token, input.data.password);
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
    await acceptInvitationWithSession(getPrisma(), parsed.data, session.userId);
    return { ok: true };
  } catch (error) {
    if (error instanceof InvitationError) return { ok: false, reason: error.reason };
    throw error;
  }
}
