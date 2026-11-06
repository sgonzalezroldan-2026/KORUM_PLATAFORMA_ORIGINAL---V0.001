import { calculatePublicBreakdown4Lines, calculateStudioTicketingTCO, PublicBreakdownMismatchError } from '@/core/finance/tco.service';
import { z } from 'zod';
import { reportError } from '@/lib/error-reporting';
import { daysLeft, isAchieved, progressPercent, ticketsAvailable, type PublicFormat } from './catalog';
import { buildCourseChallenge, orderedGroupNames, type CourseChallengeLine, type CourseProgressRow } from './course-challenge';

/**
 * Del dato de la base al dato que pinta el portal. Todo lo que sale de aquí es serializable (sin `Date`) para poder cruzar de un componente de
 * servidor a uno de cliente, y no contiene nada que no sea público: ni correos, ni NIF, ni importes por curso, ni la pizarra interna.
 */

export interface InitiativeRow {
  id: number;
  status: 'FUNDRAISING' | 'GOAL_REACHED' | 'CLOSED';
  walletEscrowId: string;
  format: PublicFormat;
  title: string;
  category: string;
  stage: string;
  description: string;
  closesAt: Date;
  raisedCents: number;
  goalCents: number;
  totalContributions: number;
  showPublicBreakdown: boolean;
  matchingPoolRemainingCents: number;
  matchingSponsorName: string | null;
  ticketSubtype: 'EVENT' | 'RAFFLE' | null;
  ticketPriceCents: number | null;
  ticketMax: number | null;
  ticketsSold: number;
  ticketsHeld: number;
  ticketFeeMode: 'ADD' | 'INC' | null;
  ticketVenue: string | null;
  plaqueEnabled: boolean;
  rewardEnabled: boolean;
  rewardText: string | null;
  targetFamiliesPerCourse: number;
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  /** Con valor desde que la campaña pasó a recaudar con su precio ya calculado. */
  quotaReservedAt: Date | null;
  courses: CourseProgressRow[];
  /** Traducciones opcionales del contenido: `{ ca: { title, description }, en: { … } }`. */
  translationsJson?: unknown;
}

export interface InitiativeCardData {
  id: number;
  format: PublicFormat;
  subtype: 'EVENT' | 'RAFFLE' | null;
  title: string;
  category: string;
  stage: string;
  pct: number;
  daysLeft: number;
  raisedCents: number;
  goalCents: number;
  ticketsSold: number;
  ticketMax: number;
  ticketsAvailable: number;
  ticketPriceCents: number;
  /** Lo que paga quien compra por entrada: el precio más los gastos de gestión digital si van encima (`ADD`). */
  ticketBuyerCents: number;
  /** Aportaciones completadas de personas y comercios (el Auto-Impulso no cuenta). */
  contributions: number;
  /** Meta lograda (campaña) o aforo completo (taquilla). */
  achieved: boolean;
  /** La iniciativa ya no está en `FUNDRAISING`: no admite aportaciones aunque no figure como lograda. */
  closed: boolean;
  matching: boolean;
  zeroCommission: boolean;
}

/** Gastos de gestión digital de la entidad (tarifa pública de taquilla). */
export interface TicketFees {
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
}
const NO_TICKET_FEES: TicketFees = { ticketFeeFixedCents: 0, ticketFeeBps: 0 };

export function toCardData(row: InitiativeRow, now: Date, fees: TicketFees = NO_TICKET_FEES): InitiativeCardData {
  const ticketMax = row.ticketMax ?? 0;
  const base = { format: row.format, raisedCents: row.raisedCents, goalCents: row.goalCents, ticketsSold: row.ticketsSold, ticketMax, ticketsHeld: row.ticketsHeld };
  return {
    id: row.id,
    format: row.format,
    subtype: row.ticketSubtype,
    title: row.title,
    category: row.category,
    stage: row.stage,
    pct: progressPercent(base),
    daysLeft: daysLeft(row.closesAt, now),
    raisedCents: row.raisedCents,
    goalCents: row.goalCents,
    ticketsSold: row.ticketsSold,
    ticketMax,
    ticketsAvailable: ticketsAvailable(base),
    ticketPriceCents: row.ticketPriceCents ?? 0,
    ticketBuyerCents: buildTicketInfo(row, fees)?.buyerUnitCents ?? 0,
    contributions: row.totalContributions,
    achieved: isAchieved(base) || row.status === 'GOAL_REACHED',
    closed: row.status !== 'FUNDRAISING',
    matching: row.matchingPoolRemainingCents > 0,
    // Solo si el precio ya está calculado (`quotaReservedAt`) y la plataforma no cobra ni comisión de tramos ni mantenimiento.
    zeroCommission: row.format === 'BUDGET' && row.quotaReservedAt !== null && row.bracketFeeCents === 0 && row.maintFeeCents === 0 && row.goalCents > 0
  };
}

export interface BreakdownData {
  providerCents: number;
  installCents: number;
  contingencyCents: number;
  escrowAndGuaranteeCents: number;
  realExecutionCents: number;
  totalGoalCents: number;
  contingencyBps: number;
}

/**
 * Las 4 líneas públicas suman exactamente la meta (QA-F03). Nunca se publica un desglose falso ni se afirma que el presupuesto está
 * «validado» si el coste real supera la meta (`mismatch`); el descuadre se registra para que alguien lo corrija.
 */
export function buildBreakdown(row: Pick<InitiativeRow, 'id' | 'format' | 'showPublicBreakdown' | 'costMatCents' | 'costInstCents' | 'contingencyBps' | 'goalCents'>): BreakdownState {
  if (row.format !== 'BUDGET') return { kind: 'none' };
  try {
    // Se comprueba aunque la entidad no quiera enseñar las líneas: «presupuesto validado» solo puede decirse si el coste real cabe en la meta.
    const lines = calculatePublicBreakdown4Lines(row);
    if (!row.showPublicBreakdown) return { kind: 'hidden' };
    return { kind: 'shown', data: {
      providerCents: lines.line1ProviderCents,
      installCents: lines.line2InstallCents,
      contingencyCents: lines.line3ContingencyCents,
      escrowAndGuaranteeCents: lines.line4EscrowAndGuaranteeCents,
      realExecutionCents: lines.realExecutionTotalCents,
      totalGoalCents: lines.totalGoalCents,
      contingencyBps: row.contingencyBps
    } };
  } catch (error) {
    if (!(error instanceof PublicBreakdownMismatchError)) throw error;
    reportError(error, { area: 'public-breakdown', initiativeId: row.id });
    return { kind: 'mismatch' };
  }
}

/**
 * Estado del desglose público: `shown` (4 líneas que suman la meta), `hidden` (la entidad no las enseña; el coste real sí cabe en la meta),
 * `mismatch` (el coste real supera la meta: no se afirma nada) o `none` (taquilla).
 */
export type BreakdownState = { kind: 'shown'; data: BreakdownData } | { kind: 'hidden' } | { kind: 'mismatch' } | { kind: 'none' };

export interface TicketInfoData {
  mode: 'ADD' | 'INC';
  priceCents: number;
  /** Gastos de gestión digital por entrada. */
  feeUnitCents: number;
  /** Lo que paga quien compra por entrada. */
  buyerUnitCents: number;
  /** Lo que recibe la entidad por entrada. */
  centerUnitCents: number;
  venue: string | null;
}

/** Información de taquilla con las mismas fórmulas del Estudio (`calculateStudioTicketingTCO`): `ADD` suma la gestión al precio, `INC` la incluye. */
export function buildTicketInfo(
  row: Pick<InitiativeRow, 'format' | 'ticketPriceCents' | 'ticketFeeMode' | 'ticketVenue'>,
  fees: TicketFees
): TicketInfoData | null {
  if (row.format !== 'TICKETING' || row.ticketPriceCents === null || row.ticketFeeMode === null) return null;
  const pricing = calculateStudioTicketingTCO({
    ticketPriceCents: row.ticketPriceCents,
    ticketMax: 1,
    feeMode: row.ticketFeeMode,
    digitalFeeConfig: { fixedCents: fees.ticketFeeFixedCents, pctBps: fees.ticketFeeBps },
    // Solo se pregunta por la gestión digital: la pasarela no se enseña a las familias.
    gatewayConfig: { pctBps: 0, fixedCents: 0 },
    maintFeeCents: 0
  });
  return {
    mode: row.ticketFeeMode,
    priceCents: row.ticketPriceCents,
    feeUnitCents: pricing.digitalFeeUnitCents,
    buyerUnitCents: pricing.buyerUnitChargeCents,
    centerUnitCents: row.ticketFeeMode === 'ADD' ? pricing.grossTicketsCents : pricing.grossTicketsCents - pricing.totalDigitalFeesCents,
    venue: row.ticketVenue
  };
}

export interface InitiativeDetailData {
  card: InitiativeCardData;
  description: string;
  walletEscrowId: string;
  /** Fecha límite en ISO (se formatea en la interfaz con el idioma de la persona). */
  closesAtIso: string;
  breakdown: BreakdownState;
  ticket: TicketInfoData | null;
  plaque: boolean;
  matchingSponsorName: string | null;
  challenge: { enabled: boolean; rewardText: string | null; target: number; lines: CourseChallengeLine[] };
}

export interface DetailContext {
  vertical: string;
  participationGroupsJson: unknown;
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
}

export function toDetailData(row: InitiativeRow, context: DetailContext, now: Date): InitiativeDetailData {
  const order = orderedGroupNames(context.vertical, context.participationGroupsJson);
  return {
    card: toCardData(row, now, context),
    description: row.description,
    walletEscrowId: row.walletEscrowId,
    closesAtIso: row.closesAt.toISOString(),
    breakdown: buildBreakdown(row),
    ticket: buildTicketInfo(row, context),
    plaque: row.plaqueEnabled,
    matchingSponsorName: row.matchingPoolRemainingCents > 0 ? row.matchingSponsorName : null,
    challenge: {
      enabled: row.rewardEnabled,
      rewardText: row.rewardText,
      target: row.targetFamiliesPerCourse,
      lines: row.rewardEnabled ? buildCourseChallenge(row.courses, row.targetFamiliesPerCourse, order) : []
    }
  };
}

const translationsSchema = z.record(z.string(), z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().trim().min(1).max(5000).optional() }));

/**
 * Título y descripción en el idioma de la persona si la entidad los tradujo (`translationsJson`); si no, en el idioma en que los escribió
 * (`contentLocale`). `lang` es el idioma real del texto, para marcarlo en el HTML (lectores de pantalla y traductores); `undefined` si
 * coincide con el de la página. La categoría y la etapa se muestran siempre tal como las escribió la entidad.
 */
export function localizeRow<T extends Pick<InitiativeRow, 'title' | 'description' | 'translationsJson'>>(row: T, locale: string, contentLocale: string): { row: T; lang: string | undefined } {
  const parsed = translationsSchema.safeParse(row.translationsJson);
  const translated = parsed.success ? parsed.data[locale] : undefined;
  if (translated && locale !== contentLocale && (translated.title || translated.description)) {
    return { row: { ...row, title: translated.title ?? row.title, description: translated.description ?? row.description }, lang: translated.title && translated.description ? undefined : contentLocale };
  }
  return { row, lang: contentLocale === locale ? undefined : contentLocale };
}
