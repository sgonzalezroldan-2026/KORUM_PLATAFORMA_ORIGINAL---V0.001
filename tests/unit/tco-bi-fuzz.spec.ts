import { describe, expect, it } from 'vitest';
import {
  bracketConfigFor,
  calculateBracketFeeCents,
  calculatePublicBreakdown4Lines,
  calculateStudioBudgetTCO,
  calculateStudioTicketingTCO,
  evaluateMaintenanceCapShutoff,
  gatewayChargeCostCents,
  PublicBreakdownMismatchError,
  type BracketConfig,
  type BudgetTcoInputCents
} from '@/core/finance/tco.service';
import { createRandom, type Random } from '@/seed/random';
import { loadSeedData } from '@/seed/seed-types';
import type { BracketMode } from '@/types/korum.types';

const seed = loadSeedData();
const rules = seed.globalRules;
const FLAT: BracketConfig = bracketConfigFor({ ...rules, bracketMode: 'FLAT' });
const MARGINAL: BracketConfig = bracketConfigFor({ ...rules, bracketMode: 'MARGINAL' });

const between = (random: Random, min: number, max: number) => min + Math.floor(random() * (max - min + 1));
const pick = <T>(random: Random, options: readonly T[]): T => options[Math.floor(random() * options.length)]!;

function randomConfig(random: Random, mode: BracketMode): BracketConfig {
  const t1MaxCents = between(random, 100_000, 1_000_000);
  return {
    mode,
    t1MaxCents,
    // Uno de cada diez con umbrales cruzados o iguales: el motor los admite y deja vacío el tramo 2.
    t2MaxCents: random() < 0.1 ? between(random, 0, t1MaxCents) : t1MaxCents + between(random, 1, 2_500_000),
    ratesBps: { t1: between(random, 0, 800), t2: between(random, 0, 800), t3: between(random, 0, 800) }
  };
}

function randomBudget(random: Random, mode: BracketMode): BudgetTcoInputCents {
  return {
    costMatCents: between(random, 0, 5_000_000),
    costInstCents: pick(random, [0, between(random, 1, 1_000_000)]),
    contingencyBps: between(random, 0, 2_000),
    isCategoryExempt: random() < 0.15,
    baseExemptRemainingCents: pick(random, [0, 50_000, 100_000, 150_000, between(random, 0, 300_000)]),
    medalGrantAvailableCents: pick(random, [0, 50_000, 100_000, 200_000]),
    bracketConfig: randomConfig(random, mode),
    maintConfig: {
      active: random() < 0.5,
      perInitCents: pick(random, [0, 4_900, between(random, 1, 10_000)]),
      annualCapCents: pick(random, [0, 14_700, between(random, 0, 30_000)]),
      alreadyChargedOrReservedCents: pick(random, [0, 4_900, 9_800, 14_700, between(random, 0, 30_000)])
    },
    gatewayConfig: {
      pctBps: between(random, 0, 300),
      fixedCents: between(random, 0, 50),
      defaultDonationTicketCents: pick(random, [0, 100, 1_000, 2_500, 3_000, 5_000])
    }
  };
}

/** Comisión calculada por un camino distinto al del motor (coma flotante sobre importes pequeños), para que el fuzzing no se compare consigo mismo. */
function independentFee(netCents: number, exemptCents: number, cfg: BracketConfig): number {
  const from = Math.min(netCents, exemptCents);
  const { t1, t2, t3 } = cfg.ratesBps;
  const t2Max = Math.max(cfg.t1MaxCents, cfg.t2MaxCents);
  if (cfg.mode === 'FLAT') {
    const rate = netCents <= cfg.t1MaxCents ? t1 : netCents <= t2Max ? t2 : t3;
    return Math.round(((netCents - from) * rate) / 10_000);
  }
  const portion = (low: number, high: number) => Math.max(0, Math.min(netCents, high) - Math.max(from, low));
  const weighted = portion(0, cfg.t1MaxCents) * t1 + portion(cfg.t1MaxCents, t2Max) * t2 + portion(t2Max, Infinity) * t3;
  return Math.round(weighted / 10_000);
}

describe('QA-FIN02 · fuzzing 1.000x del redondeo en BUDGET', () => {
  for (const mode of ['FLAT', 'MARGINAL'] as const) {
    it(`cuadra al céntimo en 1.000/1.000 combinaciones en modo ${mode}`, () => {
      const random = createRandom(mode === 'FLAT' ? 20261030 : 20261031);
      let checked = 0;
      for (let i = 0; i < 1_000; i += 1) {
        const input = randomBudget(random, mode);
        const tco = calculateStudioBudgetTCO(input);
        const context = JSON.stringify(input);

        expect(tco.finalGoalCents % 100, context).toBe(0);
        expect(tco.netGuaranteedForSchoolCents + tco.bracketFeeCents + tco.maintFeeCents + tco.gatewayFeeCents, context).toBe(tco.finalGoalCents);
        expect(tco.roundingBufferCents, context).toBeGreaterThanOrEqual(0);
        expect(tco.roundingBufferCents, context).toBeLessThanOrEqual(99);
        expect(tco.gatewayFeeCents - tco.rawGatewayFeeCents, context).toBe(tco.roundingBufferCents);
        for (const [name, value] of Object.entries(tco)) {
          expect(Number.isSafeInteger(value), `${name} = ${value} en ${context}`).toBe(true);
          expect(value, `${name} en ${context}`).toBeGreaterThanOrEqual(0);
        }

        const net = tco.netGuaranteedForSchoolCents;
        if (input.isCategoryExempt) {
          expect(tco.bracketFeeCents, context).toBe(0);
          expect(tco.defaultExemptUsedCents + tco.medalExemptUsedCents, context).toBe(0);
        } else {
          expect(tco.defaultExemptUsedCents + tco.medalExemptUsedCents + tco.taxableCents, context).toBe(net);
          expect(tco.defaultExemptUsedCents, context).toBeLessThanOrEqual(input.baseExemptRemainingCents);
          expect(tco.medalExemptUsedCents, context).toBeLessThanOrEqual(input.medalGrantAvailableCents);
          expect(tco.bracketFeeCents, context).toBe(independentFee(net, tco.defaultExemptUsedCents + tco.medalExemptUsedCents, input.bracketConfig));
        }

        const breakdown = calculatePublicBreakdown4Lines({ costMatCents: input.costMatCents, costInstCents: input.costInstCents, contingencyBps: input.contingencyBps, goalCents: tco.finalGoalCents });
        expect(breakdown.line1ProviderCents + breakdown.line2InstallCents + breakdown.line3ContingencyCents + breakdown.line4EscrowAndGuaranteeCents, context).toBe(tco.finalGoalCents);
        expect(breakdown.line4EscrowAndGuaranteeCents, context).toBe(tco.bracketFeeCents + tco.maintFeeCents + tco.gatewayFeeCents);
        checked += 1;
      }
      expect(checked).toBe(1_000);
    });
  }

  it('la secuencia de casos es determinista', () => {
    const run = () => {
      const random = createRandom(99);
      return Array.from({ length: 50 }, () => calculateStudioBudgetTCO(randomBudget(random, 'MARGINAL')).finalGoalCents);
    };
    expect(run()).toEqual(run());
  });

  it('una iniciativa sin presupuesto da meta 0, sin cuota ni pasarela', () => {
    const tco = calculateStudioBudgetTCO({
      ...randomBudget(createRandom(1), 'FLAT'),
      costMatCents: 0,
      costInstCents: 0,
      maintConfig: { active: true, perInitCents: 4_900, annualCapCents: 14_700, alreadyChargedOrReservedCents: 0 }
    });
    expect(tco.finalGoalCents).toBe(0);
    expect(tco.maintFeeCents).toBe(0);
    expect(tco.estTransactions).toBe(0);
  });
});

describe('calculateBracketFeeCents · modos FLAT y MARGINAL', () => {
  it('FLAT reproduce el efecto escalón documentado: un céntimo más paga menos comisión', () => {
    expect(calculateBracketFeeCents(500_000, 100_000, FLAT)).toEqual({ rateBps: 500, feeCents: 20_000 });
    expect(calculateBracketFeeCents(500_001, 100_000, FLAT)).toEqual({ rateBps: 400, feeCents: 16_000 });
  });

  it('MARGINAL grava cada tramo solo por su porción y da la tarifa media ponderada', () => {
    // 4.000 € al 5 % + 10.000 € al 4 % + 5.000 € al 3 % = 750 € sobre 19.000 € sujetos.
    expect(calculateBracketFeeCents(2_000_000, 100_000, MARGINAL)).toEqual({ rateBps: 395, feeCents: 75_000 });
  });

  it('los dos modos coinciden dentro del primer tramo', () => {
    const random = createRandom(11);
    for (let i = 0; i < 1_000; i += 1) {
      const net = between(random, 0, 500_000);
      const exempt = between(random, 0, 200_000);
      expect(calculateBracketFeeCents(net, exempt, MARGINAL).feeCents).toBe(calculateBracketFeeCents(net, exempt, FLAT).feeCents);
    }
  });

  it('MARGINAL es continuo y monótono creciente en los umbrales (1.000 configuraciones)', () => {
    const random = createRandom(12);
    for (let i = 0; i < 1_000; i += 1) {
      const cfg = randomConfig(random, 'MARGINAL');
      const exempt = pick(random, [0, 100_000, between(random, 0, 3_000_000)]);
      for (const threshold of [cfg.t1MaxCents, cfg.t2MaxCents]) {
        const at = calculateBracketFeeCents(threshold, exempt, cfg).feeCents;
        const above = calculateBracketFeeCents(threshold + 1, exempt, cfg).feeCents;
        expect(above, JSON.stringify({ cfg, exempt, threshold })).toBeGreaterThanOrEqual(at);
        expect(above - at, JSON.stringify({ cfg, exempt, threshold })).toBeLessThanOrEqual(1);
      }
      const nets = Array.from({ length: 20 }, () => between(random, 0, 6_000_000)).sort((a, b) => a - b);
      const fees = nets.map((net) => calculateBracketFeeCents(net, exempt, cfg).feeCents);
      expect(fees).toEqual([...fees].sort((a, b) => a - b));
    }
  });

  it('todo exento no paga comisión y el exento mayor que el neto no da importes negativos', () => {
    expect(calculateBracketFeeCents(50_000, 100_000, FLAT).feeCents).toBe(0);
    expect(calculateBracketFeeCents(50_000, 100_000, MARGINAL)).toEqual({ rateBps: 500, feeCents: 0 });
  });

  it('con umbrales cruzados o iguales el tramo 2 queda vacío en los dos modos y nada se cobra dos veces', () => {
    for (const t2MaxCents of [100_000, 500_000]) {
      const crossed = { t1MaxCents: 500_000, t2MaxCents, ratesBps: { t1: 500, t2: 400, t3: 300 } };
      // 5.000 € al 5 % + 1.000 € al 3 %, sin exento.
      expect(calculateBracketFeeCents(600_000, 0, { ...crossed, mode: 'MARGINAL' }).feeCents).toBe(28_000);
      expect(calculateBracketFeeCents(600_000, 0, { ...crossed, mode: 'FLAT' })).toEqual({ rateBps: 300, feeCents: 18_000 });
      expect(calculateBracketFeeCents(400_000, 0, { ...crossed, mode: 'FLAT' }).rateBps).toBe(500);
    }
  });

  it('rechaza importes que no son enteros o son negativos', () => {
    expect(() => calculateBracketFeeCents(10.5, 0, FLAT)).toThrow(RangeError);
    expect(() => calculateBracketFeeCents(-1, 0, FLAT)).toThrow(RangeError);
    expect(() => calculateBracketFeeCents(100, Number.NaN, FLAT)).toThrow(RangeError);
    expect(() => calculateBracketFeeCents(100, 0, { ...FLAT, ratesBps: { t1: -1, t2: 0, t3: 0 } })).toThrow(RangeError);
  });

  it('las tarifas propias solo se aplican con customRules; modo y umbrales son siempre globales', () => {
    const own = { customRules: true, t1Bps: 400, t2Bps: 350, t3Bps: 250 };
    expect(bracketConfigFor(rules, own).ratesBps).toEqual({ t1: 400, t2: 350, t3: 250 });
    expect(bracketConfigFor(rules, { ...own, customRules: false }).ratesBps).toEqual({ t1: 500, t2: 400, t3: 300 });
    expect(bracketConfigFor({ ...rules, bracketMode: 'MARGINAL' }, own).mode).toBe('MARGINAL');
  });
});

describe('el motor reproduce las comisiones de la semilla', () => {
  const budgets = seed.initiatives.filter((initiative) => initiative.format === 'BUDGET');

  it.each(budgets.map((initiative) => [initiative.id, initiative] as const))('iniciativa %i: misma tarifa y misma comisión', (_id, initiative) => {
    const org = seed.schools.find((school) => school.id === initiative.organizationId)!;
    const net = initiative.costMatCents + initiative.costInstCents + Math.round(((initiative.costMatCents + initiative.costInstCents) * initiative.contingencyBps) / 10_000);
    const isExempt = seed.globalCategories.find((category) => category.name === initiative.category)?.rule === 'EXEMPT';
    if (isExempt) {
      expect(initiative.bracketFeeCents).toBe(0);
      return;
    }
    const fee = calculateBracketFeeCents(net, initiative.defaultExemptAppliedCents + initiative.medalExemptAppliedCents, bracketConfigFor(rules, org));
    expect(fee).toEqual({ rateBps: initiative.bracketRateAppliedBps, feeCents: initiative.bracketFeeCents });
  });

  it('la iniciativa 1 sale completa de la pizarra: meta 5.833,00 € y pasarela 78,60 €', () => {
    const tco = calculateStudioBudgetTCO({
      costMatCents: 380_000,
      costInstCents: 130_000,
      contingencyBps: 1_000,
      isCategoryExempt: false,
      baseExemptRemainingCents: 100_000,
      medalGrantAvailableCents: 100_000,
      bracketConfig: FLAT,
      maintConfig: { active: false, perInitCents: 4_900, annualCapCents: 14_700, alreadyChargedOrReservedCents: 0 },
      gatewayConfig: { pctBps: 100, fixedCents: 9, defaultDonationTicketCents: 2_500 }
    });
    expect(tco).toMatchObject({ netGuaranteedForSchoolCents: 561_000, bracketFeeCents: 14_440, gatewayFeeCents: 7_860, finalGoalCents: 583_300, medalSavedCents: 4_000, taxableCents: 361_000 });
  });
});

describe('QA-FIN03 · margen real en taquilla', () => {
  const event = { ticketMax: 200, digitalFeeConfig: { fixedCents: 45, pctBps: 200 }, gatewayConfig: { pctBps: 100, fixedCents: 9 }, maintFeeCents: 0 };

  it('en ADD, Paycomet cobra sobre 555 cts (6 + 9 = 15) y el margen es exactamente +40 cts por entrada', () => {
    const tco = calculateStudioTicketingTCO({ ...event, ticketPriceCents: 500, feeMode: 'ADD' });
    expect(tco).toMatchObject({
      digitalFeeUnitCents: 55,
      buyerUnitChargeCents: 555,
      gatewayUnitCostCents: 15,
      netKorumMarginPerTicketCents: 40,
      netKorumMarginAt100Cents: 8_000,
      grossTicketsCents: 100_000,
      netGuaranteedForSchoolCents: 100_000,
      isGatewayCovered: true
    });
  });

  it('en INC, los gastos salen del precio y Paycomet cobra sobre el precio', () => {
    const tco = calculateStudioTicketingTCO({ ...event, ticketPriceCents: 1_000, feeMode: 'INC', maintFeeCents: 4_900 });
    expect(tco).toMatchObject({ digitalFeeUnitCents: 65, buyerUnitChargeCents: 1_000, gatewayUnitCostCents: 19, netKorumMarginPerTicketCents: 46 });
    expect(tco.netGuaranteedForSchoolCents).toBe(200_000 - 13_000 - 4_900);
  });

  it('a margen cero la pasarela no se considera cubierta y el neto de la entidad no baja de 0', () => {
    // 5,14 € al comprador: 5 cts + 9 cts de pasarela, justo los 14 cts de gestión.
    const covered = calculateStudioTicketingTCO({ ...event, ticketPriceCents: 500, feeMode: 'ADD', digitalFeeConfig: { fixedCents: 14, pctBps: 0 } });
    expect(covered.netKorumMarginPerTicketCents).toBe(0);
    expect(covered.isGatewayCovered).toBe(false);
    expect(calculateStudioTicketingTCO({ ...event, ticketPriceCents: 10, feeMode: 'INC' }).netGuaranteedForSchoolCents).toBe(0);
  });

  it('en INC no se retiene más que el precio: una entrada de 0,40 € deja como mucho 0,31 € de margen', () => {
    const cheap = calculateStudioTicketingTCO({ ...event, ticketMax: 100, ticketPriceCents: 40, feeMode: 'INC' });
    expect(cheap).toMatchObject({ digitalFeeUnitCents: 40, gatewayUnitCostCents: 9, netKorumMarginPerTicketCents: 31, netKorumMarginAt100Cents: 3_100, netGuaranteedForSchoolCents: 0 });
  });

  it('un evento gratis en INC no inventa ingresos: sin cobro no hay pasarela ni margen', () => {
    expect(calculateStudioTicketingTCO({ ...event, ticketPriceCents: 0, feeMode: 'INC' })).toMatchObject({
      digitalFeeUnitCents: 0,
      buyerUnitChargeCents: 0,
      gatewayUnitCostCents: 0,
      netKorumMarginAt100Cents: 0,
      isGatewayCovered: false
    });
  });

  it('el neto a 0 no esconde el mantenimiento que la recaudación no cubre', () => {
    const tco = calculateStudioTicketingTCO({ ...event, ticketMax: 5, ticketPriceCents: 500, feeMode: 'ADD', maintFeeCents: 4_900 });
    expect(tco).toMatchObject({ netGuaranteedForSchoolCents: 0, maintShortfallCents: 2_400 });
  });

  it('rechaza tarifas de pasarela y de gestión que no son enteros positivos', () => {
    expect(() => gatewayChargeCostCents(100, { pctBps: 100, fixedCents: 0.5 })).toThrow(RangeError);
    expect(() => gatewayChargeCostCents(100, { pctBps: -100, fixedCents: 9 })).toThrow(RangeError);
    expect(() => calculateStudioTicketingTCO({ ...event, ticketPriceCents: 1_000, feeMode: 'ADD', digitalFeeConfig: { fixedCents: 45, pctBps: -5_000 } })).toThrow(RangeError);
    const budget = { ...randomBudget(createRandom(3), 'FLAT'), costMatCents: 100_000 };
    expect(() => calculateStudioBudgetTCO({ ...budget, gatewayConfig: { ...budget.gatewayConfig, pctBps: -500 } })).toThrow(RangeError);
    expect(() => calculateStudioBudgetTCO({ ...budget, gatewayConfig: { ...budget.gatewayConfig, fixedCents: 0.5 } })).toThrow(RangeError);
  });

  it('un aforo imposible no desborda en silencio', () => {
    expect(() => calculateStudioTicketingTCO({ ...event, ticketPriceCents: 500, feeMode: 'ADD', ticketMax: Number.MAX_SAFE_INTEGER })).toThrow(RangeError);
  });

  it('gatewayChargeCostCents aplica % + fijo con el redondeo del resto del motor', () => {
    expect(gatewayChargeCostCents(5_000, { pctBps: 100, fixedCents: 9 })).toBe(59);
    expect(gatewayChargeCostCents(50, { pctBps: 100, fixedCents: 9 })).toBe(10);
    expect(() => gatewayChargeCostCents(-1, { pctBps: 100, fixedCents: 9 })).toThrow(RangeError);
  });
});

describe('QA-FIN04 · tope anual de mantenimiento (Colegio San José: 49 €/campaña, tope 147 €, ya pagó 98 €)', () => {
  const maint = { active: true, perInitCents: 4_900, annualCapCents: 14_700 };

  it('los datos de San José en la semilla son los del escenario', () => {
    expect(seed.schools.find((school) => school.id === 'SANJOSE')).toMatchObject({ maintActive: true, maintPerInitCents: 4_900, maintAnnualCapCents: 14_700, maintPaidCents: 9_800 });
  });

  it('la 3ª campaña aplica 49,00 € hasta 147,00 € y desde la 4ª aplica 0,00 €', () => {
    expect(evaluateMaintenanceCapShutoff({ ...maint, alreadyChargedOrReservedCents: 9_800 })).toEqual({ maintFeeCents: 4_900, remainingToCapCents: 4_900, remainingAfterCents: 0, capReached: true });
    expect(evaluateMaintenanceCapShutoff({ ...maint, alreadyChargedOrReservedCents: 14_700 })).toEqual({ maintFeeCents: 0, remainingToCapCents: 0, remainingAfterCents: 0, capReached: true });
  });

  it('una campaña que llega justa al tope paga solo lo que falta; si está desactivado, 0', () => {
    expect(evaluateMaintenanceCapShutoff({ ...maint, alreadyChargedOrReservedCents: 12_000 }).maintFeeCents).toBe(2_700);
    expect(evaluateMaintenanceCapShutoff({ ...maint, alreadyChargedOrReservedCents: 20_000 }).maintFeeCents).toBe(0);
    expect(evaluateMaintenanceCapShutoff({ ...maint, active: false, alreadyChargedOrReservedCents: 0 })).toMatchObject({ maintFeeCents: 0, capReached: false });
  });

  it('la pizarra del Estudio aplica el tope y sigue cuadrando', () => {
    const budget = (alreadyChargedOrReservedCents: number) =>
      calculateStudioBudgetTCO({
        costMatCents: 100_000,
        costInstCents: 0,
        contingencyBps: 0,
        isCategoryExempt: false,
        baseExemptRemainingCents: 0,
        medalGrantAvailableCents: 0,
        bracketConfig: FLAT,
        maintConfig: { ...maint, alreadyChargedOrReservedCents },
        gatewayConfig: { pctBps: 100, fixedCents: 9, defaultDonationTicketCents: 2_500 }
      });
    const third = budget(9_800);
    const fourth = budget(14_700);
    expect(third.maintFeeCents).toBe(4_900);
    expect(fourth.maintFeeCents).toBe(0);
    for (const tco of [third, fourth]) {
      expect(tco.netGuaranteedForSchoolCents + tco.bracketFeeCents + tco.maintFeeCents + tco.gatewayFeeCents).toBe(tco.finalGoalCents);
    }
  });
});

describe('calculatePublicBreakdown4Lines · cuadre público', () => {
  it('las 8 iniciativas de la semilla suman su meta en 4 líneas', () => {
    for (const initiative of seed.initiatives) {
      const lines = calculatePublicBreakdown4Lines(initiative);
      expect(lines.line1ProviderCents + lines.line2InstallCents + lines.line3ContingencyCents + lines.line4EscrowAndGuaranteeCents, `iniciativa ${initiative.id}`).toBe(initiative.goalCents);
    }
  });

  it('no publica un desglose falso si el coste real supera la meta', () => {
    expect(() => calculatePublicBreakdown4Lines({ costMatCents: 100_000, costInstCents: 0, contingencyBps: 1_000, goalCents: 100_000 })).toThrow(PublicBreakdownMismatchError);
  });
});
