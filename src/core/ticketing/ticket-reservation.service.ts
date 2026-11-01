import { randomBytes } from 'node:crypto';
import { calculateStudioTicketingTCO } from '@/core/finance/tco.service';
import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { PaymentMethod } from '@/generated/prisma/enums';
import { inTransaction, QUEUED_TRANSACTION, type Db } from '@/lib/db';

/**
 * Reserva atómica de aforo (skill korum-ticketing-qr §3, QA-P03). Al iniciar el pago se retienen las plazas durante un rato: si dos compras
 * llegan a la vez, la fila de la iniciativa las ordena y la segunda ve lo que ha dejado la primera. El `CHECK` de la migración rechaza
 * pasarse del aforo aunque este bloqueo fallara. Una reserva que nadie paga se libera sola con la siguiente reserva del evento.
 */

export const TICKET_HOLD_MS = 15 * 60_000;
export const MAX_TICKETS_PER_ORDER = 20;

export type TicketReservationBlock = 'NOT_FOUND' | 'NOT_ON_SALE' | 'INVALID_QUANTITY' | 'SOLD_OUT';

export class TicketReservationError extends Error {
  readonly reason: TicketReservationBlock;
  /** Plazas que quedan, para ofrecer menos entradas en lugar de un error seco. */
  readonly availableTickets: number;

  constructor(reason: TicketReservationBlock, availableTickets = 0) {
    super(`No se pueden reservar las entradas: ${reason}.`);
    this.name = 'TicketReservationError';
    this.reason = reason;
    this.availableTickets = availableTickets;
  }
}

export interface TicketReservationInput {
  initiativeId: number;
  quantity: number;
  /** El comprador: con sesión, su `userId`; sin ella, solo el email. */
  buyer: { userId: string; email: string } | { guestEmail: string };
  paymentMethod: PaymentMethod;
  groupName?: string;
  guaranteeContributionCents?: number;
  locale?: 'es' | 'ca' | 'en';
}

export interface TicketReservation {
  contributionId: number;
  paycometOrder: string;
  amountCents: number;
  serviceFeeCents: number;
  totalChargedCents: number;
  holdUntil: Date;
}

/** Devuelve las plazas de una compra que las tenga retenidas. Repetirlo no hace nada. La iniciativa debe estar bloqueada. */
export async function releaseTicketHoldInTx(tx: Db, contribution: { id: number; initiativeId: number; ticketQuantity: number | null }): Promise<boolean> {
  const { count } = await tx.contribution.updateMany({ where: { id: contribution.id, ticketHoldUntil: { not: null } }, data: { ticketHoldUntil: null } });
  if (count === 0 || contribution.ticketQuantity === null) return false;
  await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { ticketsHeld: { decrement: contribution.ticketQuantity } } });
  return true;
}

async function releaseExpiredOfInitiative(tx: Db, initiativeId: number, now: Date): Promise<number> {
  const expired = await tx.contribution.findMany({ where: { initiativeId, type: 'TICKET', ticketHoldUntil: { lte: now } }, select: { id: true, initiativeId: true, ticketQuantity: true } });
  for (const contribution of expired) await releaseTicketHoldInTx(tx, contribution);
  return expired.length;
}

/** Libera las reservas caducadas de todos los eventos. La ejecuta la tarea programada (Sprint 2.4) para que el aforo visible no se quede corto. */
export async function releaseExpiredTicketHolds(db: Db, now: Date = new Date()): Promise<number> {
  const initiatives = await db.contribution.findMany({ where: { type: 'TICKET', ticketHoldUntil: { lte: now } }, distinct: ['initiativeId'], select: { initiativeId: true } });
  let released = 0;
  for (const { initiativeId } of initiatives) {
    released += await inTransaction(db, async (tx) => {
      await tx.initiative.update({ where: { id: initiativeId }, data: { ticketsHeld: { increment: 0 } } });
      return releaseExpiredOfInitiative(tx, initiativeId, now);
    });
  }
  return released;
}

/** Retiene las plazas y crea la aportación `PENDING` que confirmará el webhook. El precio sale siempre de la base de datos. */
export async function reserveTickets(db: Db, input: TicketReservationInput, now: Date = new Date()): Promise<TicketReservation> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_TICKETS_PER_ORDER) throw new TicketReservationError('INVALID_QUANTITY');
  const guaranteeCents = input.guaranteeContributionCents ?? 0;
  if (!Number.isSafeInteger(guaranteeCents) || guaranteeCents < 0) throw new TicketReservationError('INVALID_QUANTITY');

  return inTransaction(db, async (tx) => {
    const { count } = await tx.initiative.updateMany({ where: { id: input.initiativeId }, data: { ticketsHeld: { increment: 0 } } });
    if (count === 0) throw new TicketReservationError('NOT_FOUND');
    await releaseExpiredOfInitiative(tx, input.initiativeId, now);

    const initiative = await tx.initiative.findUniqueOrThrow({
      where: { id: input.initiativeId },
      select: {
        organizationId: true, format: true, status: true, closesAt: true, ticketMax: true, ticketsSold: true, ticketsHeld: true, ticketPriceCents: true, ticketFeeMode: true, ticketSubtype: true, rafflePrizeCount: true,
        organization: { select: { ticketFeeFixedCents: true, ticketFeeBps: true, contentLocale: true } },
        _count: { select: { raffleDraws: true } }
      }
    });
    const { ticketMax, ticketPriceCents, ticketFeeMode } = initiative;
    if (initiative.format !== 'TICKETING' || initiative.status !== 'FUNDRAISING' || initiative.closesAt <= now || initiative._count.raffleDraws > 0) throw new TicketReservationError('NOT_ON_SALE');
    if (ticketMax === null || ticketPriceCents === null || ticketFeeMode === null) throw new TicketReservationError('NOT_ON_SALE');
    if (initiative.ticketSubtype === 'RAFFLE' && initiative.rafflePrizeCount === null) throw new TicketReservationError('NOT_ON_SALE');
    const available = Math.max(0, ticketMax - initiative.ticketsSold - initiative.ticketsHeld);
    if (input.quantity > available) throw new TicketReservationError('SOLD_OUT', available);

    const config = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { gatewayPctBps: true, gatewayFixedCents: true } });
    const pricing = calculateStudioTicketingTCO({
      ticketPriceCents,
      ticketMax: input.quantity,
      feeMode: ticketFeeMode,
      digitalFeeConfig: { fixedCents: initiative.organization.ticketFeeFixedCents, pctBps: initiative.organization.ticketFeeBps },
      gatewayConfig: { pctBps: config.gatewayPctBps, fixedCents: config.gatewayFixedCents },
      maintFeeCents: 0
    });
    const serviceFeeCents = pricing.totalDigitalFeesCents;
    const amountCents = ticketFeeMode === 'ADD' ? pricing.grossTicketsCents : pricing.grossTicketsCents - serviceFeeCents;
    const totalChargedCents = amountCents + serviceFeeCents + guaranteeCents;
    // Sin importe para la hucha no hay asiento posible: se cobraría y el webhook fallaría siempre. Una entrada gratuita no pasa por aquí.
    if (amountCents <= 0) throw new TicketReservationError('NOT_ON_SALE');

    const holdUntil = new Date(now.getTime() + TICKET_HOLD_MS);
    const buyer = 'userId' in input.buyer ? { userId: input.buyer.userId, canonicalEmail: normalizeCanonicalEmail(input.buyer.email) } : { guestEmail: input.buyer.guestEmail, canonicalEmail: normalizeCanonicalEmail(input.buyer.guestEmail) };
    const paycometOrder = `KT${randomBytes(8).toString('hex').toUpperCase()}`;
    const contribution = await tx.contribution.create({
      data: {
        organizationId: initiative.organizationId,
        initiativeId: input.initiativeId,
        ...buyer,
        locale: input.locale ?? initiative.organization.contentLocale,
        fiscalYear: now.getUTCFullYear(),
        type: 'TICKET',
        groupName: input.groupName ?? null,
        ticketQuantity: input.quantity,
        ticketHoldUntil: holdUntil,
        amountCents,
        guaranteeContributionCents: guaranteeCents,
        totalChargedCents,
        paymentMethod: input.paymentMethod,
        paycometOrder,
        status: 'PENDING',
        createdAt: now
      }
    });
    await tx.initiative.update({ where: { id: input.initiativeId }, data: { ticketsHeld: { increment: input.quantity } } });
    return { contributionId: contribution.id, paycometOrder, amountCents, serviceFeeCents, totalChargedCents, holdUntil };
  }, QUEUED_TRANSACTION);
}
