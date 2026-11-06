import type { Metadata } from 'next';
import type { Locale } from '@/i18n/routing';
import { absoluteUrl, languageAlternates, OG_IMAGE_SIZE, ogImageUrl, type PillarKey } from './marketing-routes';

const OG_LOCALE: Record<Locale, string> = { es: 'es_ES', ca: 'ca_ES', en: 'en_GB' };

/** Longitudes recomendadas en la skill de SEO §2: el título lleva ` · KORUM` detrás, salvo en la portada. */
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;
export const TITLE_SUFFIX = ' · KORUM';

export interface PageSeo {
  locale: Locale;
  /** Ruta sin prefijo de idioma (`/precios`). */
  path: string;
  title: string;
  description: string;
  /** Texto alternativo de la imagen social. */
  imageAlt: string;
  /** Tarjeta social de marketing. Las páginas de entidades e iniciativas pasan `imageUrl` en su lugar. */
  ogPage?: PillarKey | 'home';
  /** URL absoluta de una tarjeta propia (la de la iniciativa, versionada). Tiene prioridad sobre `ogPage`. */
  imageUrl?: string;
  /** Páginas privadas o de una entidad que no quiere indexarse: `noindex, nofollow`. */
  noindex?: boolean;
  /** La portada lleva su propio título completo; el resto recibe ` · KORUM`. */
  absoluteTitle?: boolean;
}

/**
 * Metadatos de una página pública de marketing: título, descripción, canónica absoluta, `hreflang` (es, ca, en y x-default),
 * Open Graph y tarjeta de X con imagen de 1200×630 (skill korum-seo-discoverability §2).
 */
export function buildPageMetadata(seo: PageSeo): Metadata {
  const url = absoluteUrl(seo.locale, seo.path);
  const image = { url: seo.imageUrl ?? ogImageUrl(seo.locale, seo.ogPage ?? 'home'), ...OG_IMAGE_SIZE, alt: seo.imageAlt };
  const fullTitle = seo.absoluteTitle ? seo.title : `${seo.title}${TITLE_SUFFIX}`;

  return {
    title: seo.absoluteTitle ? { absolute: seo.title } : seo.title,
    description: seo.description,
    ...(seo.noindex ? { robots: { index: false, follow: false } } : {}),
    alternates: { canonical: url, languages: languageAlternates(seo.path) },
    openGraph: {
      type: 'website',
      url,
      title: fullTitle,
      description: seo.description,
      siteName: 'KORUM',
      locale: OG_LOCALE[seo.locale],
      alternateLocale: (Object.keys(OG_LOCALE) as Locale[]).filter((locale) => locale !== seo.locale).map((locale) => OG_LOCALE[locale]),
      images: [image]
    },
    twitter: { card: 'summary_large_image', title: fullTitle, description: seo.description, images: [{ url: image.url, alt: seo.imageAlt }] }
  };
}

/** Recorta un texto a `max` caracteres sin partir una palabra a la mitad cuando puede evitarlo, y añade «…». */
export function fitText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}
