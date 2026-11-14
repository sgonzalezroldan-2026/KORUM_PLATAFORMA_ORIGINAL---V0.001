import type { InitiativeStatus } from '@/generated/prisma/enums';
import type { Keyring } from '@/core/security/crypto';
import { LOCALES } from '@/i18n/routing';
import type { Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { localizedPath, siteUrl } from '@/lib/seo/marketing-routes';
import { initiativePath, portalPath } from '@/lib/seo/portal-routes';
import { secretDefinition } from '@/services/settings/setting-definitions';
import { getSecret } from '@/services/settings/settings.service';

/**
 * IndexNow (Sprint 5.5b, skill korum-seo-discoverability, heredado del 3.1 y del 3.3): avisa a Bing y a los demás buscadores del protocolo de que la ficha de una
 * iniciativa ha cambiado de verdad: se publicó, se cerró o dejó de ser pública. Solo iniciativas de entidades que se indexan (las mismas del sitemap).
 *
 * - **Nunca dentro de una transacción ni frenando la acción:** lo llaman la publicación desde `after()` (con la respuesta ya enviada) y la tarea diaria de
 *   vencimientos al terminar; un fallo se registra y no se propaga.
 * - **Solo lo que cambió:** `Initiative.indexNowStatus` guarda el estado del último aviso aceptado. Se avisa cuando el estado actual es otro y uno de los dos es
 *   público; si el buscador no responde o rechaza el aviso, el marcador no se mueve y el siguiente barrido lo repite.
 * - La clave es la de la consola (`seo.indexNowKey`) y se publica en `/indexnow-key.txt`, como pide el protocolo (cualquiera puede leerla: es lo que prueba que
 *   el dominio es nuestro, no una credencial). Sin clave, o con la web en `localhost` o sin HTTPS, no se envía nada.
 */

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const INDEXNOW_KEY_PATH = '/indexnow-key.txt';
/** Iniciativas por aviso: cada una son 6 URL (ficha y portada de la entidad en 3 idiomas) y el protocolo admite 10.000 por petición. */
export const INDEXNOW_BATCH = 1000;
const TIMEOUT_MS = 5000;

const PUBLIC_STATUSES = ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] as const satisfies readonly InitiativeStatus[];
/** Las mismas entidades que entran en el sitemap (`public.repository.ts`). */
const INDEXABLE_ORGANIZATION = { archivedAt: null, publicIndexing: true, kybStatus: 'VERIFIED' } as const;

export type IndexNowOutcome =
  | { status: 'SENT'; initiatives: number; urls: number }
  | { status: 'SKIPPED'; reason: 'NO_KEY' | 'NOT_PUBLIC_HOST' | 'NOTHING_CHANGED' }
  | { status: 'FAILED'; reason: 'REJECTED' | 'UNREACHABLE'; httpStatus?: number };

export interface IndexNowDeps {
  db: Db;
  /** Perezoso: sin web pública no hace falta descifrar nada. */
  keyring: () => Keyring;
  /** URL canónica pública; por defecto, `NEXT_PUBLIC_APP_URL`. */
  appUrl?: string;
  fetch?: typeof fetch;
}

/** Solo una web pública con HTTPS: avisar de `localhost` o de una demo interna haría que los buscadores rastrearan direcciones que no existen. */
export function isPublicHost(appUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !host.includes('.')) return false;
  return !(host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':'));
}

/** Lo que cambia en una web cuando cambia una iniciativa: su ficha y la portada de su entidad (que la lista), en los tres idiomas, sobre la URL pública `appUrl`. */
export function indexNowUrls(appUrl: string, orgSlug: string, initiativeId: number): string[] {
  const base = appUrl.replace(/\/+$/, '');
  return LOCALES.flatMap((locale) => [`${base}${localizedPath(locale, initiativePath(orgSlug, initiativeId))}`, `${base}${localizedPath(locale, portalPath(orgSlug))}`]);
}

/** La clave de la consola si tiene el formato del protocolo; si no, `null` (no se publica ni se envía). */
export async function readIndexNowKey(db: Db, keyring: Keyring): Promise<string | null> {
  const key = (await getSecret(db, keyring, 'seo.indexNowKey'))?.trim();
  const pattern = secretDefinition('seo.indexNowKey').pattern;
  return key && (!pattern || pattern.test(key)) ? key : null;
}

/** Iniciativas cuyo estado ha cambiado desde el último aviso aceptado y que fueron o son públicas. */
async function pendingInitiatives(db: Db, initiativeIds: readonly number[] | undefined) {
  return db.initiative.findMany({
    where: {
      ...(initiativeIds ? { id: { in: [...initiativeIds] } } : {}),
      organization: INDEXABLE_ORGANIZATION,
      OR: [
        { indexNowStatus: null, status: { in: [...PUBLIC_STATUSES] } },
        { indexNowStatus: { not: null }, NOT: { status: { equals: db.initiative.fields.indexNowStatus } }, OR: [{ status: { in: [...PUBLIC_STATUSES] } }, { indexNowStatus: { in: [...PUBLIC_STATUSES] } }] }
      ]
    },
    orderBy: { id: 'asc' },
    take: INDEXNOW_BATCH,
    select: { id: true, status: true, organization: { select: { slug: true } } }
  });
}

/**
 * Avisa a IndexNow de las iniciativas que han cambiado (todas, o solo `initiativeIds`). Nunca lanza: devuelve qué ha pasado. Se puede llamar a la vez desde dos
 * sitios: como mucho se repite un aviso, que los buscadores aceptan sin problema.
 */
export async function notifyIndexNow(deps: IndexNowDeps, options: { initiativeIds?: readonly number[] } = {}): Promise<IndexNowOutcome> {
  try {
    const appUrl = (deps.appUrl ?? siteUrl()).replace(/\/+$/, '');
    if (!isPublicHost(appUrl)) return { status: 'SKIPPED', reason: 'NOT_PUBLIC_HOST' };
    const key = await readIndexNowKey(deps.db, deps.keyring());
    if (!key) return { status: 'SKIPPED', reason: 'NO_KEY' };
    const pending = await pendingInitiatives(deps.db, options.initiativeIds);
    if (pending.length === 0) return { status: 'SKIPPED', reason: 'NOTHING_CHANGED' };

    const urlList = [...new Set(pending.flatMap((initiative) => indexNowUrls(appUrl, initiative.organization.slug, initiative.id)))];
    // Nunca se anota como avisado algo que no se ha enviado (fallo encontrado por la integración: las URL salían de otra dirección y la lista llegaba vacía).
    if (urlList.length === 0) return { status: 'SKIPPED', reason: 'NOTHING_CHANGED' };
    const response = await (deps.fetch ?? fetch)(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(appUrl).host, key, keyLocation: `${appUrl}${INDEXNOW_KEY_PATH}`, urlList }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store'
    });
    if (response.status !== 200 && response.status !== 202) {
      // Sin el cuerpo de la respuesta ni la clave: solo el código (403 = clave no encontrada en el fichero, 422 = URL de otro dominio, 429 = demasiados avisos).
      reportError(new Error(`IndexNow rechazó el aviso (HTTP ${response.status})`), { area: 'indexnow', httpStatus: response.status });
      return { status: 'FAILED', reason: 'REJECTED', httpStatus: response.status };
    }
    // Se anota por estado observado: si la iniciativa cambió otra vez mientras tanto, el marcador no se mueve y el siguiente barrido avisa de nuevo.
    const byStatus = new Map<InitiativeStatus, number[]>();
    for (const initiative of pending) byStatus.set(initiative.status, [...(byStatus.get(initiative.status) ?? []), initiative.id]);
    for (const [status, ids] of byStatus) await deps.db.initiative.updateMany({ where: { id: { in: ids }, status }, data: { indexNowStatus: status } });
    return { status: 'SENT', initiatives: pending.length, urls: urlList.length };
  } catch (error) {
    reportError(error, { area: 'indexnow' });
    return { status: 'FAILED', reason: 'UNREACHABLE' };
  }
}
