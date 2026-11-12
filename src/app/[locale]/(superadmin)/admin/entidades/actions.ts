'use server';

import { z } from 'zod';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { requireVerifiedSuperadmin } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { KybReviewRejectedError, releaseOrganizationCif, reviewKyb } from '@/services/admin/kyb-review.service';
import { addOrganizationCategory, OrgAdminRejectedError, saveOrganizationTariffs, setOrganizationCategoryRule } from '@/services/admin/org-admin.service';

/**
 * Acciones de la ficha 360º (Sprint 5.2). Todas piden el Super-Admin verificado (TOTP de hace menos de 10 minutos) y la entidad sale del identificador
 * de la propia acción: quien actúa siempre sale de la sesión. Las respuestas no cuentan la causa de un rechazo: solo qué campo está mal o si hay que
 * volver a pasar el segundo factor.
 */

export type EntityActionResult =
  | { status: 'DONE'; detail?: string }
  | { status: 'REAUTH_REQUIRED' | 'INVALID_INPUT' }
  | { status: 'REJECTED'; reason: string; fields: string[] };

const organizationId = z.string().trim().min(1).max(80);

async function run(operation: string, work: (actor: VerifiedSuperadminActor) => Promise<string | void>): Promise<EntityActionResult> {
  try {
    const actor = await requireVerifiedSuperadmin(operation);
    const detail = await work(actor);
    return detail ? { status: 'DONE', detail } : { status: 'DONE' };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    if (error instanceof OrgAdminRejectedError || error instanceof KybReviewRejectedError) return { status: 'REJECTED', reason: error.reason, fields: error.fields };
    throw error;
  }
}

const withOrganization = z.object({ organizationId });

/** Verificar o devolver los documentos del titular. El cuerpo de la decisión lo valida el servicio (`kybReviewSchema`). */
export async function reviewKybAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = withOrganization.extend({ review: z.unknown() }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('kyb.review', async (actor) => (await reviewKyb(getPrisma(), actor, parsed.data.organizationId, parsed.data.review)).decision);
}

export async function releaseCifAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = withOrganization.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('kyb.release_cif', (actor) => releaseOrganizationCif(getPrisma(), actor, parsed.data.organizationId));
}

export async function saveTariffsAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = withOrganization.extend({ tariffs: z.unknown() }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('organization.tariffs_update', (actor) => saveOrganizationTariffs(getPrisma(), actor, parsed.data.organizationId, parsed.data.tariffs));
}

export async function setCategoryRuleAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = withOrganization.extend({ category: z.unknown() }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('organization.category_rule', (actor) => setOrganizationCategoryRule(getPrisma(), actor, parsed.data.organizationId, parsed.data.category));
}

export async function addCategoryAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = withOrganization.extend({ category: z.unknown() }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('organization.category_add', (actor) => addOrganizationCategory(getPrisma(), actor, parsed.data.organizationId, parsed.data.category));
}
