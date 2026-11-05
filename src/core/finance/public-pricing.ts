import type { BracketConfig } from './tco.service';

/**
 * Tarifas que se enseñan en la web pública (`/precios`, simulador de la portada, `llms.txt`). Salen de la misma tabla
 * `GlobalConfig` que el motor TCO, así que lo que lee una persona antes de darse de alta es lo que aplica el Estudio.
 * Funciones puras: la lectura de la base de datos (con su respaldo) vive en `src/services/marketing/public-config.ts`.
 */
export interface PublicPricing {
  /** Importe exento de comisión por curso para una entidad nueva. */
  exemptLimitCents: number;
  bracket: BracketConfig;
  /** Fee de gestión publicitaria sobre el nivel de patrocinio, sin IVA. */
  sponsorFeeBps: number;
  gatewayPctBps: number;
  gatewayFixedCents: number;
  /** «Gastos de gestión digital» de entradas y papeletas: fijo + porcentaje sobre el precio. */
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
  maintActive: boolean;
  maintPerInitCents: number;
  maintAnnualCapCents: number;
  maxCampaignDays: number;
}

/** Fila de `GlobalConfig` que necesita la web pública. */
export interface GlobalConfigPricingRow {
  exemptLimitCents: number;
  bracketMode: BracketConfig['mode'];
  t1MaxCents: number;
  t2MaxCents: number;
  t1Bps: number;
  t2Bps: number;
  t3Bps: number;
  sponsorFeeBps: number;
  gatewayPctBps: number;
  gatewayFixedCents: number;
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
  maintActive: boolean;
  maintPerInitCents: number;
  maintAnnualCapCents: number;
  maxCampaignDays: number;
}

export function publicPricingFromGlobalConfig(row: GlobalConfigPricingRow): PublicPricing {
  return {
    exemptLimitCents: row.exemptLimitCents,
    bracket: { mode: row.bracketMode, t1MaxCents: row.t1MaxCents, t2MaxCents: row.t2MaxCents, ratesBps: { t1: row.t1Bps, t2: row.t2Bps, t3: row.t3Bps } },
    sponsorFeeBps: row.sponsorFeeBps,
    gatewayPctBps: row.gatewayPctBps,
    gatewayFixedCents: row.gatewayFixedCents,
    ticketFeeFixedCents: row.ticketFeeFixedCents,
    ticketFeeBps: row.ticketFeeBps,
    maintActive: row.maintActive,
    maintPerInitCents: row.maintPerInitCents,
    maintAnnualCapCents: row.maintAnnualCapCents,
    maxCampaignDays: row.maxCampaignDays
  };
}

/**
 * Valores de lanzamiento (los mismos que `GlobalConfig` en `schema/schema.prisma`). Se usan cuando la base de datos no responde: la
 * web pública sigue mostrando tarifas coherentes en lugar de caerse. Una prueba comprueba que no se separan del esquema.
 */
export const DEFAULT_PUBLIC_PRICING: PublicPricing = {
  exemptLimitCents: 100_000,
  bracket: { mode: 'FLAT', t1MaxCents: 500_000, t2MaxCents: 1_500_000, ratesBps: { t1: 500, t2: 400, t3: 300 } },
  sponsorFeeBps: 1500,
  gatewayPctBps: 100,
  gatewayFixedCents: 9,
  ticketFeeFixedCents: 45,
  ticketFeeBps: 200,
  maintActive: false,
  maintPerInitCents: 4900,
  maintAnnualCapCents: 14_700,
  maxCampaignDays: 60
};
