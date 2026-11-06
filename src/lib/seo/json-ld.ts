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

const ORGANIZATION_TYPE = { SCHOOL: 'EducationalOrganization', SPORTS_CLUB: 'SportsOrganization', CULTURAL: 'Organization' } as const;

/**
 * Portada de una entidad: colegio, club o entidad cultural, con su nombre, localidad y provincia. Nunca personas ni contactos (skill de SEO §3).
 * `city` y `postalCode` son opcionales: las entidades dadas de alta antes del Sprint 3.2 no los tienen.
 */
export function entityJsonLd(
  locale: Locale,
  entity: { slug: string; name: string; vertical: string; city: string | null; postalCode: string | null; province: string; description: string }
): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': ORGANIZATION_TYPE[entity.vertical as keyof typeof ORGANIZATION_TYPE] ?? 'Organization',
    '@id': `${absoluteUrl(locale, `/${entity.slug}`)}#organization`,
    name: entity.name,
    url: absoluteUrl(locale, `/${entity.slug}`),
    description: entity.description,
    inLanguage: locale,
    address: {
      '@type': 'PostalAddress',
      ...(entity.city ? { addressLocality: entity.city } : {}),
      ...(entity.postalCode ? { postalCode: entity.postalCode } : {}),
      addressRegion: entity.province,
      addressCountry: 'ES'
    }
  };
}

/**
 * Evento de taquilla. La campaña de entradas cierra el día del evento, así que `closesAt` es el inicio. Sin organizador personal: la
 * entidad. La disponibilidad sale de las plazas libres.
 */
export function eventJsonLd(
  locale: Locale,
  event: { entitySlug: string; entityName: string; initiativeId: number; name: string; description: string; startsAtIso: string; venue: string | null; priceCents: number; available: number; imageUrl: string }
): JsonLdNode {
  const url = absoluteUrl(locale, `/${event.entitySlug}/iniciativas/${event.initiativeId}`);
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.name,
    description: event.description,
    startDate: event.startsAtIso,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: event.venue ?? event.entityName },
    organizer: { '@type': 'Organization', name: event.entityName, url: absoluteUrl(locale, `/${event.entitySlug}`) },
    image: event.imageUrl,
    inLanguage: locale,
    offers: {
      '@type': 'Offer',
      url,
      // Aritmética entera: el precio en euros con dos decimales sin pasar por coma flotante (Regla 01 §2).
      price: `${(event.priceCents - (event.priceCents % 100)) / 100}.${String(event.priceCents % 100).padStart(2, '0')}`,
      priceCurrency: 'EUR',
      availability: event.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut'
    }
  };
}

/** Serializa el JSON-LD para incrustarlo en un `<script>`: `<` se escapa para que ningún texto pueda cerrar la etiqueta. */
export function serializeJsonLd(data: JsonLdNode | readonly JsonLdNode[]): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
