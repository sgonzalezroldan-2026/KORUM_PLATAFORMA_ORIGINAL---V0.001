import type { InitiativeStatus } from '@/generated/prisma/enums';

/**
 * Auto-Impulso de KORUM (Sprint 5.2, Regla 02 §7 y §10). Funciones puras: el servicio las llama dentro de su transacción.
 *
 * - **Suposición contra el simulador** (tareas externas aplazadas, Regla 04 §2.4): el dinero del Auto-Impulso es de KORUM y debe estar en Paycomet para
 *   poder repartirse. Para el reparto se trata como un cobro de KORUM (`paycometOrder` propio, `PLATFORM`): así la liquidación lo ofrece como origen
 *   del reparto y `SPLIT_OVERUSE` lo vigila como cualquier cobro. La conciliación diaria lo ignora (no pasó por Paycomet como compra). Cómo fondea
 *   KORUM esa cuenta en Paycomet lo confirma Paycomet y **bloquea el paso a cobros reales**.
 * - No hay coste de pasarela: no es una compra con tarjeta, así que el retorno del 💎 ya lo cuenta entero como `AUTO_BOOST_EXPENSE`.
 */

export type SelfBoostRejection = 'NOT_FOUND' | 'NOT_FUNDRAISING' | 'NOTHING_MISSING' | 'AMOUNT_CHANGED' | 'PAST_DEADLINE' | 'ORG_ARCHIVED' | 'NOT_PROFITABLE' | 'NEGATIVE_RETURN';

export class SelfBoostNotAllowedError extends Error {
  constructor(
    readonly initiativeId: number,
    readonly reason: SelfBoostRejection,
    detail: string
  ) {
    super(`No se puede aportar el Auto-Impulso a la iniciativa ${initiativeId}: ${detail}.`);
    this.name = 'SelfBoostNotAllowedError';
  }
}

/** Referencia del «cobro» de KORUM: única por iniciativa y por Auto-Impulso (si un contracargo la reabre, puede haber otro). */
export function selfBoostOrder(initiativeId: number, sequence: number): string {
  return `KB-${initiativeId}-${sequence}`;
}

/** Código de autorización que acompaña a ese reparto. Es de KORUM, no de un banco: el reparto real lo define el acuerdo con Paycomet. */
export const SELF_BOOST_AUTH_CODE = 'KORUM';

/** Lo que falta para la meta, en céntimos. Nunca negativo. */
export function missingToGoal(goalCents: number, raisedCents: number): number {
  return Math.max(0, goalCents - raisedCents);
}

/**
 * ¿Se puede aportar ahora? Devuelve el motivo, o `null` si sí. `expectedAmountCents` es lo que el Super-Admin tenía en pantalla: si otra aportación
 * llegó entre medias, lo que falta cambia y no se gasta más de lo que vio.
 */
export function selfBoostRejection(initiative: { status: InitiativeStatus; goalCents: number; raisedCents: number; closesAt: Date }, expectedAmountCents: number, now: Date): SelfBoostRejection | null {
  if (initiative.status !== 'FUNDRAISING') return 'NOT_FUNDRAISING';
  // Una campaña pasada de su fecha límite la cierra la tarea de vencimiento: completarla ahora la convertiría en lograda fuera de plazo.
  if (initiative.closesAt.getTime() <= now.getTime()) return 'PAST_DEADLINE';
  const missing = missingToGoal(initiative.goalCents, initiative.raisedCents);
  if (missing === 0) return 'NOTHING_MISSING';
  if (missing !== expectedAmountCents) return 'AMOUNT_CHANGED';
  return null;
}

/** Tarifas que una entidad tiene propias y que el botón «Corregir tarifas» puede subir hasta el valor global (Sprint 5.2). */
export interface OrganizationRuleFacts {
  customRules: boolean;
  fullIntegrityCheckCents: number;
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
  /**
   * La entidad tiene una taquilla o rifa a la venta. La compra de entradas lee la tarifa **actual** de la entidad (no guarda la de la publicación), así
   * que cambiar sus gastos de gestión cambiaría lo que paga quien compra o lo que recibe la entidad en una campaña ya prometida (auditoría financiera, B1).
   */
  hasPublishedTicketing: boolean;
}

export interface GlobalRuleFacts {
  fullIntegrityCheckCents: number;
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
}

export interface NegativeReturnFixPlan {
  /** Campos de la entidad que suben al valor global (solo con tarifa propia y solo los que están por debajo). */
  organization: Partial<Pick<OrganizationRuleFacts, 'fullIntegrityCheckCents' | 'ticketFeeFixedCents' | 'ticketFeeBps'>>;
  /** Hay algo que corregir pero la campaña ya está publicada y no se toca (la pantalla lo explica). */
  publishedLeftUntouched: boolean;
}

/**
 * Qué hace el botón «Corregir tarifas en 1 clic» (decisión del promotor, 2026-11-11): solo lo que no se ha prometido. Corrige las tarifas de la
 * entidad para sus próximas campañas; una campaña publicada no se toca (ni su cobertura de pasarela). La cobertura de un borrador no se retira desde aquí:
 * el BI no incluye borradores, así que el botón nunca llega a actuar sobre uno (auditoría financiera del 5.2, M1).
 */
export function planNegativeReturnFix(
  initiative: { status: InitiativeStatus; absorbsGatewayCostByKorum: boolean },
  organization: OrganizationRuleFacts,
  global: GlobalRuleFacts
): NegativeReturnFixPlan {
  const raise: NegativeReturnFixPlan['organization'] = {};
  // Los gastos de gestión de las entradas no se tocan mientras la entidad tenga una taquilla a la venta: cambiarían lo prometido.
  let ticketingFeesHeld = false;
  if (organization.customRules) {
    if (organization.fullIntegrityCheckCents < global.fullIntegrityCheckCents) raise.fullIntegrityCheckCents = global.fullIntegrityCheckCents;
    if (organization.ticketFeeFixedCents < global.ticketFeeFixedCents || organization.ticketFeeBps < global.ticketFeeBps) {
      if (organization.hasPublishedTicketing) ticketingFeesHeld = true;
      else {
        if (organization.ticketFeeFixedCents < global.ticketFeeFixedCents) raise.ticketFeeFixedCents = global.ticketFeeFixedCents;
        if (organization.ticketFeeBps < global.ticketFeeBps) raise.ticketFeeBps = global.ticketFeeBps;
      }
    }
  }
  const draft = initiative.status === 'BUDGETING';
  return {
    organization: raise,
    publishedLeftUntouched: ticketingFeesHeld || (!draft && initiative.absorbsGatewayCostByKorum)
  };
}

/** ¿Cambia algo el botón? Si no, no se ofrece (no hay nada que corregir sin romper lo prometido). */
export function fixHasEffect(plan: NegativeReturnFixPlan): boolean {
  return Object.keys(plan.organization).length > 0;
}
