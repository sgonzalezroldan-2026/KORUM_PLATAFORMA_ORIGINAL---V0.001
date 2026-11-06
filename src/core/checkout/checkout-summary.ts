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
  | { kind: 'TICKET'; quantity: number; ticketsCents: number; feeCents: number; totalCents: number; valid: boolean };

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
