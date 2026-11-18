/**
 * Categorías estándar de la plataforma (Sprint 5.9). El nombre se guarda en castellano (es el dato que compara el Estudio, el candado de exenciones
 * y los filtros), así que no se cambia: solo se **enseña** traducido. Una categoría que la entidad ha creado a mano no está en la lista y se enseña tal
 * como la escribió, en el idioma de su contenido.
 */
export const STANDARD_CATEGORY_KEYS = {
  'Infraestructura y Confort': 'comfort',
  'Patios y Deporte': 'courts',
  'Tecnología y Recursos': 'tech',
  'Comunidad y Viajes': 'community',
  'Solidaridad y Becas': 'solidarity',
  Taquilla: 'ticketing'
} as const;

export type StandardCategoryKey = (typeof STANDARD_CATEGORY_KEYS)[keyof typeof STANDARD_CATEGORY_KEYS];

/** La clave del catálogo de traducciones de una categoría estándar, o `null` si es una categoría propia de la entidad. */
export function standardCategoryKey(name: string): StandardCategoryKey | null {
  const key = (STANDARD_CATEGORY_KEYS as Record<string, StandardCategoryKey | undefined>)[name.trim()];
  return key ?? null;
}
