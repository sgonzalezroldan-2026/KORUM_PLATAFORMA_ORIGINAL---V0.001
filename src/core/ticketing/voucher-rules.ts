import { bpsOf } from '@/core/finance/money';
import { gatewayChargeCostCents, type GatewayRates } from '@/core/finance/tco.service';

/**
 * Reglas puras de los vales (Sprint 5.14a; decisión 32 del promotor, con la 49 y las dos del 2026-11-19). Sin base de datos: las usan la compra, el canje,
 * la salud de precios de la consola y, desde el 5.14b, el Estudio y la ficha pública.
 *
 * - **Un vale es una unidad de canje** de precio único. Cada compra tiene **un solo pase** con su saldo (`quantity − checkedInCount`).
 * - **Gastos de gestión digital con tarifa propia**, que se calculan **por compra**: `fijo + porcentaje × importe de la compra`. Comprar 10 vales de 1 € paga
 *   un solo fijo, como la pasarela, que cobra uno por cobro. En `ADD` van encima; en `INC`, dentro del importe (nunca más que el importe).
 * - **«Sin producto»**: al agotarse el tope, la entidad puede dejar seguir aportando sin recibir vales. Es una **aportación sin certificado**, fuera del
 *   Modelo 182 y con los mismos Gastos de gestión digital (decisión del promotor del 2026-11-19), y se mide en vales: «aportar el equivalente a 3 vales». No se ofrece
 *   en un colegio con ánimo de lucro, que no recibe donaciones (decisiones 42 y 51; segunda decisión del 2026-11-19).
 */

/** Vales por compra. Una cifra mayor casi siempre es un error al teclear; la persona puede hacer otra compra. */
export const MAX_VOUCHERS_PER_ORDER = 50;

export type VoucherFeeMode = 'ADD' | 'INC';

export interface VoucherFeeConfig {
  fixedCents: number;
  pctBps: number;
}

export interface VoucherCharge {
  /** Precio de los vales de la compra: `precio × cantidad`. */
  grossCents: number;
  /** Gastos de gestión digital que se queda KORUM (en `INC`, dentro del importe). */
  serviceFeeCents: number;
  /** Lo que entra en la hucha de la venta. */
  amountCents: number;
  /** Lo que se cobra (sin la aportación voluntaria a KORUM, que va aparte). */
  totalChargedCents: number;
}

export class VoucherPricingError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'VoucherPricingError';
  }
}

const isNonNegativeInt = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Gastos de gestión digital de una compra de vales: `fijo + importe × pct / 10000`, redondeado al céntimo. */
export function voucherFeeCents(grossCents: number, fee: VoucherFeeConfig): number {
  if (!isNonNegativeInt(grossCents) || !isNonNegativeInt(fee.fixedCents) || !isNonNegativeInt(fee.pctBps)) {
    throw new VoucherPricingError('La tarifa de los vales o el importe no son enteros válidos.');
  }
  return fee.fixedCents + bpsOf(grossCents, fee.pctBps);
}

/** Lo que paga quien compra `quantity` vales (o aporta su equivalente «sin producto») y lo que llega a la hucha. Lanza con datos imposibles. */
export function voucherCharge(input: { priceCents: number; quantity: number; feeMode: VoucherFeeMode; fee: VoucherFeeConfig }): VoucherCharge {
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents <= 0) throw new VoucherPricingError('El precio de un vale debe ser un entero positivo.');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_VOUCHERS_PER_ORDER) throw new VoucherPricingError('La cantidad de vales no es válida.');
  const grossCents = input.priceCents * input.quantity;
  if (!Number.isSafeInteger(grossCents)) throw new VoucherPricingError('El importe de la compra no cabe en un entero.');
  const feeCents = voucherFeeCents(grossCents, input.fee);
  if (input.feeMode === 'ADD') return { grossCents, serviceFeeCents: feeCents, amountCents: grossCents, totalChargedCents: grossCents + feeCents };
  const retainedCents = Math.min(feeCents, grossCents);
  return { grossCents, serviceFeeCents: retainedCents, amountCents: grossCents - retainedCents, totalChargedCents: grossCents };
}

/**
 * Margen de KORUM en una compra de vales: gastos de gestión menos la pasarela sobre lo cobrado (`importe + gestión`, el caso `ADD`, como en las entradas).
 * La Regla 02 §6 exige que sea estrictamente positivo. Lo usa la salud de precios de la consola.
 */
export function voucherFeeMarginCents(grossCents: number, fee: VoucherFeeConfig, gateway: GatewayRates): { feeCents: number; gatewayCostCents: number; marginCents: number } {
  const feeCents = voucherFeeCents(grossCents, fee);
  const gatewayCostCents = gatewayChargeCostCents(grossCents + feeCents, gateway);
  return { feeCents, gatewayCostCents, marginCents: feeCents - gatewayCostCents };
}

// --- La venta ------------------------------------------------------------------------------------------------------------------------------

export interface VoucherSaleState {
  status: string;
  closesAt: Date;
  voucherValidUntil: Date | null;
  ticketPriceCents: number | null;
  ticketFeeMode: VoucherFeeMode | null;
  ticketMax: number | null;
  ticketsSold: number;
  ticketsHeld: number;
  voucherNoProductEnabled: boolean;
  /** Forma jurídica de la entidad que vende. */
  legalForm: string;
}

/**
 * ¿Es un colegio con ánimo de lucro? Hoy la plataforma lo reconoce por su forma jurídica: titular de un colegio privado o concertado (`SCHOOL_OWNER`, que no
 * puede declarar la Ley 49/2002; CUMPLIMIENTO §2). El reparto fino de formas jurídicas se revisa en el Sprint 5.15.
 */
export const isForProfitSchool = (legalForm: string): boolean => legalForm === 'SCHOOL_OWNER';

/** Vales que quedan a la venta, o `null` si la venta no tiene tope. Las plazas retenidas por pagos en curso no están disponibles. */
export function vouchersAvailable(sale: Pick<VoucherSaleState, 'ticketMax' | 'ticketsSold' | 'ticketsHeld'>): number | null {
  if (sale.ticketMax === null) return null;
  return Math.max(0, sale.ticketMax - sale.ticketsSold - sale.ticketsHeld);
}

/** Por qué no se pueden comprar vales ahora (o `null` si se puede): fuera de venta, vencida la venta o pasada la validez de los vales. */
export function voucherSaleBlock(sale: VoucherSaleState, now: Date): 'NOT_ON_SALE' | 'VALIDITY_ENDED' | null {
  if (sale.status !== 'FUNDRAISING' || sale.closesAt.getTime() <= now.getTime()) return 'NOT_ON_SALE';
  if (sale.ticketPriceCents === null || sale.ticketPriceCents <= 0 || sale.ticketFeeMode === null || sale.voucherValidUntil === null) return 'NOT_ON_SALE';
  // Un vale que ya no se puede gastar no se vende.
  if (sale.voucherValidUntil.getTime() <= now.getTime()) return 'VALIDITY_ENDED';
  return null;
}

/**
 * ¿Se ofrece ahora seguir aportando «sin producto»? Solo si la venta está abierta, tiene tope y está **agotada de verdad** (todo vendido y pagado), la entidad lo
 * ha activado y no es un colegio con ánimo de lucro. Con los últimos vales retenidos por un pago en curso no se ofrece: si ese pago no se completa, vuelven a
 * estar a la venta, y quien hubiera aportado «sin producto» (que no se devuelve) habría pagado sin vales habiéndolos (auditoría de seguridad del 5.14a).
 * Una venta sin tope nunca se agota: ahí siempre se compran vales.
 */
export function noProductOffered(sale: VoucherSaleState, now: Date): boolean {
  if (!sale.voucherNoProductEnabled || isForProfitSchool(sale.legalForm)) return false;
  if (voucherSaleBlock(sale, now) !== null) return false;
  return sale.ticketMax !== null && sale.ticketsSold >= sale.ticketMax;
}

// --- El canje ------------------------------------------------------------------------------------------------------------------------------

/** Estados de la venta en los que se puede gastar un vale: a la venta, cerrada sin liquidar o ya liquidada (el vale vale hasta su fecha, no hasta la liquidación). */
const REDEEMABLE_SALE_STATUSES = new Set(['FUNDRAISING', 'GOAL_REACHED', 'CLOSED']);

export type VoucherRedeemBlock = 'REVOKED' | 'NOT_PAID' | 'SALE_CLOSED' | 'EXPIRED';

/** Por qué no se puede gastar ningún vale de un pase (o `null` si se puede). El orden importa: un pase anulado se dice antes que una venta cerrada. */
export function voucherRedeemBlock(pass: { revokedAt: Date | null; contributionStatus: string }, sale: { status: string; voucherValidUntil: Date | null }, now: Date): VoucherRedeemBlock | null {
  if (pass.revokedAt !== null) return 'REVOKED';
  if (!REDEEMABLE_SALE_STATUSES.has(sale.status)) return 'SALE_CLOSED';
  if (pass.contributionStatus !== 'COMPLETED') return 'NOT_PAID';
  if (sale.voucherValidUntil === null || sale.voucherValidUntil.getTime() <= now.getTime()) return 'EXPIRED';
  return null;
}
