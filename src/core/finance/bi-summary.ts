import type { InitiativeStatus } from '@/types/korum.types';
import { BI_FINISHED_STATUSES, isOpenInitiative, progressPercent, sum, type BiInitiativeRow, type BiOrganizationFacts } from './bi-aggregate';
import { REVENUE_SOURCE_KEYS, sumRevenueBreakdowns, type RevenueSources } from './bi-analytics.service';
import { assertSafeCents } from './money';

/**
 * Vistas agregadas del BI de la consola (Sprint 5.1): proyección al 100 % de las campañas abiertas, previsión por trimestre, filtros y suma de los
 * ingresos reales por entidad. Siguen a las filas de `bi-aggregate.ts` y también son funciones puras de aritmética entera.
 */

export interface BiKpis {
  potentialGoalCents: number;
  raisedCents: number;
  expectedNetCents: number;
  weightedNetCents: number;
  /** Avance medio de la red en % entero: recaudado ÷ meta de las campañas abiertas. */
  averageProgressPct: number;
}

export interface BiProjection {
  kpis: BiKpis;
  sourcesCents: RevenueSources;
  sourcesTotalCents: number;
  gatewayLossCents: number;
  /** Auto-Impulso y contracargos ya asentados en las campañas abiertas: un coste ya gastado, aparte de la pasarela. */
  sunkCostsCents: number;
  netRevenueCents: number;
}

/** Proyección al 100 % de las campañas abiertas: los KPIs y las 6 fuentes salen de las mismas filas, así que suman lo mismo. */
export function summarizeProjection(rows: readonly BiInitiativeRow[]): BiProjection {
  const open = rows.filter((row) => isOpenInitiative(row.status));
  const totals = sumRevenueBreakdowns(open);
  const potentialGoalCents = sum(open, (row) => row.goalCents);
  const raisedCents = sum(open, (row) => row.raisedCents);
  const sunkCostsCents = sum(open, (row) => row.sunkCostsCents);
  const netRevenueCents = assertSafeCents(totals.netRevenueCents - sunkCostsCents, 'ingreso neto proyectado');
  return {
    kpis: {
      potentialGoalCents,
      raisedCents,
      expectedNetCents: netRevenueCents,
      weightedNetCents: sum(open, (row) => row.weightedNetCents),
      averageProgressPct: progressPercent(raisedCents, potentialGoalCents)
    },
    sourcesCents: totals.sourcesCents,
    sourcesTotalCents: totals.sourcesTotalCents,
    gatewayLossCents: totals.gatewayLossCents,
    sunkCostsCents,
    netRevenueCents
  };
}

export interface BiQuarterForecast {
  quarter: string;
  count: number;
  goalCents: number;
  unweightedNetCents: number;
  weightedNetCents: number;
}

/** Previsión de cierres por trimestre, de las campañas abiertas y por orden cronológico del código (`2026-Q4` antes que `2027-Q1`). */
export function forecastByQuarter(rows: readonly BiInitiativeRow[]): BiQuarterForecast[] {
  const open = rows.filter((row) => isOpenInitiative(row.status));
  return [...new Set(open.map((row) => row.quarter))].sort().map((quarter) => {
    const inQuarter = open.filter((row) => row.quarter === quarter);
    return {
      quarter,
      count: inQuarter.length,
      goalCents: sum(inQuarter, (row) => row.goalCents),
      unweightedNetCents: sum(inQuarter, (row) => row.netRevenueCents),
      weightedNetCents: sum(inQuarter, (row) => row.weightedNetCents)
    };
  });
}

export type BiStatusFilter = 'ALL' | 'ACTIVE' | 'FINISHED';

export interface BiFilters {
  province?: string;
  organizationId?: string;
  health?: 'OK' | 'CALL';
  quarter?: string;
  /** Solo para el listado global. */
  status?: BiStatusFilter;
}

export function filterOrganizations<T extends Pick<BiOrganizationFacts, 'id' | 'province' | 'health'>>(organizations: readonly T[], filters: BiFilters): T[] {
  return organizations.filter(
    (organization) =>
      (!filters.province || organization.province === filters.province) && (!filters.organizationId || organization.id === filters.organizationId) && (!filters.health || organization.health === filters.health)
  );
}

/** Iniciativas de las entidades que pasan el filtro (provincia, entidad, estado de acompañamiento) y del trimestre elegido. */
export function filterInitiatives(rows: readonly BiInitiativeRow[], organizationIds: ReadonlySet<string>, filters: BiFilters): BiInitiativeRow[] {
  return rows.filter((row) => organizationIds.has(row.organizationId) && (!filters.quarter || row.quarter === filters.quarter));
}

/** Filtro de estado del listado global: «Solo activas» (recaudando) o «Solo terminadas» (logro conseguido y cerradas). */
export function filterByStatus(rows: readonly BiInitiativeRow[], status: BiStatusFilter | undefined): BiInitiativeRow[] {
  if (status === 'ACTIVE') return rows.filter((row) => row.status === 'FUNDRAISING');
  if (status === 'FINISHED') return rows.filter((row) => (BI_FINISHED_STATUSES as readonly InitiativeStatus[]).includes(row.status));
  return [...rows];
}

export interface BiRealRevenue {
  sourcesCents: RevenueSources;
  sourcesTotalCents: number;
  gatewayNetCostCents: number;
  autoBoostExpenseCents: number;
  chargebackLossesCents: number;
  netRevenueCents: number;
}

type RealRevenueParts = Omit<BiRealRevenue, 'sourcesTotalCents' | 'netRevenueCents'> & Partial<Pick<BiRealRevenue, 'sourcesTotalCents' | 'netRevenueCents'>>;

/** Suma los ingresos reales de varias entidades; el neto sale de la misma identidad que el de cada una (`Σ fuentes − costes`). */
export function sumRealRevenues(parts: readonly RealRevenueParts[]): BiRealRevenue {
  const sourcesCents = Object.fromEntries(REVENUE_SOURCE_KEYS.map((key) => [key, parts.reduce((total, part) => total + part.sourcesCents[key], 0)])) as RevenueSources;
  const sourcesTotalCents = assertSafeCents(
    REVENUE_SOURCE_KEYS.reduce((total, key) => total + sourcesCents[key], 0),
    'total de fuentes reales'
  );
  const gatewayNetCostCents = sum(parts, (part) => part.gatewayNetCostCents);
  const autoBoostExpenseCents = sum(parts, (part) => part.autoBoostExpenseCents);
  const chargebackLossesCents = sum(parts, (part) => part.chargebackLossesCents);
  return { sourcesCents, sourcesTotalCents, gatewayNetCostCents, autoBoostExpenseCents, chargebackLossesCents, netRevenueCents: sourcesTotalCents - gatewayNetCostCents - autoBoostExpenseCents - chargebackLossesCents };
}
