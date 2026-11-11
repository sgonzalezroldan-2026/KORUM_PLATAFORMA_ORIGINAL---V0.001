import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionActor } from '@/lib/auth/session';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { InitiativeCoverError, publishInitiativeCover } from '@/services/panel/initiative-cover.service';
import { authorizeEntityImageUpload, EntityBrandingError, ENTITY_IMAGE_MAX_BYTES } from '@/services/panel/entity-branding.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Imagen representativa de una campaña (Sprint 4.4c). Ruta y no Server Action por el tope de 1 MB de las acciones, como la portada de la entidad: se
 * comprueba que la petición viene de la propia web (`Origin`), se corta por tamaño y se comprueba el cargo con el segundo factor **antes de leer el
 * cuerpo**. La entidad sale de su `orgSlug` y quien sube, de la sesión; la campaña se pide junto a su entidad (una de otra responde un 404 idéntico
 * al de una inexistente). Quitarla es una Server Action (`removeInitiativeCoverAction`).
 */

const MAX_BYTES = ENTITY_IMAGE_MAX_BYTES.banner;

const fields = z.object({
  orgSlug: z.string().min(1).max(80),
  initiativeId: z.coerce.number().int().positive().max(2_147_483_647)
});

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function deny(actor: SessionActor, reason: string) {
  if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_cover_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/campana-imagen', metadata: { reason } });
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
  const query = new URL(request.url).searchParams;
  const parsed = fields.safeParse({ orgSlug: query.get('orgSlug'), initiativeId: query.get('initiativeId') });
  if (!parsed.success) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return json({ ok: false, error: 'LENGTH_REQUIRED' }, 411);
  if (length > MAX_BYTES + 64 * 1024) return json({ ok: false, error: 'TOO_LARGE' }, 413);
  if (actor.kind !== 'user' || actor.secondFactor !== true) return deny(actor, 'SECOND_FACTOR');

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return deny(actor, 'UNKNOWN_ORGANIZATION');
  try {
    // El cargo y el tope de subidas, antes de leer el cuerpo: alguien sin cargo en la entidad no llega a subir nada.
    await authorizeEntityImageUpload(db, actor, organizationId, new Date(), 'initiative.cover_upload');
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: 'INVALID_INPUT' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
    if (file.size > MAX_BYTES) return json({ ok: false, error: 'TOO_LARGE' }, 413);
    const result = await publishInitiativeCover(db, getStorageProvider(), actor, {
      organizationId,
      initiativeId: parsed.data.initiativeId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMimeType: file.type,
      fileName: file.name,
      noMinorsConfirmed: form.get('noMinors') === 'true'
    });
    revalidatePortal(parsed.data.orgSlug);
    return json({ ok: true, fileId: result.fileId }, 200);
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof EntityBrandingError) return json({ ok: false, error: error.reason }, 422);
    if (error instanceof InitiativeCoverError) return json({ ok: false, error: error.reason }, 422);
    if (error instanceof FileRejectedError) return json({ ok: false, error: `FILE_${error.reason}` }, 422);
    throw error;
  }
}
