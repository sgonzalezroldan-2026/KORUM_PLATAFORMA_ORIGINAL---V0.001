import { parseDossierRequest } from '@/core/dossier/dossier-model';
import { isLocale } from '@/i18n/routing';
import { getSessionActor } from '@/lib/auth/session';
import { dossierFromOwnSite, dossierJson, dossierPdfResponse } from '@/lib/dossier/dossier-response';
import { getPrisma } from '@/lib/prisma';
import { DossierRateLimitError, downloadDossier } from '@/repositories/dossier.repository';
import { TenantAccessError } from '@/repositories/tenant-guard';

/**
 * Expediente en PDF de una aportación, una campaña o una liquidación de cualquier entidad (Sprint 5.8b), para la consola. Descarga de solo lectura (`GET`).
 * Solo el Super-Admin con el segundo factor de su sesión; a cualquier otra cuenta se le deniega y queda anotado. Cada descarga queda en la auditoría antes
 * de entregarse, y cada cuenta tiene un tope de peticiones por hora.
 */
export async function GET(request: Request) {
  const actor = await getSessionActor();
  if (!dossierFromOwnSite(request) || actor.kind !== 'user') return dossierJson({ ok: false, error: 'FORBIDDEN' }, 403);
  const params = new URL(request.url).searchParams;
  const lang = params.get('lang') ?? '';
  const wanted = parseDossierRequest(Object.fromEntries(params));
  try {
    // La guardia va antes de mirar la forma de lo pedido: quien no es de KORUM recibe siempre la misma respuesta.
    if (wanted === null || wanted === 'invalid' || !isLocale(lang)) {
      if (!actor.isSuperadmin || actor.secondFactor !== true) return dossierJson({ ok: false, error: 'FORBIDDEN' }, 403);
      return dossierJson({ ok: false, error: 'INVALID_INPUT' }, 400);
    }
    const data = await downloadDossier(getPrisma(), actor, { scope: 'console' }, wanted);
    return data ? dossierPdfResponse(data, lang) : dossierJson({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (error) {
    if (error instanceof TenantAccessError) return dossierJson({ ok: false, error: 'FORBIDDEN' }, 403);
    if (error instanceof DossierRateLimitError) return dossierJson({ ok: false, error: 'RATE_LIMITED' }, 429);
    throw error;
  }
}
