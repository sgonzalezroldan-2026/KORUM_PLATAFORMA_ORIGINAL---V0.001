import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionActor } from '@/lib/auth/session';
import { revalidatePortal } from '@/lib/portal/revalidate-portal';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { getStorageProvider } from '@/services/storage/provider-factory';
import { MAX_LOGO_BYTES, publishSponsorLogo, SponsorLogoRejectedError } from '@/services/storage/sponsor-logo.service';

/**
 * Logotipo de un comercio amigo (Sprint 4.2b). Ruta y no Server Action por el tope de 1 MB de las acciones, igual que las fotos de logros: se comprueba
 * que la petición viene de la propia web (`Origin`), se corta por tamaño antes de leer el cuerpo y quien llama sale de la sesión con el segundo factor.
 * La entidad sale de su `orgSlug` y el comercio debe ser suyo (lo comprueba el servicio).
 */

const fields = z.object({ orgSlug: z.string().min(1).max(80), sponsorId: z.coerce.number().int().positive().max(2_147_483_647) });

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function deny(actor: SessionActor, reason: string) {
  if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_sponsor_logo_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/comercios/logo', metadata: { reason } });
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
  if (length > MAX_LOGO_BYTES + 64 * 1024) return json({ ok: false, error: 'TOO_LARGE' }, 413);
  if (actor.kind !== 'user' || actor.secondFactor !== true) return deny(actor, 'SECOND_FACTOR');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  }
  const parsed = fields.safeParse({ orgSlug: form.get('orgSlug'), sponsorId: form.get('sponsorId') });
  const file = form.get('file');
  if (!parsed.success || !(file instanceof File) || file.size === 0) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  if (file.size > MAX_LOGO_BYTES) return json({ ok: false, error: 'TOO_LARGE' }, 413);

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return deny(actor, 'UNKNOWN_ORGANIZATION');
  try {
    const result = await publishSponsorLogo(db, getStorageProvider(), actor, {
      organizationId,
      sponsorId: parsed.data.sponsorId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMimeType: file.type,
      fileName: file.name
    });
    revalidatePortal(parsed.data.orgSlug);
    return json({ ok: true, fileId: result.fileId }, 200);
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof SponsorLogoRejectedError) return json({ ok: false, error: error.reason }, 422);
    if (error instanceof FileRejectedError) return json({ ok: false, error: `FILE_${error.reason}` }, 422);
    throw error;
  }
}
