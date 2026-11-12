import { describe, expect, it } from 'vitest';
import { type BiInitiativeFacts, type BiOrganizationFacts, buildBiInitiativeRow, buildBiOrganizationRows, progressPercent } from '@/core/finance/bi-aggregate';
import { filterByStatus, filterInitiatives, filterOrganizations, forecastByQuarter, summarizeProjection, sumRealRevenues } from '@/core/finance/bi-summary';
import { REVENUE_SOURCE_KEYS } from '@/core/finance/bi-analytics.service';
import type { InitiativeStatus } from '@/types/korum.types';

const facts = (overrides: Partial<BiInitiativeFacts> = {}): BiInitiativeFacts => ({
  id: 1,
  walletEscrowId: 'WLT-ESC-001',
  title: 'Patio cubierto',
  organizationId: 'ORG-A',
  organizationName: 'CEIP A',
  organizationSlug: 'ceip-a',
  province: 'Barcelona',
  status: 'FUNDRAISING',
  format: 'BUDGET',
  quarter: '2026-Q4',
  closesAt: '2026-12-15T10:00:00.000Z',
  goalCents: 100_000,
  raisedCents: 50_000,
  totalContributions: 12,
  bracketFeeCents: 4_000,
  maintFeeCents: 0,
  gatewayFeeCents: 1_500,
  absorbsGatewayCostByKorum: false,
  realizedGuaranteeCents: 300,
  projectedGuaranteeAt100Cents: 900,
  approvedSponsorsFeeCents: 3_750,
  ticketMarginAt100Cents: 0,
  ticketMarginRealizedCents: 0,
  huchaTopupNetCents: 0,
  settled: { sourcesCents: { bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 }, costsCents: 0 },
  ...overrides
});

describe('QA-A01 · fila del BI de una iniciativa', () => {
  it('una campaña abierta proyecta tramos, mantenimiento y aportación voluntaria al 100 %', () => {
    const row = buildBiInitiativeRow(facts({ maintFeeCents: 4_900 }));
    expect(row.sourcesCents).toEqual({ bracketFeeCents: 4_000, supportGuaranteeCents: 900, sponsorFeeCents: 3_750, digitalTicketFeeCents: 0, maintFeeCents: 4_900, huchaTopupFeeCents: 0 });
    expect(row.netRevenueCents).toBe(4_000 + 900 + 3_750 + 4_900);
    expect(row.progressPct).toBe(50);
    // Ponderado: el neto por el avance (50 %), redondeado al céntimo.
    expect(row.weightedNetCents).toBe(Math.round((13_550 * 50_000) / 100_000));
  });

  const settledSources = { ...{ bracketFeeCents: 4_000, supportGuaranteeCents: 300, sponsorFeeCents: 3_750, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 } };

  it('una campaña cerrada es lo asentado en su libro: fuentes menos costes, sin proyectar nada (ni la comisión ni la pasarela del plan)', () => {
    const row = buildBiInitiativeRow(facts({ status: 'CLOSED', raisedCents: 100_000, projectedGuaranteeAt100Cents: 9_999, bracketFeeCents: 99_999, settled: { sourcesCents: settledSources, costsCents: 120 } }));
    expect(row.sourcesCents).toEqual(settledSources);
    expect(row.gatewayLossCents).toBe(120);
    expect(row.netRevenueCents).toBe(4_000 + 300 + 3_750 - 120);
    expect(row.collectedNetRevenueCents).toBe(row.netRevenueCents);
    expect(row.isProfitableSelfBoost).toBe(false);
  });

  it.each<InitiativeStatus>(['EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED'])('una campaña %s no proyecta nada: lleva lo asentado, incluida la pasarela que KORUM pagó y no recupera', (status) => {
    const row = buildBiInitiativeRow(facts({ status, maintFeeCents: 4_900, absorbsGatewayCostByKorum: true, projectedGuaranteeAt100Cents: 9_999, settled: { sourcesCents: { ...settledSources, bracketFeeCents: 0, sponsorFeeCents: 0 }, costsCents: 331 } }));
    expect(row.sourcesCents.bracketFeeCents).toBe(0);
    expect(row.sourcesCents.maintFeeCents).toBe(0);
    expect(row.sourcesCents.supportGuaranteeCents).toBe(300);
    expect(row.gatewayLossCents).toBe(331);
    expect(row.netRevenueCents).toBe(-31);
    expect(row.isNegativeReturnAlert).toBe(true);
    expect(row.isProfitableSelfBoost).toBe(false);
  });

  it('una campaña abierta con fee de patrocinio: el neto lo incluye y el retorno del 💎 no (el fee se conserva aporte o no)', () => {
    const row = buildBiInitiativeRow(facts({ goalCents: 100_000, raisedCents: 90_000, bracketFeeCents: 2_000, realizedGuaranteeCents: 0, projectedGuaranteeAt100Cents: 0, approvedSponsorsFeeCents: 10_000 }));
    expect(row.sourcesCents.sponsorFeeCents).toBe(10_000);
    expect(row.netRevenueCents).toBe(12_000);
    expect(row.collectedNetRevenueCents).toBe(2_000);
    // Faltan 100,00 €: aportar da 20 − 100 = −80 €, no «+20 €».
    expect(row.netProfitAfterBoostCents).toBe(-8_000);
    expect(row.isProfitableSelfBoost).toBe(false);
  });

  it('una campaña cerrada separa la pasarela de lo ya gastado en Auto-Impulso y contracargos: el neto no cambia, pero la causa se ve (auditoría financiera del 5.2, H2)', () => {
    const closed = buildBiInitiativeRow(facts({ status: 'CLOSED', raisedCents: 100_000, settled: { sourcesCents: { bracketFeeCents: 35_000, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 }, costsCents: 0, sunkCostsCents: 60_000 } }));
    expect(closed).toMatchObject({ gatewayLossCents: 0, sunkCostsCents: 60_000, netRevenueCents: -25_000, isNegativeReturnAlert: true });
    const withGateway = buildBiInitiativeRow(facts({ status: 'REFUNDED', settled: { sourcesCents: { bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 }, costsCents: 31, sunkCostsCents: 100 } }));
    expect(withGateway).toMatchObject({ gatewayLossCents: 31, sunkCostsCents: 100, netRevenueCents: -131 });
  });

  it('el Auto-Impulso anterior de una campaña reabierta se descuenta del retorno del 💎, todos los que siguen puestos, y con retorno exactamente 0 no hay 💎 (auditoría financiera, H2)', () => {
    const reopened = { goalCents: 100_000, raisedCents: 88_000, bracketFeeCents: 20_000, realizedGuaranteeCents: 0, projectedGuaranteeAt100Cents: 0, approvedSponsorsFeeCents: 0 };
    const one = buildBiInitiativeRow(facts({ ...reopened, selfBoostStandingCents: 15_000, sunkCostsCents: 15_000 }));
    expect(one).toMatchObject({ recoverableSelfBoostCents: 15_000, netProfitAfterBoostCents: -7_000, isProfitableSelfBoost: false });
    // El neto proyectado resta lo ya gastado una sola vez; el 💎 lo resta aparte, sin tocar las 6 fuentes.
    expect(one.netRevenueCents).toBe(buildBiInitiativeRow(facts({ ...reopened })).netRevenueCents - 15_000);
    // Lo ya gastado en Auto-Impulso va en su propio campo: no se disfraza de coste de pasarela (auditoría financiera del 5.2).
    const without = buildBiInitiativeRow(facts({ ...reopened }));
    expect(one.sunkCostsCents).toBe(15_000);
    expect(one.gatewayLossCents).toBe(without.gatewayLossCents);
    expect(REVENUE_SOURCE_KEYS.reduce((sum, key) => sum + one.sourcesCents[key], 0) - one.gatewayLossCents - one.sunkCostsCents).toBe(one.netRevenueCents);
    expect(summarizeProjection([one])).toMatchObject({ gatewayLossCents: without.gatewayLossCents, sunkCostsCents: 15_000, netRevenueCents: one.netRevenueCents });
    // Dos Auto-Impulsos todavía puestos se restan los dos.
    expect(buildBiInitiativeRow(facts({ ...reopened, selfBoostStandingCents: 27_000, sunkCostsCents: 27_000 }))).toMatchObject({ recoverableSelfBoostCents: 27_000, netProfitAfterBoostCents: -19_000 });
    // Justo en cero (200 − 120 − 80): no compensa.
    expect(buildBiInitiativeRow(facts({ ...reopened, selfBoostStandingCents: 8_000 }))).toMatchObject({ netProfitAfterBoostCents: 0, isProfitableSelfBoost: false });
    // Sin Auto-Impulso anterior, la misma campaña sí compensa.
    expect(buildBiInitiativeRow(facts({ ...reopened }))).toMatchObject({ recoverableSelfBoostCents: 0, netProfitAfterBoostCents: 8_000, isProfitableSelfBoost: true });
  });

  it('el diagnóstico «Faltan X» solo se enseña en las campañas que recaudan (ver InitiativeDiagnosis)', () => {
    const expired = buildBiInitiativeRow(facts({ status: 'EXPIRED', raisedCents: 50_000, settled: { sourcesCents: { ...settledSources, sponsorFeeCents: 10_000 }, costsCents: 0 } }));
    expect(expired.missingTo100Cents).toBe(50_000);
    expect(expired.isProfitableSelfBoost).toBe(false);
  });

  it('una campaña devuelta sin nada asentado vale 0 (no hay 🚨 por un plan que nunca se cobró)', () => {
    const row = buildBiInitiativeRow(facts({ status: 'REFUNDED', bracketFeeCents: 20_000, absorbsGatewayCostByKorum: true, gatewayFeeCents: 5_000 }));
    expect(row.netRevenueCents).toBe(0);
    expect(row.isNegativeReturnAlert).toBe(false);
  });

  it('🚨 retorno negativo: una campaña que absorbe la pasarela y no ingresa nada pierde exactamente la pasarela', () => {
    const row = buildBiInitiativeRow(facts({ absorbsGatewayCostByKorum: true, bracketFeeCents: 0, realizedGuaranteeCents: 0, projectedGuaranteeAt100Cents: 0, approvedSponsorsFeeCents: 0, gatewayFeeCents: 6_250 }));
    expect(row.netRevenueCents).toBe(-6_250);
    expect(row.gatewayLossCents).toBe(6_250);
    expect(row.isNegativeReturnAlert).toBe(true);
    expect(row.isProfitableSelfBoost).toBe(false);
  });

  it('💎 Auto-Impulso: solo cuenta lo ya cobrado más la comisión y el mantenimiento; la aportación proyectada no cambia el resultado', () => {
    const base = { goalCents: 100_000, raisedCents: 90_000, bracketFeeCents: 15_000, maintFeeCents: 0, realizedGuaranteeCents: 0, approvedSponsorsFeeCents: 0 };
    const low = buildBiInitiativeRow(facts({ ...base, projectedGuaranteeAt100Cents: 0 }));
    const high = buildBiInitiativeRow(facts({ ...base, projectedGuaranteeAt100Cents: 99_999 }));
    expect(low.missingTo100Cents).toBe(10_000);
    expect(low.netProfitAfterBoostCents).toBe(5_000);
    expect(low.isProfitableSelfBoost).toBe(true);
    expect(high.netProfitAfterBoostCents).toBe(low.netProfitAfterBoostCents);
    expect(high.isProfitableSelfBoost).toBe(true);
    // Pero la proyección sí sube el neto esperado: son dos vistas distintas.
    expect(high.netRevenueCents).toBeGreaterThan(low.netRevenueCents);
  });

  it('💎 no aparece si la campaña no está recaudando ni si ya está completa', () => {
    expect(buildBiInitiativeRow(facts({ status: 'GOAL_REACHED', raisedCents: 90_000, bracketFeeCents: 15_000 })).isProfitableSelfBoost).toBe(false);
    expect(buildBiInitiativeRow(facts({ raisedCents: 100_000, bracketFeeCents: 15_000 })).isProfitableSelfBoost).toBe(false);
  });

  it('el ponderado redondea la mitad hacia fuera de cero y nunca supera la meta', () => {
    const half = buildBiInitiativeRow(facts({ goalCents: 2, raisedCents: 1, bracketFeeCents: 1_001, realizedGuaranteeCents: 0, projectedGuaranteeAt100Cents: 0, approvedSponsorsFeeCents: 0, gatewayFeeCents: 0 }));
    expect(half.weightedNetCents).toBe(501);
    const negative = buildBiInitiativeRow(facts({ goalCents: 2, raisedCents: 1, absorbsGatewayCostByKorum: true, bracketFeeCents: 0, realizedGuaranteeCents: 0, projectedGuaranteeAt100Cents: 0, approvedSponsorsFeeCents: 0, gatewayFeeCents: 1_001 }));
    expect(negative.weightedNetCents).toBe(-501);
    const over = buildBiInitiativeRow(facts({ goalCents: 100, raisedCents: 250 }));
    expect(over.weightedNetCents).toBe(over.netRevenueCents);
    expect(over.progressPct).toBe(100);
  });

  it('el avance nunca pasa de 100 y una meta 0 no divide por cero', () => {
    expect(progressPercent(250, 100)).toBe(100);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(2, 3)).toBe(66);
    // Hacia abajo: 99,5 % no se muestra como 100 % mientras quede importe pendiente.
    expect(progressPercent(99_500, 100_000)).toBe(99);
    expect(progressPercent(100_000, 100_000)).toBe(100);
  });

  it('taquilla: el margen de las entradas se proyecta al aforo completo y, mientras no se venden, el 💎 solo ve las vendidas', () => {
    const row = buildBiInitiativeRow(
      facts({ format: 'TICKETING', bracketFeeCents: 0, approvedSponsorsFeeCents: 0, realizedGuaranteeCents: 0, projectedGuaranteeAt100Cents: 0, ticketMarginAt100Cents: 8_000, ticketMarginRealizedCents: 2_000, goalCents: 10_000, raisedCents: 9_000 })
    );
    expect(row.sourcesCents.digitalTicketFeeCents).toBe(8_000);
    expect(row.netRevenueCents).toBe(8_000);
    expect(row.collectedNetRevenueCents).toBe(2_000);
    // Faltan 1.000 y solo hay 2.000 cobrados: aportar compensa, y no por las entradas que aún no se han vendido.
    expect(row.netProfitAfterBoostCents).toBe(1_000);
  });
});

describe('QA-A02 · las 6 fuentes cuadran al céntimo en todas las vistas', () => {
  /** Generador determinista (LCG) para no depender del azar. */
  const random = (() => {
    let seed = 20_261_111;
    return (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % (max + 1);
    };
  })();
  const STATUSES: InitiativeStatus[] = ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'REFUNDED', 'REFUNDING', 'RESIZE_VOTING'];

  const generated = Array.from({ length: 400 }, (_, index) => {
    const goalCents = 100 * (1 + random(500_000));
    const ticketing = random(1) === 1;
    return facts({
      id: index + 1,
      organizationId: `ORG-${random(3)}`,
      status: STATUSES[random(STATUSES.length - 1)]!,
      format: ticketing ? 'TICKETING' : 'BUDGET',
      quarter: random(1) === 0 ? '2026-Q4' : '2027-Q1',
      goalCents,
      raisedCents: random(goalCents + 5_000),
      bracketFeeCents: random(20_000),
      maintFeeCents: random(3) === 0 ? 4_900 : 0,
      gatewayFeeCents: random(3_000),
      absorbsGatewayCostByKorum: random(3) === 0,
      realizedGuaranteeCents: random(1_500),
      projectedGuaranteeAt100Cents: random(3_000),
      approvedSponsorsFeeCents: random(9_000),
      ticketMarginAt100Cents: random(12_000) - 4_000,
      ticketMarginRealizedCents: random(6_000) - 2_000,
      huchaTopupNetCents: random(600) - 200,
      settled: { sourcesCents: { bracketFeeCents: random(9_000), supportGuaranteeCents: random(900), sponsorFeeCents: random(4_000), digitalTicketFeeCents: random(7_000), maintFeeCents: random(2) * 4_900, huchaTopupFeeCents: random(300) }, costsCents: random(6_000) - 500 }
    });
  });
  const rows = generated.map(buildBiInitiativeRow);

  it('en cada fila, Σ 6 fuentes − pérdida de pasarela === neto, y el neto ponderado nunca pasa del neto', () => {
    for (const row of rows) {
      const total = REVENUE_SOURCE_KEYS.reduce((sum, key) => sum + row.sourcesCents[key], 0);
      expect(total - row.gatewayLossCents - row.sunkCostsCents, `iniciativa ${row.id}`).toBe(row.netRevenueCents);
      expect(Math.abs(row.weightedNetCents), `ponderado ${row.id}`).toBeLessThanOrEqual(Math.abs(row.netRevenueCents));
      expect(Number.isSafeInteger(row.weightedNetCents)).toBe(true);
    }
  });

  it('la proyección suma exactamente las filas abiertas: KPIs, gráfico y neto salen de lo mismo', () => {
    const projection = summarizeProjection(rows);
    const open = rows.filter((row) => row.status === 'FUNDRAISING' || row.status === 'GOAL_REACHED');
    expect(projection.kpis.expectedNetCents).toBe(open.reduce((sum, row) => sum + row.netRevenueCents, 0));
    expect(projection.netRevenueCents).toBe(projection.kpis.expectedNetCents);
    expect(projection.kpis.weightedNetCents).toBe(open.reduce((sum, row) => sum + row.weightedNetCents, 0));
    expect(projection.kpis.potentialGoalCents).toBe(open.reduce((sum, row) => sum + row.goalCents, 0));
    expect(projection.sourcesTotalCents - projection.gatewayLossCents - projection.sunkCostsCents).toBe(projection.netRevenueCents);
    for (const key of REVENUE_SOURCE_KEYS) expect(projection.sourcesCents[key]).toBe(open.reduce((sum, row) => sum + row.sourcesCents[key], 0));
  });

  it('la previsión por trimestre y las filas por entidad suman lo mismo que la proyección', () => {
    const projection = summarizeProjection(rows);
    const forecast = forecastByQuarter(rows);
    expect(forecast.map((quarter) => quarter.quarter)).toEqual([...forecast.map((quarter) => quarter.quarter)].sort());
    expect(forecast.reduce((sum, quarter) => sum + quarter.unweightedNetCents, 0)).toBe(projection.kpis.expectedNetCents);
    expect(forecast.reduce((sum, quarter) => sum + quarter.weightedNetCents, 0)).toBe(projection.kpis.weightedNetCents);
    expect(forecast.reduce((sum, quarter) => sum + quarter.goalCents, 0)).toBe(projection.kpis.potentialGoalCents);

    const organizations: BiOrganizationFacts[] = [0, 1, 2, 3].map((index) => ({
      id: `ORG-${index}`, slug: `org-${index}`, name: `Entidad ${index}`, province: 'Barcelona', health: 'OK', medalRank: index, completedThisYear: index, completedHistorical: index * 2, activeSponsorsCount: index, historicalSponsorsCount: index * 3
    }));
    const byOrganization = buildBiOrganizationRows(organizations, rows);
    expect(byOrganization.reduce((sum, row) => sum + row.expectedNetCents, 0)).toBe(projection.kpis.expectedNetCents);
    expect(byOrganization.reduce((sum, row) => sum + row.currentRaisedCents, 0)).toBe(projection.kpis.raisedCents);
    expect(byOrganization.reduce((sum, row) => sum + row.openCount, 0)).toBe(rows.filter((row) => row.status === 'FUNDRAISING' || row.status === 'GOAL_REACHED').length);
  });
});

describe('QA-A01 · filtros del BI', () => {
  const organizations: BiOrganizationFacts[] = [
    { id: 'A', slug: 'a', name: 'A', province: 'Barcelona', health: 'OK', medalRank: 0, completedThisYear: 0, completedHistorical: 0, activeSponsorsCount: 0, historicalSponsorsCount: 0 },
    { id: 'B', slug: 'b', name: 'B', province: 'Madrid', health: 'CALL', medalRank: 1, completedThisYear: 0, completedHistorical: 0, activeSponsorsCount: 0, historicalSponsorsCount: 0 },
    { id: 'C', slug: 'c', name: 'C', province: 'Madrid', health: 'OK', medalRank: 2, completedThisYear: 0, completedHistorical: 0, activeSponsorsCount: 0, historicalSponsorsCount: 0 }
  ];
  const rows = [
    buildBiInitiativeRow(facts({ id: 1, organizationId: 'A', quarter: '2026-Q4' })),
    buildBiInitiativeRow(facts({ id: 2, organizationId: 'B', quarter: '2027-Q1' })),
    buildBiInitiativeRow(facts({ id: 3, organizationId: 'C', quarter: '2026-Q4', status: 'CLOSED' })),
    buildBiInitiativeRow(facts({ id: 4, organizationId: 'C', quarter: '2026-Q4', status: 'GOAL_REACHED' }))
  ];

  it('filtra entidades por provincia, entidad y estado de acompañamiento, y las iniciativas por esas entidades y el trimestre', () => {
    expect(filterOrganizations(organizations, {}).map((organization) => organization.id)).toEqual(['A', 'B', 'C']);
    expect(filterOrganizations(organizations, { province: 'Madrid' }).map((organization) => organization.id)).toEqual(['B', 'C']);
    expect(filterOrganizations(organizations, { province: 'Madrid', health: 'OK' }).map((organization) => organization.id)).toEqual(['C']);
    expect(filterOrganizations(organizations, { organizationId: 'A', province: 'Madrid' })).toEqual([]);

    const madrid = new Set(['B', 'C']);
    expect(filterInitiatives(rows, madrid, {}).map((row) => row.id)).toEqual([2, 3, 4]);
    expect(filterInitiatives(rows, madrid, { quarter: '2026-Q4' }).map((row) => row.id)).toEqual([3, 4]);
    expect(filterInitiatives(rows, new Set(), {})).toEqual([]);
  });

  it('el listado global separa activas (recaudando) de terminadas (logro conseguido y cerradas)', () => {
    expect(filterByStatus(rows, 'ACTIVE').map((row) => row.id)).toEqual([1, 2]);
    expect(filterByStatus(rows, 'FINISHED').map((row) => row.id)).toEqual([3, 4]);
    expect(filterByStatus(rows, 'ALL')).toHaveLength(4);
    expect(filterByStatus(rows, undefined)).toHaveLength(4);
  });
});

describe('QA-FIN05 · ingresos reales por entidad', () => {
  const part = (sources: Partial<Record<(typeof REVENUE_SOURCE_KEYS)[number], number>>, costs: { gateway?: number; boost?: number; chargebacks?: number } = {}) => ({
    sourcesCents: { bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0, ...sources },
    gatewayNetCostCents: costs.gateway ?? 0,
    autoBoostExpenseCents: costs.boost ?? 0,
    chargebackLossesCents: costs.chargebacks ?? 0
  });

  it('suma fuentes y costes de varias entidades y el neto sale de la misma identidad', () => {
    const total = sumRealRevenues([part({ supportGuaranteeCents: 1_000, digitalTicketFeeCents: 10_780 }, { gateway: 1_500, boost: 200 }), part({ bracketFeeCents: 4_000, sponsorFeeCents: 3_750 }, { gateway: 500, chargebacks: 100 })]);
    expect(total.sourcesTotalCents).toBe(19_530);
    expect(total.gatewayNetCostCents).toBe(2_000);
    expect(total.autoBoostExpenseCents).toBe(200);
    expect(total.chargebackLossesCents).toBe(100);
    expect(total.netRevenueCents).toBe(19_530 - 2_300);
  });

  it('sin entidades no hay ingresos ni costes (nunca una cifra inventada)', () => {
    const total = sumRealRevenues([]);
    expect(total.sourcesTotalCents).toBe(0);
    expect(total.netRevenueCents).toBe(0);
    expect(Object.values(total.sourcesCents).every((cents) => cents === 0)).toBe(true);
  });
});
