import type { KorumGlobalRulesCents } from '@/types/korum.types';
import type { RevenueSourceKey } from './bi-analytics.service';
import { bpsOf } from './money';
import { bracketConfigFor, calculateBracketFeeCents, gatewayChargeCostCents } from './tco.service';

/**
 * Salud de precios (skill korum-tco-calculator §2.1; docs/DECISIONES_TECNICAS.md §6.1). Decisión del promotor: ninguna regla se
 * bloquea. Si una combinación pierde dinero o es incoherente, se avisa con las cifras para que decida el Super-Admin; ninguna
 * función de este módulo impide guardar. Los textos salen de los catálogos (`admin.pricingHealth.<code>`), aquí solo hay cifras.
 */

export type PricingAlertCode =
  | 'HUCHA_FEE_BELOW_GATEWAY_COST'
  | 'TICKET_FEE_BELOW_GATEWAY_COST'
  | 'SPONSOR_FEE_BELOW_GATEWAY_COST'
  | 'RULE_VALUE_INVALID'
  | 'BRACKET_THRESHOLDS_INVALID'
  | 'BRACKET_CLIFF'
  | 'BRACKET_RATES_NOT_DECREASING'
  | 'SOURCE_NEGATIVE_MARGIN';

export type PricingAlertSeverity = 'CRITICAL' | 'WARNING';

export interface PricingAlert {
  code: PricingAlertCode;
  severity: PricingAlertSeverity;
  /** Cifras para el mensaje (importes en céntimos). */
  params: Record<string, number>;
  /** Huella de los valores de configuración implicados: si cambian, una aceptación anterior deja de valer. */
  fingerprint: string;
  /** Ajustes que habría que tocar (para el botón «Ajustar»). */
  settingKeys: string[];
  /** Solo en `SOURCE_NEGATIVE_MARGIN`: la fuente de ingresos afectada. */
  source?: RevenueSourceKey;
}

/** Aceptación guardada en `PlatformSetting` (`pricing.acknowledgements`). */
export interface PricingAcknowledgement {
  code: PricingAlertCode;
  fingerprint: string;
  acknowledgedById: string;
  acknowledgedAt: string;
  note: string;
}

export type ReviewedPricingAlert = PricingAlert & { acknowledgement: PricingAcknowledgement | null };

export const HUCHA_PROBE_AMOUNTS_CENTS = [500, 1000, 2500, 5000, 10000] as const;
export const TICKET_PROBE_PRICES_CENTS = [200, 500, 1000, 2000, 5000] as const;
/** Niveles de patrocinio de la Regla 02 §5. */
export const SPONSOR_TIERS_CENTS = [10000, 25000, 50000] as const;
/** Cargo de Mi Hucha con el que se explica el aviso si pierde dinero: un importe fácil de imaginar. */
const HUCHA_REFERENCE_AMOUNT_CENTS = 5000;

type RuleKey = keyof KorumGlobalRulesCents;

const GATEWAY_KEYS: readonly RuleKey[] = ['gatewayPctBps', 'gatewayFixedCents'];
const HUCHA_KEYS: readonly RuleKey[] = ['topupFeeCents', 'topupFeeBps', ...GATEWAY_KEYS];
const TICKET_KEYS: readonly RuleKey[] = ['ticketFeeFixedCents', 'ticketFeeBps', ...GATEWAY_KEYS];
const SPONSOR_KEYS: readonly RuleKey[] = ['sponsorFeeBps', ...GATEWAY_KEYS];
const BRACKET_RATE_KEYS: readonly RuleKey[] = ['t1Bps', 't2Bps', 't3Bps'];
const BRACKET_KEYS: readonly RuleKey[] = ['bracketMode', 't1MaxCents', 't2MaxCents', ...BRACKET_RATE_KEYS, 'exemptLimitCents'];

/** Valores que entran en los cálculos. Por encima de este límite (10 M€ o 10.000.000 %) no es una regla de precios, es una errata. */
const NUMERIC_RULE_KEYS: readonly RuleKey[] = ['exemptLimitCents', 't1MaxCents', 't2MaxCents', ...BRACKET_RATE_KEYS, 'sponsorFeeBps', 'gatewayPctBps', 'gatewayFixedCents', 'topupFeeCents', 'topupFeeBps', 'ticketFeeFixedCents', 'ticketFeeBps'];
const MAX_RULE_VALUE = 1_000_000_000;

const SOURCE_KEYS: Record<RevenueSourceKey, readonly RuleKey[]> = {
  bracketFeeCents: [...BRACKET_KEYS, ...GATEWAY_KEYS],
  supportGuaranteeCents: ['fullIntegrityCheckCents', 'guaranteePresetsCents', 'defaultGuaranteeIdx', ...GATEWAY_KEYS],
  sponsorFeeCents: SPONSOR_KEYS,
  digitalTicketFeeCents: TICKET_KEYS,
  maintFeeCents: ['maintActive', 'maintPerInitCents', 'maintAnnualCapCents', ...GATEWAY_KEYS],
  huchaTopupFeeCents: HUCHA_KEYS
};

/** Texto estable y legible: se puede calcular también en el navegador, mientras se edita un campo. */
function fingerprintOf(code: PricingAlertCode, rules: KorumGlobalRulesCents, keys: readonly RuleKey[], scope = ''): string {
  const values = [...keys].sort().map((key) => `${key}=${String(rules[key])}`);
  return [code, scope, ...values].filter((part) => part !== '').join('|');
}

function evaluateHuchaFee(rules: KorumGlobalRulesCents, gateway: { pctBps: number; fixedCents: number }): PricingAlert | null {
  const marginAt = (amountCents: number) => rules.topupFeeCents + bpsOf(amountCents, rules.topupFeeBps) - gatewayChargeCostCents(amountCents, gateway);
  const losing = HUCHA_PROBE_AMOUNTS_CENTS.filter((amountCents) => marginAt(amountCents) < 0);
  if (losing.length === 0) return null;

  const referenceCents = losing.find((amountCents) => amountCents === HUCHA_REFERENCE_AMOUNT_CENTS) ?? losing[losing.length - 1]!;
  const largestProbeCents = HUCHA_PROBE_AMOUNTS_CENTS[HUCHA_PROBE_AMOUNTS_CENTS.length - 1]!;
  // En euros enteros, dentro de los importes probados. Lo normal es perder con los cargos altos («rentable hasta»); si el
  // porcentaje del fee supera al de la pasarela, se pierde con los bajos («rentable desde»).
  let profitableUpToCents = 0;
  for (let cents = 100; cents <= largestProbeCents && marginAt(cents) >= 0; cents += 100) profitableUpToCents = cents;
  let profitableFromCents = 0;
  for (let cents = largestProbeCents; cents >= 100 && marginAt(cents) >= 0; cents -= 100) profitableFromCents = cents;

  return {
    code: 'HUCHA_FEE_BELOW_GATEWAY_COST',
    severity: 'CRITICAL',
    params: {
      amountCents: referenceCents,
      gatewayCostCents: gatewayChargeCostCents(referenceCents, gateway),
      feeCents: rules.topupFeeCents + bpsOf(referenceCents, rules.topupFeeBps),
      lossCents: -marginAt(referenceCents),
      profitableUpToCents,
      profitableFromCents
    },
    fingerprint: fingerprintOf('HUCHA_FEE_BELOW_GATEWAY_COST', rules, HUCHA_KEYS),
    settingKeys: [...HUCHA_KEYS]
  };
}

/** Regla 02 §6: el margen de una entrada debe ser estrictamente positivo; a coste cero tampoco está cubierta. */
function evaluateTicketFee(rules: KorumGlobalRulesCents, gateway: { pctBps: number; fixedCents: number }): PricingAlert | null {
  const probes = TICKET_PROBE_PRICES_CENTS.map((priceCents) => {
    const feeCents = rules.ticketFeeFixedCents + bpsOf(priceCents, rules.ticketFeeBps);
    const gatewayCostCents = gatewayChargeCostCents(priceCents + feeCents, gateway);
    return { priceCents, feeCents, gatewayCostCents, marginCents: feeCents - gatewayCostCents };
  });
  const worst = probes.reduce((lowest, probe) => (probe.marginCents < lowest.marginCents ? probe : lowest));
  if (worst.marginCents > 0) return null;
  return {
    code: 'TICKET_FEE_BELOW_GATEWAY_COST',
    severity: 'CRITICAL',
    params: { priceCents: worst.priceCents, feeCents: worst.feeCents, gatewayCostCents: worst.gatewayCostCents, lossCents: Math.abs(worst.marginCents) },
    fingerprint: fingerprintOf('TICKET_FEE_BELOW_GATEWAY_COST', rules, TICKET_KEYS),
    settingKeys: [...TICKET_KEYS]
  };
}

function evaluateSponsorFee(rules: KorumGlobalRulesCents, gateway: { pctBps: number; fixedCents: number }): PricingAlert | null {
  const probes = SPONSOR_TIERS_CENTS.map((tierCents) => {
    const feeCents = bpsOf(tierCents, rules.sponsorFeeBps);
    const gatewayCostCents = gatewayChargeCostCents(tierCents + feeCents, gateway);
    return { tierCents, feeCents, gatewayCostCents, marginCents: feeCents - gatewayCostCents };
  });
  const worst = probes.reduce((lowest, probe) => (probe.marginCents < lowest.marginCents ? probe : lowest));
  if (worst.marginCents >= 0) return null;
  return {
    code: 'SPONSOR_FEE_BELOW_GATEWAY_COST',
    severity: 'CRITICAL',
    params: { tierCents: worst.tierCents, feeCents: worst.feeCents, gatewayCostCents: worst.gatewayCostCents, lossCents: -worst.marginCents },
    fingerprint: fingerprintOf('SPONSOR_FEE_BELOW_GATEWAY_COST', rules, SPONSOR_KEYS),
    settingKeys: [...SPONSOR_KEYS]
  };
}

/** Un valor vacío, negativo o con decimales mientras se edita: se avisa y no se evalúa nada más, porque las cifras no significarían nada. */
function evaluateRuleValues(rules: KorumGlobalRulesCents): PricingAlert | null {
  const isValid = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_RULE_VALUE;
  const invalid = NUMERIC_RULE_KEYS.filter((key) => !isValid(rules[key]));
  if (invalid.length === 0) return null;
  return {
    code: 'RULE_VALUE_INVALID',
    severity: 'CRITICAL',
    params: { invalidCount: invalid.length },
    fingerprint: fingerprintOf('RULE_VALUE_INVALID', rules, invalid),
    settingKeys: [...invalid]
  };
}

/** Umbrales cruzados: el motor deja vacío el tramo 2 y sigue funcionando, pero seguro que no es lo que se quería. */
function evaluateBracketThresholds(rules: KorumGlobalRulesCents): PricingAlert | null {
  if (rules.t1MaxCents <= rules.t2MaxCents) return null;
  const keys: readonly RuleKey[] = ['t1MaxCents', 't2MaxCents'];
  return {
    code: 'BRACKET_THRESHOLDS_INVALID',
    severity: 'CRITICAL',
    params: { t1MaxCents: rules.t1MaxCents, t2MaxCents: rules.t2MaxCents },
    fingerprint: fingerprintOf('BRACKET_THRESHOLDS_INVALID', rules, keys),
    settingKeys: [...keys]
  };
}

/** Solo en `FLAT`: un céntimo más de presupuesto en un umbral paga menos comisión. Un aviso por código: el primer salto y el mayor. */
function evaluateBracketCliff(rules: KorumGlobalRulesCents): PricingAlert | null {
  if (rules.bracketMode !== 'FLAT' || rules.t1MaxCents > rules.t2MaxCents) return null;
  const config = bracketConfigFor(rules);
  const cliffs = [...new Set([rules.t1MaxCents, rules.t2MaxCents])]
    .map((thresholdCents) => ({
      thresholdCents,
      feeAtCents: calculateBracketFeeCents(thresholdCents, rules.exemptLimitCents, config).feeCents,
      feeAboveCents: calculateBracketFeeCents(thresholdCents + 1, rules.exemptLimitCents, config).feeCents
    }))
    .filter((cliff) => cliff.feeAboveCents < cliff.feeAtCents);
  const first = cliffs[0];
  if (!first) return null;
  return {
    code: 'BRACKET_CLIFF',
    severity: 'WARNING',
    params: {
      ...first,
      exemptCents: rules.exemptLimitCents,
      dropCents: first.feeAtCents - first.feeAboveCents,
      worstDropCents: Math.max(...cliffs.map((cliff) => cliff.feeAtCents - cliff.feeAboveCents)),
      cliffCount: cliffs.length
    },
    fingerprint: fingerprintOf('BRACKET_CLIFF', rules, BRACKET_KEYS),
    settingKeys: [...BRACKET_KEYS]
  };
}

function evaluateBracketRates(rules: KorumGlobalRulesCents): PricingAlert | null {
  if (rules.t1Bps >= rules.t2Bps && rules.t2Bps >= rules.t3Bps) return null;
  return {
    code: 'BRACKET_RATES_NOT_DECREASING',
    severity: 'WARNING',
    params: { t1Bps: rules.t1Bps, t2Bps: rules.t2Bps, t3Bps: rules.t3Bps },
    fingerprint: fingerprintOf('BRACKET_RATES_NOT_DECREASING', rules, BRACKET_RATE_KEYS),
    settingKeys: [...BRACKET_RATE_KEYS]
  };
}

/**
 * Avisos de las reglas de precio, los `CRITICAL` primero. `realSourceMarginsCents` son los márgenes reales del libro mayor en el
 * periodo visible (ingreso menos pasarela de esos cobros), que llegan con el BI del Sprint 5.1. La huella de ese aviso no incluye
 * el margen: cambia con cada cobro, y una aceptación solo debe caducar si cambia la configuración.
 * Nunca lanza, sea cual sea el valor editado: `RULE_VALUE_INVALID` sustituye a los cálculos que ese valor haría imposibles.
 */
export function evaluatePricingHealth(rules: KorumGlobalRulesCents, realSourceMarginsCents: Partial<Record<RevenueSourceKey, number>> = {}): PricingAlert[] {
  const invalidValues = evaluateRuleValues(rules);
  if (invalidValues) return [invalidValues];

  const gateway = { pctBps: rules.gatewayPctBps, fixedCents: rules.gatewayFixedCents };
  const sourceAlerts = Object.entries(realSourceMarginsCents)
    .filter(([, marginCents]) => marginCents < 0)
    .map(([key, marginCents]): PricingAlert => {
      const source = key as RevenueSourceKey;
      return {
        code: 'SOURCE_NEGATIVE_MARGIN',
        severity: 'CRITICAL',
        source,
        params: { marginCents },
        fingerprint: fingerprintOf('SOURCE_NEGATIVE_MARGIN', rules, SOURCE_KEYS[source], source),
        settingKeys: [...SOURCE_KEYS[source]]
      };
    });

  return [
    evaluateHuchaFee(rules, gateway),
    evaluateTicketFee(rules, gateway),
    evaluateSponsorFee(rules, gateway),
    ...sourceAlerts,
    evaluateBracketThresholds(rules),
    evaluateBracketCliff(rules),
    evaluateBracketRates(rules)
  ].filter((alert): alert is PricingAlert => alert !== null);
}

/**
 * Cruza los avisos con las aceptaciones. Un aviso aceptado no desaparece (se muestra atenuado); si cambia su huella, vuelve a
 * saltar como nuevo porque la aceptación ya no coincide.
 */
export function reviewPricingAlerts(alerts: readonly PricingAlert[], acknowledgements: readonly PricingAcknowledgement[]): ReviewedPricingAlert[] {
  return alerts.map((alert) => ({
    ...alert,
    acknowledgement: acknowledgements.find((ack) => ack.code === alert.code && ack.fingerprint === alert.fingerprint) ?? null
  }));
}

/** Insignia de la cabecera de `/admin`: avisos sin aceptar, y si alguno es crítico (banner de la portada). */
export function countOpenPricingAlerts(reviewed: readonly ReviewedPricingAlert[]): { open: number; openCritical: number } {
  const open = reviewed.filter((alert) => alert.acknowledgement === null);
  return { open: open.length, openCritical: open.filter((alert) => alert.severity === 'CRITICAL').length };
}
