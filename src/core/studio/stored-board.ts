import { bpsOf } from '@/core/finance/money';
import type { BudgetBoard } from './studio-board';

/** Pizarra de una campaña ya publicada: lo que se guardó al publicarla, sin recalcular (los cupos ya se descontaron y volver a calcularlos los contaría dos veces). */
export function storedBudgetBoard(stored: {
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
  goalCents: number;
  defaultExemptAppliedCents: number;
  medalExemptAppliedCents: number;
  bracketRateAppliedBps: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
}): BudgetBoard {
  const baseCents = stored.costMatCents + stored.costInstCents;
  const contingencyCents = bpsOf(baseCents, stored.contingencyBps);
  const netCents = baseCents + contingencyCents;
  const exempt = stored.defaultExemptAppliedCents + stored.medalExemptAppliedCents;
  return {
    kind: 'BUDGET',
    baseCents,
    contingencyCents,
    netCents,
    defaultExemptCents: stored.defaultExemptAppliedCents,
    medalExemptCents: stored.medalExemptAppliedCents,
    medalSavedCents: 0,
    taxableCents: stored.bracketFeeCents === 0 && stored.bracketRateAppliedBps === 0 ? 0 : Math.max(0, netCents - exempt),
    rateBps: stored.bracketRateAppliedBps,
    bracketFeeCents: stored.bracketFeeCents,
    maintFeeCents: stored.maintFeeCents,
    gatewayDetail: null,
    gatewayFeeCents: stored.gatewayFeeCents,
    goalCents: stored.goalCents,
    categoryExempt: stored.bracketRateAppliedBps === 0 && stored.bracketFeeCents === 0 && netCents > 0,
    lock: { requested: false, blocked: false, term: null }
  };
}
