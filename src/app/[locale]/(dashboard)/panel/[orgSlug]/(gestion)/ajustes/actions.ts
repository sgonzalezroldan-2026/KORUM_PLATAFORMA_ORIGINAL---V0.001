'use server';

import { after } from 'next/server';
import { getSessionActor } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporting';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { EntitySettingsError, saveEntitySettings } from '@/services/panel/entity-settings.service';
import { KybRejectedError, saveKybIdentity, submitKyb, type KybRejection } from '@/services/panel/kyb.service';

/**
 * Acciones de los ajustes de la entidad (Sprint 4.2c). La entidad sale de su `orgSlug` y quien actúa, de la sesión. Las acciones no pasan por el
 * `layout`: el servicio (`requireSigner`) exige el segundo factor y el cargo en esa entidad, y deja en la auditoría lo denegado. Los documentos se suben por su propia ruta
 * (`/api/panel/documentos`): una acción tiene un tope de 1 MB.
 */

export type SettingsActionResult = { status: 'OK'; ideasToDoubleCheck?: number } | { status: 'ERROR'; reason: KybRejection | 'FORBIDDEN'; fields?: string[] };

async function panelContext(orgSlug: string): Promise<{ actor: SessionActor; organizationId: string } | null> {
  const organizationId = await findOrganizationIdBySlug(getPrisma(), orgSlug.slice(0, 64));
  if (!organizationId) return null;
  return { actor: await getSessionActor(), organizationId };
}

async function run(orgSlug: string, operation: (context: { actor: SessionActor; organizationId: string }) => Promise<SettingsActionResult>): Promise<SettingsActionResult> {
  const context = await panelContext(orgSlug);
  if (!context) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    return await operation(context);
  } catch (error) {
    if (error instanceof KybRejectedError) return { status: 'ERROR', reason: error.reason, fields: error.fields };
    if (error instanceof EntitySettingsError) return { status: 'ERROR', reason: 'INVALID', fields: error.fields };
    if (error instanceof TenantAccessError || error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

export async function saveKybIdentityAction(orgSlug: string, payload: unknown): Promise<SettingsActionResult> {
  return run(orgSlug, async ({ actor, organizationId }) => {
    await saveKybIdentity(getPrisma(), actor, organizationId, payload);
    return { status: 'OK' };
  });
}

export async function submitKybAction(orgSlug: string): Promise<SettingsActionResult> {
  return run(orgSlug, async ({ actor, organizationId }) => {
    await submitKyb(getPrisma(), actor, organizationId);
    return { status: 'OK' };
  });
}

export async function saveEntitySettingsAction(orgSlug: string, payload: unknown): Promise<SettingsActionResult> {
  return run(orgSlug, async ({ actor, organizationId }) => {
    const db = getPrisma();
    const result = await saveEntitySettings(db, actor, organizationId, payload);
    if (result.portalChanged) revalidatePortal(orgSlug.slice(0, 64));
    if (result.ideasToDoubleCheck.length > 0) {
      // El aviso «idea con quórum» a quienes firman sale ya, no con la tarea de la bandeja (como en la bandeja de aprobaciones).
      const pending = await db.outboxMessage.findMany({
        where: { organizationId, status: 'PENDING', OR: result.ideasToDoubleCheck.map((ideaId) => ({ idempotencyKey: { startsWith: `idea.quorumReached:idea:${ideaId}:` } })) },
        select: { id: true },
        take: 50
      });
      const ids = pending.map((row) => row.id);
      if (ids.length > 0) {
        after(() =>
          dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length })
            .then(() => undefined)
            .catch((error: unknown) => reportError(error, { stage: 'outbox-after-settings' }))
        );
      }
    }
    return { status: 'OK', ideasToDoubleCheck: result.ideasToDoubleCheck.length };
  });
}
