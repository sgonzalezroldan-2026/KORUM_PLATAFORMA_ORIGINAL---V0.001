import type { MetadataRoute } from 'next';

/** Una entidad se indexa solo si lo decidió en el alta (`publicIndexing`) y su KYB está verificado (QA-SEO03). Mismo criterio que el sitemap y el buscador. */
export function isIndexable(organization: { publicIndexing: boolean; kybStatus: string }): boolean {
  return organization.publicIndexing && organization.kybStatus === 'VERIFIED';
}

/**
 * Antiindexación de todo lo que no sea producción (Sprint 5.10a, `QA-SEO04`). Una preproducción, una demostración o una previsualización copian la web real
 * con datos de prueba: si un buscador las indexara, saldrían junto a la real (y con textos legales o precios que no son los publicados). Solo la variable
 * `SEARCH_INDEXING=allow` abre la web a los buscadores; sin ella (el valor por defecto), `robots.txt` lo bloquea todo y cada página responde con `noindex`.
 * Se decide **al servir**, no al compilar: una misma compilación se puede pasar de la previsualización a producción.
 */

export const NOINDEX_VALUE = 'noindex, nofollow';

export function searchIndexingAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.SEARCH_INDEXING?.trim() === 'allow';
}

/** `robots.txt` de un entorno que no es producción: nada que rastrear y ningún sitemap que seguir. */
export const BLOCK_ALL_ROBOTS: MetadataRoute.Robots = { rules: [{ userAgent: '*', disallow: '/' }] };
