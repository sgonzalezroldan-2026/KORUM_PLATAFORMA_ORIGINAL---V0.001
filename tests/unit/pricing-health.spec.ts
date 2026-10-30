import { describe, expect, it } from 'vitest';
import {
  countOpenPricingAlerts,
  evaluatePricingHealth,
  reviewPricingAlerts,
  type PricingAcknowledgement,
  type PricingAlertCode
} from '@/core/finance/pricing-health';
import { loadSeedData } from '@/seed/seed-types';
import type { KorumGlobalRulesCents } from '@/types/korum.types';

const defaults: KorumGlobalRulesCents = loadSeedData().globalRules;
const codes = (rules: KorumGlobalRulesCents) => evaluatePricingHealth(rules).map((alert) => alert.code);
const alertOf = (rules: KorumGlobalRulesCents, code: PricingAlertCode) => evaluatePricingHealth(rules).find((alert) => alert.code === code);

describe('QA-FIN06 · salud de precios con los valores por defecto', () => {
  it('produce exactamente HUCHA_FEE_BELOW_GATEWAY_COST y BRACKET_CLIFF, con el crítico primero', () => {
    expect(codes(defaults)).toEqual(['HUCHA_FEE_BELOW_GATEWAY_COST', 'BRACKET_CLIFF']);
  });

  it('Mi Hucha: un cargo de 50 € cuesta 0,59 €, cobra 0,25 € y pierde 0,34 €; es rentable hasta 16 €', () => {
    expect(alertOf(defaults, 'HUCHA_FEE_BELOW_GATEWAY_COST')).toMatchObject({
      severity: 'CRITICAL',
      params: { amountCents: 5_000, gatewayCostCents: 59, feeCents: 25, lossCents: 34, profitableUpToCents: 1_600, profitableFromCents: 0 }
    });
  });

  it('efecto escalón: con 1.000 € exentos, 5.000,00 € paga 200 € y 5.000,01 € paga 160 €, en los dos umbrales', () => {
    expect(alertOf(defaults, 'BRACKET_CLIFF')).toMatchObject({
      severity: 'WARNING',
      params: { thresholdCents: 500_000, feeAtCents: 20_000, feeAboveCents: 16_000, exemptCents: 100_000, dropCents: 4_000, worstDropCents: 14_000, cliffCount: 2 }
    });
  });

  it('cada aviso indica los ajustes que hay que tocar', () => {
    expect(alertOf(defaults, 'HUCHA_FEE_BELOW_GATEWAY_COST')?.settingKeys).toEqual(expect.arrayContaining(['topupFeeCents', 'topupFeeBps', 'gatewayPctBps', 'gatewayFixedCents']));
    expect(alertOf(defaults, 'BRACKET_CLIFF')?.settingKeys).toEqual(expect.arrayContaining(['bracketMode', 't1MaxCents', 't2MaxCents', 'exemptLimitCents']));
  });
});

describe('cada código salta cuando debe y solo cuando debe', () => {
  it('Mi Hucha con 1 % + 0,10 € no avisa', () => {
    expect(codes({ ...defaults, topupFeeCents: 10, topupFeeBps: 100 })).not.toContain('HUCHA_FEE_BELOW_GATEWAY_COST');
  });

  it('Mi Hucha justo a coste no avisa: no pierde dinero', () => {
    expect(codes({ ...defaults, topupFeeCents: 9, topupFeeBps: 100 })).not.toContain('HUCHA_FEE_BELOW_GATEWAY_COST');
  });

  it('Mi Hucha con porcentaje alto y sin fijo pierde en los cargos bajos: rentable desde, no hasta', () => {
    expect(alertOf({ ...defaults, topupFeeCents: 0, topupFeeBps: 200 }, 'HUCHA_FEE_BELOW_GATEWAY_COST')?.params).toMatchObject({ amountCents: 500, lossCents: 4, profitableUpToCents: 0, profitableFromCents: 900 });
  });

  it('si no se llega a cubrir nunca, ni desde ni hasta', () => {
    expect(alertOf({ ...defaults, topupFeeCents: 0, topupFeeBps: 0 }, 'HUCHA_FEE_BELOW_GATEWAY_COST')?.params).toMatchObject({ profitableUpToCents: 0, profitableFromCents: 0 });
  });

  it('los gastos de gestión digital por debajo de la pasarela avisan con el peor precio', () => {
    expect(alertOf({ ...defaults, ticketFeeFixedCents: 5, ticketFeeBps: 0 }, 'TICKET_FEE_BELOW_GATEWAY_COST')).toMatchObject({
      severity: 'CRITICAL',
      // Entrada de 50 € + 0,05 €: 50 cts + 9 cts de pasarela, frente a 5 cts de gestión.
      params: { priceCents: 5_000, feeCents: 5, gatewayCostCents: 59, lossCents: 54 }
    });
  });

  it('una entrada a margen cero también avisa (la Regla 02 §6 exige margen positivo)', () => {
    // 2 € + 0,11 €: 2 cts + 9 cts de pasarela = 11 cts de coste. Margen 0 en el precio de prueba más bajo y negativo en los altos.
    expect(codes({ ...defaults, ticketFeeFixedCents: 11, ticketFeeBps: 0 })).toContain('TICKET_FEE_BELOW_GATEWAY_COST');
    expect(alertOf({ ...defaults, ticketFeeFixedCents: 10, ticketFeeBps: 100, gatewayFixedCents: 10, gatewayPctBps: 0 }, 'TICKET_FEE_BELOW_GATEWAY_COST')).toBeUndefined();
    expect(alertOf({ ...defaults, ticketFeeFixedCents: 10, ticketFeeBps: 0, gatewayFixedCents: 10, gatewayPctBps: 0 }, 'TICKET_FEE_BELOW_GATEWAY_COST')?.params.lossCents).toBe(0);
  });

  it('sin fee de patrocinio se pierde la pasarela de cada comercio', () => {
    expect(alertOf({ ...defaults, sponsorFeeBps: 0 }, 'SPONSOR_FEE_BELOW_GATEWAY_COST')).toMatchObject({ severity: 'CRITICAL', params: { tierCents: 50_000, feeCents: 0, gatewayCostCents: 509, lossCents: 509 } });
    expect(codes(defaults)).not.toContain('SPONSOR_FEE_BELOW_GATEWAY_COST');
  });

  it('en MARGINAL no hay escalón', () => {
    expect(codes({ ...defaults, bracketMode: 'MARGINAL' })).not.toContain('BRACKET_CLIFF');
  });

  it('en FLAT con tarifas iguales tampoco hay escalón; con un exento enorme, ninguno', () => {
    expect(codes({ ...defaults, t1Bps: 400, t2Bps: 400, t3Bps: 400 })).not.toContain('BRACKET_CLIFF');
    expect(codes({ ...defaults, exemptLimitCents: 2_000_000 })).not.toContain('BRACKET_CLIFF');
    expect(alertOf({ ...defaults, exemptLimitCents: 600_000 }, 'BRACKET_CLIFF')?.params).toMatchObject({ thresholdCents: 1_500_000, cliffCount: 1 });
  });

  it('avisa si las tarifas no bajan al subir de tramo', () => {
    expect(alertOf({ ...defaults, t1Bps: 300, t2Bps: 400, t3Bps: 200 }, 'BRACKET_RATES_NOT_DECREASING')).toMatchObject({ severity: 'WARNING', params: { t1Bps: 300, t2Bps: 400, t3Bps: 200 } });
    expect(codes({ ...defaults, t2Bps: 400, t3Bps: 500 })).toContain('BRACKET_RATES_NOT_DECREASING');
    expect(codes({ ...defaults, t1Bps: 400, t2Bps: 400, t3Bps: 400 })).not.toContain('BRACKET_RATES_NOT_DECREASING');
  });

  it('SOURCE_NEGATIVE_MARGIN solo salta con un margen real negativo, un aviso por fuente', () => {
    const alerts = evaluatePricingHealth(defaults, { huchaTopupFeeCents: -816, sponsorFeeCents: 0, bracketFeeCents: 5_000, digitalTicketFeeCents: -1 });
    const negative = alerts.filter((alert) => alert.code === 'SOURCE_NEGATIVE_MARGIN');
    expect(negative.map((alert) => alert.source)).toEqual(['huchaTopupFeeCents', 'digitalTicketFeeCents']);
    expect(negative[0]).toMatchObject({ severity: 'CRITICAL', params: { marginCents: -816 } });
    expect(negative[0]?.settingKeys).toContain('topupFeeCents');
    expect(evaluatePricingHealth(defaults, { huchaTopupFeeCents: 0 }).some((alert) => alert.code === 'SOURCE_NEGATIVE_MARGIN')).toBe(false);
  });

  it('umbrales cruzados: avisa en los dos modos, no lanza y no calcula un escalón sin sentido', () => {
    for (const bracketMode of ['FLAT', 'MARGINAL'] as const) {
      for (const t1MaxCents of [2_000_000, 1_500_001]) {
        const found = codes({ ...defaults, bracketMode, t1MaxCents });
        expect(found).toContain('BRACKET_THRESHOLDS_INVALID');
        expect(found).not.toContain('BRACKET_CLIFF');
      }
    }
    expect(alertOf({ ...defaults, t1MaxCents: 2_000_000 }, 'BRACKET_THRESHOLDS_INVALID')).toMatchObject({ severity: 'CRITICAL', params: { t1MaxCents: 2_000_000, t2MaxCents: 1_500_000 } });
  });

  it('umbrales iguales: el tramo 2 está vacío, no es un error y el salto se cuenta una sola vez', () => {
    const rules = { ...defaults, t1MaxCents: 1_500_000 };
    expect(codes(rules)).not.toContain('BRACKET_THRESHOLDS_INVALID');
    expect(alertOf(rules, 'BRACKET_CLIFF')?.params.cliffCount).toBe(1);
  });

  it('un valor editado imposible nunca lanza: avisa y señala el campo', () => {
    for (const value of [Number.NaN, -1, 12.5, 2_000_000_000, Number.POSITIVE_INFINITY]) {
      for (const key of ['t1MaxCents', 'gatewayFixedCents', 'gatewayPctBps', 'topupFeeBps', 'ticketFeeBps', 'exemptLimitCents'] as const) {
        const alerts = evaluatePricingHealth({ ...defaults, [key]: value });
        expect(alerts.map((alert) => alert.code)).toEqual(['RULE_VALUE_INVALID']);
        expect(alerts[0]?.settingKeys).toEqual([key]);
      }
    }
    expect(codes(defaults)).not.toContain('RULE_VALUE_INVALID');
  });

  it('los críticos van siempre antes que los avisos', () => {
    const severities = evaluatePricingHealth({ ...defaults, t1Bps: 100, sponsorFeeBps: 0, t2MaxCents: 400_000 }, { maintFeeCents: -1 }).map((alert) => alert.severity);
    expect(severities).toEqual([...severities].sort());
    expect(severities).toContain('WARNING');
  });
});

describe('huella y aceptación de avisos', () => {
  const ack = (code: PricingAlertCode, fingerprint: string): PricingAcknowledgement => ({
    code,
    fingerprint,
    acknowledgedById: 'superadmin',
    acknowledgedAt: '2026-10-30T10:00:00.000Z',
    note: 'La Hucha es coste de captación'
  });

  it('cambiar un valor implicado cambia la huella; cambiar otro no', () => {
    const fingerprint = alertOf(defaults, 'HUCHA_FEE_BELOW_GATEWAY_COST')!.fingerprint;
    expect(alertOf({ ...defaults, topupFeeCents: 26 }, 'HUCHA_FEE_BELOW_GATEWAY_COST')!.fingerprint).not.toBe(fingerprint);
    expect(alertOf({ ...defaults, gatewayFixedCents: 10 }, 'HUCHA_FEE_BELOW_GATEWAY_COST')!.fingerprint).not.toBe(fingerprint);
    expect(alertOf({ ...defaults, t1Bps: 450 }, 'HUCHA_FEE_BELOW_GATEWAY_COST')!.fingerprint).toBe(fingerprint);
  });

  it('el aviso de margen real conserva la huella aunque cambie el margen, y la cambia con la configuración', () => {
    const fingerprintOf = (margin: number, rules = defaults) => evaluatePricingHealth(rules, { huchaTopupFeeCents: margin }).find((alert) => alert.code === 'SOURCE_NEGATIVE_MARGIN')!.fingerprint;
    expect(fingerprintOf(-100)).toBe(fingerprintOf(-999));
    expect(fingerprintOf(-100, { ...defaults, topupFeeCents: 30 })).not.toBe(fingerprintOf(-100));
    const other = evaluatePricingHealth(defaults, { maintFeeCents: -100 }).find((alert) => alert.code === 'SOURCE_NEGATIVE_MARGIN')!.fingerprint;
    expect(other).not.toBe(fingerprintOf(-100));
  });

  it('un aviso aceptado no desaparece: queda marcado y deja de contar como abierto', () => {
    const alerts = evaluatePricingHealth(defaults);
    const hucha = alerts.find((alert) => alert.code === 'HUCHA_FEE_BELOW_GATEWAY_COST')!;
    const reviewed = reviewPricingAlerts(alerts, [ack(hucha.code, hucha.fingerprint)]);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.find((alert) => alert.code === hucha.code)?.acknowledgement?.note).toBe('La Hucha es coste de captación');
    expect(reviewed.find((alert) => alert.code === 'BRACKET_CLIFF')?.acknowledgement).toBeNull();
    expect(countOpenPricingAlerts(reviewed)).toEqual({ open: 1, openCritical: 0 });
  });

  it('si cambia la configuración, el aviso aceptado vuelve a saltar como nuevo', () => {
    const hucha = alertOf(defaults, 'HUCHA_FEE_BELOW_GATEWAY_COST')!;
    const reviewed = reviewPricingAlerts(evaluatePricingHealth({ ...defaults, topupFeeCents: 20 }), [ack(hucha.code, hucha.fingerprint)]);
    expect(reviewed.find((alert) => alert.code === hucha.code)?.acknowledgement).toBeNull();
    expect(countOpenPricingAlerts(reviewed)).toEqual({ open: 2, openCritical: 1 });
  });

  it('una aceptación de otro código con la misma huella no vale', () => {
    const hucha = alertOf(defaults, 'HUCHA_FEE_BELOW_GATEWAY_COST')!;
    expect(reviewPricingAlerts([hucha], [ack('BRACKET_CLIFF', hucha.fingerprint)])[0]?.acknowledgement).toBeNull();
  });

  it('evaluar nunca bloquea ni modifica las reglas: una configuración mala solo devuelve avisos', () => {
    const bad = { ...defaults, topupFeeCents: 0, ticketFeeFixedCents: 0, ticketFeeBps: 0, sponsorFeeBps: 0, t1Bps: 0, t2Bps: 100, t3Bps: 200 };
    const snapshot = JSON.stringify(bad);
    expect(evaluatePricingHealth(bad).length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(bad)).toBe(snapshot);
  });
});
