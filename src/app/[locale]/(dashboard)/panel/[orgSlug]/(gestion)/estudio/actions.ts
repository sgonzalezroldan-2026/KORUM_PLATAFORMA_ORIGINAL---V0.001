'use server';

import { getSessionActor } from '@/lib/auth/session';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { discardStudioDraft, publishStudioInitiative, saveStudioDraft, StudioError, type StudioErrorReason } from '@/services/panel/studio.service';

/**
 * Acciones del Estudio de edición (Sprint 4.3). La entidad sale de su `orgSlug` y quien actúa, de la sesión: el servicio (`requireSigner`) exige el
 * segundo factor y el cargo en esa entidad, y deja en la auditoría lo denegado. Aquí no se calcula nada: el servicio recalcula la pizarra con las
 * reglas y los cupos de la base de datos.
 */

export type StudioActionResult =
  | { status: 'SAVED'; initiativeId: number; goalCents: number; created: boolean }
  | { status: 'PUBLISHED'; initiativeId: number }
  | { status: 'DISCARDED' }
  | { status: 'ERROR'; reason: StudioErrorReason | 'FORBIDDEN'; detail: string[]; initiativeId?: number };

async function run(orgSlug: string, operation: (context: { actor: SessionActor; organizationId: string; slug: string }) => Promise<StudioActionResult>): Promise<StudioActionResult> {
  const slug = orgSlug.slice(0, 64);
  const organizationId = await findOrganizationIdBySlug(getPrisma(), slug);
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN', detail: [] };
  try {
    return await operation({ actor: await getSessionActor(), organizationId, slug });
  } catch (error) {
    if (error instanceof StudioError) return { status: 'ERROR', reason: error.reason, detail: [...error.detail], ...(error.initiativeId === undefined ? {} : { initiativeId: error.initiativeId }) };
    if (error instanceof TenantAccessError || error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'FORBIDDEN', detail: [] };
    throw error;
  }
}

export async function saveStudioAction(orgSlug: string, payload: unknown): Promise<StudioActionResult> {
  return run(orgSlug, async ({ actor, organizationId, slug }) => {
    const saved = await saveStudioDraft(getPrisma(), actor, organizationId, payload);
    revalidatePortal(slug);
    return { status: 'SAVED', initiativeId: saved.initiativeId, goalCents: saved.goalCents, created: saved.created };
  });
}

export async function publishStudioAction(orgSlug: string, payload: unknown): Promise<StudioActionResult> {
  return run(orgSlug, async ({ actor, organizationId, slug }) => {
    const result = await publishStudioInitiative(getPrisma(), actor, organizationId, payload);
    revalidatePortal(slug);
    return { status: 'PUBLISHED', initiativeId: result.initiativeId };
  });
}

export async function discardStudioAction(orgSlug: string, initiativeId: number): Promise<StudioActionResult> {
  return run(orgSlug, async ({ actor, organizationId, slug }) => {
    await discardStudioDraft(getPrisma(), actor, organizationId, initiativeId);
    revalidatePortal(slug);
    return { status: 'DISCARDED' };
  });
}
