import { bpsOf } from '@/core/finance/money';
import { calculateStudioBudgetTCO, calculateStudioTicketingTCO, evaluateMaintenanceCapShutoff, type BracketConfig, type GatewayRates } from '@/core/finance/tco.service';
import { evaluateSemanticLock } from '@/core/security/semantic-lock';
import { endOfDayInMadrid, madridIsoDate, TICKETING_CATEGORY, type StudioDraft, type StudioVertical } from './studio-draft';

/**
 * Pizarra del Estudio y requisitos para publicar (Sprint 4.3, `recalcStudioTCO` del prototipo). Funciones puras: la pantalla las llama en cada
 * pulsación para enseñar la pizarra en vivo y el servidor las vuelve a llamar al guardar y al publicar, con las reglas y los cupos que lee él mismo.
 * Toda la aritmética es del motor TCO (`src/core/finance/tco.service.ts`): aquí solo se eligen sus entradas.
 */

const DAY_MS = 86_400_000;
/** Tope absoluto de duración (Regla 02 §4): ni el motor de reglas lo sube. Igual que `MAX_CAMPAIGN_DAYS_LIMIT` de la ventana de 90 días. */
const MAX_CAMPAIGN_DAYS_LIMIT = 75;

export interface StudioCategory {
  name: string;
  icon: string;
  rule: 'EXEMPT' | 'BRACKETS';
}

/** Todo lo que el Estudio necesita saber de la entidad y de la plataforma. Lo carga el servidor, nunca el navegador. */
export interface StudioContext {
  vertical: StudioVertical;
  bracket: BracketConfig;
  gateway: GatewayRates;
  /** Importe de aportación sugerido de la entidad, con el que se estima el número de cobros. */
  donationTicketCents: number;
  exemptRemainingCents: number;
  medalGrantAvailableCents: number;
  medalRank: number;
  maint: { active: boolean; perInitCents: number; annualCapCents: number; paidCents: number };
  ticketFee: { fixedCents: number; pctBps: number };
  maxCampaignDays: number;
  categories: readonly StudioCategory[];
  kybVerified: boolean;
}

export interface SemanticLockView {
  /** La categoría elegida es de las que no pagan comisión. */
  requested: boolean;
  /** El texto habla de equipamiento o infraestructura: la exención no se aplica. */
  blocked: boolean;
  /** Palabra que lo ha bloqueado, para explicárselo a la entidad. */
  term: string | null;
}

export interface BudgetBoard {
  kind: 'BUDGET';
  baseCents: number;
  contingencyCents: number;
  netCents: number;
  defaultExemptCents: number;
  medalExemptCents: number;
  medalSavedCents: number;
  taxableCents: number;
  rateBps: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  /** Solo en una pizarra calculada: una ya publicada no guarda cómo se estimó la pasarela. */
  gatewayDetail: { estTransactions: number; variableCents: number; fixedCents: number; roundingCents: number } | null;
  gatewayFeeCents: number;
  goalCents: number;
  categoryExempt: boolean;
  lock: SemanticLockView;
}

export interface TicketingBoard {
  kind: 'TICKETING';
  /** Aforo completo por el precio. */
  grossCents: number;
  digitalFeeUnitCents: number;
  buyerUnitChargeCents: number;
  gatewayUnitCostCents: number;
  marginPerTicketCents: number;
  totalDigitalFeesCents: number;
  totalGatewayCostCents: number;
  maintFeeCents: number;
  maintShortfallCents: number;
  /** Lo que la entidad se queda con el aforo completo, descontado el mantenimiento. */
  netCents: number;
  /** Lo que entra en la hucha con el aforo completo: es la meta de la campaña (en `INC`, sin los gastos de gestión). */
  goalCents: number;
  isGatewayCovered: boolean;
}

export type StudioBoard = BudgetBoard | TicketingBoard;

/** Categoría elegida entre las de la entidad. Una que no existe no es válida para guardar. */
export function findCategory(context: StudioContext, name: string): StudioCategory | undefined {
  return context.categories.find((category) => category.name === name);
}

/**
 * Candado semántico en vivo: una categoría al 0 % solo vale si el título y la descripción no hablan de equipamiento o infraestructura
 * («ventiladores», «toldos»). Es un filtro de buena fe; el Super-Admin revisa las campañas al 0 % (auditoría `studio.exempt_category_saved`).
 */
export function evaluateStudioLock(context: StudioContext, draft: Pick<StudioDraft, 'category' | 'title' | 'description'>): SemanticLockView {
  const requested = findCategory(context, draft.category)?.rule === 'EXEMPT';
  if (!requested) return { requested: false, blocked: false, term: null };
  const result = evaluateSemanticLock(`${draft.title} ${draft.description}`);
  return { requested: true, blocked: result.isBlocked, term: result.matchedTerm };
}

export function computeBudgetBoard(context: StudioContext, draft: StudioDraft): BudgetBoard {
  const lock = evaluateStudioLock(context, draft);
  const categoryExempt = lock.requested && !lock.blocked;
  const tco = calculateStudioBudgetTCO({
    costMatCents: draft.costMatCents,
    costInstCents: draft.costInstCents,
    contingencyBps: draft.contingencyBps,
    isCategoryExempt: categoryExempt,
    baseExemptRemainingCents: context.exemptRemainingCents,
    medalGrantAvailableCents: context.medalGrantAvailableCents,
    bracketConfig: context.bracket,
    maintConfig: { active: context.maint.active, perInitCents: context.maint.perInitCents, annualCapCents: context.maint.annualCapCents, alreadyChargedOrReservedCents: context.maint.paidCents },
    gatewayConfig: { ...context.gateway, defaultDonationTicketCents: context.donationTicketCents }
  });
  return {
    kind: 'BUDGET',
    baseCents: tco.baseExecutionCents,
    contingencyCents: tco.contingencyCents,
    netCents: tco.netGuaranteedForSchoolCents,
    defaultExemptCents: tco.defaultExemptUsedCents,
    medalExemptCents: tco.medalExemptUsedCents,
    medalSavedCents: tco.medalSavedCents,
    taxableCents: tco.taxableCents,
    rateBps: tco.bracketRateBps,
    bracketFeeCents: tco.bracketFeeCents,
    maintFeeCents: tco.maintFeeCents,
    gatewayDetail: { estTransactions: tco.estTransactions, variableCents: tco.rawVariableGatewayCents, fixedCents: tco.rawFixedGatewayCents, roundingCents: tco.roundingBufferCents },
    gatewayFeeCents: tco.gatewayFeeCents,
    goalCents: tco.finalGoalCents,
    categoryExempt,
    lock
  };
}

/**
 * Taquilla o rifa. La meta es lo que entra en la hucha con el aforo completo: en `ADD` los gastos de gestión digital se cobran aparte y entra el
 * precio entero; en `INC` van dentro del precio y entra el precio menos esos gastos. (Con el precio entero como meta, una campaña `INC` vendida
 * por completo nunca llegaría al 100 %.) `maintFeeCents` fija el mantenimiento de una campaña ya publicada, que no se recalcula.
 */
export function computeTicketingBoard(context: StudioContext, draft: StudioDraft, frozenMaintFeeCents?: number): TicketingBoard {
  const gross = draft.ticketPriceCents * draft.ticketMax;
  const maintFeeCents =
    frozenMaintFeeCents ??
    (gross > 0
      ? evaluateMaintenanceCapShutoff({ active: context.maint.active, perInitCents: context.maint.perInitCents, annualCapCents: context.maint.annualCapCents, alreadyChargedOrReservedCents: context.maint.paidCents }).maintFeeCents
      : 0);
  const tco = calculateStudioTicketingTCO({
    ticketPriceCents: draft.ticketPriceCents,
    ticketMax: draft.ticketMax,
    feeMode: draft.ticketFeeMode,
    digitalFeeConfig: context.ticketFee,
    gatewayConfig: context.gateway,
    maintFeeCents
  });
  return {
    kind: 'TICKETING',
    grossCents: tco.grossTicketsCents,
    digitalFeeUnitCents: tco.digitalFeeUnitCents,
    buyerUnitChargeCents: tco.buyerUnitChargeCents,
    gatewayUnitCostCents: tco.gatewayUnitCostCents,
    marginPerTicketCents: tco.netKorumMarginPerTicketCents,
    totalDigitalFeesCents: tco.totalDigitalFeesCents,
    totalGatewayCostCents: tco.totalGatewayCostCents,
    maintFeeCents,
    maintShortfallCents: tco.maintShortfallCents,
    netCents: tco.netGuaranteedForSchoolCents,
    goalCents: tco.grossTicketsCents - (draft.ticketFeeMode === 'ADD' ? 0 : tco.totalDigitalFeesCents),
    isGatewayCovered: tco.isGatewayCovered
  };
}

export function computeStudioBoard(context: StudioContext, draft: StudioDraft): StudioBoard {
  return draft.format === 'TICKETING' ? computeTicketingBoard(context, draft) : computeBudgetBoard(context, draft);
}

/** Pizarra de una campaña ya publicada: lo que se guardó al publicarla, sin recalcular (los cupos ya se descontaron y volver a calcularlos los contaría dos veces). */
export function storedBudgetBoard(stored: {
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
  goalCents: number;
  defaultExemptAppliedCents: number;
  medalExemptAppliedCents: number;
  bracketRateAppliedBps: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
}): BudgetBoard {
  const baseCents = stored.costMatCents + stored.costInstCents;
  const contingencyCents = bpsOf(baseCents, stored.contingencyBps);
  const netCents = baseCents + contingencyCents;
  const exempt = stored.defaultExemptAppliedCents + stored.medalExemptAppliedCents;
  return {
    kind: 'BUDGET',
    baseCents,
    contingencyCents,
    netCents,
    defaultExemptCents: stored.defaultExemptAppliedCents,
    medalExemptCents: stored.medalExemptAppliedCents,
    medalSavedCents: 0,
    taxableCents: stored.bracketFeeCents === 0 && stored.bracketRateAppliedBps === 0 ? 0 : Math.max(0, netCents - exempt),
    rateBps: stored.bracketRateAppliedBps,
    bracketFeeCents: stored.bracketFeeCents,
    maintFeeCents: stored.maintFeeCents,
    gatewayDetail: null,
    gatewayFeeCents: stored.gatewayFeeCents,
    goalCents: stored.goalCents,
    categoryExempt: stored.bracketRateAppliedBps === 0 && stored.bracketFeeCents === 0 && netCents > 0,
    lock: { requested: false, blocked: false, term: null }
  };
}

/** Días de campaña desde `from` hasta el cierre, redondeando hacia arriba (como `campaignDays` del cierre de campañas). */
export function campaignDaysFrom(from: Date, closesAt: Date): number {
  return Math.ceil((closesAt.getTime() - from.getTime()) / DAY_MS);
}

/** Días máximos que admite una campaña hoy: el ajuste de la consola, sin pasar nunca de 75. */
export function effectiveMaxCampaignDays(maxCampaignDays: number): number {
  return Math.min(maxCampaignDays, MAX_CAMPAIGN_DAYS_LIMIT);
}

/**
 * Último día que se puede elegir como cierre. Una campaña cierra a las 23:59 de España del día elegido, así que con `maxDays` de máximo el último día
 * válido es el anterior al de `hoy + maxDays` si ese 23:59 ya pasaría del límite: el selector de fecha y la comprobación del servidor dicen lo mismo.
 */
export function latestCloseOn(now: Date, maxDays: number): string {
  let day = madridIsoDate(new Date(now.getTime() + maxDays * DAY_MS));
  for (let guard = 0; guard < 3; guard += 1) {
    const closesAt = endOfDayInMadrid(day);
    if (closesAt && campaignDaysFrom(now, closesAt) <= maxDays) return day;
    // Un día de calendario atrás, no 24 horas: con el cambio de hora de marzo un día tiene 23 y se saltaría una fecha válida.
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    day = new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
  }
  return day;
}

export type SaveProblem = 'TITLE_MISSING' | 'INVALID_CATEGORY' | 'CLOSING_INVALID' | 'CLOSING_PAST' | 'CLOSING_TOO_LATE' | 'RAFFLE_PRIZES_EXCEED';

/** Lo que impide guardar el borrador. Es poco: un borrador a medias se puede guardar; lo que falta para publicar lo dice `publishBlockers`. */
export function saveProblems(context: StudioContext, draft: StudioDraft, now: Date): SaveProblem[] {
  const problems: SaveProblem[] = [];
  if (draft.title.trim().length < 3) problems.push('TITLE_MISSING');
  const category = findCategory(context, draft.category);
  const validCategory = draft.format === 'TICKETING' ? draft.category === TICKETING_CATEGORY : category !== undefined && category.name !== TICKETING_CATEGORY;
  if (!validCategory) problems.push('INVALID_CATEGORY');
  const closesAt = endOfDayInMadrid(draft.closesOn);
  if (!closesAt) problems.push('CLOSING_INVALID');
  else if (closesAt.getTime() <= now.getTime()) problems.push('CLOSING_PAST');
  else if (campaignDaysFrom(now, closesAt) > effectiveMaxCampaignDays(context.maxCampaignDays)) problems.push('CLOSING_TOO_LATE');
  if (draft.format === 'TICKETING' && draft.rafflePrizeCount !== null && draft.rafflePrizeCount > draft.ticketMax) problems.push('RAFFLE_PRIZES_EXCEED');
  return problems;
}

export type PublishBlocker =
  | 'KYB'
  | 'GOAL_ZERO'
  | 'STAGE_MISSING'
  | 'DESCRIPTION_MISSING'
  | 'TICKET_MAX_ZERO'
  | 'TICKET_PRICE_ZERO'
  | 'TICKET_FEE_EXCEEDS_PRICE'
  | 'MAINT_EXCEEDS_TAKINGS'
  | 'RAFFLE_PRIZES'
  | 'RAFFLE_NOTICE'
  | SaveProblem;

/**
 * Qué falta para publicar. Los pasa quien llama a la pantalla (lista con un enlace a cada cosa) y el servidor al publicar (nunca confía en el
 * botón). Una lista vacía significa que se puede publicar. El candado semántico no impide publicar: avisa y la comisión se cobra por tramos.
 */
export function publishBlockers(context: StudioContext, draft: StudioDraft, board: StudioBoard, now: Date): PublishBlocker[] {
  const blockers: PublishBlocker[] = [...saveProblems(context, draft, now)];
  if (!context.kybVerified) blockers.push('KYB');
  if (draft.stage.trim() === '') blockers.push('STAGE_MISSING');
  if (draft.description.trim() === '') blockers.push('DESCRIPTION_MISSING');
  if (board.kind === 'BUDGET') {
    if (board.goalCents <= 0) blockers.push('GOAL_ZERO');
  } else {
    if (draft.ticketMax <= 0) blockers.push('TICKET_MAX_ZERO');
    // Sin importe para la hucha no hay asiento posible: `reserveTickets` rechazaría cada compra (heredado del Sprint 2.3).
    if (draft.ticketPriceCents <= 0) blockers.push('TICKET_PRICE_ZERO');
    else if (draft.ticketFeeMode === 'INC' && draft.ticketPriceCents <= board.digitalFeeUnitCents) blockers.push('TICKET_FEE_EXCEEDS_PRICE');
    // El mantenimiento se reserva contra el tope anual al publicar: si lo recaudable no lo cubre, la liquidación saldría en negativo.
    if (board.maintShortfallCents > 0) blockers.push('MAINT_EXCEEDS_TAKINGS');
    if (draft.ticketSubtype === 'RAFFLE') {
      if (draft.rafflePrizeCount === null || draft.rafflePrizeCount < 1 || draft.rafflePrizeCount > draft.ticketMax) blockers.push('RAFFLE_PRIZES');
      if (!draft.raffleNoticeConfirmed) blockers.push('RAFFLE_NOTICE');
    }
  }
  return [...new Set(blockers)];
}
