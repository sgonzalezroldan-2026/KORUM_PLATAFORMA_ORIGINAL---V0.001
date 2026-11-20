import { randomBytes } from 'node:crypto';
import { GUARANTEE_MAX_CENTS } from '@/core/checkout/checkout-limits';
import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { PaymentMethod } from '@/generated/prisma/enums';
import { inTransaction, QUEUED_TRANSACTION, type Db } from '@/lib/db';
import { releaseExpiredOfInitiative, TICKET_HOLD_MS } from './ticket-reservation.service';
import { MAX_VOUCHERS_PER_ORDER, noProductOffered, voucherCharge, voucherSaleBlock, vouchersAvailable, type VoucherSaleState } from './voucher-rules';

/**
 * Compra de vales (Sprint 5.14a, QA-VAL01). Como la reserva de entradas: la fila de la venta ordena las compras simultáneas, los vales quedan retenidos
 * 15 minutos mientras se paga (`ticketsHeld`) y el `CHECK` de la base de datos impide pasarse del tope aunque este bloqueo fallara. El precio y la tarifa
 * salen siempre de la base de datos. Confirma el cobro el webhook (`settleTicketSeatInTx`), que emite el pase con su saldo.
 *
 * La aportación **«sin producto»** (`mode: 'NO_PRODUCT'`) solo se admite cuando la venta está agotada y la entidad la ofrece (`noProductOffered`): es un cobro
 * de la venta sin vales, sin pase y sin plaza retenida (`Contribution.voucherNoProduct`). Se mide en vales y paga los mismos Gastos de gestión digital.
 */

export type VoucherReservationBlock = 'NOT_FOUND' | 'NOT_ON_SALE' | 'VALIDITY_ENDED' | 'INVALID_QUANTITY' | 'INVALID_GUARANTEE' | 'SOLD_OUT' | 'NO_PRODUCT_NOT_OFFERED';

export class VoucherReservationError extends Error {
  readonly reason: VoucherReservationBlock;
  /** Vales que quedan (para ofrecer menos en lugar de un error seco); `null` si la venta no tiene tope. */
  readonly availableVouchers: number | null;

  constructor(reason: VoucherReservationBlock, availableVouchers: number | null = 0) {
    super(`No se pueden comprar los vales: ${reason}.`);
    this.name = 'VoucherReservationError';
    this.reason = reason;
    this.availableVouchers = availableVouchers;
  }
}

export interface VoucherReservationInput {
  initiativeId: number;
  /** Vales que se compran o, «sin producto», cuántos vales equivale la aportación. */
  quantity: number;
  mode: 'VOUCHERS' | 'NO_PRODUCT';
  /** El comprador: con sesión, su `userId`; sin ella, solo el email. */
  buyer: { userId: string; email: string } | { guestEmail: string };
  paymentMethod: PaymentMethod;
  guaranteeContributionCents?: number;
  locale?: 'es' | 'ca' | 'en';
}

export interface VoucherReservation {
  contributionId: number;
  paycometOrder: string;
  amountCents: number;
  serviceFeeCents: number;
  totalChargedCents: number;
  /** Hasta cuándo quedan retenidos los vales; `null` en una aportación «sin producto», que no retiene nada. */
  holdUntil: Date | null;
}

export async function reserveVouchers(db: Db, input: VoucherReservationInput, now: Date = new Date()): Promise<VoucherReservation> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_VOUCHERS_PER_ORDER) throw new VoucherReservationError('INVALID_QUANTITY');
  const guaranteeCents = input.guaranteeContributionCents ?? 0;
  if (!Number.isSafeInteger(guaranteeCents) || guaranteeCents < 0 || guaranteeCents > GUARANTEE_MAX_CENTS) throw new VoucherReservationError('INVALID_GUARANTEE');

  return inTransaction(
    db,
    async (tx) => {
      // Bloquea la fila de la venta: dos compras de los últimos vales van una detrás de otra y la segunda ve lo que dejó la primera.
      const { count } = await tx.initiative.updateMany({ where: { id: input.initiativeId, ticketSubtype: 'VOUCHER' }, data: { ticketsHeld: { increment: 0 } } });
      if (count === 0) throw new VoucherReservationError('NOT_FOUND');
      await releaseExpiredOfInitiative(tx, input.initiativeId, now);

      const row = await tx.initiative.findUniqueOrThrow({
        where: { id: input.initiativeId },
        select: {
          organizationId: true, format: true, status: true, closesAt: true, voucherValidUntil: true, voucherNoProductEnabled: true, ticketPriceCents: true, ticketFeeMode: true,
          ticketMax: true, ticketsSold: true, ticketsHeld: true,
          organization: { select: { legalForm: true, voucherFeeFixedCents: true, voucherFeeBps: true, contentLocale: true, archivedAt: true } }
        }
      });
      if (row.format !== 'TICKETING' || row.organization.archivedAt !== null) throw new VoucherReservationError('NOT_ON_SALE');
      const sale: VoucherSaleState = { ...row, legalForm: row.organization.legalForm };
      const block = voucherSaleBlock(sale, now);
      if (block !== null) throw new VoucherReservationError(block);
      const available = vouchersAvailable(sale);
      if (input.mode === 'VOUCHERS' && available !== null && input.quantity > available) throw new VoucherReservationError('SOLD_OUT', available);
      if (input.mode === 'NO_PRODUCT' && !noProductOffered(sale, now)) throw new VoucherReservationError('NO_PRODUCT_NOT_OFFERED', available);

      const charge = voucherCharge({
        priceCents: row.ticketPriceCents!,
        quantity: input.quantity,
        feeMode: row.ticketFeeMode!,
        fee: { fixedCents: row.organization.voucherFeeFixedCents, pctBps: row.organization.voucherFeeBps }
      });
      // Sin importe para la hucha no hay asiento posible (unos gastos incluidos que se comen el precio): se cobraría y el webhook fallaría siempre.
      if (charge.amountCents <= 0) throw new VoucherReservationError('NOT_ON_SALE', available);

      const vouchers = input.mode === 'VOUCHERS';
      const holdUntil = vouchers ? new Date(now.getTime() + TICKET_HOLD_MS) : null;
      const buyer = 'userId' in input.buyer ? { userId: input.buyer.userId, canonicalEmail: normalizeCanonicalEmail(input.buyer.email) } : { guestEmail: input.buyer.guestEmail, canonicalEmail: normalizeCanonicalEmail(input.buyer.guestEmail) };
      const paycometOrder = `KV${randomBytes(8).toString('hex').toUpperCase()}`;
      const totalChargedCents = charge.totalChargedCents + guaranteeCents;
      const contribution = await tx.contribution.create({
        data: {
          organizationId: row.organizationId,
          initiativeId: input.initiativeId,
          ...buyer,
          locale: input.locale ?? row.organization.contentLocale,
          fiscalYear: spanishFiscalYear(now),
          // Un vale y la aportación «sin producto» se tratan como una entrada: sin certificado y fuera del Modelo 182 (decisión 32 y la del 2026-11-19).
          type: 'TICKET',
          ticketQuantity: vouchers ? input.quantity : null,
          ticketHoldUntil: holdUntil,
          voucherNoProduct: !vouchers,
          amountCents: charge.amountCents,
          guaranteeContributionCents: guaranteeCents,
          totalChargedCents,
          paymentMethod: input.paymentMethod,
          paycometOrder,
          status: 'PENDING',
          createdAt: now
        }
      });
      if (vouchers) await tx.initiative.update({ where: { id: input.initiativeId }, data: { ticketsHeld: { increment: input.quantity } } });
      return { contributionId: contribution.id, paycometOrder, amountCents: charge.amountCents, serviceFeeCents: charge.serviceFeeCents, totalChargedCents, holdUntil };
    },
    QUEUED_TRANSACTION
  );
}
