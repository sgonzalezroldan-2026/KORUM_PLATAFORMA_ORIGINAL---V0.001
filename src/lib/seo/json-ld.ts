import type { Locale } from '@/i18n/routing';
import { absoluteUrl, siteUrl } from './marketing-routes';

/**
 * Datos estructurados (schema.org) de las páginas de marketing. Solo información pública y de la plataforma: nunca personas, correos ni
 * datos de familias o menores (skill korum-seo-discoverability §3 y §7).
 */

export type JsonLdNode = Record<string, unknown>;

export function organizationJsonLd(input: { description: string; slogan: string }): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${siteUrl()}/#organization`,
    name: 'KORUM',
    url: siteUrl(),
    logo: `${siteUrl()}/icon.svg`,
    slogan: input.slogan,
    description: input.description
  };
}

export function websiteJsonLd(locale: Locale, input: { description: string }): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${siteUrl()}/#website`,
    name: 'KORUM',
    url: absoluteUrl(locale, '/'),
    description: input.description,
    inLanguage: locale,
    publisher: { '@id': `${siteUrl()}/#organization` }
  };
}

export function faqJsonLd(items: ReadonlyArray<{ q: string; a: string }>): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } }))
  };
}

/** Migas de pan: el primer elemento es siempre la portada del idioma. */
export function breadcrumbJsonLd(locale: Locale, trail: ReadonlyArray<{ name: string; path: string }>): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: absoluteUrl(locale, crumb.path) }))
  };
}

/** Serializa el JSON-LD para incrustarlo en un `<script>`: `<` se escapa para que ningún texto pueda cerrar la etiqueta. */
export function serializeJsonLd(data: JsonLdNode | readonly JsonLdNode[]): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
