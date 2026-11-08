import { getTranslations } from 'next-intl/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isLocale } from '@/i18n/routing';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError } from '@/repositories/tenant-guard';
import { buildMedalKitFile, MedalKitUnavailableError } from '@/services/panel/medal-kit.service';

/**
 * Kit de una medalla (Sprint 4.1): el informe de impacto en PDF (`?tipo=informe`) y el sello para la web en SVG (`?tipo=sello`). Es una descarga
 * de solo lectura (`GET`, para que el navegador la trate como un enlace normal). La persona sale de la sesión (firmante con segundo factor) y
 * la entidad, de su `orgSlug`; el servicio comprueba que la entidad tiene ya esa medalla. Nada se guarda en el servidor ni en caché.
 */

const query = z.object({
  orgSlug: z.string().min(1).max(80),
  nivel: z.string().min(1).max(20),
  tipo: z.enum(['informe', 'sello']),
  locale: z.string().refine(isLocale)
});

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  const actor = await getSessionActor();
  // Un enlace puesto en otra web no puede forzar la descarga (ni dejar su fila en la auditoría a nombre de la persona).
  if (request.headers.get('sec-fetch-site') === 'cross-site') return json({ ok: false, error: 'FORBIDDEN' }, 403);
  // Sin el segundo factor en esta sesión, quien firma por una entidad no tiene aquí más derechos que cualquier otra persona.
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    if (actor.kind === 'user') await recordAudit(getPrisma(), actor, { action: 'api.panel_medalla_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/medalla', metadata: { reason: 'SECOND_FACTOR' } });
    return json({ ok: false, error: 'FORBIDDEN' }, 403);
  }
  const url = new URL(request.url);
  const parsed = query.safeParse({ orgSlug: url.searchParams.get('orgSlug'), nivel: url.searchParams.get('nivel'), tipo: url.searchParams.get('tipo'), locale: url.searchParams.get('locale') });
  if (!parsed.success || !isLocale(parsed.data.locale)) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  const { orgSlug, nivel, tipo, locale } = parsed.data;

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug);
  if (!organizationId) {
    await recordAudit(db, actor, { action: 'api.panel_medalla_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/medalla', metadata: { reason: 'UNKNOWN_ORGANIZATION' } });
    return json({ ok: false, error: 'FORBIDDEN' }, 403);
  }

  const [report, seal, names] = await Promise.all([getTranslations({ locale, namespace: 'panel.medals.report' }), getTranslations({ locale, namespace: 'panel.medals.seal' }), getTranslations({ locale, namespace: 'panel.medals.names' })]);
  const tierNames = Object.fromEntries((['bronze', 'silver', 'gold'] as const).map((key) => [key, names(key)]));
  try {
    const file = await buildMedalKitFile(db, actor, {
      organizationId,
      levelKey: nivel,
      kind: tipo === 'informe' ? 'report' : 'seal',
      locale,
      tierNames,
      translate: {
        report: (key, values) => report(key as never, values as never),
        seal: (key, values) => seal(key as never, values as never)
      },
      now: new Date()
    });
    return new NextResponse(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // Por si el SVG llegara a abrirse en línea: sin scripts, sin recursos externos.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      }
    });
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof MedalKitUnavailableError) return json({ ok: false, error: error.reason }, error.reason === 'UNKNOWN_LEVEL' ? 404 : 409);
    throw error;
  }
}
