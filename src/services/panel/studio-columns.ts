import { isVoucherDraft, type StudioBoard, type StudioContext } from '@/core/studio/studio-board';
import { endOfDayInMadrid, type StudioDraft } from '@/core/studio/studio-draft';

/**
 * Columnas que el Estudio escribe en una campaña (Sprint 4.3; venta de vales, Sprint 5.14b). Separado de `studio.service.ts` para que cada módulo quede por
 * debajo de las 300 líneas (Regla 04 §3).
 */

/** Campos de una venta de vales: vacíos en cualquier otra campaña (la base de datos lo exige). */
const NO_VOUCHER_COLUMNS = { voucherValidUntil: null, voucherTargetCount: null, voucherNoProductEnabled: false } as const;

/** Campos que dependen del formato y de la pizarra: se escriben siempre juntos para que una campaña nunca quede con la mitad de otro formato. */
export function pricingColumns(draft: StudioDraft, board: StudioBoard, context: StudioContext) {
  if (board.kind === 'BUDGET') {
    return {
      goalCents: board.goalCents,
      costMatCents: draft.costMatCents,
      costInstCents: draft.costInstCents,
      contingencyBps: draft.contingencyBps,
      defaultExemptAppliedCents: board.defaultExemptCents,
      medalExemptAppliedCents: board.medalExemptCents,
      medalRankApplied: board.medalExemptCents > 0 ? context.medalRank : 0,
      bracketRateAppliedBps: board.rateBps,
      bracketFeeCents: board.bracketFeeCents,
      maintFeeCents: board.maintFeeCents,
      gatewayFeeCents: board.gatewayFeeCents,
      ticketSubtype: null,
      ticketPriceCents: null,
      ticketMax: null,
      ticketFeeMode: null,
      ticketVenue: null,
      ...NO_VOUCHER_COLUMNS
    };
  }
  if (board.kind === 'VOUCHER') {
    const validUntil = draft.voucherValidOn === null ? null : endOfDayInMadrid(draft.voucherValidOn);
    return {
      goalCents: board.goalCents,
      costMatCents: 0,
      costInstCents: 0,
      contingencyBps: draft.contingencyBps,
      defaultExemptAppliedCents: 0,
      medalExemptAppliedCents: 0,
      medalRankApplied: 0,
      bracketRateAppliedBps: 0,
      bracketFeeCents: 0,
      maintFeeCents: board.maintFeeCents,
      // Como en los eventos: la pasarela la pagan los gastos de gestión digital, no la hucha.
      gatewayFeeCents: 0,
      ticketSubtype: 'VOUCHER' as const,
      ticketPriceCents: draft.ticketPriceCents,
      // Sin tope, `ticketMax` queda vacío (el motor del 5.14a vende sin límite) y el objetivo orientativo va aparte; un objetivo a 0 no se guarda (la base lo exige positivo).
      ticketMax: draft.voucherCapped ? draft.ticketMax : null,
      ticketFeeMode: draft.ticketFeeMode,
      ticketVenue: null,
      voucherValidUntil: validUntil,
      voucherTargetCount: !draft.voucherCapped && draft.voucherTargetCount > 0 ? draft.voucherTargetCount : null,
      // Una venta sin tope nunca se agota y un colegio con ánimo de lucro no recibe aportaciones sin nada a cambio (decisión 65): ahí no se guarda aunque llegue marcado.
      voucherNoProductEnabled: draft.voucherCapped && draft.voucherNoProductEnabled && !context.forProfitSchool
    };
  }
  return {
    goalCents: board.goalCents,
    costMatCents: 0,
    costInstCents: 0,
    contingencyBps: draft.contingencyBps,
    defaultExemptAppliedCents: 0,
    medalExemptAppliedCents: 0,
    medalRankApplied: 0,
    bracketRateAppliedBps: 0,
    bracketFeeCents: 0,
    maintFeeCents: board.maintFeeCents,
    // En taquilla la pasarela ya la pagan los gastos de gestión digital (cuentas `KORUM_REVENUE_TICKET_FEE` y `GATEWAY_FEES_EXPENSE`): guardarla aquí haría que la
    // liquidación la restara otra vez de la hucha. La pizarra la enseña como coste cubierto, no como parte de la meta (auditoría financiera del 4.3).
    gatewayFeeCents: 0,
    ticketSubtype: draft.ticketSubtype,
    ticketPriceCents: draft.ticketPriceCents,
    ticketMax: draft.ticketMax,
    ticketFeeMode: draft.ticketFeeMode,
    ticketVenue: draft.ticketVenue,
    ...NO_VOUCHER_COLUMNS
  };
}

/** Lo que no mueve dinero y se puede cambiar con la campaña ya recaudando. Una venta de vales no tiene reto por curso ni placa: su compra no se apunta a un curso. */
export function softColumns(draft: StudioDraft) {
  const vouchers = isVoucherDraft(draft);
  return {
    description: draft.description,
    showPublicBreakdown: draft.showPublicBreakdown,
    plaqueEnabled: vouchers ? false : draft.plaqueEnabled,
    rewardEnabled: vouchers ? false : draft.rewardEnabled,
    rewardText: draft.rewardEnabled && !vouchers ? draft.rewardText : null,
    targetFamiliesPerCourse: draft.targetFamiliesPerCourse
  };
}
