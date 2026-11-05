import type { MetadataRoute } from 'next';
import { buildRobotsRules } from '@/lib/seo/crawler-policy';
import { MARKETING_PATHS, siteUrl } from '@/lib/seo/marketing-routes';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';

// La política de rastreadores se edita en la consola (`seo.aiCrawlers`): se relee cada 10 minutos en lugar de quedar fijada en la compilación.
export const revalidate = 600;

export default async function robots(): Promise<MetadataRoute.Robots> {
  const { crawlers } = await getPublicPlatformConfig();
  return { rules: buildRobotsRules(crawlers, MARKETING_PATHS), sitemap: `${siteUrl()}/sitemap.xml` };
}
