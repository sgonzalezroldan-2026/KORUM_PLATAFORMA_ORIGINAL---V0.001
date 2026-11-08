import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getKeyring } from '@/config/keyring';
import { normalizeContactPhone } from '@/core/tax/contact-phone';
import { Model182FormatError } from '@/core/tax/model182-format';
import { exportModel182, Model182NotAllowedError } from '@/core/tax/model182.service';
import { getSessionActor } from '@/lib/auth/session';
import { isSameOrigin } from '@/lib/http/same-origin';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { recordAudit, ResourceNotFoundError, TenantAccessError } from '@/repositories/tenant-guard';

/**
 * Descarga del fichero del Modelo 182 (Sprint 4.1, QA-REG02). Es una ruta porque entrega un fichero. Quien llama sale de la sesión (firmante con
 * segundo factor), la entidad de su `orgSlug` y la petición tiene que venir de la propia web. El servicio `exportModel182` comprueba además
 * que la Ley 49/2002 esté **verificada**: sin ella responde 409 y deja el intento en la auditoría. El nombre de contacto es el de la persona
 * de la sesión; el teléfono lo escribe quien descarga (9 cifras). Las cifras de lo que quedó fuera viajan en cabeceras, para que la pantalla
 * le diga a la entidad cuánto no ha entrado; el fichero no se guarda en ningún sitio.
 */

const FIRST_YEAR = 2024;

const input = z.object({
  orgSlug: z.string().min(1).max(80),
  fiscalYear: z.number().int().min(FIRST_YEAR).max(2100),
  contactPhone: z.string().max(30)
});

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const actor = await getSessionActor();
  const db = getPrisma();
  const deny = async (reason: string) => {
    if (actor.kind === 'user') await recordAudit(db, actor, { action: 'api.panel_modelo182_denied', organizationId: null, targetType: 'Route', targetId: 'api/panel/modelo-182', metadata: { reason } });
    return json({ ok: false, error: 'FORBIDDEN' }, 403);
  };
  if (!isSameOrigin(request)) return deny('ORIGIN');
  if (actor.kind !== 'user' || actor.secondFactor !== true) return deny('SECOND_FACTOR');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  }
  const parsed = input.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  const contactPhone = normalizeContactPhone(parsed.data.contactPhone);
  if (!/^\d{9}$/.test(contactPhone)) return json({ ok: false, error: 'PHONE_INVALID' }, 422);

  const organizationId = await findOrganizationIdBySlug(db, parsed.data.orgSlug);
  if (!organizationId) return deny('UNKNOWN_ORGANIZATION');
  const person = await db.user.findUnique({ where: { id: actor.userId }, select: { name: true } });

  try {
    const result = await exportModel182(db, getKeyring(), actor, { organizationId, fiscalYear: parsed.data.fiscalYear, contactPhone, contactName: person?.name ?? '' });
    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=ISO-8859-1',
        'Content-Disposition': `attachment; filename="modelo182-${parsed.data.fiscalYear}-${parsed.data.orgSlug}.txt"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Korum-Donors': String(result.donorCount),
        'X-Korum-Total-Cents': String(result.totalCents),
        'X-Korum-Excluded': String(result.excluded.contributions),
        'X-Korum-Excluded-Cents': String(result.excluded.amountCents),
        'X-Korum-Unresolved': String(result.unresolved.contributions),
        'X-Korum-Unresolved-Cents': String(result.unresolved.amountCents),
        'X-Korum-Returned': String(result.returned.contributions),
        'X-Korum-Returned-Cents': String(result.returned.amountCents)
      }
    });
  } catch (error) {
    if (error instanceof TenantAccessError) return json({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof ResourceNotFoundError) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (error instanceof Model182NotAllowedError) return json({ ok: false, error: error.reason }, 409);
    if (error instanceof Model182FormatError) return json({ ok: false, error: 'FORMAT' }, 422);
    throw error;
  }
}
