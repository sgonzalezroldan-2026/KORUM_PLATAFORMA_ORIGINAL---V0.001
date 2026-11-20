import { evaluateMaintenanceCapShutoff, gatewayChargeCostCents } from '@/core/finance/tco.service';
import { MAX_VOUCHERS_PER_ORDER, voucherCharge, voucherFeeMarginCents } from '@/core/ticketing/voucher-rules';
import type { StudioContext } from './studio-board';
import { endOfDayInMadrid, latestVoucherValidOn, type StudioDraft } from './studio-draft';

/**
 * Pizarra de una venta de vales en el Estudio (Sprint 5.14b; decisión 32 y las del promotor del 2026-11-19 y del 2026-11-20). Función pura: la pantalla la llama en
 * cada pulsación y el servidor al guardar y al publicar, con la tarifa de vales de la entidad que lee él mismo. Las fórmulas de cada compra son las del motor
 * (`voucherCharge`), así que la pizarra, la ficha y el cobro dicen lo mismo.
 *
 * - **Unidades:** el tope o, sin tope, el objetivo orientativo de vales (que no limita la venta).
 * - **Gastos de gestión digital por compra**, no por vale. Cuántas compras habrá no se sabe: en `INC` la meta usa el **peor neto por vale** de cualquier compra
 *   posible (de 1 a `MAX_VOUCHERS_PER_ORDER` vales, redondeado hacia abajo), así que es lo mínimo que recibe la entidad si se vende todo, se compre como se compre.
 *   Con un fijo por compra el peor caso es casi siempre la compra de un vale; sin fijo, el redondeo del porcentaje puede hacer que una compra de varios deje un
 *   céntimo menos por vale (auditoría financiera del 5.14b). En `ADD` los gastos van aparte y la meta es el precio de todos los vales.
 * - **Pasarela cubierta:** la gestión debe pagar la pasarela tanto en la compra más pequeña (1 vale) como en la más grande (`MAX_VOUCHERS_PER_ORDER`), como
 *   comprueba la salud de precios de la consola.
 */

export interface VoucherBoard {
  kind: 'VOUCHER';
  /** `true` con tope; `false` si `units` es el objetivo orientativo. */
  capped: boolean;
  /** Vales del tope o del objetivo. */
  units: number;
  /** Precio de todos esos vales. */
  grossCents: number;
  /** Gastos de gestión digital de una compra de 1 vale y lo que paga quien la hace. */
  feeOneCents: number;
  buyerOneCents: number;
  /** La compra más grande: `MAX_VOUCHERS_PER_ORDER` vales. */
  largestQuantity: number;
  feeLargestCents: number;
  /** Gastos de gestión y pasarela si cada vale fuera una compra (el máximo posible). */
  totalDigitalFeesCents: number;
  totalGatewayCostCents: number;
  maintFeeCents: number;
  maintShortfallCents: number;
  /** Lo que se queda la entidad si se venden todos los vales, descontado el mantenimiento (al menos esto en `INC`). */
  netCents: number;
  /** Lo que entra en la hucha si se venden todos los vales: la meta de la venta. */
  goalCents: number;
  /** Margen de KORUM en la compra de 1 vale (la pasarela sobre lo cobrado), para el aviso. */
  marginOneCents: number;
  isGatewayCovered: boolean;
}

/** Vales con los que se calcula la venta: el tope o, sin él, el objetivo. */
export const voucherUnits = (draft: Pick<StudioDraft, 'voucherCapped' | 'ticketMax' | 'voucherTargetCount'>): number => (draft.voucherCapped ? draft.ticketMax : draft.voucherTargetCount);

/** Una compra de `quantity` vales con la tarifa de la entidad, o `null` si con estos datos no hay compra posible (precio a cero). */
function chargeOf(context: StudioContext, draft: StudioDraft, quantity: number) {
  if (draft.ticketPriceCents <= 0) return null;
  return voucherCharge({ priceCents: draft.ticketPriceCents, quantity, feeMode: draft.ticketFeeMode, fee: context.voucherFee });
}

/** El menor importe por vale (en céntimos enteros, hacia abajo) que llega a la hucha en cualquier compra de 1 a `MAX_VOUCHERS_PER_ORDER` vales. */
function worstNetPerVoucherCents(context: StudioContext, draft: StudioDraft): number {
  if (draft.ticketPriceCents <= 0) return 0;
  let worst = draft.ticketPriceCents;
  for (let quantity = 1; quantity <= MAX_VOUCHERS_PER_ORDER; quantity += 1) {
    const charge = chargeOf(context, draft, quantity);
    if (charge) worst = Math.min(worst, Math.floor(charge.amountCents / quantity));
  }
  return worst;
}

/** `maintFeeCents` fija el mantenimiento de una venta ya publicada, que no se recalcula. */
export function computeVoucherBoard(context: StudioContext, draft: StudioDraft, frozenMaintFeeCents?: number): VoucherBoard {
  const units = voucherUnits(draft);
  const one = chargeOf(context, draft, 1);
  const largest = chargeOf(context, draft, MAX_VOUCHERS_PER_ORDER);
  const feeOneCents = one?.serviceFeeCents ?? 0;
  const grossCents = draft.ticketPriceCents * units;
  const netPerVoucherCents = worstNetPerVoucherCents(context, draft);
  const goalCents = netPerVoucherCents * units;
  const maintFeeCents =
    frozenMaintFeeCents ??
    (grossCents > 0
      ? evaluateMaintenanceCapShutoff({ active: context.maint.active, perInitCents: context.maint.perInitCents, annualCapCents: context.maint.annualCapCents, alreadyChargedOrReservedCents: context.maint.paidCents }).maintFeeCents
      : 0);
  const oneMargin = one ? voucherFeeMarginCents(one.grossCents, context.voucherFee, context.gateway) : null;
  const largestMargin = largest ? voucherFeeMarginCents(largest.grossCents, context.voucherFee, context.gateway) : null;
  const gatewayOneCents = one && one.totalChargedCents > 0 ? gatewayChargeCostCents(one.totalChargedCents, context.gateway) : 0;
  return {
    kind: 'VOUCHER',
    capped: draft.voucherCapped,
    units,
    grossCents,
    feeOneCents,
    buyerOneCents: one?.totalChargedCents ?? 0,
    largestQuantity: MAX_VOUCHERS_PER_ORDER,
    feeLargestCents: largest?.serviceFeeCents ?? 0,
    totalDigitalFeesCents: feeOneCents * units,
    totalGatewayCostCents: gatewayOneCents * units,
    maintFeeCents,
    maintShortfallCents: Math.max(0, maintFeeCents - goalCents),
    netCents: Math.max(0, goalCents - maintFeeCents),
    goalCents,
    marginOneCents: oneMargin?.marginCents ?? 0,
    // Sin precio no hay compra que medir: no se avisa de nada que no exista.
    isGatewayCovered: oneMargin === null || largestMargin === null || (oneMargin.marginCents > 0 && largestMargin.marginCents > 0)
  };
}

/**
 * Validez de los vales (decisión 49 y la del promotor del 2026-11-20): la fija la entidad, sin mínimo, pero nunca antes del día de cierre de la venta (un vale no
 * puede caducar mientras se vende) ni más de `VOUCHER_VALIDITY_MAX_MONTHS` meses después (frena una errata). Las fechas `AAAA-MM-DD` se comparan como texto.
 */
export function voucherValidityProblem(draft: Pick<StudioDraft, 'closesOn' | 'voucherValidOn'>): 'VALIDITY_INVALID' | 'VALIDITY_BEFORE_CLOSE' | 'VALIDITY_TOO_LATE' | null {
  if (draft.voucherValidOn === null || endOfDayInMadrid(draft.voucherValidOn) === null) return 'VALIDITY_INVALID';
  if (endOfDayInMadrid(draft.closesOn) === null) return null;
  if (draft.voucherValidOn < draft.closesOn) return 'VALIDITY_BEFORE_CLOSE';
  if (draft.voucherValidOn > latestVoucherValidOn(draft.closesOn)) return 'VALIDITY_TOO_LATE';
  return null;
}
