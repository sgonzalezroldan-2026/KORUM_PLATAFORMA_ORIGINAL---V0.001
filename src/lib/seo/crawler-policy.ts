import type { MetadataRoute } from 'next';
import { LOCALES, routing } from '@/i18n/routing';
import { localizedPath } from './marketing-routes';

/**
 * Política de rastreadores de `robots.txt` (skill korum-seo-discoverability §4 y §5). Los nombres de los bots cambian con frecuencia, así
 * que la lista vive en el ajuste `seo.aiCrawlers` de la consola; estos son los valores de lanzamiento.
 * - **Búsqueda y respuesta** (se citan al contestar a una persona): permitidos en toda la web pública.
 * - **Entrenamiento**: solo en las páginas de marketing; en las portadas de las entidades quedan bloqueados para respetar a las comunidades escolares.
 */
export interface CrawlerRule {
  userAgent: string;
  allow: boolean;
}

export interface CrawlerPolicy {
  search: CrawlerRule[];
  training: CrawlerRule[];
}

const allowed = (...userAgents: string[]): CrawlerRule[] => userAgents.map((userAgent) => ({ userAgent, allow: true }));

export const DEFAULT_CRAWLER_POLICY: CrawlerPolicy = {
  search: allowed('OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User'),
  training: allowed('GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Applebot-Extended', 'Meta-ExternalAgent')
};

/** Zonas privadas, en cada idioma: el panel, la consola y la API (salvo las imágenes sociales, que las redes necesitan leer). */
const PRIVATE_PREFIXES = ['/panel/', '/admin/'];

function privateDisallows(): string[] {
  const prefixes = LOCALES.flatMap((locale) => PRIVATE_PREFIXES.map((prefix) => (locale === routing.defaultLocale ? prefix : `/${locale}${prefix}`)));
  return [...prefixes, '/api/'];
}

const OG_ALLOW = '/api/og/';

/**
 * Rutas de marketing de todos los idiomas, para permitir el entrenamiento solo ahí. Las portadas llevan `$` (coincidencia exacta): `/ca$`
 * deja pasar `/ca` pero no `/ca/cervantes`, que es la portada de una entidad.
 */
function marketingAllows(marketingPaths: readonly string[]): string[] {
  const pages = LOCALES.flatMap((locale) =>
    marketingPaths.map((path) => {
      const localized = localizedPath(locale, path);
      return path === '/' ? (localized === '/' ? '/$' : `${localized}$`) : localized;
    })
  );
  return [...pages, '/llms.txt', OG_ALLOW];
}

function userAgentsWith(rules: readonly CrawlerRule[], allow: boolean): string[] {
  return rules.filter((rule) => rule.allow === allow).map((rule) => rule.userAgent);
}

/** Reglas de `robots.txt` para el rastreo general, los asistentes de búsqueda y los de entrenamiento. */
export function buildRobotsRules(policy: CrawlerPolicy, marketingPaths: readonly string[]): Exclude<MetadataRoute.Robots['rules'], undefined> {
  const rules: Array<{ userAgent: string | string[]; allow?: string | string[]; disallow?: string | string[] }> = [
    { userAgent: '*', allow: ['/', OG_ALLOW], disallow: privateDisallows() }
  ];

  const searchAllowed = userAgentsWith(policy.search, true);
  if (searchAllowed.length > 0) rules.push({ userAgent: searchAllowed, allow: ['/', OG_ALLOW], disallow: privateDisallows() });

  const trainingAllowed = userAgentsWith(policy.training, true);
  if (trainingAllowed.length > 0) rules.push({ userAgent: trainingAllowed, allow: marketingAllows(marketingPaths), disallow: '/' });

  const blocked = [...userAgentsWith(policy.search, false), ...userAgentsWith(policy.training, false)];
  if (blocked.length > 0) rules.push({ userAgent: blocked, disallow: '/' });

  return rules;
}
