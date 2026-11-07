import type { Locale } from '@/i18n/routing';
import { siteUrl } from './marketing-routes';

/**
 * Rutas del portal público de una entidad (Entorno 1). Son las que ya enlazan los emails (`definitions-transactions.ts`): si cambian, hay que
 * ajustar las plantillas en el mismo sprint. Sin prefijo de idioma; `localizedPath` y `absoluteUrl` lo añaden.
 */
export const portalPath = (orgSlug: string): string => `/${orgSlug}`;
export const initiativePath = (orgSlug: string, initiativeId: number): string => `/${orgSlug}/iniciativas/${initiativeId}`;
export const passPath = (orgSlug: string, passUuid: string): string => `/${orgSlug}/entrada/${passUuid}`;
/** Pago de una iniciativa (Sprint 3.4): la ficha con el checkout abierto encima, para que el enlace funcione también compartido o recargado. */
export const checkoutPath = (orgSlug: string, initiativeId: number): string => `/${orgSlug}/iniciativas/${initiativeId}/aportar`;
/** Vuelta del pago (`?pedido=&sig=`): celebración, espera de la confirmación o explicación del rechazo. */
export const checkoutResultPath = (orgSlug: string, initiativeId: number): string => `${checkoutPath(orgSlug, initiativeId)}/resultado`;
/** Página de pago simulada (`?pedido=&sig=`): solo existe con `PAYCOMET_MODE=mock`. */
export const paymentSimulatorPath = (orgSlug: string, initiativeId: number): string => `${checkoutPath(orgSlug, initiativeId)}/simulador`;
/** Comercios amigos de la entidad (Sprint 3.5). */
export const sponsorsPath = (orgSlug: string): string => `/${orgSlug}/comercios`;
/** Justificante o factura de un patrocinio (`?pedido=&sig=`): solo lo recibe quien pagó. */
export const SPONSOR_DOCUMENTS = ['justificante', 'factura'] as const;
export type SponsorDocumentKind = (typeof SPONSOR_DOCUMENTS)[number];
export const sponsorDocumentPath = (orgSlug: string, kind: SponsorDocumentKind): string => `/${orgSlug}/comercios/documentos/${kind}`;
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

/** Buzón de ideas de la entidad (Sprint 3.6). Las ideas llevan `noindex`: son propuestas de familias, no contenido de la entidad. */
export const ideasPath = (orgSlug: string): string => `/${orgSlug}/ideas`;
/** Logros conseguidos con su comparador Antes / Después (Sprint 3.6). */
export const achievementsPath = (orgSlug: string): string => `/${orgSlug}/logros`;
