import { NextResponse } from 'next/server';
import { z } from 'zod';
import { KYB_DOCUMENT_KINDS } from '@/core/panel/entity-settings-rules';
import { getSessionActor } from '@/lib/auth/session';
import { isSameOrigin } from '@/lib/http/same-origin';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { authorizeKybUpload, KybRejectedError, uploadKybDocument } from '@/services/panel/kyb.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { FILE_RULES } from '@/services/storage/file-rules';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Subida de un documento del titular (KYB, Sprint 4.2c; heredado del 3.2). Ruta y no Server Action por el tope de 1 MB de las acciones. Antes de leer
 * el cuerpo: que la petición venga de la propia web (`Origin`), su tamaño, la sesión con el segundo factor y, con la entidad y el tipo de la
 * dirección (`?orgSlug=&kind=`), el cargo en **esa** entidad y el tope de subidas (auditoría del 4.2c: nadie de otra entidad hace leer el fichero).
 * Después, el servicio vuelve a comprobarlo todo con el contenido.
 */

const MAX_BYTES = FILE_RULES.KYB_DOCUMENT.maxBytes;
const query = z.object({ orgSlug: z.string().min(1).max(80), kind: z.enum(KYB_DOCUMENT_KINDS) });

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function deny(actor: SessionActor, reason: string) {
  if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_kyb_upload_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/documentos', metadata: { reason } });
  return json({ ok: false, error: 'FORBIDDEN' }, 403);
}

function fail(error: unknown) {
  if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
  if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  if (error instanceof KybRejectedError) return json({ ok: false, error: error.reason }, error.reason === 'RATE_LIMITED' ? 429 : 422);
  if (error instanceof FileRejectedError) return json({ ok: false, error: `FILE_${error.reason}` }, 422);
  throw error;
}

export async function POST(request: Request) {
  const actor = await getSessionActor();
  if (!isSameOrigin(request)) return deny(actor, 'ORIGIN');
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return json({ ok: false, error: 'LENGTH_REQUIRED' }, 411);
  if (length > MAX_BYTES + 64 * 1024) return json({ ok: false, error: 'TOO_LARGE' }, 413);
  if (actor.kind !== 'user' || actor.secondFactor !== true) return deny(actor, 'SECOND_FACTOR');
  const url = new URL(request.url);
  const parsed = query.safeParse({ orgSlug: url.searchParams.get('orgSlug'), kind: url.searchParams.get('kind') });
  if (!parsed.success) return json({ ok: false, error: 'INVALID_INPUT' }, 400);

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return deny(actor, 'UNKNOWN_ORGANIZATION');
  try {
    await authorizeKybUpload(db, actor, organizationId);
  } catch (error) {
    return fail(error);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'TOO_LARGE' }, 413);
  try {
    const result = await uploadKybDocument(db, getStorageProvider(), actor, {
      organizationId,
      kind: parsed.data.kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMimeType: file.type,
      fileName: file.name
    });
    return json({ ok: true, documentId: result.documentId }, 200);
  } catch (error) {
    return fail(error);
  }
}
