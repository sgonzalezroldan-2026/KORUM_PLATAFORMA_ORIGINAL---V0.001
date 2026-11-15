import { headers } from 'next/headers';
import type { DossierPickerResult } from '@/components/audit/dossier-picker';
import { DOSSIER_KIND_SLUGS, DOSSIER_QUERY_KEYS, parseDossierRequest, type DossierKind } from '@/core/dossier/dossier-model';
import type { Locale } from '@/i18n/routing';
import type { KorumPrismaClient } from '@/lib/prisma';
import { DossierRateLimitError, resolveDossier, type DossierAccess } from '@/repositories/dossier.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { requestIsFromOwnSite } from './own-site';

/**
 * Lo que las páginas de la auditoría enseñan cuando se pide un expediente (Sprint 5.8b): si existe y se puede ver, el enlace de su descarga; si no, que no
 * se ha encontrado. La comprobación es la misma que hará la descarga (`resolveDossier`): en el panel, un número de otra entidad da el mismo «no encontrado»
 * que uno que no existe, y queda anotado.
 *
 * **Solo si la petición sale de la propia aplicación** (o de escribir la dirección): un enlace puesto en otra web, con un número de otra entidad, no puede
 * dejar un intento anotado a nombre de quien lo pulsa (auditoría de seguridad del sprint). En ese caso la página enseña el selector sin resultado.
 */

/** Dirección de la descarga, con el tipo y el número ya comprobados. */
export function dossierHref(access: DossierAccess['scope'], kind: DossierKind, id: number, locale: Locale, orgSlug?: string): string {
  const params = new URLSearchParams({ [DOSSIER_QUERY_KEYS.kind]: `${DOSSIER_KIND_SLUGS[kind]}:${id}`, lang: locale, ...(access === 'entity' && orgSlug ? { org: orgSlug } : {}) });
  return `/api/${access === 'console' ? 'admin' : 'panel'}/expediente?${params.toString()}`;
}

export async function dossierPickerResult(
  db: KorumPrismaClient,
  actor: SessionActor,
  access: DossierAccess,
  raw: Record<string, string | string[] | undefined>,
  locale: Locale,
  orgSlug?: string
): Promise<DossierPickerResult | null> {
  const wanted = parseDossierRequest(raw);
  if (wanted === null) return null;
  if (!requestIsFromOwnSite((await headers()).get('sec-fetch-site'))) return null;
  if (wanted === 'invalid') return { status: 'invalid' };
  try {
    const subject = await resolveDossier(db, actor, access, wanted);
    if (!subject) return { status: 'notFound' };
    return { status: 'ready', kind: subject.kind, id: subject.id, initiativeId: subject.initiativeId, title: subject.initiativeTitle, href: dossierHref(access.scope, subject.kind, subject.id, locale, orgSlug) };
  } catch (error) {
    if (error instanceof DossierRateLimitError) return { status: 'limited' };
    // El equipo de KORUM mirando el panel de una entidad no descarga desde aquí (tiene la consola): para la página, no hay nada que ofrecer.
    if (error instanceof TenantAccessError) return { status: 'notFound' };
    throw error;
  }
}
