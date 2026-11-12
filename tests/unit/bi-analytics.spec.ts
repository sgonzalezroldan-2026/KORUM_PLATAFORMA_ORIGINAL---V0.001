import { describe, expect, it } from 'vitest';
import {
  analyzeInitiativeProfitabilityAndSelfBoost,
  calculateRealRevenueFromLedger,
  calculateRevenueBreakdown6Sources,
  guaranteeActivationBps,
  projectGuaranteeContributionsAt100,
  REVENUE_SOURCE_KEYS,
  sumRevenueBreakdowns,
  type GuaranteeSample,
  type InitiativeRevenueInput
} from '@/core/finance/bi-analytics.service';
import { calculateStudioTicketingTCO } from '@/core/finance/tco.service';
import { planAllFunding } from '@/seed/funding-plan';
import { createRandom } from '@/seed/random';
import { loadSeedData } from '@/seed/seed-types';

const seed = loadSeedData();
const plans = planAllFunding(seed);
const EMPTY_SAMPLE: GuaranteeSample = { contributions: 0, contributionsWithGuarantee: 0, guaranteeCents: 0 };

function sampleFrom(initiativeIds: number[]): GuaranteeSample {
  const donations = plans.filter((plan) => initiativeIds.includes(plan.initiativeId)).flatMap((plan) => plan.payments.filter((payment) => payment.type === 'DONATION'));
  return {
    contributions: donations.length,
    contributionsWithGuarantee: donations.filter((payment) => payment.guaranteeCents > 0).length,
    guaranteeCents: donations.reduce((total, payment) => total + payment.guaranteeCents, 0)
  };
}

/** Métricas de una iniciativa de la semilla con el mismo cálculo que hará la consola, sin ninguna cifra escrita a mano. */
function analyzeSeedInitiative(id: number) {
  const initiative = seed.initiatives.find((candidate) => candidate.id === id)!;
  const org = seed.schools.find((school) => school.id === initiative.organizationId)!;
  const sameOrg = seed.initiatives.filter((candidate) => candidate.organizationId === org.id).map((candidate) => candidate.id);
  const realized = sampleFrom([id]).guaranteeCents;
  const donations = plans.find((plan) => plan.initiativeId === id)!.payments.filter((payment) => payment.type === 'DONATION');
  const projection = projectGuaranteeContributionsAt100({
    goalCents: initiative.goalCents,
    raisedCents: initiative.raisedCents,
    donationsCount: donations.length,
    donationsCents: donations.reduce((total, payment) => total + payment.amountCents, 0),
    realizedGuaranteeCents: realized,
    defaultDonationTicketCents: org.donationPresetsCents[org.defaultDonationIdx]!,
    entitySample: sampleFrom(sameOrg),
    platformSample: sampleFrom(seed.initiatives.map((candidate) => candidate.id))
  });
  const ticketMargin =
    initiative.format === 'TICKETING'
      ? calculateStudioTicketingTCO({
          ticketPriceCents: initiative.ticketPriceCents!,
          ticketMax: initiative.ticketMax!,
          feeMode: initiative.ticketFeeMode!,
          digitalFeeConfig: { fixedCents: org.ticketFeeFixedCents, pctBps: org.ticketFeeBps },
          gatewayConfig: { pctBps: seed.globalRules.gatewayPctBps, fixedCents: seed.globalRules.gatewayFixedCents },
          maintFeeCents: initiative.maintFeeCents
        }).netKorumMarginAt100Cents
      : 0;
  return {
    projection,
    realized,
    result: analyzeInitiativeProfitabilityAndSelfBoost({
      format: initiative.format,
      status: initiative.status,
      goalCents: initiative.goalCents,
      raisedCents: initiative.raisedCents,
      bracketFeeCents: initiative.bracketFeeCents,
      maintFeeCents: initiative.maintFeeCents,
      gatewayFeeCents: initiative.gatewayFeeCents,
      absorbsGatewayCostByKorum: initiative.absorbsGatewayCostByKorum ?? false,
      realizedGuaranteeContributionsCents: realized,
      projectedGuaranteeContributionsAt100Cents: projection.projectedCents,
      approvedSponsorsFeeCents: seed.sponsors.filter((sponsor) => sponsor.initiativeId === id && sponsor.status === 'APPROVED').reduce((total, sponsor) => total + sponsor.feeGeneratedCents, 0),
      netDigitalTicketMarginAt100Cents: ticketMargin,
      netDigitalTicketMarginRealizedCents: initiative.format === 'TICKETING' ? (ticketMargin / initiative.ticketMax!) * initiative.ticketsSold! : 0,
      allocatedHuchaTopupNetCents: 0
    })
  };
}

const baseInput: InitiativeRevenueInput = {
  format: 'BUDGET',
  bracketFeeCents: 0,
  maintFeeCents: 0,
  gatewayFeeCents: 0,
  absorbsGatewayCostByKorum: false,
  realizedGuaranteeContributionsCents: 0,
  projectedGuaranteeContributionsAt100Cents: 0,
  approvedSponsorsFeeCents: 0,
  netDigitalTicketMarginAt100Cents: 0,
  allocatedHuchaTopupNetCents: 0
};

describe('QA-FIN05 · BI cuadrado y alertas con las 8 iniciativas de la semilla', () => {
  const ids = seed.initiatives.map((initiative) => initiative.id);

  it('las 6 fuentes menos la pérdida de pasarela suman netRevenueCents al céntimo', () => {
    for (const id of ids) {
      const { result } = analyzeSeedInitiative(id);
      const total = REVENUE_SOURCE_KEYS.reduce((sum, key) => sum + result.sourcesCents[key], 0);
      expect(total, `iniciativa ${id}`).toBe(result.sourcesTotalCents);
      expect(total - result.gatewayLossCents, `iniciativa ${id}`).toBe(result.netRevenueCents);
      expect(Object.keys(result.sourcesCents)).toHaveLength(6);
    }
  });

  it('#1 al 97,4 % dispara 💎: aportar lo que falta deja retorno positivo', () => {
    const { result } = analyzeSeedInitiative(1);
    // 144,40 € de tramos + 127,50 € de patrocinios + 83,56 € de aportación voluntaria (81,00 € cobrados y 2,56 € proyectados).
    expect(result.sourcesCents).toEqual({ bracketFeeCents: 14_440, supportGuaranteeCents: 8_356, sponsorFeeCents: 12_750, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 });
    expect(result.netRevenueCents).toBe(35_546);
    expect(result.missingTo100Cents).toBe(15_000);
    // Solo lo cobrado: sin los 2,56 € proyectados y sin los 127,50 € de fee de patrocinio, que KORUM conserva aporte o no.
    expect(result.collectedNetRevenueCents).toBe(22_540);
    expect(result.netProfitAfterBoostCents).toBe(7_540);
    expect(result.isProfitableSelfBoost).toBe(true);
    expect(result.isNegativeReturnAlert).toBe(false);
  });

  it('#8 exenta de IES Mediterráneo dispara 🚨: KORUM absorbe 62,50 € sin ingresos', () => {
    const { result } = analyzeSeedInitiative(8);
    expect(result.sourcesTotalCents).toBe(0);
    expect(result.gatewayLossCents).toBe(6_250);
    expect(result.netRevenueCents).toBe(-6_250);
    expect(result.isNegativeReturnAlert).toBe(true);
    expect(result.isProfitableSelfBoost).toBe(false);
  });

  it('solo las campañas que recaudan pueden disparar 💎 y solo #8 dispara 🚨', () => {
    const alerts = ids.map((id) => ({ id, ...analyzeSeedInitiative(id).result }));
    expect(alerts.filter((row) => row.isNegativeReturnAlert).map((row) => row.id)).toEqual([8]);
    expect(alerts.filter((row) => row.isProfitableSelfBoost).map((row) => row.id)).toEqual([1, 2, 5, 7]);
    expect(alerts.find((row) => row.id === 2)).toMatchObject({ netRevenueCents: 8_000, netProfitAfterBoostCents: 5_840 });
    expect(alerts.find((row) => row.id === 5)).toMatchObject({ netRevenueCents: 61_907, netProfitAfterBoostCents: 9_013 });
    expect(alerts.find((row) => row.id === 7)).toMatchObject({ netRevenueCents: 46_104, netProfitAfterBoostCents: 23_700 });
  });

  it('la campaña ya lograda no dispara 💎 aunque sea rentable', () => {
    expect(analyzeSeedInitiative(3).result).toMatchObject({ missingTo100Cents: 0, isProfitableSelfBoost: false });
    expect(analyzeInitiativeProfitabilityAndSelfBoost({ ...baseInput, status: 'BUDGETING', goalCents: 100, raisedCents: 0, bracketFeeCents: 500, netDigitalTicketMarginRealizedCents: 0 }).isProfitableSelfBoost).toBe(false);
  });

  it('💎 no cuenta lo que aún no se ha cobrado: la aportación proyectada no justifica gastar dinero real', () => {
    const boost = { ...baseInput, status: 'FUNDRAISING', goalCents: 10_000, raisedCents: 5_000, netDigitalTicketMarginRealizedCents: 0 } as const;
    // 35 € de tramos + 17 € proyectados = 52 € al 100 %, pero faltan 50 € y solo hay 35 € seguros: no compensa.
    const projected = analyzeInitiativeProfitabilityAndSelfBoost({ ...boost, bracketFeeCents: 3_500, projectedGuaranteeContributionsAt100Cents: 1_700 });
    expect(projected).toMatchObject({ netRevenueCents: 5_200, collectedNetRevenueCents: 3_500, netProfitAfterBoostCents: -1_500, isProfitableSelfBoost: false });
    // Con esos mismos 17 € ya cobrados, sí compensa.
    const realized = analyzeInitiativeProfitabilityAndSelfBoost({ ...boost, bracketFeeCents: 3_500, realizedGuaranteeContributionsCents: 1_700 });
    expect(realized).toMatchObject({ netProfitAfterBoostCents: 200, isProfitableSelfBoost: true });
  });

  it('💎 no cuenta el fee de patrocinio ya cobrado: KORUM lo conserva aporte o no (ejemplo del promotor)', () => {
    // Faltan 100 €, 20 € de comisión por tramos y 100 € de fee de comercios: aportar da 20 − 100 = −80 €, no «+20 €».
    const boost = { ...baseInput, status: 'FUNDRAISING', goalCents: 10_000, raisedCents: 0, netDigitalTicketMarginRealizedCents: 0, bracketFeeCents: 2_000, approvedSponsorsFeeCents: 10_000 } as const;
    expect(analyzeInitiativeProfitabilityAndSelfBoost(boost)).toMatchObject({ netRevenueCents: 12_000, collectedNetRevenueCents: 2_000, netProfitAfterBoostCents: -8_000, isProfitableSelfBoost: false });
    // Sin comercios, la misma campaña sí compensa si la comisión supera lo que falta.
    expect(analyzeInitiativeProfitabilityAndSelfBoost({ ...boost, approvedSponsorsFeeCents: 0, bracketFeeCents: 10_100 })).toMatchObject({ netProfitAfterBoostCents: 100, isProfitableSelfBoost: true });
  });

  it('💎 descuenta el Auto-Impulso anterior de una campaña reabierta, que volvería a KORUM si la campaña fracasa (ejemplo del promotor, 2026-11-12)', () => {
    // Meta 1.000 €, 880 € recaudados tras un contracargo de 120 €, comisión por tramos de 200 € y un primer Auto-Impulso de 150 € todavía puesto.
    const reopened = { ...baseInput, status: 'FUNDRAISING', goalCents: 100_000, raisedCents: 88_000, bracketFeeCents: 20_000, netDigitalTicketMarginRealizedCents: 0 } as const;
    // Sin descontarlo, la pantalla decía «Aportar 120 € ➔ Retorno +80 €».
    expect(analyzeInitiativeProfitabilityAndSelfBoost(reopened)).toMatchObject({ missingTo100Cents: 12_000, netProfitAfterBoostCents: 8_000, recoverableSelfBoostCents: 0, isProfitableSelfBoost: true });
    // Si KORUM aporta queda en 200 − 120 − 150 = −70 €; si no aporta, recupera los 150 € y queda en 0: no compensa.
    expect(analyzeInitiativeProfitabilityAndSelfBoost({ ...reopened, recoverableSelfBoostCents: 15_000 })).toMatchObject({ netProfitAfterBoostCents: -7_000, recoverableSelfBoostCents: 15_000, isProfitableSelfBoost: false });
    // Con un Auto-Impulso anterior pequeño sigue compensando, y la cifra lo refleja.
    expect(analyzeInitiativeProfitabilityAndSelfBoost({ ...reopened, recoverableSelfBoostCents: 5_000 })).toMatchObject({ netProfitAfterBoostCents: 3_000, isProfitableSelfBoost: true });
    // Una campaña que ya no recauda no lo resta (no hay nada que decidir).
    expect(analyzeInitiativeProfitabilityAndSelfBoost({ ...reopened, status: 'GOAL_REACHED', recoverableSelfBoostCents: 15_000 })).toMatchObject({ recoverableSelfBoostCents: 0 });
  });

  it('💎 en taquilla cuenta el margen de las entradas vendidas, no el del aforo completo', () => {
    const boost = { ...baseInput, format: 'TICKETING', status: 'FUNDRAISING', goalCents: 10_000, raisedCents: 9_000, netDigitalTicketMarginAt100Cents: 2_000 } as const;
    expect(analyzeInitiativeProfitabilityAndSelfBoost({ ...boost, netDigitalTicketMarginRealizedCents: 800 })).toMatchObject({ netRevenueCents: 2_000, netProfitAfterBoostCents: -200, isProfitableSelfBoost: false });
    expect(analyzeInitiativeProfitabilityAndSelfBoost({ ...boost, netDigitalTicketMarginRealizedCents: 1_100 })).toMatchObject({ netProfitAfterBoostCents: 100, isProfitableSelfBoost: true });
  });

  it('el gráfico suma exactamente lo mismo que las filas de la tabla', () => {
    const rows = ids.map((id) => analyzeSeedInitiative(id).result);
    const totals = sumRevenueBreakdowns(rows);
    expect(totals.netRevenueCents).toBe(rows.reduce((sum, row) => sum + row.netRevenueCents, 0));
    for (const key of REVENUE_SOURCE_KEYS) expect(totals.sourcesCents[key]).toBe(rows.reduce((sum, row) => sum + row.sourcesCents[key], 0));
  });

  it('la proyección de la aportación voluntaria usa la tasa real de la entidad', () => {
    const { projection, realized } = analyzeSeedInitiative(1);
    expect(projection.basedOn).toBe('ENTITY');
    const cervantes = sampleFrom(seed.initiatives.filter((initiative) => initiative.organizationId === 'CERVANTES').map((initiative) => initiative.id));
    expect(projection.activationBps).toBe(guaranteeActivationBps(cervantes));
    // Con el check desmarcado por defecto, la tasa observada (28,44 %) está lejos del 72 % fijo del prototipo.
    expect(projection).toMatchObject({ activationBps: 2_844, remainingContributions: 5, projectedCents: 8_356 });
    expect(realized).toBe(8_100);
  });
});

describe('projectGuaranteeContributionsAt100 · sin constantes inventadas', () => {
  const base = { goalCents: 583_300, raisedCents: 568_300, donationsCount: 162, donationsCents: 493_300, realizedGuaranteeCents: 9_000, defaultDonationTicketCents: 2_500, platformSample: EMPTY_SAMPLE };

  it('faltan 5 aportaciones al importe medio y aportan según lo observado', () => {
    // 150 € ÷ (4.933 € ÷ 162) = 4,93 → 5 aportaciones; 54 cts por aportación observada (30 % × 1,80 €).
    const result = projectGuaranteeContributionsAt100({ ...base, entitySample: { contributions: 100, contributionsWithGuarantee: 30, guaranteeCents: 5_400 } });
    expect(result).toEqual({ projectedCents: 9_270, remainingContributions: 5, activationBps: 3_000, basedOn: 'ENTITY' });
  });

  it('si la tasa observada se duplica, también lo proyectado', () => {
    const result = projectGuaranteeContributionsAt100({ ...base, entitySample: { contributions: 100, contributionsWithGuarantee: 60, guaranteeCents: 10_800 } });
    expect(result.projectedCents).toBe(9_540);
    expect(result.activationBps).toBe(6_000);
  });

  it('sin datos de la entidad usa los de la plataforma, y sin ninguno no proyecta nada', () => {
    const platform = projectGuaranteeContributionsAt100({ ...base, entitySample: EMPTY_SAMPLE, platformSample: { contributions: 200, contributionsWithGuarantee: 20, guaranteeCents: 3_600 } });
    expect(platform).toMatchObject({ basedOn: 'PLATFORM', activationBps: 1_000, projectedCents: 9_090 });
    expect(projectGuaranteeContributionsAt100({ ...base, entitySample: EMPTY_SAMPLE })).toEqual({ projectedCents: 9_000, remainingContributions: 0, activationBps: 0, basedOn: 'NONE' });
  });

  it('una iniciativa sin cobros estima con el importe sugerido; una lograda ya no suma nada', () => {
    const sample = { contributions: 100, contributionsWithGuarantee: 50, guaranteeCents: 10_000 };
    const fresh = projectGuaranteeContributionsAt100({ ...base, raisedCents: 0, donationsCount: 0, donationsCents: 0, realizedGuaranteeCents: 0, goalCents: 100_000, entitySample: sample });
    expect(fresh.remainingContributions).toBe(40);
    expect(fresh.projectedCents).toBe(4_000);
    const done = projectGuaranteeContributionsAt100({ ...base, raisedCents: 583_300, entitySample: sample });
    expect(done).toMatchObject({ remainingContributions: 0, projectedCents: 9_000 });
  });

  it('patrocinios y bolsa no inflan la donación media: la estimación usa solo donaciones', () => {
    // 10 donaciones de 100 € en total y 900 € de patrocinio; faltan 1.000 €: son 100 donaciones, no 10.
    const result = projectGuaranteeContributionsAt100({ ...base, goalCents: 200_000, raisedCents: 100_000, donationsCount: 10, donationsCents: 10_000, realizedGuaranteeCents: 0, entitySample: { contributions: 10, contributionsWithGuarantee: 5, guaranteeCents: 500 } });
    expect(result).toMatchObject({ remainingContributions: 100, projectedCents: 5_000 });
  });

  it('un importe sugerido a cero o bajo usa el mismo respaldo que el motor TCO, sin tirar la tabla', () => {
    const fresh = { ...base, raisedCents: 0, donationsCount: 0, donationsCents: 0, realizedGuaranteeCents: 0, goalCents: 100_000, entitySample: { contributions: 1, contributionsWithGuarantee: 1, guaranteeCents: 100 } };
    expect(projectGuaranteeContributionsAt100({ ...fresh, defaultDonationTicketCents: 0 }).remainingContributions).toBe(40);
    expect(projectGuaranteeContributionsAt100({ ...fresh, defaultDonationTicketCents: 100 }).remainingContributions).toBe(200);
  });

  it('rechaza muestras imposibles o incoherentes', () => {
    expect(() => guaranteeActivationBps({ contributions: 5, contributionsWithGuarantee: 6, guaranteeCents: 600 })).toThrow(RangeError);
    expect(() => guaranteeActivationBps({ contributions: 100, contributionsWithGuarantee: 0, guaranteeCents: 5_000 })).toThrow(/incoherente/);
    expect(() => guaranteeActivationBps({ contributions: 100, contributionsWithGuarantee: 5, guaranteeCents: 0 })).toThrow(/incoherente/);
  });
});

describe('calculateRevenueBreakdown6Sources · cada fuente en su sitio', () => {
  it('lo ya cobrado no se pierde al absorber la pasarela, pero no se proyecta más', () => {
    const result = calculateRevenueBreakdown6Sources({ ...baseInput, absorbsGatewayCostByKorum: true, gatewayFeeCents: 1_000, realizedGuaranteeContributionsCents: 300, projectedGuaranteeContributionsAt100Cents: 900 });
    expect(result.sourcesCents.supportGuaranteeCents).toBe(300);
    expect(result).toMatchObject({ gatewayLossCents: 1_000, netRevenueCents: -700 });
  });

  it('la proyección nunca baja de lo ya cobrado', () => {
    expect(calculateRevenueBreakdown6Sources({ ...baseInput, realizedGuaranteeContributionsCents: 500, projectedGuaranteeContributionsAt100Cents: 400 }).sourcesCents.supportGuaranteeCents).toBe(500);
  });

  it('en taquilla no hay comisión por tramos y un margen negativo pasa a pérdida, no a fuente', () => {
    const positive = calculateRevenueBreakdown6Sources({ ...baseInput, format: 'TICKETING', bracketFeeCents: 999, netDigitalTicketMarginAt100Cents: 8_000 });
    expect(positive.sourcesCents).toMatchObject({ bracketFeeCents: 0, digitalTicketFeeCents: 8_000 });
    const negative = calculateRevenueBreakdown6Sources({ ...baseInput, format: 'TICKETING', netDigitalTicketMarginAt100Cents: -2_000 });
    expect(negative).toMatchObject({ gatewayLossCents: 2_000, netRevenueCents: -2_000 });
    expect(negative.sourcesCents.digitalTicketFeeCents).toBe(0);
  });

  it('en taquilla «absorber» no resta la pasarela otra vez: el margen ya la descuenta', () => {
    const absorbing = { ...baseInput, format: 'TICKETING', absorbsGatewayCostByKorum: true, gatewayFeeCents: 1_000 } as const;
    expect(calculateRevenueBreakdown6Sources({ ...absorbing, netDigitalTicketMarginAt100Cents: -2_000 })).toMatchObject({ gatewayLossCents: 2_000, netRevenueCents: -2_000 });
    expect(calculateRevenueBreakdown6Sources({ ...absorbing, netDigitalTicketMarginAt100Cents: 8_000 })).toMatchObject({ gatewayLossCents: 0, netRevenueCents: 8_000 });
  });

  it('cada fuente de entrada acaba en su sitio y suma al neto', () => {
    const result = calculateRevenueBreakdown6Sources({ ...baseInput, bracketFeeCents: 1_000, maintFeeCents: 4_900, approvedSponsorsFeeCents: 300, projectedGuaranteeContributionsAt100Cents: 20, allocatedHuchaTopupNetCents: 7 });
    expect(result.sourcesCents).toEqual({ bracketFeeCents: 1_000, supportGuaranteeCents: 20, sponsorFeeCents: 300, digitalTicketFeeCents: 0, maintFeeCents: 4_900, huchaTopupFeeCents: 7 });
    expect(result.netRevenueCents).toBe(6_227);
  });

  it('una iniciativa de presupuesto ignora el margen de taquilla', () => {
    expect(calculateRevenueBreakdown6Sources({ ...baseInput, netDigitalTicketMarginAt100Cents: -500 })).toMatchObject({ gatewayLossCents: 0, netRevenueCents: 0 });
  });

  it('Mi Hucha con margen negativo resta del neto sin esconderse', () => {
    expect(calculateRevenueBreakdown6Sources({ ...baseInput, bracketFeeCents: 100, allocatedHuchaTopupNetCents: -30 }).netRevenueCents).toBe(70);
  });

  it('rechaza importes que no son enteros o negativos', () => {
    expect(() => calculateRevenueBreakdown6Sources({ ...baseInput, bracketFeeCents: 1.5 })).toThrow(RangeError);
    expect(() => calculateRevenueBreakdown6Sources({ ...baseInput, approvedSponsorsFeeCents: -1 })).toThrow(RangeError);
  });

  it('el neto cuadra con las fuentes en 1.000 combinaciones (semilla fija)', () => {
    const random = createRandom(5);
    const amount = () => Math.floor(random() * 1_000_000);
    for (let i = 0; i < 1_000; i += 1) {
      const result = calculateRevenueBreakdown6Sources({
        format: random() < 0.5 ? 'BUDGET' : 'TICKETING',
        bracketFeeCents: amount(),
        maintFeeCents: amount(),
        gatewayFeeCents: amount(),
        absorbsGatewayCostByKorum: random() < 0.3,
        realizedGuaranteeContributionsCents: amount(),
        projectedGuaranteeContributionsAt100Cents: amount(),
        approvedSponsorsFeeCents: amount(),
        netDigitalTicketMarginAt100Cents: amount() - 500_000,
        allocatedHuchaTopupNetCents: amount() - 500_000
      });
      expect(REVENUE_SOURCE_KEYS.reduce((sum, key) => sum + result.sourcesCents[key], 0) - result.gatewayLossCents).toBe(result.netRevenueCents);
    }
  });
});

describe('calculateRealRevenueFromLedger · ingresos reales desde el libro mayor', () => {
  it('reparte cada cuenta en su fuente y descuenta los costes reales', () => {
    const real = calculateRealRevenueFromLedger([
      { account: 'KORUM_REVENUE_GUARANTEE', balanceCents: 100 },
      { account: 'KORUM_REVENUE_BRACKET', balanceCents: 200 },
      { account: 'KORUM_REVENUE_SPONSOR_FEE', balanceCents: 300 },
      { account: 'KORUM_REVENUE_TICKET_FEE', balanceCents: 400 },
      { account: 'KORUM_REVENUE_MAINTENANCE', balanceCents: 500 },
      { account: 'KORUM_REVENUE_TOPUP_FEE', balanceCents: 600 },
      { account: 'GATEWAY_FEES_EXPENSE', balanceCents: 700 },
      { account: 'GATEWAY_FEES_RECOVERED', balanceCents: 250 },
      { account: 'AUTO_BOOST_EXPENSE', balanceCents: 80 },
      { account: 'CHARGEBACK_LOSSES', balanceCents: 20 },
      { account: 'INITIATIVE_ESCROW', balanceCents: 999_999 }
    ]);
    expect(real.sourcesCents).toEqual({ bracketFeeCents: 200, supportGuaranteeCents: 100, sponsorFeeCents: 300, digitalTicketFeeCents: 400, maintFeeCents: 500, huchaTopupFeeCents: 600 });
    expect(real).toMatchObject({ sourcesTotalCents: 2_100, gatewayNetCostCents: 450, autoBoostExpenseCents: 80, chargebackLossesCents: 20, netRevenueCents: 1_550 });
  });

  it('sin movimientos, todo es cero: ningún ingreso inventado', () => {
    expect(calculateRealRevenueFromLedger([])).toMatchObject({ sourcesTotalCents: 0, netRevenueCents: 0 });
  });
});
