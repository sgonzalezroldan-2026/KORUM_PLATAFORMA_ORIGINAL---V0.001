import type { InitiativeFormat, InitiativeStatus } from '@/types/korum.types';
import { analyzeInitiativeProfitabilityAndSelfBoost, REVENUE_SOURCE_KEYS, type RevenueSources } from './bi-analytics.service';
import { assertSafeCents } from './money';

/**
 * Agregación del BI de la consola (Sprint 5.1, Regla 02 §10). Funciones puras: la consulta a la base de datos vive en
 * `src/services/admin/bi-data.ts` y aquí solo hay aritmética entera sobre sus resultados, para poder fijar las cifras con pruebas.
 *
 * Dos vistas que nunca se mezclan:
 * - **Real**: lo ya cobrado, leído del libro mayor (`calculateRealRevenueFromLedger`).
 * - **Proyectada**: las campañas abiertas (`FUNDRAISING` y `GOAL_REACHED`) completadas al 100 %, con los datos observados.
 * Una campaña que no está abierta no proyecta nada: solo cuenta lo realmente cobrado.
 */

/** Campañas que aún pueden ingresar: lo que se proyecta al 100 % y lo que suman los KPIs de «meta activa» y «recaudado». */
export const BI_OPEN_STATUSES = ['FUNDRAISING', 'GOAL_REACHED'] as const satisfies readonly InitiativeStatus[];
/** Estados que cuentan como «terminadas» en el listado global (filtro «Solo terminadas»). */
export const BI_FINISHED_STATUSES = ['GOAL_REACHED', 'CLOSED'] as const satisfies readonly InitiativeStatus[];

export const isOpenInitiative = (status: InitiativeStatus): boolean => (BI_OPEN_STATUSES as readonly InitiativeStatus[]).includes(status);

/** Datos de una iniciativa tal como salen de la base de datos y del libro mayor (todo en céntimos enteros). */
export interface BiInitiativeFacts {
  id: number;
  walletEscrowId: string;
  title: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  province: string;
  status: InitiativeStatus;
  format: InitiativeFormat;
  quarter: string;
  closesAt: string;
  goalCents: number;
  raisedCents: number;
  totalContributions: number;
  /** Comisión y mantenimiento calculados al publicar: solo se cobran al liquidar. */
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  absorbsGatewayCostByKorum: boolean;
  /** Aportación voluntaria ya cobrada (libro mayor, neta de devoluciones) y la esperada al llegar al 100 %. */
  realizedGuaranteeCents: number;
  projectedGuaranteeAt100Cents: number;
  approvedSponsorsFeeCents: number;
  /** Margen de taquilla con el aforo completo y el ya vendido (libro mayor: gastos de gestión menos pasarela). Pueden ser negativos. */
  ticketMarginAt100Cents: number;
  ticketMarginRealizedCents: number;
  /** Margen neto real de las aportaciones mensuales de Mi Hucha de esta iniciativa. */
  huchaTopupNetCents: number;
  /**
   * Lo realmente asentado en el libro mayor para esta iniciativa (fuentes brutas y costes asumidos: pasarela neta de lo recuperado, Auto-Impulso y
   * contracargos). Es la fila de una campaña que ya no está abierta: no proyecta nada y lleva todos sus costes, también la pasarela de los cobros
   * devueltos, que KORUM no recupera.
   */
  settled: { sourcesCents: RevenueSources; costsCents: number };
}

export interface BiInitiativeRow {
  id: number;
  walletEscrowId: string;
  title: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  province: string;
  status: InitiativeStatus;
  format: InitiativeFormat;
  quarter: string;
  closesAt: string;
  goalCents: number;
  raisedCents: number;
  totalContributions: number;
  /** Avance en % entero (0–100). */
  progressPct: number;
  sourcesCents: RevenueSources;
  gatewayLossCents: number;
  /** Neto de KORUM al llegar al 100 % (lo ya cobrado en las campañas que no están abiertas). */
  netRevenueCents: number;
  /** El neto proyectado multiplicado por el avance. */
  weightedNetCents: number;
  collectedNetRevenueCents: number;
  missingTo100Cents: number;
  /**
   * «Retorno +Y €» del 💎: lo ya cobrado, más la comisión y el mantenimiento que se liquidan al completar la meta, sin el fee de patrocinio
   * ya cobrado (KORUM lo conserva aporte o no), menos lo que falta. Solo tiene sentido en campañas abiertas: la pantalla no lo muestra en el resto.
   */
  netProfitAfterBoostCents: number;
  isNegativeReturnAlert: boolean;
  isProfitableSelfBoost: boolean;
}

/** División entera con redondeo de la mitad hacia fuera de cero, sin coma flotante. */
function proportionalCents(valueCents: number, part: number, whole: number): number {
  if (whole <= 0 || part <= 0 || valueCents === 0) return 0;
  const numerator = BigInt(valueCents) * BigInt(Math.min(part, whole));
  const denominator = BigInt(whole);
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = Number((magnitude * 2n + denominator) / (denominator * 2n));
  return assertSafeCents(numerator < 0n ? -rounded : rounded, 'importe ponderado');
}

export function progressPercent(raisedCents: number, goalCents: number): number {
  if (goalCents <= 0) return 0;
  if (raisedCents >= goalCents) return 100;
  // Hacia abajo: un 99,5 % nunca se muestra como «100 %» con importe pendiente.
  return Math.floor((raisedCents * 100) / goalCents);
}

function rowIdentity(facts: BiInitiativeFacts) {
  return {
    id: facts.id,
    walletEscrowId: facts.walletEscrowId,
    title: facts.title,
    organizationId: facts.organizationId,
    organizationName: facts.organizationName,
    organizationSlug: facts.organizationSlug,
    province: facts.province,
    status: facts.status,
    format: facts.format,
    quarter: facts.quarter,
    closesAt: facts.closesAt,
    goalCents: facts.goalCents,
    raisedCents: facts.raisedCents,
    totalContributions: facts.totalContributions,
    progressPct: progressPercent(facts.raisedCents, facts.goalCents)
  };
}

/**
 * Fila de una campaña que ya no está abierta (cerrada, vencida, en votación, en devolución o devuelta): no proyecta nada, es lo realmente
 * asentado en su libro. Así una campaña devuelta lleva la pasarela que KORUM pagó y no recupera, y una cerrada que absorbía la pasarela, su pérdida.
 * Aquí el 💎 nunca salta (no está recaudando) y el 🚨 sí, si lo asentado es negativo.
 */
function buildSettledRow(facts: BiInitiativeFacts): BiInitiativeRow {
  const { sourcesCents, costsCents } = facts.settled;
  const sourcesTotalCents = REVENUE_SOURCE_KEYS.reduce((total, key) => total + sourcesCents[key], 0);
  const netRevenueCents = assertSafeCents(sourcesTotalCents - costsCents, 'ingreso neto asentado');
  const missingTo100Cents = Math.max(0, facts.goalCents - facts.raisedCents);
  return {
    ...rowIdentity(facts),
    sourcesCents,
    gatewayLossCents: costsCents,
    netRevenueCents,
    weightedNetCents: proportionalCents(netRevenueCents, facts.raisedCents, facts.goalCents),
    collectedNetRevenueCents: netRevenueCents,
    missingTo100Cents,
    netProfitAfterBoostCents: netRevenueCents - missingTo100Cents,
    isNegativeReturnAlert: netRevenueCents < 0,
    isProfitableSelfBoost: false
  };
}

/**
 * Fila del BI de una iniciativa abierta: proyectada al 100 % con comisión, mantenimiento, pasarela absorbida y aportación voluntaria esperada.
 * Las que no están abiertas pasan por `buildSettledRow`.
 */
export function buildBiInitiativeRow(facts: BiInitiativeFacts): BiInitiativeRow {
  if (!isOpenInitiative(facts.status)) return buildSettledRow(facts);
  const analysis = analyzeInitiativeProfitabilityAndSelfBoost({
    format: facts.format,
    status: facts.status,
    goalCents: facts.goalCents,
    raisedCents: facts.raisedCents,
    bracketFeeCents: facts.bracketFeeCents,
    maintFeeCents: facts.maintFeeCents,
    gatewayFeeCents: facts.gatewayFeeCents,
    absorbsGatewayCostByKorum: facts.absorbsGatewayCostByKorum,
    realizedGuaranteeContributionsCents: facts.realizedGuaranteeCents,
    projectedGuaranteeContributionsAt100Cents: Math.max(facts.projectedGuaranteeAt100Cents, facts.realizedGuaranteeCents),
    approvedSponsorsFeeCents: facts.approvedSponsorsFeeCents,
    netDigitalTicketMarginAt100Cents: facts.ticketMarginAt100Cents,
    netDigitalTicketMarginRealizedCents: facts.ticketMarginRealizedCents,
    allocatedHuchaTopupNetCents: facts.huchaTopupNetCents
  });
  return {
    ...rowIdentity(facts),
    sourcesCents: analysis.sourcesCents,
    gatewayLossCents: analysis.gatewayLossCents,
    netRevenueCents: analysis.netRevenueCents,
    weightedNetCents: proportionalCents(analysis.netRevenueCents, facts.raisedCents, facts.goalCents),
    collectedNetRevenueCents: analysis.collectedNetRevenueCents,
    missingTo100Cents: analysis.missingTo100Cents,
    netProfitAfterBoostCents: analysis.netProfitAfterBoostCents,
    isNegativeReturnAlert: analysis.isNegativeReturnAlert,
    isProfitableSelfBoost: analysis.isProfitableSelfBoost
  };
}

export interface BiOrganizationFacts {
  id: string;
  slug: string;
  name: string;
  province: string;
  health: 'OK' | 'CALL';
  /** 0 = sin medalla; 1 Bronce, 2 Plata, 3 Oro. */
  medalRank: number;
  completedThisYear: number;
  completedHistorical: number;
  activeSponsorsCount: number;
  historicalSponsorsCount: number;
}

export interface BiOrganizationRow extends BiOrganizationFacts {
  openCount: number;
  potentialGoalCents: number;
  currentRaisedCents: number;
  expectedNetCents: number;
  weightedNetCents: number;
}

/** Una fila por entidad con lo que tiene abierto. `rows` son las iniciativas ya filtradas. */
export function buildBiOrganizationRows(organizations: readonly BiOrganizationFacts[], rows: readonly BiInitiativeRow[]): BiOrganizationRow[] {
  return organizations.map((organization) => {
    const open = rows.filter((row) => row.organizationId === organization.id && isOpenInitiative(row.status));
    return {
      ...organization,
      openCount: open.length,
      potentialGoalCents: sum(open, (row) => row.goalCents),
      currentRaisedCents: sum(open, (row) => row.raisedCents),
      expectedNetCents: sum(open, (row) => row.netRevenueCents),
      weightedNetCents: sum(open, (row) => row.weightedNetCents)
    };
  });
}

/** Suma entera segura de una columna de céntimos. */
export function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return assertSafeCents(
    items.reduce((total, item) => total + pick(item), 0),
    'suma del BI'
  );
}
