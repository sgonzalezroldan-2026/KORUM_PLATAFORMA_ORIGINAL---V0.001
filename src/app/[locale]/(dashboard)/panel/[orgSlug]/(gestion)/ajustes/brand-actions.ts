'use server';

import type { GroupIssue } from '@/core/panel/participation-groups-rules';
import { getSessionActor } from '@/lib/auth/session';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { EntityBrandingError, removeEntityImage, saveEntityAccent } from '@/services/panel/entity-branding.service';
import { ParticipationGroupsError, saveParticipationGroups } from '@/services/panel/participation-groups.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Acciones de los grupos de participación y de la identidad visual (Sprint 4.2e). La entidad sale de su `orgSlug` y quien actúa, de la sesión; el
 * servicio exige el cargo con el segundo factor. Lo que cambia se ve en el portal: se regenera al momento en sus tres idiomas. Las imágenes se suben
 * por su ruta (`/api/panel/marca`): una acción tiene un tope de 1 MB.
 */

export type BrandActionResult =
  | { status: 'OK' }
  | {
      status: 'ERROR';
      reason: 'FORBIDDEN' | 'INVALID' | 'NOTHING_TO_REMOVE';
      fields?: string[];
      issues?: GroupIssue[];
    };

async function run(orgSlug: string, operation: (input: { actor: SessionActor; organizationId: string; slug: string }) => Promise<BrandActionResult>): Promise<BrandActionResult> {
  const slug = orgSlug.slice(0, 64);
  const organizationId = await findOrganizationIdBySlug(getPrisma(), slug);
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    return await operation({
      actor: await getSessionActor(),
      organizationId,
      slug
    });
  } catch (error) {
    if (error instanceof ParticipationGroupsError)
      return {
        status: 'ERROR',
        reason: 'INVALID',
        fields: error.fields,
        issues: error.issues
      };
    if (error instanceof EntityBrandingError) return { status: 'ERROR', reason: 'INVALID' };
    if (error instanceof TenantAccessError || error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

export async function saveParticipationGroupsAction(orgSlug: string, payload: unknown): Promise<BrandActionResult> {
  return run(orgSlug, async ({ actor, organizationId, slug }) => {
    await saveParticipationGroups(getPrisma(), actor, organizationId, payload);
    revalidatePortal(slug);
    return { status: 'OK' };
  });
}

export async function saveEntityAccentAction(orgSlug: string, payload: unknown): Promise<BrandActionResult> {
  return run(orgSlug, async ({ actor, organizationId, slug }) => {
    await saveEntityAccent(getPrisma(), actor, organizationId, payload);
    revalidatePortal(slug);
    return { status: 'OK' };
  });
}

export async function removeEntityImageAction(orgSlug: string, kind: unknown): Promise<BrandActionResult> {
  if (kind !== 'logo' && kind !== 'banner') return { status: 'ERROR', reason: 'INVALID' };
  return run(orgSlug, async ({ actor, organizationId, slug }) => {
    const removed = await removeEntityImage(getPrisma(), getStorageProvider(), actor, organizationId, kind);
    if (!removed) return { status: 'ERROR', reason: 'NOTHING_TO_REMOVE' };
    revalidatePortal(slug);
    return { status: 'OK' };
  });
}
