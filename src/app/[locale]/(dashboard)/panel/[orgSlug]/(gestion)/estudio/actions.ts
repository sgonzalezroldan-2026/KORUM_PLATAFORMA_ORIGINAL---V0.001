'use server';

import { after } from 'next/server';
import { getKeyring } from '@/config/keyring';
import { getSessionActor } from '@/lib/auth/session';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { InitiativeCoverError, removeInitiativeCover } from '@/services/panel/initiative-cover.service';
import { notifyIndexNow } from '@/services/seo/indexnow.service';
import { getStorageProvider } from '@/services/storage/provider-factory';
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
    // Aviso a los buscadores con la respuesta ya enviada: ni dentro de la transacción ni haciendo esperar a quien publica (IndexNow, Sprint 5.5b).
    if (result.published) after(() => notifyIndexNow({ db: getPrisma(), keyring: getKeyring }, { initiativeIds: [result.initiativeId] }).then(() => undefined));
    return { status: 'PUBLISHED', initiativeId: result.initiativeId };
  });
}

export type CoverActionResult = { status: 'OK' } | { status: 'ERROR'; reason: 'FORBIDDEN' | 'NOTHING_TO_REMOVE' | 'NOT_EDITABLE' };

/** Quita la imagen de una campaña (subirla es la ruta `/api/panel/campana-imagen`: una acción tiene un tope de 1 MB). */
export async function removeInitiativeCoverAction(orgSlug: string, initiativeId: number): Promise<CoverActionResult> {
  if (typeof orgSlug !== 'string') return { status: 'ERROR', reason: 'FORBIDDEN' };
  const slug = orgSlug.slice(0, 64);
  const organizationId = await findOrganizationIdBySlug(getPrisma(), slug);
  if (!organizationId || !Number.isSafeInteger(initiativeId) || initiativeId < 1 || initiativeId > 2_147_483_647) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    const removed = await removeInitiativeCover(getPrisma(), getStorageProvider(), await getSessionActor(), organizationId, initiativeId);
    if (!removed) return { status: 'ERROR', reason: 'NOTHING_TO_REMOVE' };
    revalidatePortal(slug);
    return { status: 'OK' };
  } catch (error) {
    if (error instanceof InitiativeCoverError) return { status: 'ERROR', reason: 'NOT_EDITABLE' };
    if (error instanceof TenantAccessError || error instanceof ResourceNotFoundError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

export async function discardStudioAction(orgSlug: string, initiativeId: number): Promise<StudioActionResult> {
  return run(orgSlug, async ({ actor, organizationId, slug }) => {
    await discardStudioDraft(getPrisma(), actor, organizationId, initiativeId);
    revalidatePortal(slug);
    return { status: 'DISCARDED' };
  });
}
