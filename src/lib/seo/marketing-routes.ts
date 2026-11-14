import { routing, type Locale } from '@/i18n/routing';

/**
 * Mapa de las páginas públicas de marketing (Entorno 0). Es la única fuente de rutas para el menú, el pie, el sitemap, `robots.txt` y
 * `llms.txt`: añadir una página aquí la deja enlazada, indexada y descrita sin tocar nada más. Las rutas son las mismas en los tres idiomas
 * (`/para-colegios`, `/ca/para-colegios`, `/en/para-colegios`): el idioma lo decide el prefijo, no el nombre de la ruta.
 */
export const PILLAR_PAGES = [
  { key: 'colegios', path: '/para-colegios', priority: 0.9, group: 'audience' },
  { key: 'clubes', path: '/para-clubes', priority: 0.9, group: 'audience' },
  { key: 'culturales', path: '/para-entidades-culturales', priority: 0.9, group: 'audience' },
  { key: 'comercios', path: '/para-comercios', priority: 0.8, group: 'audience' },
  { key: 'comoFunciona', path: '/como-funciona', priority: 0.9, group: 'info' },
  { key: 'precios', path: '/precios', priority: 0.9, group: 'info' },
  { key: 'seguridad', path: '/seguridad-y-transparencia', priority: 0.8, group: 'info' },
  { key: 'faq', path: '/preguntas-frecuentes', priority: 0.8, group: 'info' }
] as const;

/** Declaración de accesibilidad (Sprint 5.5b, EXPERIENCIA §7): enlazada desde el pie de todas las páginas y en el sitemap; no es una página pilar. */
export const ACCESSIBILITY_PATH = '/accesibilidad';

export type PillarKey = (typeof PILLAR_PAGES)[number]['key'];

export function pillarByKey(key: PillarKey) {
  const page = PILLAR_PAGES.find((candidate) => candidate.key === key);
  if (!page) throw new RangeError(`Página pilar desconocida: ${key}`);
  return page;
}

/** Portada y páginas pilar, sin prefijo de idioma. */
export const MARKETING_PATHS: readonly string[] = ['/', ...PILLAR_PAGES.map((page) => page.path)];

/** `/` en castellano, `/ca` y `/en` en portada; el prefijo solo cuando no es el idioma por defecto (`localePrefix: 'as-needed'`). */
export function localizedPath(locale: Locale, path: string): string {
  if (locale === routing.defaultLocale) return path;
  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

export function absoluteUrl(locale: Locale, path: string): string {
  return `${siteUrl()}${localizedPath(locale, path)}`;
}

/** Alternativas de idioma de una ruta, con `x-default` apuntando al castellano (skill de SEO §2). */
export function languageAlternates(path: string): Record<Locale | 'x-default', string> {
  return {
    es: absoluteUrl('es', path),
    ca: absoluteUrl('ca', path),
    en: absoluteUrl('en', path),
    'x-default': absoluteUrl(routing.defaultLocale, path)
  };
}

export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

/** Versión de la imagen social: WhatsApp y Facebook la guardan en caché, así que cambiarla fuerza una nueva (skill de SEO §6). */
export const OG_IMAGE_VERSION = '1';

export function ogImageUrl(locale: Locale, pageKey: PillarKey | 'home'): string {
  return `${siteUrl()}/api/og/marketing?locale=${locale}&page=${pageKey}&v=${OG_IMAGE_VERSION}`;
}

export function isPillarKey(value: string): value is PillarKey {
  return PILLAR_PAGES.some((page) => page.key === value);
}

/**
 * Fecha (AAAA-MM-DD) en que se revisó por última vez el contenido de las páginas de marketing. Se muestra en cada página pilar y es la
 * `lastModified` del sitemap: no es la fecha de la compilación, que cambiaría sin que cambiara nada. Se actualiza al editar los textos.
 */
export const MARKETING_CONTENT_UPDATED = '2026-11-05';
