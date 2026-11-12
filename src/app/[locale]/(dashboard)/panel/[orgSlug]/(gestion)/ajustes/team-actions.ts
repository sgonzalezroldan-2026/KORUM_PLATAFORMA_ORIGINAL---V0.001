'use server';

import { after } from 'next/server';
import { getEnv } from '@/config/env';
import { secondFactorIsFresh } from '@/core/security/verified-actor';
import { getAuthSession, getSessionActor } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { cancelHandover, proposeHandover, resendHandoverInvitation } from '@/services/panel/signer-handover.service';
import { changeSignatureMode, correctCosignerInvitation, updateOwnRoleLabel } from '@/services/panel/signer-team.service';
import { TeamRejectedError, type TeamContext, type TeamRejection } from '@/services/panel/team-common';

/**
 * Acciones del equipo que firma (Sprint 4.2e). La entidad sale de su `orgSlug`; quien actúa y si confirmó su código hace menos de 10 minutos, de
 * la sesión (nunca del formulario). Los servicios exigen el cargo con el segundo factor y dejan en la auditoría lo denegado. Los emails (invitación,
 * aviso a quien sale) salen al momento con `after()`, no con la tarea de la bandeja. El modo de firma y los relevos los decide la propia entidad (2026-11-12).
 */

export type TeamActionResult = { status: 'OK' } | { status: 'ERROR'; reason: TeamRejection | 'FORBIDDEN'; fields?: string[] };

const HANDOVER_ID = /^[a-z0-9]{20,40}$/;

async function run(orgSlug: string, operation: (input: { actor: SessionActor; organizationId: string; context: TeamContext }) => Promise<void>): Promise<TeamActionResult> {
  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug.slice(0, 64));
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN' };
  const [actor, session] = await Promise.all([getSessionActor(), getAuthSession()]);
  const env = getEnv();
  const context: TeamContext = {
    appUrl: env.NEXT_PUBLIC_APP_URL,
    hmacSecret: env.DATA_HMAC_SECRET,
    secondFactorFresh:
      session !== null && actor.kind === 'user' && session.userId === actor.userId
        ? await secondFactorIsFresh(db, {
            userId: session.userId,
            sessionId: session.sessionId
          })
        : false,
    dispatch: (ids) => {
      if (ids.length === 0) return;
      after(() =>
        dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length })
          .then(() => undefined)
          .catch((error: unknown) => reportError(error, { stage: 'outbox-after-team' }))
      );
    }
  };
  try {
    await operation({ actor, organizationId, context });
    return { status: 'OK' };
  } catch (error) {
    if (error instanceof TeamRejectedError) return { status: 'ERROR', reason: error.reason, fields: error.fields };
    if (error instanceof TenantAccessError || error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

const handoverId = (raw: unknown): string => (typeof raw === 'string' && HANDOVER_ID.test(raw) ? raw : '');

export async function proposeHandoverAction(orgSlug: string, payload: unknown): Promise<TeamActionResult> {
  return run(orgSlug, async ({ actor, organizationId, context }) => {
    await proposeHandover(getPrisma(), actor, organizationId, payload, context);
  });
}

export async function changeSignatureModeAction(orgSlug: string, payload: unknown): Promise<TeamActionResult> {
  return run(orgSlug, async ({ actor, organizationId, context }) => {
    await changeSignatureMode(getPrisma(), actor, organizationId, payload, context);
  });
}

export async function cancelHandoverAction(orgSlug: string, id: unknown): Promise<TeamActionResult> {
  return run(orgSlug, ({ actor, organizationId }) => cancelHandover(getPrisma(), actor, organizationId, handoverId(id)));
}

export async function resendHandoverAction(orgSlug: string, id: unknown): Promise<TeamActionResult> {
  return run(orgSlug, ({ actor, organizationId, context }) => resendHandoverInvitation(getPrisma(), actor, organizationId, handoverId(id), context));
}

export async function correctCosignerAction(orgSlug: string, payload: unknown): Promise<TeamActionResult> {
  return run(orgSlug, ({ actor, organizationId, context }) => correctCosignerInvitation(getPrisma(), actor, organizationId, payload, context));
}

export async function updateRoleLabelAction(orgSlug: string, payload: unknown): Promise<TeamActionResult> {
  return run(orgSlug, async ({ actor, organizationId }) => {
    await updateOwnRoleLabel(getPrisma(), actor, organizationId, payload);
  });
}
