import { z } from 'zod';
import { GUARANTEE_MAX_CENTS } from '@/core/checkout/checkout-limits';
import type { KorumGlobalRulesCents } from '@/types/korum.types';

/**
 * Motor de reglas globales del Super-Admin (Sprint 5.3, prototipo `saveGlobalEconomicRules`, `saveGatewayAndTopupCosts` y `saveMedalsConfiguration`).
 * Funciones puras: el formulario las usa para avisar campo a campo y el servidor las vuelve a aplicar antes de guardar.
 *
 * Decisión del promotor (DECISIONES_TECNICAS §6.1): **ninguna regla de precios se bloquea por «perder dinero»** (lo avisa la salud de precios), pero **sí se
 * rechazan los datos imposibles**: decimales, negativos, vacíos o fuera de rango. Todo importe es un entero en céntimos y todo porcentaje, en puntos básicos.
 */

const cents = (max: number) => z.number().int().min(0).max(max);
const bps = z.number().int().min(0).max(10_000);

export const GLOBAL_RULE_LIMITS = {
  exemptLimitCents: 100_000_000,
  thresholdCents: 1_000_000_000,
  smallCents: 100_000,
  /** La aportación voluntaria no puede pasar de lo que el checkout cobra (`GUARANTEE_MAX_CENTS`): con más, la familia vería un importe distinto del que se cobra (auditoría financiera del 5.3, I5). */
  guaranteeCents: GUARANTEE_MAX_CENTS,
  /** Fijo por transacción de la pasarela: con más de 100 € el Estudio podría calcular una meta que no cabe en un entero de la base de datos (M2). */
  gatewayFixedCents: 10_000,
  maintPerInitCents: 10_000_000,
  maintAnnualCapCents: 100_000_000,
  /** Nunca más de 75 días (Regla 02 §4): Paycomet solo reparte fondos durante 90 días desde cada cobro. */
  maxCampaignDays: 75,
  /** La base de datos lo limita a 70 (`CHECK`): el día 70 la bolsa de un comercio pasa al Fondo de actividades de la entidad. */
  creditPoolMaxDays: 70
} as const;

export const GUARANTEE_PRESET_COUNT = 4;

/** Las reglas globales completas (la fila `GlobalConfig` sin su fecha). Todos los campos son obligatorios. */
export const globalRulesSchema = z
  .object({
    exemptLimitCents: cents(GLOBAL_RULE_LIMITS.exemptLimitCents),
    bracketMode: z.enum(['FLAT', 'MARGINAL']),
    t1MaxCents: cents(GLOBAL_RULE_LIMITS.thresholdCents),
    t2MaxCents: cents(GLOBAL_RULE_LIMITS.thresholdCents),
    t1Bps: bps,
    t2Bps: bps,
    t3Bps: bps,
    sponsorFeeBps: bps,
    fullIntegrityCheckCents: cents(GLOBAL_RULE_LIMITS.guaranteeCents),
    guaranteePresetsCents: z.array(cents(GLOBAL_RULE_LIMITS.guaranteeCents)).length(GUARANTEE_PRESET_COUNT),
    defaultGuaranteeIdx: z.number().int().min(0).max(GUARANTEE_PRESET_COUNT - 1),
    gatewayPctBps: bps,
    gatewayFixedCents: cents(GLOBAL_RULE_LIMITS.gatewayFixedCents),
    topupFeeCents: cents(GLOBAL_RULE_LIMITS.smallCents),
    topupFeeBps: bps,
    ticketFeeFixedCents: cents(GLOBAL_RULE_LIMITS.smallCents),
    ticketFeeBps: bps,
    maintActive: z.boolean(),
    maintPerInitCents: cents(GLOBAL_RULE_LIMITS.maintPerInitCents),
    maintAnnualCapCents: cents(GLOBAL_RULE_LIMITS.maintAnnualCapCents),
    maxCampaignDays: z.number().int().min(1).max(GLOBAL_RULE_LIMITS.maxCampaignDays),
    creditPoolMaxDays: z.number().int().min(1).max(GLOBAL_RULE_LIMITS.creditPoolMaxDays)
  })
  .strict();

export type GlobalRulesInput = z.infer<typeof globalRulesSchema>;
export type GlobalRuleKey = keyof GlobalRulesInput;

/** Reglas de precio (las del cálculo de la pizarra) a partir de las globales completas: lo que consume la salud de precios. */
export function pricingRulesOf(rules: GlobalRulesInput): KorumGlobalRulesCents {
  const { maxCampaignDays: _maxCampaignDays, creditPoolMaxDays: _creditPoolMaxDays, ...pricing } = rules;
  return pricing;
}

/** Campos que no pasan el esquema, para marcarlos en el formulario (solo la ruta del campo, nunca su valor). */
export function invalidRuleFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'form')))];
}

/** Qué campos cambian entre dos versiones de las reglas (la auditoría guarda solo esos, con su antes y su después). */
export function changedRuleKeys(before: GlobalRulesInput, after: GlobalRulesInput): GlobalRuleKey[] {
  return (Object.keys(after) as GlobalRuleKey[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** Los gastos de gestión digital de las entradas: con una taquilla a la venta no pueden cambiar (cambiaría lo prometido a quien compra y la meta). */
export function changesTicketFee(before: GlobalRulesInput, after: GlobalRulesInput): boolean {
  return before.ticketFeeFixedCents !== after.ticketFeeFixedCents || before.ticketFeeBps !== after.ticketFeeBps;
}

// --- Medallas ------------------------------------------------------------------------------------------------------------------------------

export const MEDAL_KEYS = ['bronze', 'silver', 'gold'] as const;
export type MedalKey = (typeof MEDAL_KEYS)[number];

export const MEDAL_LIMITS = { campaignsRequired: 99, grantCents: 100_000_000 } as const;

const medalTier = z
  .object({ key: z.enum(MEDAL_KEYS), campaignsRequired: z.number().int().min(1).max(MEDAL_LIMITS.campaignsRequired), grantCents: cents(MEDAL_LIMITS.grantCents) })
  .strict();

/**
 * Bronce, Plata y Oro, cada una una vez y con más campañas cada nivel: con niveles que no suben, «la siguiente medalla» no tendría sentido. Los importes de
 * la beca no se bloquean (cada uno es una decisión de negocio) pero tampoco admiten datos imposibles.
 */
export const medalsSchema = z
  .array(medalTier)
  .length(MEDAL_KEYS.length)
  .refine((tiers) => MEDAL_KEYS.every((key) => tiers.filter((tier) => tier.key === key).length === 1), { message: 'MEDAL_KEYS' })
  .refine(
    (tiers) => {
      const byKey = new Map(tiers.map((tier) => [tier.key, tier.campaignsRequired]));
      return byKey.get('bronze')! < byKey.get('silver')! && byKey.get('silver')! < byKey.get('gold')!;
    },
    { message: 'MEDAL_ORDER' }
  );
export type MedalsInput = z.infer<typeof medalsSchema>;

// --- Aceptar un aviso de precios ------------------------------------------------------------------------------------------------------------

export const PRICING_CODES = [
  'HUCHA_FEE_BELOW_GATEWAY_COST',
  'TICKET_FEE_BELOW_GATEWAY_COST',
  'SPONSOR_FEE_BELOW_GATEWAY_COST',
  'RULE_VALUE_INVALID',
  'BRACKET_THRESHOLDS_INVALID',
  'BRACKET_CLIFF',
  'BRACKET_RATES_NOT_DECREASING',
  'SOURCE_NEGATIVE_MARGIN'
] as const;

/** Un aviso concreto tal y como lo vio quien lo acepta: si la configuración cambió mientras tanto (otra huella), el servidor lo rechaza. */
export const pricingAcknowledgeTarget = z
  .object({ code: z.enum(PRICING_CODES), fingerprint: z.string().min(1).max(400), source: z.string().min(1).max(40).optional() })
  .strict();
export type PricingAcknowledgeTarget = z.infer<typeof pricingAcknowledgeTarget>;

/** Aceptaciones que se guardan como máximo: las más recientes (las antiguas con otra huella ya no valen para nada). */
export const MAX_ACKNOWLEDGEMENTS = 200;
