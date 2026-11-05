import { NextResponse } from 'next/server';
import { cleanSearchQuery } from '@/lib/entity-search';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { searchPublicEntities } from '@/services/marketing/entity-search';

/**
 * Buscador público de entidades de la portada (`GET /api/entities?q=…`). No requiere sesión y solo devuelve nombre, enlace, tipo y
 * provincia de las entidades que aceptan aparecer en buscadores. La respuesta se cachea en el borde 60 s por texto buscado, así que una
 * ráfaga de la misma consulta no llega a la base de datos.
 */
const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120' };

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q') ?? '';
  if (!cleanSearchQuery(query)) return NextResponse.json({ entities: [] }, { headers: CACHE_HEADERS });

  try {
    return NextResponse.json({ entities: await searchPublicEntities(getPrisma(), query) }, { headers: CACHE_HEADERS });
  } catch (error) {
    reportError(error, { area: 'entity-search' });
    // Sin caché: un fallo puntual no debe quedarse guardado en el borde.
    return NextResponse.json({ error: 'search_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
