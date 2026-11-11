import { assertSafeCents, bpsOf } from '@/core/finance/money';

/**
 * Cifras de una campaña redimensionada por votación (Sprint 4.4b, decisión del promotor del 2026-11-11). Funciones puras en céntimos enteros.
 *
 * - **Meta nueva** = lo que queda en la hucha tras devolver a quien lo pidió (`newGoalCents`).
 * - **Comisión de KORUM proporcional a lo recaudado:** el tramo, el mantenimiento y la pasarela prevista se multiplican por `meta nueva / meta original`
 *   y se redondean **hacia abajo** al céntimo (el redondeo, a favor de la entidad).
 * - **Las 4 líneas públicas siguen sumando la meta** (Regla 02 §1): el presupuesto y la instalación se reparten en la misma proporción que tenían, con la
 *   reserva de la línea 3 calculada con su fórmula de siempre, y la línea 4 es el resto. Ese resto cubre las comisiones nuevas y, como mucho, un céntimo
 *   del redondeo de la reserva, que no es de KORUM: la liquidación paga a la entidad `recaudado − comisiones`, así que ese céntimo también le llega.
 */

export interface ResizeFiguresInput {
  originalGoalCents: number;
  newGoalCents: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
}

export interface ResizedFigures {
  goalCents: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  costMatCents: number;
  costInstCents: number;
  /** Línea 3 del desglose público con las cifras nuevas. */
  contingencyCents: number;
  /** Línea 4 del desglose público: comisiones nuevas + el céntimo de redondeo de la reserva, si lo hay. */
  line4Cents: number;
}

function assertCents(value: number, label: string): number {
  assertSafeCents(value, label);
  if (value < 0) throw new RangeError(`El ${label} no puede ser negativo: ${String(value)}`);
  return value;
}

/** `amount × numerator / denominator`, redondeado hacia abajo, sin coma flotante ni desbordamiento. */
function scaleDown(amountCents: number, numerator: number, denominator: number): number {
  return Number((BigInt(amountCents) * BigInt(numerator)) / BigInt(denominator));
}

/** El mayor coste de ejecución `S` (presupuesto + instalación) cuya reserva, sumada, cabe en `budgetCents`: `S + reserva(S) ≤ budgetCents`. */
function largestExecutionWithin(budgetCents: number, contingencyBps: number): number {
  let execution = scaleDown(budgetCents, 10_000, 10_000 + contingencyBps);
  while (execution + 1 + bpsOf(execution + 1, contingencyBps) <= budgetCents) execution += 1;
  while (execution > 0 && execution + bpsOf(execution, contingencyBps) > budgetCents) execution -= 1;
  return execution;
}

export function resizedFigures(input: ResizeFiguresInput): ResizedFigures {
  const originalGoal = assertCents(input.originalGoalCents, 'meta original');
  const newGoal = assertCents(input.newGoalCents, 'meta nueva');
  if (originalGoal === 0) throw new RangeError('La meta original no puede ser 0.');
  if (newGoal === 0 || newGoal > originalGoal) throw new RangeError(`La meta nueva (${newGoal}) debe ser mayor que 0 y no superar la original (${originalGoal}).`);
  const contingencyBps = assertCents(input.contingencyBps, 'porcentaje de reserva');
  const costMat = assertCents(input.costMatCents, 'presupuesto del proveedor');
  const costInst = assertCents(input.costInstCents, 'coste de instalación');

  const bracketFeeCents = scaleDown(assertCents(input.bracketFeeCents, 'tramo'), newGoal, originalGoal);
  const maintFeeCents = scaleDown(assertCents(input.maintFeeCents, 'mantenimiento'), newGoal, originalGoal);
  const gatewayFeeCents = scaleDown(assertCents(input.gatewayFeeCents, 'pasarela'), newGoal, originalGoal);
  const feesCents = bracketFeeCents + maintFeeCents + gatewayFeeCents;
  if (feesCents > newGoal) throw new RangeError(`Las comisiones (${feesCents}) superan la meta nueva (${newGoal}).`);

  const executionCents = costMat + costInst === 0 ? 0 : largestExecutionWithin(newGoal - feesCents, contingencyBps);
  const costMatCents = costMat + costInst === 0 ? 0 : scaleDown(executionCents, costMat, costMat + costInst);
  const costInstCents = executionCents - costMatCents;
  const contingencyCents = bpsOf(executionCents, contingencyBps);
  const line4Cents = newGoal - executionCents - contingencyCents;
  return { goalCents: newGoal, bracketFeeCents, maintFeeCents, gatewayFeeCents, costMatCents, costInstCents, contingencyCents, line4Cents };
}
