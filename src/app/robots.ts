import type { MetadataRoute } from 'next';
import { buildRobotsRules } from '@/lib/seo/crawler-policy';
import { BLOCK_ALL_ROBOTS, searchIndexingAllowed } from '@/lib/seo/indexing';
import { MARKETING_PATHS, siteUrl } from '@/lib/seo/marketing-routes';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';

// Se sirve en cada petición: depende de si el entorno es producción (`SEARCH_INDEXING`, Sprint 5.10a), que se lee al servir, y de la política de
// rastreadores de la consola (`seo.aiCrawlers`), que la configuración pública ya guarda en memoria unos minutos.
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  if (!searchIndexingAllowed()) return BLOCK_ALL_ROBOTS;
  const { crawlers } = await getPublicPlatformConfig();
  return { rules: buildRobotsRules(crawlers, MARKETING_PATHS), sitemap: `${siteUrl()}/sitemap.xml` };
}
