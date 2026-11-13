import { GLOBAL_RULE_LIMITS, GUARANTEE_PRESET_COUNT, globalRulesSchema, type GlobalRulesInput } from '@/core/admin/global-rules';
import { MoneyParseError, parseEurosToCents } from '@/core/finance/money';

/**
 * Modelo del formulario de reglas globales: lo que escribe la persona (texto, con la coma o el punto de su idioma) y cómo se convierte en las reglas enteras
 * (céntimos y puntos básicos) que valida el servidor. Sin React: el formulario y sus pruebas usan lo mismo.
 */

export type PresetKey = `preset${0 | 1 | 2 | 3}`;
export type NumericKey =
  | 'exemptLimitCents'
  | 't1MaxCents'
  | 't2MaxCents'
  | 't1Bps'
  | 't2Bps'
  | 't3Bps'
  | 'sponsorFeeBps'
  | 'fullIntegrityCheckCents'
  | 'gatewayPctBps'
  | 'gatewayFixedCents'
  | 'topupFeeCents'
  | 'topupFeeBps'
  | 'ticketFeeFixedCents'
  | 'ticketFeeBps'
  | 'maintPerInitCents'
  | 'maintAnnualCapCents'
  | 'maxCampaignDays'
  | 'creditPoolMaxDays'
  | PresetKey;

export type FieldKind = 'eur' | 'pct' | 'days';
export interface FieldDef {
  key: NumericKey;
  kind: FieldKind;
  max: number;
  min: number;
}

const eur = (key: NumericKey, max: number): FieldDef => ({ key, kind: 'eur', max, min: 0 });
const pct = (key: NumericKey): FieldDef => ({ key, kind: 'pct', max: 10_000, min: 0 });

export const PRESET_KEYS: readonly PresetKey[] = ['preset0', 'preset1', 'preset2', 'preset3'];

export const NUMERIC_FIELDS: readonly FieldDef[] = [
  eur('exemptLimitCents', GLOBAL_RULE_LIMITS.exemptLimitCents),
  eur('t1MaxCents', GLOBAL_RULE_LIMITS.thresholdCents),
  eur('t2MaxCents', GLOBAL_RULE_LIMITS.thresholdCents),
  pct('t1Bps'),
  pct('t2Bps'),
  pct('t3Bps'),
  pct('sponsorFeeBps'),
  eur('fullIntegrityCheckCents', GLOBAL_RULE_LIMITS.guaranteeCents),
  ...PRESET_KEYS.map((key) => eur(key, GLOBAL_RULE_LIMITS.guaranteeCents)),
  pct('gatewayPctBps'),
  eur('gatewayFixedCents', GLOBAL_RULE_LIMITS.gatewayFixedCents),
  eur('topupFeeCents', GLOBAL_RULE_LIMITS.smallCents),
  pct('topupFeeBps'),
  eur('ticketFeeFixedCents', GLOBAL_RULE_LIMITS.smallCents),
  pct('ticketFeeBps'),
  eur('maintPerInitCents', GLOBAL_RULE_LIMITS.maintPerInitCents),
  eur('maintAnnualCapCents', GLOBAL_RULE_LIMITS.maintAnnualCapCents),
  { key: 'maxCampaignDays', kind: 'days', max: GLOBAL_RULE_LIMITS.maxCampaignDays, min: 1 },
  { key: 'creditPoolMaxDays', kind: 'days', max: GLOBAL_RULE_LIMITS.creditPoolMaxDays, min: 1 }
];

export const fieldDef = (key: NumericKey): FieldDef => NUMERIC_FIELDS.find((field) => field.key === key)!;

export interface RulesFormState {
  texts: Record<NumericKey, string>;
  bracketMode: GlobalRulesInput['bracketMode'];
  maintActive: boolean;
  defaultGuaranteeIdx: number;
}

/** Céntimos (o centésimas de punto porcentual) como los escribiría una persona: `4900` → `49`, `180` → `1,80` (o `1.80` en inglés). */
export function toInputText(hundredths: number, decimal: ',' | '.'): string {
  const whole = Math.floor(hundredths / 100);
  const fraction = hundredths % 100;
  return fraction === 0 ? String(whole) : `${whole}${decimal}${String(fraction).padStart(2, '0')}`;
}

function textOf(rules: GlobalRulesInput, key: NumericKey, decimal: ',' | '.'): string {
  const preset = /^preset([0-3])$/.exec(key);
  if (preset) return toInputText(rules.guaranteePresetsCents[Number(preset[1])] ?? 0, decimal);
  const value = rules[key as Exclude<NumericKey, PresetKey>];
  const field = fieldDef(key);
  return field.kind === 'days' ? String(value) : toInputText(value as number, decimal);
}

export function stateOf(rules: GlobalRulesInput, decimal: ',' | '.'): RulesFormState {
  const texts = Object.fromEntries(NUMERIC_FIELDS.map((field) => [field.key, textOf(rules, field.key, decimal)])) as Record<NumericKey, string>;
  return { texts, bracketMode: rules.bracketMode, maintActive: rules.maintActive, defaultGuaranteeIdx: rules.defaultGuaranteeIdx };
}

/** Lee un campo: un entero dentro de su rango, o `null` si es imposible (decimales de más, negativo, no numérico, demasiado grande o vacío). */
export function parseField(text: string, field: FieldDef, locale: 'es' | 'ca' | 'en'): number | null {
  if (field.kind === 'days') {
    const value = /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : null;
    return value !== null && value >= field.min && value <= field.max ? value : null;
  }
  try {
    const value = parseEurosToCents(text.replace('%', ''), locale);
    return value >= field.min && value <= field.max ? value : null;
  } catch (error) {
    if (error instanceof MoneyParseError) return null;
    throw error;
  }
}

/** Las reglas completas si todos los campos son válidos; si no, cuáles fallan (en el orden de la pantalla). El servidor vuelve a validarlo todo. */
export function parseState(state: RulesFormState, locale: 'es' | 'ca' | 'en'): { rules: GlobalRulesInput | null; invalid: NumericKey[] } {
  const values = {} as Record<NumericKey, number>;
  const invalid: NumericKey[] = [];
  for (const field of NUMERIC_FIELDS) {
    const value = parseField(state.texts[field.key], field, locale);
    if (value === null) invalid.push(field.key);
    else values[field.key] = value;
  }
  if (invalid.length > 0) return { rules: null, invalid };
  const candidate = {
    exemptLimitCents: values.exemptLimitCents,
    bracketMode: state.bracketMode,
    t1MaxCents: values.t1MaxCents,
    t2MaxCents: values.t2MaxCents,
    t1Bps: values.t1Bps,
    t2Bps: values.t2Bps,
    t3Bps: values.t3Bps,
    sponsorFeeBps: values.sponsorFeeBps,
    fullIntegrityCheckCents: values.fullIntegrityCheckCents,
    guaranteePresetsCents: PRESET_KEYS.map((key) => values[key]),
    defaultGuaranteeIdx: Math.min(state.defaultGuaranteeIdx, GUARANTEE_PRESET_COUNT - 1),
    gatewayPctBps: values.gatewayPctBps,
    gatewayFixedCents: values.gatewayFixedCents,
    topupFeeCents: values.topupFeeCents,
    topupFeeBps: values.topupFeeBps,
    ticketFeeFixedCents: values.ticketFeeFixedCents,
    ticketFeeBps: values.ticketFeeBps,
    maintActive: state.maintActive,
    maintPerInitCents: values.maintPerInitCents,
    maintAnnualCapCents: values.maintAnnualCapCents,
    maxCampaignDays: values.maxCampaignDays,
    creditPoolMaxDays: values.creditPoolMaxDays
  };
  const parsed = globalRulesSchema.safeParse(candidate);
  return parsed.success ? { rules: parsed.data, invalid: [] } : { rules: null, invalid: [] };
}
