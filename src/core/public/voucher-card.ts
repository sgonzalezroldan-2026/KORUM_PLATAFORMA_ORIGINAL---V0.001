import { MAX_VOUCHERS_PER_ORDER, noProductOffered, voucherCharge, voucherSaleBlock } from '@/core/ticketing/voucher-rules';
import { daysLeft, percentOf } from './catalog';
import type { InitiativeCardData, InitiativeRow, TicketFees } from './view-model';

/**
 * Tarjeta pública de una venta de vales (Sprint 5.14b, QA-VAL03): lo que `toCardData` enseña cuando la taquilla es de vales. Separado de `view-model.ts` para
 * que cada módulo quede por debajo de las 300 líneas (Regla 04 §3). Mismas reglas que la compra (`voucher-rules`).
 */

/** Lo que la tarjeta y la ficha enseñan de una venta de vales (Sprint 5.14b). Sin lista de artículos: lo que se canjea lo explica la descripción. */
export interface VoucherCardData {
  /** Con tope: `units` es el tope. Sin tope: es el objetivo orientativo, que no limita la venta. */
  capped: boolean;
  units: number;
  /** Vales que quedan a la venta; `null` sin tope. */
  available: number | null;
  /** Último instante en que se pueden gastar (ISO). */
  validUntilIso: string;
  priceCents: number;
  feeMode: 'ADD' | 'INC';
  /** Gastos de gestión digital por compra (no por vale): fijo + porcentaje del importe. */
  feeFixedCents: number;
  feeBps: number;
  /** Lo que paga quien compra un solo vale. */
  buyerOneCents: number;
  /** Ahora se ofrece seguir aportando «sin producto» (venta agotada de verdad, activado y nunca en un colegio con ánimo de lucro). */
  noProduct: boolean;
}

/** Datos públicos de una venta de vales: las mismas reglas que la compra (`voucher-rules`), para que la ficha nunca ofrezca lo que el servidor rechazaría. */
export function buildVoucherCard(row: InitiativeRow, now: Date, fees: TicketFees): VoucherCardData | null {
  if (row.format !== 'TICKETING' || row.ticketSubtype !== 'VOUCHER' || row.ticketPriceCents === null || row.ticketPriceCents <= 0 || row.ticketFeeMode === null || !row.voucherValidUntil) return null;
  const fee = { fixedCents: fees.voucherFeeFixedCents ?? 0, pctBps: fees.voucherFeeBps ?? 0 };
  const capped = row.ticketMax !== null;
  const sale = {
    status: row.status,
    closesAt: row.closesAt,
    voucherValidUntil: row.voucherValidUntil,
    ticketPriceCents: row.ticketPriceCents,
    ticketFeeMode: row.ticketFeeMode,
    ticketMax: row.ticketMax,
    ticketsSold: row.ticketsSold,
    ticketsHeld: row.ticketsHeld,
    voucherNoProductEnabled: row.voucherNoProductEnabled === true,
    legalForm: fees.legalForm ?? ''
  };
  return {
    capped,
    units: row.ticketMax ?? row.voucherTargetCount ?? 0,
    available: capped ? Math.max(0, (row.ticketMax ?? 0) - row.ticketsSold - row.ticketsHeld) : null,
    validUntilIso: row.voucherValidUntil.toISOString(),
    priceCents: row.ticketPriceCents,
    feeMode: row.ticketFeeMode,
    feeFixedCents: fee.fixedCents,
    feeBps: fee.pctBps,
    buyerOneCents: voucherCharge({ priceCents: row.ticketPriceCents, quantity: 1, feeMode: row.ticketFeeMode, fee }).totalChargedCents,
    noProduct: noProductOffered(sale, now)
  };
}

/** ¿Ya no se pueden comprar vales? Fuera de venta o pasada la validez (un vale que no se puede gastar no se vende). */
function voucherSaleClosed(row: InitiativeRow, now: Date): boolean {
  const sale = { status: row.status, closesAt: row.closesAt, voucherValidUntil: row.voucherValidUntil ?? null, ticketPriceCents: row.ticketPriceCents, ticketFeeMode: row.ticketFeeMode, ticketMax: row.ticketMax, ticketsSold: row.ticketsSold, ticketsHeld: row.ticketsHeld, voucherNoProductEnabled: false, legalForm: '' };
  return voucherSaleBlock(sale, now) !== null;
}

/**
 * Tarjeta de una venta de vales. El avance se mide en vales sobre el tope o, sin tope, sobre el objetivo orientativo (que puede superarse: la barra se queda en
 * el 100 %). Está «agotada» solo con tope y sin vales libres; aun así, si se ofrece «sin producto», la ficha deja seguir aportando.
 */
export function toVoucherCardData(row: InitiativeRow, voucher: VoucherCardData, now: Date): InitiativeCardData {
  return {
    id: row.id,
    format: row.format,
    subtype: 'VOUCHER',
    voucher,
    title: row.title,
    category: row.category,
    stage: row.stage,
    pct: percentOf(row.ticketsSold, voucher.units),
    daysLeft: daysLeft(row.closesAt, now),
    raisedCents: row.raisedCents,
    goalCents: row.goalCents,
    ticketsSold: row.ticketsSold,
    ticketMax: voucher.units,
    ticketsAvailable: voucher.available ?? MAX_VOUCHERS_PER_ORDER,
    ticketPriceCents: voucher.priceCents,
    ticketBuyerCents: voucher.buyerOneCents,
    contributions: row.totalContributions,
    achieved: voucher.capped && voucher.available === 0,
    closed: voucherSaleClosed(row, now),
    matching: false,
    coverFileId: row.coverFileId ?? null,
    zeroCommission: false
  };
}
