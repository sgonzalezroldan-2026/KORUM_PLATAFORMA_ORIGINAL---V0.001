import type { BracketMode, KorumGlobalRulesCents } from '@/types/korum.types';
import { assertSafeCents, bpsOf } from './money';

/**
 * Motor TCO en céntimos enteros (Regla 02 §1, §2 y §6; skill korum-tco-calculator §2–§4). Funciones puras y deterministas:
 * el Estudio, la calculadora y el BI llaman a estas mismas fórmulas. Una entrada que no sea un entero seguro no negativo
 * lanza `RangeError`: un importe con decimales delata un error aguas arriba y nunca se redondea en silencio.
 */

export interface BracketConfig {
  /** `FLAT` reproduce el prototipo; `MARGINAL` elimina el efecto escalón. */
  mode: BracketMode;
  /** Límite superior del tramo 1 sobre el neto (500000 = 5.000,00 €). */
  t1MaxCents: number;
  /** Límite superior del tramo 2 sobre el neto (1500000 = 15.000,00 €). Si no supera a `t1MaxCents`, el tramo 2 queda vacío. */
  t2MaxCents: number;
  ratesBps: { t1: number; t2: number; t3: number };
}

export interface GatewayRates {
  pctBps: number;
  fixedCents: number;
}

export interface MaintenanceConfig {
  active: boolean;
  perInitCents: number;
  annualCapCents: number;
  /** Lo ya cobrado o reservado en el curso por otras campañas. */
  alreadyChargedOrReservedCents: number;
}

export interface BudgetTcoInputCents {
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
  /** `true` si la categoría es al 0 % (y ha superado el candado semántico). No consume cupos. */
  isCategoryExempt: boolean;
  baseExemptRemainingCents: number;
  medalGrantAvailableCents: number;
  bracketConfig: BracketConfig;
  maintConfig: MaintenanceConfig;
  gatewayConfig: GatewayRates & { defaultDonationTicketCents: number };
}

/** Importe de referencia si la entidad no tiene aportación sugerida, y mínimo para que la estimación de cobros sea razonable. */
const FALLBACK_DONATION_TICKET_CENTS = 2500;
const MIN_DONATION_TICKET_CENTS = 500;

function assertAmount(value: number, label: string): number {
  assertSafeCents(value, label);
  if (value < 0) throw new RangeError(`El ${label} no puede ser negativo, recibido: ${value}`);
  return value;
}

function assertBracketConfig(cfg: BracketConfig): void {
  assertAmount(cfg.t1MaxCents, 't1MaxCents');
  assertAmount(cfg.t2MaxCents, 't2MaxCents');
  for (const [tier, rate] of Object.entries(cfg.ratesBps)) assertAmount(rate, `tarifa ${tier}`);
}

function assertGatewayRates(gateway: GatewayRates): void {
  assertAmount(gateway.pctBps, 'porcentaje de pasarela');
  assertAmount(gateway.fixedCents, 'fijo de pasarela');
}

/** División entera redondeando hacia arriba, sin coma flotante. */
function ceilDiv(dividend: number, divisor: number): number {
  return Number((BigInt(dividend) + BigInt(divisor) - 1n) / BigInt(divisor));
}

function safeProduct(a: number, b: number, label: string): number {
  return assertSafeCents(a * b, label);
}

/** Coste de Paycomet de un cobro: `round(importe × pct / 10000) + fijo`. */
export function gatewayChargeCostCents(amountCents: number, gateway: GatewayRates): number {
  assertGatewayRates(gateway);
  return bpsOf(assertAmount(amountCents, 'importe del cobro'), gateway.pctBps) + gateway.fixedCents;
}

/** Importe con el que se estiman los cobros de una campaña: el sugerido por la entidad, con un respaldo y un mínimo razonables. */
export function donationTicketRefCents(defaultDonationTicketCents: number): number {
  return Math.max(MIN_DONATION_TICKET_CENTS, assertAmount(defaultDonationTicketCents, 'importe sugerido') || FALLBACK_DONATION_TICKET_CENTS);
}

/** Tramos que aplican a una entidad: umbrales y modo siempre globales; tarifas propias solo con `customRules`. */
export function bracketConfigFor(
  rules: Pick<KorumGlobalRulesCents, 'bracketMode' | 't1MaxCents' | 't2MaxCents' | 't1Bps' | 't2Bps' | 't3Bps'>,
  organization?: { customRules: boolean; t1Bps: number; t2Bps: number; t3Bps: number }
): BracketConfig {
  const source = organization?.customRules ? organization : rules;
  return {
    mode: rules.bracketMode,
    t1MaxCents: rules.t1MaxCents,
    t2MaxCents: rules.t2MaxCents,
    ratesBps: { t1: source.t1Bps, t2: source.t2Bps, t3: source.t3Bps }
  };
}

/**
 * Comisión por tramos sobre la parte del neto que queda por encima de lo exento; lo exento ocupa siempre los primeros céntimos.
 * - `FLAT`: el tramo se elige por el neto total y se aplica a todo lo sujeto.
 * - `MARGINAL`: cada tramo grava solo su porción y se redondea una sola vez, así que la comisión crece de forma continua.
 * `rateBps` es la tarifa para la pizarra: en `MARGINAL`, la media ponderada de lo sujeto.
 * Umbrales cruzados (`t1MaxCents > t2MaxCents`): el tramo 2 queda vacío en los dos modos, nunca se cobra dos veces ni se bloquea
 * el Estudio; la consola lo avisa con `BRACKET_THRESHOLDS_INVALID`.
 */
export function calculateBracketFeeCents(netCents: number, exemptCents: number, cfg: BracketConfig): { rateBps: number; feeCents: number } {
  assertAmount(netCents, 'neto');
  assertAmount(exemptCents, 'exento');
  assertBracketConfig(cfg);
  const taxableFromCents = Math.min(netCents, exemptCents);
  const taxableCents = netCents - taxableFromCents;
  const { t1, t2, t3 } = cfg.ratesBps;
  const t2MaxCents = Math.max(cfg.t1MaxCents, cfg.t2MaxCents);

  if (cfg.mode === 'FLAT') {
    const rateBps = netCents <= cfg.t1MaxCents ? t1 : netCents <= t2MaxCents ? t2 : t3;
    return { rateBps, feeCents: bpsOf(taxableCents, rateBps) };
  }

  const slices: ReadonlyArray<readonly [fromCents: number, toCents: number, rateBps: number]> = [
    [0, cfg.t1MaxCents, t1],
    [cfg.t1MaxCents, t2MaxCents, t2],
    [t2MaxCents, Number.MAX_SAFE_INTEGER, t3]
  ];
  let weighted = 0n;
  for (const [fromCents, toCents, rateBps] of slices) {
    const overlapCents = Math.max(0, Math.min(netCents, toCents) - Math.max(taxableFromCents, fromCents));
    weighted += BigInt(overlapCents) * BigInt(rateBps);
  }
  const feeCents = assertSafeCents(Number((weighted + 5000n) / 10000n), 'comisión');
  // Sin nada sujeto, la pizarra muestra la tarifa del primer tramo: es la que empezaría a aplicarse.
  const rateBps = taxableCents > 0 ? Number((weighted * 2n + BigInt(taxableCents)) / (BigInt(taxableCents) * 2n)) : t1;
  return { rateBps, feeCents };
}

/**
 * Cuota de mantenimiento con tope anual («La Baza»): se cobra hasta llegar al tope y a partir de ahí es `0`, y la pizarra
 * muestra solo `0,00 €` (Regla 02 §2). Una campaña que llega justa al tope paga solo lo que falta.
 */
export function evaluateMaintenanceCapShutoff(config: MaintenanceConfig): {
  maintFeeCents: number;
  remainingToCapCents: number;
  remainingAfterCents: number;
  capReached: boolean;
} {
  assertAmount(config.perInitCents, 'mantenimiento por campaña');
  assertAmount(config.annualCapCents, 'tope anual de mantenimiento');
  assertAmount(config.alreadyChargedOrReservedCents, 'mantenimiento ya cobrado');
  const remainingToCapCents = Math.max(0, config.annualCapCents - config.alreadyChargedOrReservedCents);
  const maintFeeCents = config.active ? Math.min(config.perInitCents, remainingToCapCents) : 0;
  const remainingAfterCents = remainingToCapCents - maintFeeCents;
  return { maintFeeCents, remainingToCapCents, remainingAfterCents, capReached: remainingAfterCents === 0 };
}

/**
 * Pizarra del Estudio en modo `BUDGET`: las líneas cuadran siempre al céntimo con una meta en euros enteros
 * (`neto + comisión + mantenimiento + pasarela === meta`). Los céntimos del redondeo van a la pasarela (Regla 02 §1).
 */
export function calculateStudioBudgetTCO(input: BudgetTcoInputCents) {
  assertAmount(input.costMatCents, 'presupuesto de proveedor');
  assertAmount(input.costInstCents, 'coste de instalación');
  assertAmount(input.contingencyBps, 'porcentaje de contingencia');
  assertAmount(input.baseExemptRemainingCents, 'exento disponible');
  assertAmount(input.medalGrantAvailableCents, 'beca de medalla');
  assertGatewayRates(input.gatewayConfig);

  const baseExecutionCents = assertSafeCents(input.costMatCents + input.costInstCents, 'coste de ejecución');
  const contingencyCents = bpsOf(baseExecutionCents, input.contingencyBps);
  const netGuaranteedForSchoolCents = assertSafeCents(baseExecutionCents + contingencyCents, 'neto');

  let bracketRateBps = 0;
  let defaultExemptUsedCents = 0;
  let medalExemptUsedCents = 0;
  let medalSavedCents = 0;
  let bracketFeeCents = 0;

  if (!input.isCategoryExempt && netGuaranteedForSchoolCents > 0) {
    defaultExemptUsedCents = Math.min(netGuaranteedForSchoolCents, input.baseExemptRemainingCents);
    medalExemptUsedCents = Math.min(netGuaranteedForSchoolCents - defaultExemptUsedCents, input.medalGrantAvailableCents);
    const withMedal = calculateBracketFeeCents(netGuaranteedForSchoolCents, defaultExemptUsedCents + medalExemptUsedCents, input.bracketConfig);
    const withoutMedal = calculateBracketFeeCents(netGuaranteedForSchoolCents, defaultExemptUsedCents, input.bracketConfig);
    bracketRateBps = withMedal.rateBps;
    bracketFeeCents = withMedal.feeCents;
    medalSavedCents = withoutMedal.feeCents - withMedal.feeCents;
  }

  const taxableCents = input.isCategoryExempt ? 0 : netGuaranteedForSchoolCents - defaultExemptUsedCents - medalExemptUsedCents;
  const maintFeeCents = netGuaranteedForSchoolCents > 0 ? evaluateMaintenanceCapShutoff(input.maintConfig).maintFeeCents : 0;

  const subtotalBeforeGatewayCents = assertSafeCents(netGuaranteedForSchoolCents + bracketFeeCents + maintFeeCents, 'subtotal');
  const ticketRefCents = donationTicketRefCents(input.gatewayConfig.defaultDonationTicketCents);
  const estTransactions = subtotalBeforeGatewayCents > 0 ? ceilDiv(subtotalBeforeGatewayCents, ticketRefCents) : 0;
  const rawVariableGatewayCents = bpsOf(subtotalBeforeGatewayCents, input.gatewayConfig.pctBps);
  const rawFixedGatewayCents = safeProduct(estTransactions, input.gatewayConfig.fixedCents, 'fijo de pasarela');
  const rawGatewayFeeCents = rawVariableGatewayCents + rawFixedGatewayCents;

  const unroundedGoalCents = assertSafeCents(subtotalBeforeGatewayCents + rawGatewayFeeCents, 'meta');
  const finalGoalCents = safeProduct(ceilDiv(unroundedGoalCents, 100), 100, 'meta');
  const roundingBufferCents = finalGoalCents - unroundedGoalCents;

  return {
    baseExecutionCents,
    contingencyCents,
    netGuaranteedForSchoolCents,
    defaultExemptUsedCents,
    medalExemptUsedCents,
    medalSavedCents,
    taxableCents,
    bracketRateBps,
    bracketFeeCents,
    maintFeeCents,
    estTransactions,
    rawVariableGatewayCents,
    rawFixedGatewayCents,
    rawGatewayFeeCents,
    roundingBufferCents,
    gatewayFeeCents: rawGatewayFeeCents + roundingBufferCents,
    finalGoalCents
  };
}

/**
 * Pizarra del Estudio en modo `TICKETING`. En `ADD` los «Gastos de gestión digital» se suman al precio y Paycomet cobra sobre el
 * total del comprador (Regla 02 §6); en `INC` van dentro del precio, así que nunca se retiene más que el precio. Una entrada con
 * cobro 0 no pasa por Paycomet: no tiene coste ni margen. `isGatewayCovered` exige margen estrictamente positivo.
 * `maintShortfallCents` es la parte del mantenimiento que la recaudación no alcanza a cubrir, para que el neto a 0 no la esconda.
 */
export function calculateStudioTicketingTCO(input: {
  ticketPriceCents: number;
  ticketMax: number;
  feeMode: 'ADD' | 'INC';
  digitalFeeConfig: { fixedCents: number; pctBps: number };
  gatewayConfig: GatewayRates;
  maintFeeCents: number;
}) {
  assertAmount(input.ticketPriceCents, 'precio de la entrada');
  assertAmount(input.ticketMax, 'aforo');
  assertAmount(input.maintFeeCents, 'mantenimiento');
  assertGatewayRates(input.gatewayConfig);
  const configuredFeeCents =
    assertAmount(input.digitalFeeConfig.fixedCents, 'gasto digital fijo') + bpsOf(input.ticketPriceCents, assertAmount(input.digitalFeeConfig.pctBps, 'porcentaje de gasto digital'));
  const digitalFeeUnitCents = input.feeMode === 'ADD' ? configuredFeeCents : Math.min(configuredFeeCents, input.ticketPriceCents);
  const buyerUnitChargeCents = input.feeMode === 'ADD' ? input.ticketPriceCents + digitalFeeUnitCents : input.ticketPriceCents;
  const gatewayUnitCostCents = buyerUnitChargeCents > 0 ? gatewayChargeCostCents(buyerUnitChargeCents, input.gatewayConfig) : 0;
  const netKorumMarginPerTicketCents = digitalFeeUnitCents - gatewayUnitCostCents;

  const grossTicketsCents = safeProduct(input.ticketPriceCents, input.ticketMax, 'recaudación bruta');
  const totalDigitalFeesCents = safeProduct(digitalFeeUnitCents, input.ticketMax, 'gastos de gestión digital');
  const totalGatewayCostCents = safeProduct(gatewayUnitCostCents, input.ticketMax, 'coste de pasarela');
  const availableForSchoolCents = grossTicketsCents - (input.feeMode === 'ADD' ? 0 : totalDigitalFeesCents);

  return {
    digitalFeeUnitCents,
    buyerUnitChargeCents,
    gatewayUnitCostCents,
    netKorumMarginPerTicketCents,
    netKorumMarginAt100Cents: totalDigitalFeesCents - totalGatewayCostCents,
    grossTicketsCents,
    totalDigitalFeesCents,
    totalGatewayCostCents,
    netGuaranteedForSchoolCents: Math.max(0, availableForSchoolCents - input.maintFeeCents),
    maintShortfallCents: Math.max(0, input.maintFeeCents - availableForSchoolCents),
    isGatewayCovered: netKorumMarginPerTicketCents > 0
  };
}

/** El coste real supera la meta: las 4 líneas públicas no pueden cuadrar. Quien llama oculta el desglose y lo registra. */
export class PublicBreakdownMismatchError extends RangeError {
  constructor(realExecutionTotalCents: number, goalCents: number) {
    super(`El coste real (${realExecutionTotalCents}) supera la meta (${goalCents}): las 4 líneas no pueden cuadrar`);
    this.name = 'PublicBreakdownMismatchError';
  }
}

/** Las 4 líneas públicas suman exactamente la meta (Regla 02 §1). Nunca publica un desglose falso: si no cuadra, lanza. */
export function calculatePublicBreakdown4Lines(init: { costMatCents: number; costInstCents: number; contingencyBps: number; goalCents: number }) {
  const line1ProviderCents = assertAmount(init.costMatCents, 'presupuesto de proveedor');
  const line2InstallCents = assertAmount(init.costInstCents, 'coste de instalación');
  assertAmount(init.goalCents, 'meta');
  const line3ContingencyCents = bpsOf(line1ProviderCents + line2InstallCents, assertAmount(init.contingencyBps, 'porcentaje de contingencia'));
  const realExecutionTotalCents = line1ProviderCents + line2InstallCents + line3ContingencyCents;
  if (realExecutionTotalCents > init.goalCents) throw new PublicBreakdownMismatchError(realExecutionTotalCents, init.goalCents);
  return {
    line1ProviderCents,
    line2InstallCents,
    line3ContingencyCents,
    line4EscrowAndGuaranteeCents: init.goalCents - realExecutionTotalCents,
    realExecutionTotalCents,
    totalGoalCents: init.goalCents
  };
}
