import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionActor } from '@/lib/auth/session';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { authorizeEntityImageUpload, ENTITY_IMAGE_MAX_BYTES, EntityBrandingError, publishEntityImage } from '@/services/panel/entity-branding.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Logotipo y portada de la entidad (Sprint 4.2e). Ruta y no Server Action por el tope de 1 MB de las acciones, como los documentos del titular: se
 * comprueba que la petición viene de la propia web (`Origin`), se corta por tamaño y se comprueba el cargo con el segundo factor **antes de leer el
 * cuerpo**. La entidad sale de su `orgSlug` y quien sube, de la sesión.
 */

const fields = z.object({
  orgSlug: z.string().min(1).max(80),
  kind: z.enum(['logo', 'banner'])
});

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function deny(actor: SessionActor, reason: string) {
  if (actor.kind === 'user')
    await recordAudit(getPrisma(), actor, {
      action: 'api.panel_entity_image_denied',
      organizationId: null,
      targetType: 'Route',
      targetId: 'api/panel/marca',
      metadata: { reason }
    });
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
  const query = fields.safeParse({
    orgSlug: new URL(request.url).searchParams.get('orgSlug'),
    kind: new URL(request.url).searchParams.get('kind')
  });
  if (!query.success) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  const maxBytes = ENTITY_IMAGE_MAX_BYTES[query.data.kind];
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return json({ ok: false, error: 'LENGTH_REQUIRED' }, 411);
  if (length > maxBytes + 64 * 1024) return json({ ok: false, error: 'TOO_LARGE' }, 413);
  if (actor.kind !== 'user' || actor.secondFactor !== true) return deny(actor, 'SECOND_FACTOR');

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, query.data.orgSlug);
  if (!organizationId) return deny(actor, 'UNKNOWN_ORGANIZATION');
  try {
    // El cargo, antes de leer el cuerpo: alguien sin cargo en la entidad no llega a subir nada.
    await authorizeEntityImageUpload(db, actor, organizationId);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: 'INVALID_INPUT' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
    if (file.size > maxBytes) return json({ ok: false, error: 'TOO_LARGE' }, 413);
    const result = await publishEntityImage(db, getStorageProvider(), actor, {
      organizationId,
      kind: query.data.kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMimeType: file.type,
      fileName: file.name,
      noMinorsConfirmed: form.get('noMinors') === 'true'
    });
    revalidatePortal(query.data.orgSlug);
    return json({ ok: true, fileId: result.fileId }, 200);
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof EntityBrandingError) return json({ ok: false, error: error.reason }, 422);
    if (error instanceof FileRejectedError) return json({ ok: false, error: `FILE_${error.reason}` }, 422);
    throw error;
  }
}
