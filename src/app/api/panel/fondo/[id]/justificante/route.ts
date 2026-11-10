import { getTranslations } from 'next-intl/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderFundReceiptPdf } from '@/core/sponsors/activity-fund-receipt';
import { isLocale } from '@/i18n/routing';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { fundPayoutOwner, loadFundReceiptRows } from '@/repositories/activity-fund.repository';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, recordCrossTenantAttempt, recordMissingResourceProbe, TenantAccessError } from '@/repositories/tenant-guard';

/**
 * Justificante en PDF de una liquidación del Fondo de actividades ya enviada (Sprint 4.2f). Descarga de solo lectura (`GET`, como un enlace). La persona
 * sale de la sesión (firmante con segundo factor, o el Super-Admin con registro) y la entidad, de su `orgSlug`: una liquidación de otra entidad responde
 * igual que una que no existe. Nada se guarda en el servidor ni en caché.
 */

const query = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647), org: z.string().min(1).max(80), lang: z.string().refine(isLocale) });

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getSessionActor();
  // Solo desde el propio panel (o escribiendo la dirección): un enlace puesto en otra web, o en otro subdominio, no puede forzar la descarga ni dejar
  // su fila en la auditoría a nombre de la persona. Sin la cabecera (navegadores antiguos) se admite: la sesión sigue siendo obligatoria.
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return json({ ok: false, error: 'FORBIDDEN' }, 403);
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_fund_receipt_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/fondo', metadata: { reason: 'SECOND_FACTOR' } });
    return json({ ok: false, error: 'FORBIDDEN' }, 403);
  }
  const url = new URL(request.url);
  const parsed = query.safeParse({ id: (await params).id, org: url.searchParams.get('org'), lang: url.searchParams.get('lang') });
  if (!parsed.success || !isLocale(parsed.data.lang)) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  const { id, org, lang } = parsed.data;

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, org);
  if (!organizationId) return json({ ok: false, error: 'FORBIDDEN' }, 403);
  try {
    const row = await loadFundReceiptRows(db, actor, organizationId, id);
    if (!row || !row.executedAt) {
      // La misma respuesta exista o no, sea o no de otra entidad; la auditoría sí lo distingue.
      const owner = await fundPayoutOwner(db, id);
      const probe = { organizationId, resourceType: 'ActivityFundPayout', resourceId: id };
      if (owner && owner !== organizationId) await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: owner });
      else await recordMissingResourceProbe(db, actor, probe);
      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    }
    const [t, levels, roles] = await Promise.all([
      getTranslations({ locale: lang, namespace: 'panel.fund.receipt' }),
      getTranslations({ locale: lang, namespace: 'panel.fund.levels' }),
      getTranslations({ locale: lang, namespace: 'panel.approvals.doubleCheck.roles' })
    ]);
    const bytes = renderFundReceiptPdf(
      {
        reference: `FA-${row.id}`,
        entityName: row.organization.name,
        legalName: row.organization.legalName,
        amountCents: row.amountCents,
        purpose: row.purpose,
        requestedAt: row.createdAt,
        executedAt: row.executedAt,
        sponsors: row.splits.map((split) => ({ name: split.sponsor.name, level: levels(split.sponsor.categoryLevel as never), amountCents: split.amountCents, chargedAt: split.contribution.createdAt })),
        signatures: row.signatures.map((signature) => ({ role: roles(signature.signerRole as never), name: signature.signer.name, signedAt: signature.signedAt })),
        generatedAt: new Date(),
        locale: lang
      },
      (key, values) => t(key as never, values as never)
    );
    await recordAudit(db, actor, { action: 'activity_fund.receipt_downloaded', organizationId, targetType: 'ActivityFundPayout', targetId: String(id), metadata: {} });
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="justificante-fondo-FA-${row.id}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      }
    });
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    throw error;
  }
}
