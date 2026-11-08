/**
 * Kit de medallas de la entidad (Sprint 4.1, `renderSchoolMedalsExplainer` del prototipo): en qué punto está cada nivel (Bronce, Plata, Oro),
 * el sello que la entidad puede poner en su web y las etiquetas para sus redes. Funciones puras: los importes y los umbrales salen de
 * `MedalTierConfig` (reglas globales de la consola), nunca de aquí.
 */

export interface MedalTier {
  key: string;
  name: string;
  icon: string;
  rank: number;
  campaignsRequired: number;
  grantCents: number;
}

/** `EARNED`: la entidad ya tiene esa medalla. `NEXT`: la siguiente por conseguir. `LOCKED`: más adelante. */
export type MedalState = 'EARNED' | 'NEXT' | 'LOCKED';

export interface MedalLevel extends MedalTier {
  state: MedalState;
  /** Campañas que faltan este curso para llegar al nivel (0 si ya lo tiene). */
  campaignsMissing: number;
}

/** Los niveles por orden de rango, con su estado según la medalla vigente (`Organization.medalRank`) y las campañas del curso. */
export function medalLevels(tiers: readonly MedalTier[], medalRank: number, completedThisYear: number): MedalLevel[] {
  const sorted = [...tiers].sort((a, b) => a.rank - b.rank);
  const next = sorted.find((tier) => tier.rank > medalRank);
  return sorted.map((tier) => {
    const earned = tier.rank <= medalRank;
    return {
      ...tier,
      state: earned ? 'EARNED' : tier.key === next?.key ? 'NEXT' : 'LOCKED',
      campaignsMissing: earned ? 0 : Math.max(0, tier.campaignsRequired - Math.max(0, completedThisYear))
    };
  });
}

export type MedalGrantStatus = { kind: 'USED'; title: string } | { kind: 'AVAILABLE'; cents: number } | { kind: 'NONE' };

/** La beca exenta de la medalla de este curso: ya usada en una campaña, disponible (con su importe) o sin beca. */
export function medalGrantStatus(input: { availableCents: number; usedInTitle: string | null }): MedalGrantStatus {
  if (input.usedInTitle) return { kind: 'USED', title: input.usedInTitle };
  if (input.availableCents > 0) return { kind: 'AVAILABLE', cents: input.availableCents };
  return { kind: 'NONE' };
}

/** Solo se entrega el kit de una medalla que la entidad ya tiene: no se puede presumir en público de un nivel que aún no se ha conseguido. */
export function isKitAvailable(level: Pick<MedalLevel, 'state'>): boolean {
  return level.state === 'EARNED';
}

/** `#CEIPCervantes` a partir del nombre público: sin acentos ni signos, cada palabra con mayúscula inicial. Vacío si no queda nada. */
export function entityHashtag(name: string): string {
  const joined = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  return joined ? `#${joined.slice(0, 40)}` : '';
}

/** Etiquetas para el final del texto de redes: la de KORUM y la de la entidad. */
export function medalHashtags(entityName: string): string {
  return ['#ComunidadKORUM', entityHashtag(entityName)].filter(Boolean).join(' ');
}

/** Enlace para compartir el texto por WhatsApp (el navegador abre la app o la web). */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?${new URLSearchParams({ text }).toString()}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Colores del disco por rango (Bronce, Plata, Oro) y el del texto que mejor contrasta con cada uno. Fuera de rango, el dorado de la marca. */
const SEAL_COLORS: Record<number, { disc: string; text: string }> = {
  1: { disc: '#B4764A', text: '#FFFFFF' },
  2: { disc: '#C9D1DC', text: '#101F38' },
  3: { disc: '#F59E0B', text: '#101F38' }
};

function fitText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface MedalSealInput {
  rank: number;
  tierName: string;
  entityName: string;
  period: string;
  /** «COMUNIDAD IMPULSORA»: ya traducido. */
  headline: string;
  /** Texto accesible del sello (el `<title>` del SVG). */
  accessibleName: string;
}

/**
 * Sello web de la medalla: un SVG propio de KORUM (parche redondo en azul marino con el disco del nivel), con el nombre de la entidad y el
 * curso. No reproduce escudos ni lemas de instituciones reales. Se descarga tal cual y escala sin perder nitidez.
 */
export function buildMedalSealSvg(input: MedalSealInput): string {
  const colors = SEAL_COLORS[input.rank] ?? SEAL_COLORS[3]!;
  const text = (value: string, y: number, size: number, weight: number, fill: string, spacing = 0) =>
    `<text x="200" y="${y}" text-anchor="middle" font-family="Plus Jakarta Sans, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${fill}">${escapeXml(value)}</text>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400" role="img" aria-labelledby="seal-title">`,
    `<title id="seal-title">${escapeXml(input.accessibleName)}</title>`,
    '<circle cx="200" cy="200" r="190" fill="#101F38"/>',
    '<circle cx="200" cy="200" r="176" fill="none" stroke="#F59E0B" stroke-width="4" stroke-dasharray="3 9" stroke-linecap="round"/>',
    `<circle cx="200" cy="170" r="84" fill="${colors.disc}" stroke="#F59E0B" stroke-width="6"/>`,
    text('KORUM', 190, 44, 800, colors.text, 3),
    text(input.tierName.toUpperCase(), 224, 22, 800, colors.text, 4),
    text(input.headline.toUpperCase(), 296, 22, 800, '#F59E0B', 2),
    text(fitText(input.entityName, 30), 332, 20, 700, '#FFFDF8'),
    text(input.period, 362, 16, 600, '#FFFDF8'),
    '</svg>',
    ''
  ].join('\n');
}
