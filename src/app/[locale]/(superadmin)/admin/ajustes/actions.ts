'use server';

import type { EntityActionResult } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { getEnv } from '@/config/env';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { currentRequestMeta, requireVerifiedSuperadmin } from '@/lib/auth/session';
import { dispatchOutboxSoon } from '@/lib/panel/outbox-soon';
import { getPrisma } from '@/lib/prisma';
import type { RequestMeta } from '@/repositories/tenant-guard';
import { testConnection, type ConnectionResult } from '@/services/admin/connection-tests';
import { removeSecretValue, saveLegalText, saveSecretValue, saveSettingsSection, SettingsRejectedError } from '@/services/admin/platform-settings.service';
import { settingsRuntimeFromEnv } from '@/services/admin/settings-runtime';
import { cancelSuperadminInvitation, inviteSuperadmin, revokeSuperadmin, SuperadminTeamError } from '@/services/admin/superadmin-team.service';

/**
 * Acciones de `/admin/ajustes` (Sprint 5.4). Todas piden el Super-Admin verificado (TOTP de hace menos de 10 minutos, comprobado en el servidor a partir de la sesión): cambian lo que
 * mueve el dinero, los emails, la factura o quién tiene acceso. Responden con la misma forma que el resto de la consola; un rechazo solo cuenta **qué campo** falla y por qué motivo
 * (nunca el valor ni la respuesta de un proveedor), y si hay que volver a pasar el segundo factor. Nada se lee del cliente salvo lo que se guarda, que el servicio vuelve a validar.
 */

async function run(operation: string, work: (actor: VerifiedSuperadminActor, meta: RequestMeta) => Promise<string | void>): Promise<EntityActionResult> {
  try {
    const actor = await requireVerifiedSuperadmin(operation);
    const detail = await work(actor, await currentRequestMeta());
    return detail ? { status: 'DONE', detail } : { status: 'DONE' };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    if (error instanceof SettingsRejectedError) return { status: 'REJECTED', reason: error.reason, fields: error.fields };
    if (error instanceof SuperadminTeamError) return error.reason === 'INVALID_INPUT' ? { status: 'INVALID_INPUT' } : { status: 'REJECTED', reason: error.reason, fields: [] };
    throw error;
  }
}

/** Guarda un bloque de ajustes (`{ section, values, versions, confirmations }`): el servicio solo acepta los campos de ese bloque. */
export async function saveSectionAction(payload: unknown): Promise<EntityActionResult> {
  return run('settings.update', async (actor, meta) => `${(await saveSettingsSection(getPrisma(), actor, payload, settingsRuntimeFromEnv(), meta)).changed}`);
}

export async function saveSecretAction(payload: unknown): Promise<EntityActionResult> {
  return run('settings.secret_update', async (actor, meta) => {
    await saveSecretValue(getPrisma(), actor, payload, settingsRuntimeFromEnv(), meta);
  });
}

export async function removeSecretAction(payload: unknown): Promise<EntityActionResult> {
  return run('settings.secret_delete', (actor, meta) => removeSecretValue(getPrisma(), actor, payload, settingsRuntimeFromEnv(), meta));
}

export async function saveLegalTextAction(payload: unknown): Promise<EntityActionResult> {
  return run('settings.update', async (actor, meta) => (await saveLegalText(getPrisma(), actor, payload, meta)).version);
}

export async function inviteSuperadminAction(payload: unknown): Promise<EntityActionResult> {
  return run('superadmin.invite', async (actor, meta) => {
    const env = getEnv();
    await inviteSuperadmin(getPrisma(), actor, payload, { appUrl: env.NEXT_PUBLIC_APP_URL, hmacSecret: env.DATA_HMAC_SECRET, dispatch: (ids) => dispatchOutboxSoon(getPrisma(), ids, 'outbox-after-superadmin-invite') }, meta);
  });
}

export async function cancelSuperadminInvitationAction(payload: unknown): Promise<EntityActionResult> {
  return run('superadmin.invitation_cancel', (actor, meta) => cancelSuperadminInvitation(getPrisma(), actor, payload, meta));
}

export async function revokeSuperadminAction(payload: unknown): Promise<EntityActionResult> {
  return run('superadmin.revoke', (actor, meta) => revokeSuperadmin(getPrisma(), actor, payload, meta));
}

export type ConnectionActionResult = { status: 'RESULT'; result: ConnectionResult } | { status: 'REAUTH_REQUIRED' | 'INVALID_INPUT' };

/** «Probar conexión»: solo con lo que ya está guardado (el destino sale de una lista fija en el servidor, nunca del navegador). */
export async function testConnectionAction(payload: unknown): Promise<ConnectionActionResult> {
  try {
    const actor = await requireVerifiedSuperadmin('settings.connection_test');
    return { status: 'RESULT', result: await testConnection(getPrisma(), actor, payload, settingsRuntimeFromEnv(), await currentRequestMeta()) };
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    if (error instanceof SettingsRejectedError) return { status: 'INVALID_INPUT' };
    throw error;
  }
}
