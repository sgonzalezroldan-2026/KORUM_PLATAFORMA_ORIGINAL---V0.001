import { blankStudioDraft, TICKETING_CATEGORY, type StudioDraft, type StudioFormat, type StudioVertical } from './studio-draft';

/**
 * Plantillas de campaña listas para usar (Sprint 4.3, ficha «plantillas de campaña»). Una plantilla rellena el título, la descripción, la categoría
 * y, en taquilla, un precio y un aforo de partida; **nunca un presupuesto de obra o de proveedor**: KORUM no fija precios ajenos y la entidad
 * introduce el de su proveedor (Regla 02 §2). Los textos salen de `panel.studio.templates.<clave>` (es, ca, en) y el nombre de la categoría es el de
 * las categorías globales de la plataforma, así que si la entidad no la tiene, la plantilla deja la categoría por elegir.
 */

export type TemplateIllustration = 'fan' | 'court' | 'kit' | 'laptop' | 'bus' | 'heart' | 'stage' | 'raffle' | 'instrument' | 'scoreboard';

export interface CampaignTemplate {
  key: string;
  verticals: readonly StudioVertical[];
  format: StudioFormat;
  /** Categoría de mejora (nombre global); `null` en taquilla, que usa la suya. */
  category: string | null;
  illustration: TemplateIllustration;
  ticket?: { subtype: 'EVENT' | 'RAFFLE'; priceCents: number; max: number; prizes: number | null };
  /**
   * Textos propios de una vertical (Sprint 5.5b, heredado del 4.3): un club no hace «excursión de fin de curso» sino un desplazamiento a un torneo, y una
   * entidad cultural no hace «festival de fin de curso» sino un concierto. La clave apunta a `panel.studio.templates.<clave>`.
   */
  textVariants?: Partial<Record<StudioVertical, string>>;
}

const ALL: readonly StudioVertical[] = ['SCHOOL', 'SPORTS_CLUB', 'CULTURAL'];

export const CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  { key: 'climate', verticals: ['SCHOOL'], format: 'BUDGET', category: 'Infraestructura y Confort', illustration: 'fan' },
  { key: 'playground', verticals: ['SCHOOL', 'SPORTS_CLUB'], format: 'BUDGET', category: 'Patios y Deporte', illustration: 'court', textVariants: { SPORTS_CLUB: 'playgroundClub' } },
  { key: 'kit', verticals: ['SPORTS_CLUB'], format: 'BUDGET', category: 'Patios y Deporte', illustration: 'kit' },
  { key: 'scoreboard', verticals: ['SPORTS_CLUB'], format: 'BUDGET', category: 'Patios y Deporte', illustration: 'scoreboard' },
  { key: 'tech', verticals: ['SCHOOL', 'CULTURAL'], format: 'BUDGET', category: 'Tecnología y Recursos', illustration: 'laptop', textVariants: { CULTURAL: 'techCultural' } },
  { key: 'instruments', verticals: ['CULTURAL'], format: 'BUDGET', category: 'Tecnología y Recursos', illustration: 'instrument' },
  { key: 'trip', verticals: ALL, format: 'BUDGET', category: 'Comunidad y Viajes', illustration: 'bus', textVariants: { SPORTS_CLUB: 'tripClub', CULTURAL: 'tripCultural' } },
  { key: 'solidarity', verticals: ALL, format: 'BUDGET', category: 'Solidaridad y Becas', illustration: 'heart', textVariants: { SPORTS_CLUB: 'solidarityClub' } },
  { key: 'festival', verticals: ALL, format: 'TICKETING', category: null, illustration: 'stage', ticket: { subtype: 'EVENT', priceCents: 500, max: 200, prizes: null }, textVariants: { SPORTS_CLUB: 'festivalClub', CULTURAL: 'festivalCultural' } },
  { key: 'raffle', verticals: ALL, format: 'TICKETING', category: null, illustration: 'raffle', ticket: { subtype: 'RAFFLE', priceCents: 200, max: 500, prizes: 3 } }
];

/** Clave de los textos de una plantilla en una vertical (`panel.studio.templates.<clave>`): la propia de la vertical si la tiene. */
export function templateTextKey(template: CampaignTemplate, vertical: StudioVertical): string {
  return template.textVariants?.[vertical] ?? template.key;
}

/** Todas las claves de texto que usa el catálogo (para comprobar que existen en los tres idiomas). */
export const TEMPLATE_TEXT_KEYS: readonly string[] = [...new Set(CAMPAIGN_TEMPLATES.flatMap((template) => [template.key, ...Object.values(template.textVariants ?? {})]))];

/**
 * Premios del reto por curso o grupo de cada vertical (Sprint 5.5b): los tres huecos de `REWARD_PRESETS` son posiciones, y su texto cambia con la vertical
 * (`panel.studio.<sección>.<hueco>`): una tarde de cine en el salón de actos en un colegio, un entrenamiento especial en un club, un ensayo abierto en una
 * entidad cultural.
 */
export const REWARD_PRESET_SECTION: Record<StudioVertical, string> = { SCHOOL: 'rewardPresets', SPORTS_CLUB: 'rewardPresetsClub', CULTURAL: 'rewardPresetsCultural' };

export function templatesFor(vertical: StudioVertical): CampaignTemplate[] {
  return CAMPAIGN_TEMPLATES.filter((template) => template.verticals.includes(vertical));
}

export function findTemplate(key: string | null | undefined, vertical: StudioVertical): CampaignTemplate | undefined {
  return templatesFor(vertical).find((template) => template.key === key);
}

/** Borrador de una campaña nueva a partir de una plantilla. El título y la descripción vienen ya traducidos al idioma en que escribe la entidad. */
export function draftFromTemplate(
  template: CampaignTemplate,
  texts: { title: string; description: string; rewardText: string | null },
  context: { vertical: StudioVertical; defaultCloseOn: string; availableCategories: readonly string[] }
): StudioDraft {
  const blank = blankStudioDraft(template.format, context.vertical, context.defaultCloseOn);
  const category = template.format === 'TICKETING' ? TICKETING_CATEGORY : template.category !== null && context.availableCategories.includes(template.category) ? template.category : '';
  return {
    ...blank,
    title: texts.title,
    description: texts.description,
    category,
    rewardText: texts.rewardText,
    ...(template.ticket
      ? { ticketSubtype: template.ticket.subtype, ticketPriceCents: template.ticket.priceCents, ticketMax: template.ticket.max, rafflePrizeCount: template.ticket.prizes }
      : {})
  };
}
