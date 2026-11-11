import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CampaignPayoutError } from '@/core/payouts/campaign-payout-rules';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { MAX_INVOICE_BYTES, uploadPayoutInvoice } from '@/services/payouts/payout-invoice.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Subir la factura (o proforma) del proveedor de una campaña (Sprint 4.4a). Es una ruta y no una Server Action porque las acciones tienen un tope de 1 MB.
 * Quien llama sale de la sesión (firmante con segundo factor); la entidad, de su `orgSlug`. Se comprueba que la petición viene de la propia web (cabecera
 * `Origin`) y se corta por tamaño antes de leer el cuerpo.
 */

const fields = z.object({ orgSlug: z.string().min(1).max(80), initiativeId: z.coerce.number().int().positive().max(2_147_483_647) });

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Una persona con sesión que recibe un 403 deja rastro (Regla 01 §4); sin sesión no se escribe nada. */
async function deny(actor: SessionActor, reason: string) {
  if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_payout_invoice_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/liquidaciones/factura', metadata: { reason } });
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
  if (length > MAX_INVOICE_BYTES + 64 * 1024) return json({ ok: false, error: 'TOO_LARGE' }, 413);
  if (actor.kind !== 'user' || actor.secondFactor !== true) return deny(actor, 'SECOND_FACTOR');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  }
  const parsed = fields.safeParse({ orgSlug: form.get('orgSlug'), initiativeId: form.get('initiativeId') });
  const file = form.get('file');
  if (!parsed.success || !(file instanceof File) || file.size === 0) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  if (file.size > MAX_INVOICE_BYTES) return json({ ok: false, error: 'TOO_LARGE' }, 413);

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return deny(actor, 'UNKNOWN_ORGANIZATION');
  try {
    const result = await uploadPayoutInvoice(db, getStorageProvider(), actor, {
      organizationId,
      initiativeId: parsed.data.initiativeId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMimeType: file.type,
      fileName: file.name
    });
    return json({ ok: true, fileId: result.fileId }, 200);
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof CampaignPayoutError) return json({ ok: false, error: error.reason }, error.reason === 'RATE_LIMITED' ? 429 : 422);
    if (error instanceof FileRejectedError) return json({ ok: false, error: `FILE_${error.reason}` }, 422);
    throw error;
  }
}
