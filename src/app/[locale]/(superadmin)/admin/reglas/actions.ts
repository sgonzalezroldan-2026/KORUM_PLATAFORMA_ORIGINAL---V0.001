'use server';

import { z } from 'zod';
import type { EntityActionResult } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { currentRequestMeta, requireVerifiedSuperadmin } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import type { RequestMeta } from '@/repositories/tenant-guard';
import { acknowledgePricingAlert, addGlobalCategory, GlobalRulesRejectedError, saveGlobalRules, saveMedals, setGlobalCategoryRule } from '@/services/admin/global-rules.service';

/**
 * Acciones del motor de reglas globales (Sprint 5.3). Todas piden el Super-Admin verificado (TOTP de hace menos de 10 minutos): cambian lo que cobra la
 * plataforma. Quien actúa sale de la sesión. Las respuestas no cuentan la causa de un rechazo más allá de qué campo está mal, que otra persona guardó
 * antes (`STALE`) o si hay que volver a pasar el segundo factor. Devuelven la misma forma que las de la ficha 360º para reutilizar su aviso de resultado.
 */

async function run(operation: string, work: (actor: VerifiedSuperadminActor, meta: RequestMeta) => Promise<string | void>): Promise<EntityActionResult> {
  try {
    const actor = await requireVerifiedSuperadmin(operation);
    const detail = await work(actor, await currentRequestMeta());
    return detail ? { status: 'DONE', detail } : { status: 'DONE' };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    if (error instanceof GlobalRulesRejectedError) return { status: 'REJECTED', reason: error.reason, fields: error.fields };
    throw error;
  }
}

const updatedAt = z.string().datetime();
/** Las reglas que se veían, en un texto estable (`rulesVersionOf`): el guardado compara valores, no fechas. */
const version = z.string().min(2).max(4_000);

export async function saveRulesAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = z.object({ rules: z.unknown(), expectedVersion: version }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('rules.global_update', async (actor, meta) => {
    const result = await saveGlobalRules(getPrisma(), actor, parsed.data.rules, parsed.data.expectedVersion, new Date(), meta);
    // La pantalla dice a cuántas entidades se les ha aplicado el cambio (las que no tienen tarifa propia).
    return `${result.changed}:${result.organizationsUpdated}`;
  });
}

export async function saveMedalsAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = z.object({ medals: z.unknown(), expectedUpdatedAt: updatedAt }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('rules.medals_update', (actor, meta) => saveMedals(getPrisma(), actor, parsed.data.medals, parsed.data.expectedUpdatedAt, new Date(), meta));
}

export async function addGlobalCategoryAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = z.object({ category: z.unknown() }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('rules.category_add', (actor, meta) => addGlobalCategory(getPrisma(), actor, parsed.data.category, new Date(), meta));
}

export async function setGlobalCategoryRuleAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = z.object({ category: z.unknown() }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('rules.category_rule', (actor, meta) => setGlobalCategoryRule(getPrisma(), actor, parsed.data.category, new Date(), meta));
}

/** «Aceptar y registrar» un aviso de precios: el aviso tal y como se vio (código, huella y fuente) y una nota obligatoria. */
export async function acknowledgePricingAlertAction(payload: unknown): Promise<EntityActionResult> {
  const parsed = z.object({ target: z.unknown(), note: z.unknown() }).safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_INPUT' };
  return run('pricing.acknowledge', async (actor, meta) => {
    await acknowledgePricingAlert(getPrisma(), actor, parsed.data.target, parsed.data.note, new Date(), meta);
  });
}
