import { z } from 'zod';
import { type BiInitiativeRow, type BiOrganizationRow, buildBiInitiativeRow, buildBiOrganizationRows } from '@/core/finance/bi-aggregate';
import { type BiFilters, type BiProjection, type BiQuarterForecast, type BiRealRevenue, filterInitiatives, filterOrganizations, forecastByQuarter, summarizeProjection, sumRealRevenues } from '@/core/finance/bi-summary';
import { calculateRealRevenueFromLedger } from '@/core/finance/bi-analytics.service';
import type { Db } from '@/lib/db';
import { loadBiFacts, loadGlobalRules } from './bi-facts';

/**
 * Vista de negocio de la consola (Sprint 5.1): lo real (libro mayor) y lo proyectado (campañas abiertas al 100 %) siempre por separado, con
 * los filtros de provincia, entidad, estado de acompañamiento y trimestre. Quien llama ya pasó `authorizeSuperadmin`.
 */

export interface BiSnapshot {
  filters: BiFilters;
  options: {
    provinces: string[];
    organizations: Array<{ id: string; name: string; province: string }>;
    quarters: string[];
  };
  /** Hay más iniciativas de las que lee la vista (`BI_MAX_INITIATIVES`): las más antiguas no aparecen. */
  truncated: boolean;
  organizations: BiOrganizationRow[];
  initiatives: BiInitiativeRow[];
  projection: BiProjection;
  forecast: BiQuarterForecast[];
  /** Todo lo cobrado hasta hoy por las entidades elegidas: no depende del trimestre. */
  real: BiRealRevenue;
}

const filterSchemas = {
  province: z.string().trim().min(1).max(80),
  organizationId: z.string().trim().min(1).max(80),
  health: z.enum(['OK', 'CALL']),
  quarter: z.string().trim().regex(/^\d{4}-Q[1-4]$/)
};

/** Filtros de la dirección web: lo que no entiende se ignora, cada uno por separado (un enlace antiguo nunca rompe la página). */
export function parseBiFilters(searchParams: Record<string, string | string[] | undefined>): BiFilters {
  const first = (key: string) => {
    const value = searchParams[key];
    return (Array.isArray(value) ? value[0] : value) || undefined;
  };
  const filters: BiFilters = {};
  const province = filterSchemas.province.safeParse(first('provincia'));
  if (province.success) filters.province = province.data;
  const organizationId = filterSchemas.organizationId.safeParse(first('entidad'));
  if (organizationId.success) filters.organizationId = organizationId.data;
  const health = filterSchemas.health.safeParse(first('estado'));
  if (health.success) filters.health = health.data;
  const quarter = filterSchemas.quarter.safeParse(first('trimestre'));
  if (quarter.success) filters.quarter = quarter.data;
  return filters;
}

export async function loadBiSnapshot(db: Db, filters: BiFilters): Promise<BiSnapshot> {
  const rules = await loadGlobalRules(db);
  const facts = await loadBiFacts(db, rules);
  const allRows = facts.initiatives.map(buildBiInitiativeRow);

  const organizations = filterOrganizations(facts.organizations, filters);
  const organizationIds = new Set(organizations.map((organization) => organization.id));
  const rows = filterInitiatives(allRows, organizationIds, filters);

  const real = sumRealRevenues(organizations.map((organization) => calculateRealRevenueFromLedger(facts.ledgerBalancesByOrganization.get(organization.id) ?? [])));

  return {
    filters,
    options: {
      provinces: [...new Set(facts.organizations.map((organization) => organization.province))].sort((a, b) => a.localeCompare(b)),
      organizations: facts.organizations.map(({ id, name, province }) => ({ id, name, province })),
      quarters: [...new Set(allRows.map((row) => row.quarter))].sort()
    },
    truncated: facts.truncated,
    organizations: buildBiOrganizationRows(organizations, rows),
    initiatives: rows,
    projection: summarizeProjection(rows),
    forecast: forecastByQuarter(rows),
    real
  };
}
