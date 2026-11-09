/**
 * Color de acento de una entidad (Sprint 4.2e, decisión del promotor del 2026-11-09: **paleta cerrada**). El portal pinta la cabecera de la entidad
 * en azul marino KORUM con texto blanco, y el acento solo dibuja su borde y su brillo: por eso cada color de la paleta tiene al menos **3:1** de
 * contraste con el azul marino (WCAG 1.4.11, componentes) y el texto nunca va sobre el acento. Colores de uniforme escolar y deportivo; ninguno
 * copia la combinación distintiva de una institución real.
 */

export const NAVY = '#101F38';

export const ENTITY_ACCENTS = [
  { id: 'coral', hex: '#FF5A43' },
  { id: 'raspberry', hex: '#E11D48' },
  { id: 'orange', hex: '#F97316' },
  { id: 'gold', hex: '#F59E0B' },
  { id: 'emerald', hex: '#10B981' },
  { id: 'turquoise', hex: '#14B8A6' },
  { id: 'sky', hex: '#38BDF8' },
  { id: 'lilac', hex: '#A78BFA' }
] as const;

export type EntityAccentId = (typeof ENTITY_ACCENTS)[number]['id'];
export const ENTITY_ACCENT_IDS = ENTITY_ACCENTS.map((accent) => accent.id) as [EntityAccentId, ...EntityAccentId[]];

/** El color de la paleta con ese identificador, o `null`. */
export const accentById = (id: string) => ENTITY_ACCENTS.find((accent) => accent.id === id) ?? null;

/** El color de la paleta que corresponde a un `brandPrimary` guardado, o `null` si es uno antiguo fuera de la paleta. */
export const accentByHex = (hex: string) => ENTITY_ACCENTS.find((accent) => accent.hex.toLowerCase() === hex.trim().toLowerCase()) ?? null;

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa de un `#RRGGBB` (WCAG 2.2). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => channel(Number.parseInt(hex.slice(start, start + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Relación de contraste entre dos colores (de 1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}
