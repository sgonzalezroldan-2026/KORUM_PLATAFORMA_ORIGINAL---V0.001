/**
 * Filas que se anotan en el instante exacto de una aportación: la que completa la meta, o el contracargo que la reabre o la descuenta. En el panel de la
 * entidad van solo con su día (Sprint 5.8b): para ella las aportaciones son anónimas, y esa hora, junto al importe, señalaría una. Es lo mismo que enseña
 * su expediente en PDF. La consola conserva la hora.
 */
export function isContributionInstant(row: { action: string; statusChange: { reason: string | null } | null }): boolean {
  if (CONTRIBUTION_INSTANT_ACTIONS.has(row.action)) return true;
  return row.action === 'initiative.status_changed' && row.statusChange !== null && row.statusChange.reason !== null && CONTRIBUTION_INSTANT_REASONS.has(row.statusChange.reason);
}

/** El contracargo, la devolución tras liquidar y lo que provocan en una campaña rehecha por votación: se anotan todos en la misma transacción. */
const CONTRIBUTION_INSTANT_ACTIONS: ReadonlySet<string> = new Set(['payment.chargeback', 'payment.refund_after_settlement', 'initiative.resized_rescaled', 'initiative.resized_emptied']);
/** La aportación que completa la meta, y el contracargo que la reabre o deja la campaña sin fondos. */
const CONTRIBUTION_INSTANT_REASONS: ReadonlySet<string> = new Set(['GOAL_REACHED', 'REOPENED_BY_REVERSAL', 'RESIZED_LEFT_EMPTY']);
