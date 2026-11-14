import type { MetadataRoute } from 'next';
import { LOCALES } from '@/i18n/routing';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { absoluteUrl, ACCESSIBILITY_PATH, languageAlternates, MARKETING_CONTENT_UPDATED, PILLAR_PAGES } from '@/lib/seo/marketing-routes';
import { achievementsPath, helpPath, initiativePath, portalPath, sponsorsPath } from '@/lib/seo/portal-routes';
import { listIndexableInitiatives, listIndexableOrganizations } from '@/repositories/public.repository';

/**
 * Solo páginas indexables, cada una con sus alternativas de idioma (skill korum-seo-discoverability §4): la portada, las páginas pilar, el alta
 * de entidades (`/login` no se indexa) y, desde el Sprint 3.3, las portadas de las entidades con `publicIndexing` y KYB verificado y sus
 * iniciativas públicas (`FUNDRAISING`, `GOAL_REACHED` y `CLOSED`). Una entidad que desactiva `publicIndexing` sale de la lista (QA-SEO03).
 * Ideas (propuestas de familias), checkout, Mi cuenta y entradas no entran nunca; los logros sí (Sprint 3.6) y la FAQ y soporte también (Sprint 3.9).
 */
const STATIC_ENTRIES = [
  { path: '/', priority: 1, changeFrequency: 'weekly' as const },
  ...PILLAR_PAGES.map((page) => ({ path: page.path, priority: page.priority, changeFrequency: 'monthly' as const })),
  { path: '/registro-comunidad', priority: 0.9, changeFrequency: 'monthly' as const },
  { path: ACCESSIBILITY_PATH, priority: 0.3, changeFrequency: 'monthly' as const }
];

// Las entidades y sus campañas cambian cada día: se calcula en cada petición y no una vez al compilar.
export const dynamic = 'force-dynamic';

/** Espera máxima a la base de datos: un sitemap incompleto es mejor que un `robots.txt` con un sitemap que no responde. */
const DATABASE_TIMEOUT_MS = 5000;

function entry(path: string, lastModified: Date | string, priority: number, changeFrequency: 'daily' | 'weekly' | 'monthly') {
  return LOCALES.map((locale) => ({ url: absoluteUrl(locale, path), lastModified, changeFrequency, priority, alternates: { languages: languageAlternates(path) } }));
}

async function loadDynamicEntries(): Promise<MetadataRoute.Sitemap> {
  const db = getPrisma();
  const [organizations, initiatives] = await Promise.race([
    Promise.all([listIndexableOrganizations(db), listIndexableInitiatives(db)]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`La base de datos no respondió en ${DATABASE_TIMEOUT_MS} ms`)), DATABASE_TIMEOUT_MS))
  ]);
  return [
    ...organizations.flatMap((organization) => entry(portalPath(organization.slug), organization.updatedAt, 0.7, 'daily')),
    ...organizations.flatMap((organization) => entry(sponsorsPath(organization.slug), organization.updatedAt, 0.5, 'weekly')),
    ...organizations.flatMap((organization) => entry(achievementsPath(organization.slug), organization.updatedAt, 0.5, 'weekly')),
    ...organizations.flatMap((organization) => entry(helpPath(organization.slug), organization.updatedAt, 0.4, 'monthly')),
    ...initiatives.flatMap((initiative) => entry(initiativePath(initiative.organization.slug, initiative.id), initiative.updatedAt, 0.6, 'weekly'))
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const fixed = STATIC_ENTRIES.flatMap((item) => entry(item.path, MARKETING_CONTENT_UPDATED, item.priority, item.changeFrequency));
  try {
    return [...fixed, ...(await loadDynamicEntries())];
  } catch (error) {
    // Sin base de datos (compilación, caída) el sitemap sigue sirviendo las páginas fijas; el incidente se registra.
    if (process.env.NEXT_PHASE !== 'phase-production-build') reportError(error, { area: 'sitemap' });
    return fixed;
  }
}
