import type { Locale } from '@/i18n/routing';
import { siteUrl } from './marketing-routes';

/**
 * Rutas del portal público de una entidad (Entorno 1). Son las que ya enlazan los emails (`definitions-transactions.ts`): si cambian, hay que
 * ajustar las plantillas en el mismo sprint. Sin prefijo de idioma; `localizedPath` y `absoluteUrl` lo añaden.
 */
export const portalPath = (orgSlug: string): string => `/${orgSlug}`;
export const initiativePath = (orgSlug: string, initiativeId: number): string => `/${orgSlug}/iniciativas/${initiativeId}`;
export const passPath = (orgSlug: string, passUuid: string): string => `/${orgSlug}/entrada/${passUuid}`;
/** Pago de una iniciativa: lo construye el Sprint 3.4 (el pago es un modal de la propia ficha). */
export const checkoutPath = (orgSlug: string, initiativeId: number): string => `/${orgSlug}/iniciativas/${initiativeId}/aportar`;
/** Identificador de iniciativa válido en una URL: entero positivo de hasta 9 cifras. */
export const INITIATIVE_ID_PATTERN = /^[1-9]\d{0,8}$/;
/** Mi Hucha (Sprint 3.7). */
export const HUCHA_PATH = '/mi-hucha';

/** Tarjeta social de una iniciativa (1200×630). `version` (la fecha de su última modificación) obliga a WhatsApp y Facebook a pedir una imagen nueva. */
export function ogInitiativeUrl(locale: Locale, initiativeId: number, version: number, groupSlug?: string | null): string {
  const query = new URLSearchParams({ locale, v: String(version) });
  if (groupSlug) query.set('grupo', groupSlug);
  return `${siteUrl()}/api/og/initiative/${initiativeId}?${query.toString()}`;
}
