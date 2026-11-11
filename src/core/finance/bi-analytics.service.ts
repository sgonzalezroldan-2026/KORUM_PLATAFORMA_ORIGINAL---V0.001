import type { LedgerAccount } from '@/generated/prisma/enums';
import type { InitiativeFormat, InitiativeStatus } from '@/types/korum.types';
import { assertSafeCents } from './money';
import { donationTicketRefCents } from './tco.service';

/**
 * Analítica de ingresos de KORUM, real frente a proyectada (Regla 02 §10; skill korum-tco-calculator §5). Funciones puras:
 * lo real llega de los saldos del libro mayor y lo proyectado solo usa datos observados. Sin constantes inventadas: si no hay
 * ningún dato para proyectar, la proyección es `0`.
 * Invariante de las dos vistas: `Σ 6 fuentes − costes === netRevenueCents`, al céntimo.
 */

export const REVENUE_SOURCE_KEYS = ['bracketFeeCents', 'supportGuaranteeCents', 'sponsorFeeCents', 'digitalTicketFeeCents', 'maintFeeCents', 'huchaTopupFeeCents'] as const;
export type RevenueSourceKey = (typeof REVENUE_SOURCE_KEYS)[number];
export type RevenueSources = Record<RevenueSourceKey, number>;

function assertAmount(value: number, label: string): number {
  assertSafeCents(value, label);
  if (value < 0) throw new RangeError(`El ${label} no puede ser negativo, recibido: ${value}`);
  return value;
}

function sumSources(sources: RevenueSources): number {
  return assertSafeCents(
    REVENUE_SOURCE_KEYS.reduce((total, key) => total + sources[key], 0),
    'total de fuentes'
  );
}

/** División entera redondeando la mitad hacia arriba, sin coma flotante. */
function roundDiv(numerator: bigint, denominator: bigint): number {
  return assertSafeCents(Number((numerator * 2n + denominator) / (denominator * 2n)), 'proyección');
}

/** Aportaciones de donación observadas: el check va desmarcado por defecto, así que solo vale la tasa real. */
export interface GuaranteeSample {
  /** Donaciones completadas (el check de la aportación voluntaria solo se ofrece en ellas). */
  contributions: number;
  /** De ellas, las que marcaron la aportación voluntaria (`guaranteeContributionCents > 0`). */
  contributionsWithGuarantee: number;
  guaranteeCents: number;
}

/** Tasa real de activación en puntos básicos (`3000` = 30 %). `0` sin datos. */
export function guaranteeActivationBps(sample: GuaranteeSample): number {
  assertAmount(sample.contributions, 'número de aportaciones');
  assertAmount(sample.contributionsWithGuarantee, 'número de aportaciones con garantía');
  if (sample.contributionsWithGuarantee > sample.contributions) {
    throw new RangeError(`Hay más aportaciones con garantía (${sample.contributionsWithGuarantee}) que aportaciones (${sample.contributions})`);
  }
  assertAmount(sample.guaranteeCents, 'garantía observada');
  if ((sample.contributionsWithGuarantee === 0) !== (sample.guaranteeCents === 0)) {
    throw new RangeError(`Muestra incoherente: ${sample.contributionsWithGuarantee} aportaciones con garantía suman ${sample.guaranteeCents} céntimos`);
  }
  return sample.contributions === 0 ? 0 : roundDiv(BigInt(sample.contributionsWithGuarantee) * 10000n, BigInt(sample.contributions));
}

/**
 * Aportación voluntaria esperada al llegar al 100 %: lo ya cobrado más lo que aportarían las donaciones que faltan, según lo
 * observado en la propia entidad o, si aún no tiene datos, en la plataforma. El número de donaciones que faltan se estima con
 * la donación media de la iniciativa, sin patrocinios, bolsa Matching ni Auto-Impulso (o con el importe sugerido, si no tiene ninguna).
 */
export function projectGuaranteeContributionsAt100(input: {
  goalCents: number;
  raisedCents: number;
  /** Donaciones completadas de la iniciativa y su importe: solo ellas ofrecen la aportación voluntaria. */
  donationsCount: number;
  donationsCents: number;
  realizedGuaranteeCents: number;
  defaultDonationTicketCents: number;
  entitySample: GuaranteeSample;
  platformSample: GuaranteeSample;
}): { projectedCents: number; remainingContributions: number; activationBps: number; basedOn: 'ENTITY' | 'PLATFORM' | 'NONE' } {
  assertAmount(input.goalCents, 'meta');
  assertAmount(input.raisedCents, 'recaudado');
  assertAmount(input.donationsCount, 'número de donaciones');
  assertAmount(input.donationsCents, 'importe de las donaciones');
  assertAmount(input.realizedGuaranteeCents, 'garantía cobrada');

  const basedOn = input.entitySample.contributions > 0 ? 'ENTITY' : input.platformSample.contributions > 0 ? 'PLATFORM' : 'NONE';
  const sample = basedOn === 'PLATFORM' ? input.platformSample : input.entitySample;
  const activationBps = guaranteeActivationBps(sample);
  if (basedOn === 'NONE') return { projectedCents: input.realizedGuaranteeCents, remainingContributions: 0, activationBps: 0, basedOn };

  const missingCents = BigInt(Math.max(0, input.goalCents - input.raisedCents));
  const hasAverage = input.donationsCount > 0 && input.donationsCents > 0;
  // Con media: faltante ÷ (importe ÷ nº) = faltante × nº ÷ importe. Hacia arriba: una fracción de aportación es una aportación.
  const numerator = hasAverage ? missingCents * BigInt(input.donationsCount) : missingCents;
  const divisor = BigInt(hasAverage ? input.donationsCents : donationTicketRefCents(input.defaultDonationTicketCents));
  const remainingContributions = assertSafeCents(Number((numerator + divisor - 1n) / divisor), 'aportaciones que faltan');
  // Por aportación: garantía observada ÷ nº de aportaciones = tasa de activación × importe medio de quienes la marcan.
  const projectedRemainingCents = roundDiv(BigInt(remainingContributions) * BigInt(sample.guaranteeCents), BigInt(sample.contributions));
  return { projectedCents: assertSafeCents(input.realizedGuaranteeCents + projectedRemainingCents, 'proyección'), remainingContributions, activationBps, basedOn };
}

export interface InitiativeRevenueInput {
  format: InitiativeFormat;
  bracketFeeCents: number;
  maintFeeCents: number;
  /** Pasarela estimada de la iniciativa: solo es pérdida si KORUM la absorbe. */
  gatewayFeeCents: number;
  absorbsGatewayCostByKorum: boolean;
  realizedGuaranteeContributionsCents: number;
  projectedGuaranteeContributionsAt100Cents: number;
  approvedSponsorsFeeCents: number;
  /** Margen de taquilla con el aforo completo; puede ser negativo. Usa `netKorumMarginAt100Cents` del motor TCO. */
  netDigitalTicketMarginAt100Cents: number;
  /** Margen neto real de los cargos de Mi Hucha atribuidos a esta iniciativa. */
  allocatedHuchaTopupNetCents: number;
}

/**
 * Las 6 fuentes de una iniciativa proyectadas al 100 %, y el neto: `Σ fuentes − gatewayLossCents`. Lo ya cobrado nunca se
 * pierde: una iniciativa que absorbe la pasarela o de taquilla no proyecta aportación voluntaria, pero sí conserva la real.
 */
export function calculateRevenueBreakdown6Sources(input: InitiativeRevenueInput): {
  sourcesCents: RevenueSources;
  sourcesTotalCents: number;
  gatewayLossCents: number;
  netRevenueCents: number;
} {
  assertAmount(input.bracketFeeCents, 'comisión por tramos');
  assertAmount(input.maintFeeCents, 'mantenimiento');
  assertAmount(input.gatewayFeeCents, 'coste de pasarela');
  assertAmount(input.realizedGuaranteeContributionsCents, 'garantía cobrada');
  assertAmount(input.projectedGuaranteeContributionsAt100Cents, 'garantía proyectada');
  assertAmount(input.approvedSponsorsFeeCents, 'fee de patrocinios');
  assertSafeCents(input.netDigitalTicketMarginAt100Cents, 'margen de taquilla');
  assertSafeCents(input.allocatedHuchaTopupNetCents, 'margen de Mi Hucha');

  const isBudget = input.format === 'BUDGET';
  const projectsGuarantee = isBudget && !input.absorbsGatewayCostByKorum;
  const ticketMarginCents = isBudget ? 0 : input.netDigitalTicketMarginAt100Cents;

  const sourcesCents: RevenueSources = {
    bracketFeeCents: isBudget ? input.bracketFeeCents : 0,
    supportGuaranteeCents: Math.max(input.realizedGuaranteeContributionsCents, projectsGuarantee ? input.projectedGuaranteeContributionsAt100Cents : 0),
    sponsorFeeCents: input.approvedSponsorsFeeCents,
    digitalTicketFeeCents: Math.max(0, ticketMarginCents),
    maintFeeCents: input.maintFeeCents,
    huchaTopupFeeCents: input.allocatedHuchaTopupNetCents
  };
  // El margen de taquilla ya descuenta la pasarela: «absorber» solo añade pérdida en las campañas de presupuesto.
  const gatewayLossCents = ticketMarginCents < 0 ? -ticketMarginCents : isBudget && input.absorbsGatewayCostByKorum ? input.gatewayFeeCents : 0;
  const sourcesTotalCents = sumSources(sourcesCents);
  return { sourcesCents, sourcesTotalCents, gatewayLossCents, netRevenueCents: assertSafeCents(sourcesTotalCents - gatewayLossCents, 'ingreso neto') };
}

/**
 * Rentabilidad al 100 % y alertas de cada tabla (Regla 02 §10):
 * 🚨 `isNegativeReturnAlert` si el neto al 100 % es negativo; 💎 `isProfitableSelfBoost` si está recaudando y a KORUM le compensa aportar lo que falta.
 * El 💎 lleva a gastar dinero real, así que no cuenta nada proyectado (decisión del promotor): si KORUM completa la meta, las aportaciones
 * voluntarias y las entradas que faltaban ya no llegarán. `collectedNetRevenueCents` es lo ya cobrado más la comisión de tramos y el
 * mantenimiento, que aún no se han cobrado pero se liquidan precisamente al completar la meta, y **sin el fee de patrocinio**: KORUM
 * lo conserva aporte o no (Regla 02 §5), así que no es un retorno que provoque el Auto-Impulso.
 */
export function analyzeInitiativeProfitabilityAndSelfBoost(
  input: InitiativeRevenueInput & {
    status: InitiativeStatus;
    goalCents: number;
    raisedCents: number;
    /** Margen de las entradas ya vendidas: margen por entrada × vendidas. */
    netDigitalTicketMarginRealizedCents: number;
  }
) {
  assertAmount(input.goalCents, 'meta');
  assertAmount(input.raisedCents, 'recaudado');
  const breakdown = calculateRevenueBreakdown6Sources(input);
  const missingTo100Cents = Math.max(0, input.goalCents - input.raisedCents);
  // El fee de patrocinio ya cobrado tampoco cuenta (decisión del promotor, 2026-11-11): KORUM lo conserva aporte o no, así que no es ganancia del Auto-Impulso.
  const collected = calculateRevenueBreakdown6Sources({
    ...input,
    projectedGuaranteeContributionsAt100Cents: 0,
    netDigitalTicketMarginAt100Cents: input.netDigitalTicketMarginRealizedCents,
    approvedSponsorsFeeCents: 0
  });
  const netProfitAfterBoostCents = collected.netRevenueCents - missingTo100Cents;
  return {
    ...breakdown,
    collectedNetRevenueCents: collected.netRevenueCents,
    missingTo100Cents,
    netProfitAfterBoostCents,
    isNegativeReturnAlert: breakdown.netRevenueCents < 0,
    isProfitableSelfBoost: input.status === 'FUNDRAISING' && missingTo100Cents > 0 && netProfitAfterBoostCents > 0
  };
}

const SOURCE_ACCOUNT: Record<RevenueSourceKey, LedgerAccount> = {
  bracketFeeCents: 'KORUM_REVENUE_BRACKET',
  supportGuaranteeCents: 'KORUM_REVENUE_GUARANTEE',
  sponsorFeeCents: 'KORUM_REVENUE_SPONSOR_FEE',
  digitalTicketFeeCents: 'KORUM_REVENUE_TICKET_FEE',
  maintFeeCents: 'KORUM_REVENUE_MAINTENANCE',
  huchaTopupFeeCents: 'KORUM_REVENUE_TOPUP_FEE'
};

/**
 * Ingresos reales a partir de los saldos del libro mayor (`getBalancesByAccount`, por plataforma o por entidad). Aquí las
 * fuentes son brutas y los costes van aparte: pasarela neta de lo recuperado, Auto-Impulso y contracargos asumidos.
 */
export function calculateRealRevenueFromLedger(balances: ReadonlyArray<{ account: LedgerAccount; balanceCents: number }>): {
  sourcesCents: RevenueSources;
  sourcesTotalCents: number;
  gatewayNetCostCents: number;
  autoBoostExpenseCents: number;
  chargebackLossesCents: number;
  netRevenueCents: number;
} {
  const balanceOf = (account: LedgerAccount) => assertSafeCents(balances.find((row) => row.account === account)?.balanceCents ?? 0, `saldo de ${account}`);
  const sourcesCents = Object.fromEntries(REVENUE_SOURCE_KEYS.map((key) => [key, balanceOf(SOURCE_ACCOUNT[key])])) as RevenueSources;
  const sourcesTotalCents = sumSources(sourcesCents);
  const gatewayNetCostCents = balanceOf('GATEWAY_FEES_EXPENSE') - balanceOf('GATEWAY_FEES_RECOVERED');
  const autoBoostExpenseCents = balanceOf('AUTO_BOOST_EXPENSE');
  const chargebackLossesCents = balanceOf('CHARGEBACK_LOSSES');
  return {
    sourcesCents,
    sourcesTotalCents,
    gatewayNetCostCents,
    autoBoostExpenseCents,
    chargebackLossesCents,
    netRevenueCents: assertSafeCents(sourcesTotalCents - gatewayNetCostCents - autoBoostExpenseCents - chargebackLossesCents, 'ingreso neto real')
  };
}

/** Totales de varias iniciativas para el gráfico de 6 fuentes: suma exactamente lo mismo que las filas de la tabla. */
export function sumRevenueBreakdowns(rows: ReadonlyArray<{ sourcesCents: RevenueSources; gatewayLossCents: number }>): {
  sourcesCents: RevenueSources;
  sourcesTotalCents: number;
  gatewayLossCents: number;
  netRevenueCents: number;
} {
  const sourcesCents = Object.fromEntries(REVENUE_SOURCE_KEYS.map((key) => [key, rows.reduce((total, row) => total + row.sourcesCents[key], 0)])) as RevenueSources;
  const sourcesTotalCents = sumSources(sourcesCents);
  const gatewayLossCents = assertSafeCents(
    rows.reduce((total, row) => total + row.gatewayLossCents, 0),
    'pérdida de pasarela'
  );
  return { sourcesCents, sourcesTotalCents, gatewayLossCents, netRevenueCents: sourcesTotalCents - gatewayLossCents };
}
