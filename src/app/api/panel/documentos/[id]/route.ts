import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError } from '@/repositories/tenant-guard';
import { openKybDocument } from '@/services/panel/kyb.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Abrir un documento del titular (Sprint 4.2c). Es un enlace normal (`GET`): redirige a una URL firmada del cubo privado que vive 5 minutos. Solo
 * las personas firmantes de la entidad con el segundo factor, o el Super-Admin (con registro). Un documento de otra entidad responde igual que
 * uno que no existe. Ni la respuesta ni la redirección se guardan en caché, y la dirección firmada no viaja en el `Referer`.
 */

const query = z.object({ orgSlug: z.string().min(1).max(80) });
const params = z.coerce.number().int().positive().max(2_147_483_647);

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await getSessionActor();
  // Un enlace puesto en otra web (u otro subdominio) no abre el documento con las cookies de la persona ni deja rastro a su nombre: solo desde la
  // propia web o tecleado. Si un navegador antiguo no la envía, se admite: sigue haciendo falta la sesión con segundo factor y la apertura queda
  // en la auditoría.
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return json({ ok: false, error: 'FORBIDDEN' }, 403);
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_kyb_open_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/documentos', metadata: { reason: 'SECOND_FACTOR' } });
    return json({ ok: false, error: 'FORBIDDEN' }, 403);
  }
  const documentId = params.safeParse((await context.params).id);
  const parsed = query.safeParse({ orgSlug: new URL(request.url).searchParams.get('orgSlug') });
  if (!documentId.success || !parsed.success) return json({ ok: false, error: 'INVALID_INPUT' }, 400);

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  try {
    const url = await openKybDocument(db, getStorageProvider(), actor, organizationId, documentId.data);
    return new NextResponse(null, { status: 303, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    throw error;
  }
}
