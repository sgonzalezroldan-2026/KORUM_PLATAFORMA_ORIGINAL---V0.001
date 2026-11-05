import { formatBps, formatCents, type MoneyLocale } from '@/core/finance/money';
import type { PublicPricing } from '@/core/finance/public-pricing';

/**
 * Cifras de la consola dentro de los textos de marketing. Los catálogos de traducción escriben `{exempt}` o `{t1Rate}` y la web los
 * sustituye con las tarifas vigentes (`GlobalConfig`): si el Super-Admin cambia una tarifa, ninguna página pública sigue diciendo la
 * antigua. Los importes y porcentajes salen siempre de `formatCents` y `formatBps`.
 */
export type PricingTokens = Record<string, string>;

export function pricingTokens(pricing: PublicPricing, locale: MoneyLocale): PricingTokens {
  const { bracket } = pricing;
  return {
    exempt: formatCents(pricing.exemptLimitCents, locale),
    t1Max: formatCents(bracket.t1MaxCents, locale),
    t2Max: formatCents(bracket.t2MaxCents, locale),
    t1Rate: formatBps(bracket.ratesBps.t1, locale),
    t2Rate: formatBps(bracket.ratesBps.t2, locale),
    t3Rate: formatBps(bracket.ratesBps.t3, locale),
    sponsorFee: formatBps(pricing.sponsorFeeBps, locale),
    gatewayRate: formatBps(pricing.gatewayPctBps, locale),
    gatewayFixed: formatCents(pricing.gatewayFixedCents, locale),
    ticketFixed: formatCents(pricing.ticketFeeFixedCents, locale),
    ticketRate: formatBps(pricing.ticketFeeBps, locale),
    maintFee: formatCents(pricing.maintPerInitCents, locale),
    maintCap: formatCents(pricing.maintAnnualCapCents, locale),
    maxDays: String(pricing.maxCampaignDays)
  };
}

/** Sustituye cada `{token}` conocido; un token desconocido se deja tal cual para que una prueba lo detecte. */
export function fillTokens(text: string, tokens: PricingTokens): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => tokens[name] ?? match);
}

/** Aplica `fillTokens` a todas las cadenas de un contenido anidado (objetos y listas). */
export function fillTokensDeep<T>(value: T, tokens: PricingTokens): T {
  if (typeof value === 'string') return fillTokens(value, tokens) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => fillTokensDeep(item, tokens)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillTokensDeep(item, tokens)])) as T;
  }
  return value;
}
