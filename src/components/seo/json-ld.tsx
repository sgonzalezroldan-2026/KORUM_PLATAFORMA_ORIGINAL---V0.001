import { serializeJsonLd, type JsonLdNode } from '@/lib/seo/json-ld';

/** Incrusta datos estructurados en el HTML inicial (Server Component: los buscadores no necesitan ejecutar JavaScript). */
export function JsonLd({ data }: { data: JsonLdNode | readonly JsonLdNode[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
