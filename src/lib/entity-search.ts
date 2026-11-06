/**
 * Búsqueda de entidades de la portada: funciones puras (sin base de datos) para que el servidor y el navegador filtren igual.
 */

/** Lo único que el buscador de la portada devuelve de una entidad: nada de contactos, importes ni personas. */
export interface PublicEntityHit {
  slug: string;
  name: string;
  vertical: 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL';
  province: string;
  /** Municipio y código postal que la entidad declaró en el alta (Sprint 3.2); las anteriores no los tienen. */
  city?: string | null;
  postalCode?: string | null;
}

export const ENTITY_SEARCH_MIN_LENGTH = 2;
export const ENTITY_SEARCH_MAX_LENGTH = 80;
export const ENTITY_SEARCH_RESULT_LIMIT = 8;

/** Minúsculas, sin acentos y con espacios simples: «Cataluña», «cataluna» y «CATALUÑA» se buscan igual. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto de búsqueda ya limpio, o `null` si es demasiado corto para buscar. */
export function cleanSearchQuery(raw: string): string | null {
  const query = normalizeForSearch(raw.slice(0, ENTITY_SEARCH_MAX_LENGTH));
  return query.length >= ENTITY_SEARCH_MIN_LENGTH ? query : null;
}

/**
 * Entidades cuyo nombre, municipio, código postal o provincia contienen **todas** las palabras escritas. Primero las que empiezan por lo escrito; después, por orden
 * alfabético. Función pura: el filtrado en tiempo real y la prueba usan la misma.
 */
export function filterEntities(entities: readonly PublicEntityHit[], rawQuery: string, limit: number = ENTITY_SEARCH_RESULT_LIMIT): PublicEntityHit[] {
  const query = cleanSearchQuery(rawQuery);
  if (!query) return [];
  const words = query.split(' ');
  const matches = entities.filter((entity) => {
    const haystack = normalizeForSearch([entity.name, entity.city, entity.postalCode, entity.province].filter(Boolean).join(' '));
    return words.every((word) => haystack.includes(word));
  });
  const startsWithQuery = (entity: PublicEntityHit) => normalizeForSearch(entity.name).startsWith(query);
  return matches
    .map((entity, index) => ({ entity, index, first: startsWithQuery(entity) }))
    .sort((a, b) => Number(b.first) - Number(a.first) || a.index - b.index)
    .slice(0, limit)
    .map(({ entity }) => entity);
}
