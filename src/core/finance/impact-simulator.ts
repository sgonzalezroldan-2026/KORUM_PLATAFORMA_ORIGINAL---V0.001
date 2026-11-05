import type { PublicPricing } from './public-pricing';
import { calculateStudioBudgetTCO } from './tco.service';

/**
 * Simulador de impacto de la portada: dado lo que cuesta una mejora y cuántas familias tiene la comunidad, calcula la meta que se
 * publicaría y qué hace falta para alcanzarla. Usa **la misma pizarra TCO** que el Estudio de la entidad (`calculateStudioBudgetTCO`),
 * con una entidad nueva (todo el exento del curso disponible, sin medalla), así que la meta coincide al céntimo con la del Estudio.
 * Las cifras de participación son orientativas y la interfaz lo dice.
 */

/** Aportación media de referencia (la horquilla habitual es de 15 a 25 €). */
export const SIMULATOR_AVERAGE_CONTRIBUTION_CENTS = 2000;
/** Nivel de patrocinio de comercio de referencia (el intermedio de 100 / 250 / 500 €), que llega íntegro a la iniciativa. */
export const SIMULATOR_SPONSOR_LEVEL_CENTS = 25_000;
/** Reserva de contingencia con la que nace una iniciativa en el Estudio (10 %). */
export const SIMULATOR_CONTINGENCY_BPS = 1000;
/** Importe de aportación sugerido con el que se estima el número de cobros (el de una entidad nueva). */
export const SIMULATOR_SUGGESTED_DONATION_CENTS = 2500;

export const SIMULATOR_LIMITS = {
  minFamilies: 1,
  maxFamilies: 100_000,
  maxCostCents: 50_000_000,
  maxSponsors: 20
} as const;

export interface ImpactInputs {
  /** Presupuesto de la mejora (proveedor e instalación), en céntimos. */
  costCents: number;
  /** Familias, socios o personas de la comunidad. */
  families: number;
  /** Comercios del barrio que patrocinan con el nivel de referencia. */
  sponsors: number;
}

export interface ImpactResult {
  /** Lo que se publica como meta: siempre en euros enteros. */
  goalCents: number;
  /** Lo que llega a la entidad para pagar la mejora (presupuesto más contingencia). */
  netForEntityCents: number;
  /** Parte de ese neto que no paga comisión de KORUM. */
  exemptUsedCents: number;
  commissionCents: number;
  maintenanceCents: number;
  /** Coste de la pasarela de pago (incluido el redondeo al euro): va dentro de la meta. */
  gatewayCents: number;
  sponsorsCents: number;
  /** Lo que queda por reunir entre las familias una vez descontados los comercios. */
  remainingCents: number;
  /** Aportaciones de la aportación media de referencia necesarias para cubrir lo que queda. */
  contributorsNeeded: number;
  /** Porcentaje de la comunidad que supone, redondeado hacia arriba (puede pasar de 100). */
  participationPct: number;
  /** Aportación media si participa una de cada dos familias, redondeada al céntimo hacia arriba. */
  averageIfHalfCents: number;
}

function assertInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} debe ser un entero entre ${min} y ${max}, recibido: ${String(value)}`);
  }
}

function ceilDiv(dividend: number, divisor: number): number {
  return Math.ceil(dividend / divisor);
}

export function simulateImpact(pricing: PublicPricing, inputs: ImpactInputs): ImpactResult {
  assertInteger(inputs.costCents, 'El presupuesto', 0, SIMULATOR_LIMITS.maxCostCents);
  assertInteger(inputs.families, 'El número de familias', SIMULATOR_LIMITS.minFamilies, SIMULATOR_LIMITS.maxFamilies);
  assertInteger(inputs.sponsors, 'El número de comercios', 0, SIMULATOR_LIMITS.maxSponsors);

  const tco = calculateStudioBudgetTCO({
    costMatCents: inputs.costCents,
    costInstCents: 0,
    contingencyBps: SIMULATOR_CONTINGENCY_BPS,
    isCategoryExempt: false,
    baseExemptRemainingCents: pricing.exemptLimitCents,
    medalGrantAvailableCents: 0,
    bracketConfig: pricing.bracket,
    maintConfig: { active: pricing.maintActive, perInitCents: pricing.maintPerInitCents, annualCapCents: pricing.maintAnnualCapCents, alreadyChargedOrReservedCents: 0 },
    gatewayConfig: { pctBps: pricing.gatewayPctBps, fixedCents: pricing.gatewayFixedCents, defaultDonationTicketCents: SIMULATOR_SUGGESTED_DONATION_CENTS }
  });

  const sponsorsCents = inputs.sponsors * SIMULATOR_SPONSOR_LEVEL_CENTS;
  const remainingCents = Math.max(0, tco.finalGoalCents - sponsorsCents);
  const contributorsNeeded = ceilDiv(remainingCents, SIMULATOR_AVERAGE_CONTRIBUTION_CENTS);
  const halfOfCommunity = ceilDiv(inputs.families, 2);

  return {
    goalCents: tco.finalGoalCents,
    netForEntityCents: tco.netGuaranteedForSchoolCents,
    exemptUsedCents: tco.defaultExemptUsedCents,
    commissionCents: tco.bracketFeeCents,
    maintenanceCents: tco.maintFeeCents,
    gatewayCents: tco.gatewayFeeCents,
    sponsorsCents,
    remainingCents,
    contributorsNeeded,
    participationPct: ceilDiv(contributorsNeeded * 100, inputs.families),
    averageIfHalfCents: ceilDiv(remainingCents, halfOfCommunity)
  };
}
