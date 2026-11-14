import { assertSafeCents, bpsOf } from '@/core/finance/money';

/**
 * Pizarra de una campaña **rehecha por votación** (Sprint 4.4b; pizarra del Sprint 5.6). Su meta ya no sale de la fórmula del Estudio: es lo recaudado que
 * quedó tras la votación, y las comisiones bajaron en la misma proporción y hacia abajo (`resizedFigures`). La pizarra normal (exento, beca y «resto sujeto a
 * tramo») ya no describe esas cifras, así que aquí se enseñan tal como están guardadas, sin recalcular nada, y cuadradas al céntimo con la meta.
 *
 * Función pura en céntimos enteros. `roundingCents` es el céntimo que puede sobrar del redondeo de la reserva: no es de KORUM, la liquidación paga a la
 * entidad `recaudado − comisiones`, así que también le llega. Lo que recibe el proyecto (`entityCents`) usa la misma fórmula que la liquidación
 * (`payoutFigures`, probado al céntimo en `studio-resized.spec.tsx`): si KORUM asume la pasarela (`absorbsGatewayCostByKorum`), esa pasarela no está dentro
 * de la meta ni se le descuenta a la entidad.
 */

/** Lo más que puede sobrar del redondeo de la reserva con un proyecto presupuestado (`resizedFigures` nunca deja más). */
export const MAX_RESIZED_ROUNDING_CENTS = 1;

export interface ResizedBoardInput {
  /** Meta con la que se publicó la campaña, antes de la votación (`ResizePoll.originalGoalCents`). */
  originalGoalCents: number;
  goalCents: number;
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  /** KORUM asume la pasarela de esta campaña: no forma parte de la meta. */
  absorbsGatewayCostByKorum: boolean;
}

export interface ResizedBoard {
  originalGoalCents: number;
  goalCents: number;
  costMatCents: number;
  costInstCents: number;
  contingencyCents: number;
  /** Presupuesto + instalación + reserva: lo que cuesta el proyecto con la meta nueva. */
  projectCents: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  /** La pasarela la paga KORUM: se enseña, pero no está dentro de la meta ni se descuenta al liquidar. */
  gatewayAbsorbed: boolean;
  /** Lo que se descuenta de la meta al liquidar: tramo, mantenimiento y la pasarela incluida en la meta (`0` si la asume KORUM). */
  feesCents: number;
  /** Céntimo del redondeo de la reserva; llega a la entidad con la liquidación. */
  roundingCents: number;
  /** Lo que recibe la entidad al liquidar con la meta completa: `meta − comisiones`. */
  entityCents: number;
}

function cents(value: number, label: string): number {
  assertSafeCents(value, label);
  if (value < 0) throw new RangeError(`El ${label} no puede ser negativo: ${String(value)}`);
  return value;
}

/**
 * Cifras guardadas de una campaña rehecha, listas para pintar. Invariante: `proyecto + comisiones + redondeo === meta`, con un redondeo de un céntimo como
 * mucho. Si lo guardado no cuadra se lanza: una pizarra de dinero no se enseña descuadrada.
 */
export function resizedBudgetBoard(input: ResizedBoardInput): ResizedBoard {
  const goalCents = cents(input.goalCents, 'meta');
  const originalGoalCents = cents(input.originalGoalCents, 'meta original');
  const costMatCents = cents(input.costMatCents, 'presupuesto del proveedor');
  const costInstCents = cents(input.costInstCents, 'coste de instalación');
  const bracketFeeCents = cents(input.bracketFeeCents, 'tramo');
  const maintFeeCents = cents(input.maintFeeCents, 'mantenimiento');
  const gatewayFeeCents = cents(input.gatewayFeeCents, 'pasarela');
  const gatewayAbsorbed = input.absorbsGatewayCostByKorum;
  const executionCents = costMatCents + costInstCents;
  const contingencyCents = bpsOf(executionCents, cents(input.contingencyBps, 'porcentaje de reserva'));
  const projectCents = executionCents + contingencyCents;
  const feesCents = bracketFeeCents + maintFeeCents + (gatewayAbsorbed ? 0 : gatewayFeeCents);
  const roundingCents = goalCents - projectCents - feesCents;
  if (roundingCents < 0) throw new RangeError(`La campaña rehecha no cuadra: proyecto ${projectCents} + comisiones ${feesCents} superan la meta ${goalCents}.`);
  if (executionCents > 0 && roundingCents > MAX_RESIZED_ROUNDING_CENTS) throw new RangeError(`La campaña rehecha no cuadra: sobran ${roundingCents} céntimos entre el proyecto y la meta ${goalCents}.`);
  return { originalGoalCents, goalCents, costMatCents, costInstCents, contingencyCents, projectCents, bracketFeeCents, maintFeeCents, gatewayFeeCents, gatewayAbsorbed, feesCents, roundingCents, entityCents: goalCents - feesCents };
}
