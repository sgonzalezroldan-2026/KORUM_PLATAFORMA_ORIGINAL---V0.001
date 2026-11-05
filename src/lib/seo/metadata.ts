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
  ogPage: PillarKey | 'home';
  /** La portada lleva su propio título completo; el resto recibe ` · KORUM`. */
  absoluteTitle?: boolean;
}

/**
 * Metadatos de una página pública de marketing: título, descripción, canónica absoluta, `hreflang` (es, ca, en y x-default),
 * Open Graph y tarjeta de X con imagen de 1200×630 (skill korum-seo-discoverability §2).
 */
export function buildPageMetadata(seo: PageSeo): Metadata {
  const url = absoluteUrl(seo.locale, seo.path);
  const image = { url: ogImageUrl(seo.locale, seo.ogPage), ...OG_IMAGE_SIZE, alt: seo.imageAlt };
  const fullTitle = seo.absoluteTitle ? seo.title : `${seo.title}${TITLE_SUFFIX}`;

  return {
    title: seo.absoluteTitle ? { absolute: seo.title } : seo.title,
    description: seo.description,
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
