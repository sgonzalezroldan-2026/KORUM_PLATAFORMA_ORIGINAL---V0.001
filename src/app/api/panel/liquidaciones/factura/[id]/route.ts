import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CampaignPayoutError } from '@/core/payouts/campaign-payout-rules';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError } from '@/repositories/tenant-guard';
import { openPayoutInvoice } from '@/services/payouts/payout-invoice.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Abrir la factura del proveedor de una liquidación (Sprint 4.4a), para que la segunda persona vea lo que firma. Es un enlace normal (`GET`): redirige a una
 * URL firmada del cubo privado que vive 5 minutos. Solo quienes firman en la entidad con el segundo factor, o el Super-Admin (con registro). Una factura de
 * otra entidad responde igual que una que no existe. Ni la respuesta ni la redirección se guardan en caché, y la dirección firmada no viaja en el `Referer`.
 */

const query = z.object({ orgSlug: z.string().min(1).max(80) });
const params = z.string().regex(/^[a-z0-9]{20,40}$/);

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await getSessionActor();
  // Un enlace puesto en otra web no abre la factura con las cookies de la persona: solo desde la propia web o tecleado.
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return json({ ok: false, error: 'FORBIDDEN' }, 403);
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_payout_invoice_open_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/liquidaciones/factura', metadata: { reason: 'SECOND_FACTOR' } });
    return json({ ok: false, error: 'FORBIDDEN' }, 403);
  }
  const fileId = params.safeParse((await context.params).id);
  const parsed = query.safeParse({ orgSlug: new URL(request.url).searchParams.get('orgSlug') });
  if (!fileId.success || !parsed.success) return json({ ok: false, error: 'INVALID_INPUT' }, 400);

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  try {
    const url = await openPayoutInvoice(db, getStorageProvider(), actor, organizationId, fileId.data);
    return new NextResponse(null, { status: 303, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof CampaignPayoutError) return json({ ok: false, error: error.reason }, 429);
    throw error;
  }
}
