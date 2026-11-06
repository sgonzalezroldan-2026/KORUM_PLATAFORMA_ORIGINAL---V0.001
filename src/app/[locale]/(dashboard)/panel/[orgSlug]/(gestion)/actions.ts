'use server';

import { after } from 'next/server';
import { getEnv } from '@/config/env';
import { resendCosignerInvitation } from '@/core/onboarding/community-registration';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { authorizeTenant, TenantAccessError } from '@/repositories/tenant-guard';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';

/** Reenvía la invitación a la persona cofirmante. Solo quien dirige la entidad, con su sesión (nunca un `organizationId` del cliente). */
export async function resendInvitationAction(orgSlug: string): Promise<'SENT' | 'NOT_NEEDED' | 'FORBIDDEN'> {
  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug.slice(0, 64));
  if (!organizationId) return 'FORBIDDEN';
  const actor = await getSessionActor();
  // Las acciones no pasan por el layout: aquí también hace falta el segundo factor en esta sesión (auditoría del 3.2, M1).
  if (actor.kind !== 'user' || actor.secondFactor !== true) return 'FORBIDDEN';
  try {
    await authorizeTenant(db, actor, organizationId, { roles: ['DIRECTOR'], action: 'organization.resend_invitation', targetType: 'Organization', allowSuperadmin: false });
  } catch (error) {
    if (error instanceof TenantAccessError) return 'FORBIDDEN';
    throw error;
  }
  const env = getEnv();
  const sent = await resendCosignerInvitation(db, organizationId, {
    appUrl: env.NEXT_PUBLIC_APP_URL,
    hmacSecret: env.DATA_HMAC_SECRET,
    dispatch: (ids) => after(() => dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length }).then(() => undefined))
  });
  return sent ? 'SENT' : 'NOT_NEEDED';
}
