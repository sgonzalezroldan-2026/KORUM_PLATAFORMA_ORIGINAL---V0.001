import { blankStudioDraft, TICKETING_CATEGORY, type StudioDraft, type StudioFormat, type StudioVertical } from './studio-draft';

/**
 * Plantillas de campaña listas para usar (Sprint 4.3, ficha «plantillas de campaña»). Una plantilla rellena el título, la descripción, la categoría
 * y, en taquilla, un precio y un aforo de partida; **nunca un presupuesto de obra o de proveedor**: KORUM no fija precios ajenos y la entidad
 * introduce el de su proveedor (Regla 02 §2). Los textos salen de `panel.studio.templates.<clave>` (es, ca, en) y el nombre de la categoría es el de
 * las categorías globales de la plataforma, así que si la entidad no la tiene, la plantilla deja la categoría por elegir.
 */

export type TemplateIllustration = 'fan' | 'court' | 'kit' | 'laptop' | 'bus' | 'heart' | 'stage' | 'raffle';

export interface CampaignTemplate {
  key: string;
  verticals: readonly StudioVertical[];
  format: StudioFormat;
  /** Categoría de mejora (nombre global); `null` en taquilla, que usa la suya. */
  category: string | null;
  illustration: TemplateIllustration;
  ticket?: { subtype: 'EVENT' | 'RAFFLE'; priceCents: number; max: number; prizes: number | null };
}

const ALL: readonly StudioVertical[] = ['SCHOOL', 'SPORTS_CLUB', 'CULTURAL'];

export const CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  { key: 'climate', verticals: ['SCHOOL'], format: 'BUDGET', category: 'Infraestructura y Confort', illustration: 'fan' },
  { key: 'playground', verticals: ['SCHOOL', 'SPORTS_CLUB'], format: 'BUDGET', category: 'Patios y Deporte', illustration: 'court' },
  { key: 'kit', verticals: ['SPORTS_CLUB'], format: 'BUDGET', category: 'Patios y Deporte', illustration: 'kit' },
  { key: 'tech', verticals: ['SCHOOL', 'CULTURAL'], format: 'BUDGET', category: 'Tecnología y Recursos', illustration: 'laptop' },
  { key: 'trip', verticals: ALL, format: 'BUDGET', category: 'Comunidad y Viajes', illustration: 'bus' },
  { key: 'solidarity', verticals: ['SCHOOL', 'CULTURAL'], format: 'BUDGET', category: 'Solidaridad y Becas', illustration: 'heart' },
  { key: 'festival', verticals: ALL, format: 'TICKETING', category: null, illustration: 'stage', ticket: { subtype: 'EVENT', priceCents: 500, max: 200, prizes: null } },
  { key: 'raffle', verticals: ALL, format: 'TICKETING', category: null, illustration: 'raffle', ticket: { subtype: 'RAFFLE', priceCents: 200, max: 500, prizes: 3 } }
];

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
