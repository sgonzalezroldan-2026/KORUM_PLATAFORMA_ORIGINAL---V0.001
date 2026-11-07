import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { AchievementPhotoRejectedError, MAX_UPLOAD_BYTES, publishAchievementPhoto, saveThanksMessage } from '@/services/storage/achievement-photos.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Fotos Antes / Después y agradecimiento de un logro (Sprint 3.6). Es una ruta y no una Server Action porque las acciones tienen un tope de 1 MB y
 * subir el límite sería para toda la aplicación. Quien llama sale de la sesión (membresía `DIRECTOR` o `COSIGNER` con el segundo factor); la
 * entidad, de su `orgSlug`; nada de eso se acepta como identificador de confianza. Se comprueba que la petición viene de la propia web (cabecera
 * `Origin`) y se corta por tamaño antes de leer el cuerpo: las cuentas de las entidades son un objetivo de ataque como las demás.
 */

const fields = z.object({
  intent: z.enum(['photo', 'thanks']),
  orgSlug: z.string().min(1).max(80),
  initiativeId: z.coerce.number().int().positive().max(2_147_483_647)
});

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Una persona con sesión que recibe un 403 deja rastro (Regla 01 §4); sin sesión no se escribe nada, para que una avalancha anónima no llene la auditoría. */
async function deny(actor: SessionActor, reason: string) {
  if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_logros_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/logros', metadata: { reason } });
  return json({ ok: false, error: 'FORBIDDEN' }, 403);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === (request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const actor = await getSessionActor();
  if (!sameOrigin(request)) return deny(actor, 'ORIGIN');
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return json({ ok: false, error: 'LENGTH_REQUIRED' }, 411);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) return json({ ok: false, error: 'TOO_LARGE' }, 413);

  // Sin el segundo factor en esta sesión, quien firma por una entidad no tiene aquí más derechos que cualquier otra persona.
  if (actor.kind !== 'user' || actor.secondFactor !== true) return deny(actor, 'SECOND_FACTOR');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  }
  const parsed = fields.safeParse({ intent: form.get('intent'), orgSlug: form.get('orgSlug'), initiativeId: form.get('initiativeId') });
  if (!parsed.success) return json({ ok: false, error: 'INVALID_INPUT' }, 400);

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return deny(actor, 'UNKNOWN_ORGANIZATION');

  try {
    if (parsed.data.intent === 'thanks') {
      const message = await saveThanksMessage(db, actor, { organizationId, initiativeId: parsed.data.initiativeId, message: String(form.get('message') ?? '') });
      return json({ ok: true, message }, 200);
    }
    const slot = form.get('slot');
    const file = form.get('file');
    if ((slot !== 'BEFORE' && slot !== 'AFTER') || !(file instanceof File) || file.size === 0) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return json({ ok: false, error: 'TOO_LARGE' }, 413);
    const result = await publishAchievementPhoto(db, getStorageProvider(), actor, {
      organizationId,
      initiativeId: parsed.data.initiativeId,
      slot,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMimeType: file.type,
      fileName: file.name,
      noIdentifiableMinors: form.get('noMinors') === 'on'
    });
    return json({ ok: true, fileId: result.fileId }, 200);
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof AchievementPhotoRejectedError) return json({ ok: false, error: error.reason }, 422);
    if (error instanceof FileRejectedError) return json({ ok: false, error: `FILE_${error.reason}` }, 422);
    throw error;
  }
}
