import { MAX_VOUCHERS_PER_ORDER, voucherCharge, type VoucherFeeConfig } from '@/core/ticketing/voucher-rules';
import { DONATION_MAX_CENTS, DONATION_MIN_CENTS, GUARANTEE_MAX_CENTS, MAX_TICKETS_PER_ORDER } from './checkout-limits';

/**
 * Resumen del checkout que ve la familia antes de pagar. Mismas fórmulas que el servidor: la donación más la aportación voluntaria, o las
 * entradas por su precio más los *Gastos de gestión digital* si van encima (`ADD`). Es solo lo que se enseña: el importe que se cobra lo vuelve
 * a calcular el servidor con los datos de la base. Sin dependencias, para usarlo en el navegador.
 */

export interface TicketPricing {
  mode: 'ADD' | 'INC';
  priceCents: number;
  feeUnitCents: number;
  buyerUnitCents: number;
}

export type CheckoutSummary =
  | { kind: 'DONATION'; donationCents: number; guaranteeCents: number; totalCents: number; valid: boolean }
  | { kind: 'TICKET'; quantity: number; ticketsCents: number; feeCents: number; totalCents: number; valid: boolean }
  | { kind: 'VOUCHER'; quantity: number; vouchersCents: number; feeCents: number; totalCents: number; valid: boolean };

/** Lo que el navegador sabe de una venta de vales para enseñar el total: el precio, la tarifa por compra y cuántos quedan (`null` sin tope). */
export interface VoucherPricing {
  mode: 'ADD' | 'INC';
  priceCents: number;
  fee: VoucherFeeConfig;
}

/**
 * Vales que se pueden elegir: nunca más que el máximo por compra ni más de los que quedan. Una aportación «sin producto» no consume vales: solo el máximo por
 * compra. Sin tope, `available` es `null`.
 */
export function maxSelectableVouchers(available: number | null, noProduct: boolean): number {
  if (noProduct || available === null) return MAX_VOUCHERS_PER_ORDER;
  return Math.max(0, Math.min(MAX_VOUCHERS_PER_ORDER, available));
}

/**
 * Resumen de una compra de vales (o de su equivalente «sin producto»), con la fórmula del motor (`voucherCharge`): los Gastos de gestión digital van **por
 * compra**. En `ADD` se suman y se enseñan; en `INC` van dentro del precio y lo que paga la persona es solo el precio de los vales.
 */
export function voucherSummary(quantity: number, pricing: VoucherPricing, maxSelectable: number): CheckoutSummary {
  const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= Math.min(MAX_VOUCHERS_PER_ORDER, maxSelectable) && pricing.priceCents > 0;
  if (!valid) return { kind: 'VOUCHER', quantity, vouchersCents: Math.max(0, quantity) * pricing.priceCents, feeCents: 0, totalCents: Math.max(0, quantity) * pricing.priceCents, valid: false };
  const charge = voucherCharge({ priceCents: pricing.priceCents, quantity, feeMode: pricing.mode, fee: pricing.fee });
  return { kind: 'VOUCHER', quantity, vouchersCents: charge.grossCents, feeCents: pricing.mode === 'ADD' ? charge.serviceFeeCents : 0, totalCents: charge.totalChargedCents, valid: true };
}

export function donationSummary(donationCents: number | null, guaranteeCents: number): CheckoutSummary {
  const amount = donationCents ?? 0;
  const guarantee = Math.min(Math.max(0, guaranteeCents), GUARANTEE_MAX_CENTS);
  const valid = Number.isSafeInteger(amount) && amount >= DONATION_MIN_CENTS && amount <= DONATION_MAX_CENTS;
  return { kind: 'DONATION', donationCents: amount, guaranteeCents: guarantee, totalCents: amount + guarantee, valid };
}

export function ticketSummary(quantity: number, pricing: TicketPricing, available: number): CheckoutSummary {
  const ticketsCents = quantity * pricing.priceCents;
  // En `INC` la gestión va dentro del precio: lo que paga la persona es solo el precio facial.
  const feeCents = pricing.mode === 'ADD' ? quantity * pricing.feeUnitCents : 0;
  const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= Math.min(MAX_TICKETS_PER_ORDER, available);
  return { kind: 'TICKET', quantity, ticketsCents, feeCents, totalCents: quantity * pricing.buyerUnitCents, valid };
}

/** Entradas que se pueden elegir: nunca más que las que quedan ni más que el máximo por compra. */
export function maxSelectableTickets(available: number): number {
  return Math.max(0, Math.min(MAX_TICKETS_PER_ORDER, available));
}
