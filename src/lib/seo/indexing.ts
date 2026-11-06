/** Una entidad se indexa solo si lo decidió en el alta (`publicIndexing`) y su KYB está verificado (QA-SEO03). Mismo criterio que el sitemap y el buscador. */
export function isIndexable(organization: { publicIndexing: boolean; kybStatus: string }): boolean {
  return organization.publicIndexing && organization.kybStatus === 'VERIFIED';
}
