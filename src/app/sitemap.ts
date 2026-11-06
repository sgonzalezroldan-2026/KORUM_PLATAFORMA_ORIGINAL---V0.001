import type { MetadataRoute } from 'next';
import { LOCALES } from '@/i18n/routing';
import { absoluteUrl, languageAlternates, MARKETING_CONTENT_UPDATED, PILLAR_PAGES } from '@/lib/seo/marketing-routes';

/**
 * Solo páginas indexables, cada una con sus alternativas de idioma (skill korum-seo-discoverability §4). Hoy son la portada, las páginas
 * pilar y el alta de entidades (`/registro-comunidad`, Sprint 3.2; `/login` no se indexa); las portadas de las entidades con `publicIndexing`
 * y sus iniciativas se añaden en el Sprint 3.3, cuando existan esas páginas.
 */
const ENTRIES = [
  { path: '/', priority: 1, changeFrequency: 'weekly' as const },
  ...PILLAR_PAGES.map((page) => ({ path: page.path, priority: page.priority, changeFrequency: 'monthly' as const })),
  { path: '/registro-comunidad', priority: 0.9, changeFrequency: 'monthly' as const }
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ENTRIES.flatMap((entry) =>
    LOCALES.map((locale) => ({
      url: absoluteUrl(locale, entry.path),
      lastModified: MARKETING_CONTENT_UPDATED,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: { languages: languageAlternates(entry.path) }
    }))
  );
}
