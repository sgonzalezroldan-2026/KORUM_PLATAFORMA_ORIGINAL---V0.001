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
/** Documentos del comercio con el mismo enlace firmado de su pedido: justificante, factura del fee, su rectificativa (si se le devolvió) y el cartel del escaparate. */
export const SPONSOR_DOCUMENTS = ['justificante', 'factura', 'rectificativa', 'cartel'] as const;
export type SponsorDocumentKind = (typeof SPONSOR_DOCUMENTS)[number];
/** Renovación anual de un comercio amigo (Sprint 4.2d): `?r=` con el enlace firmado del email, o `?pedido=&sig=` a la vuelta del pago. */
export const sponsorRenewalPath = (orgSlug: string): string => `/${orgSlug}/comercios/renovar`;
export const sponsorDocumentPath = (orgSlug: string, kind: SponsorDocumentKind): string => `/${orgSlug}/comercios/documentos/${kind}`;
/** Identificador de iniciativa válido en una URL: entero positivo de hasta 9 cifras. */
export const INITIATIVE_ID_PATTERN = /^[1-9]\d{0,8}$/;
/** Mi Hucha (Sprint 3.8): de la persona, fuera del portal de una entidad. Con `?entidad=` abre el alta de la aportación mensual a esa entidad. */
export const HUCHA_PATH = '/mi-hucha';
export const huchaForOrganizationPath = (orgSlug: string): string => `${HUCHA_PATH}?${new URLSearchParams({ entidad: orgSlug }).toString()}`;
/** Vuelta del primer pago de la aportación mensual: Mi Hucha enseña si quedó activada. Solo lo ve su titular (la página exige su sesión). */
export const huchaResultPath = (order: string): string => `${HUCHA_PATH}?${new URLSearchParams({ pedido: order }).toString()}`;

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

/** Preguntas frecuentes y soporte de la entidad (Sprint 3.9, `fview-faq`): las contesta la propia entidad o KORUM según el tema. */
export const helpPath = (orgSlug: string): string => `/${orgSlug}/ayuda`;
