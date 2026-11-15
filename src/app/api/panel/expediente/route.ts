import { parseDossierRequest } from '@/core/dossier/dossier-model';
import { isLocale } from '@/i18n/routing';
import { getSessionActor } from '@/lib/auth/session';
import { dossierFromOwnSite, dossierJson, dossierPdfResponse } from '@/lib/dossier/dossier-response';
import { getPrisma } from '@/lib/prisma';
import { DossierRateLimitError, downloadDossier } from '@/repositories/dossier.repository';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { TenantAccessError } from '@/repositories/tenant-guard';

/**
 * Expediente en PDF de una campaña o de una liquidación de la entidad (Sprint 5.8b). Descarga de solo lectura (`GET`, como un enlace). La persona sale de
 * la sesión (firmante con segundo factor) y la entidad, de su `org`: un objeto de otra entidad responde igual que uno que no existe. Cada descarga queda
 * en la auditoría antes de entregarse, y cada cuenta tiene un tope de peticiones por hora.
 */
export async function GET(request: Request) {
  const actor = await getSessionActor();
  if (!dossierFromOwnSite(request) || actor.kind !== 'user') return dossierJson({ ok: false, error: 'FORBIDDEN' }, 403);
  const params = new URL(request.url).searchParams;
  const org = params.get('org') ?? '';
  const lang = params.get('lang') ?? '';
  const wanted = parseDossierRequest(Object.fromEntries(params));
  if (wanted === null || wanted === 'invalid' || !isLocale(lang) || org.length < 1 || org.length > 80) return dossierJson({ ok: false, error: 'INVALID_INPUT' }, 400);

  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, org);
  if (!organizationId) return dossierJson({ ok: false, error: 'FORBIDDEN' }, 403);
  try {
    // El segundo factor, el cargo y el tope de peticiones los comprueba la guardia, que deja anotado lo que deniega.
    const data = await downloadDossier(db, actor, { scope: 'entity', organizationId }, wanted);
    return data ? dossierPdfResponse(data, lang) : dossierJson({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (error) {
    if (error instanceof TenantAccessError) return dossierJson({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof DossierRateLimitError) return dossierJson({ ok: false, error: 'RATE_LIMITED' }, 429);
    throw error;
  }
}
