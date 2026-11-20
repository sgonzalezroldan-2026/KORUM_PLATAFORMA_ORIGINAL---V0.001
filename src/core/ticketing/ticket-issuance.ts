import { randomUUID } from 'node:crypto';
import type { Db } from '@/lib/db';
import { signPass } from './qr-signature';
import { releaseTicketHoldInTx } from './ticket-reservation.service';

/**
 * Lo que pasa con las plazas cuando se confirma o se deshace un cobro. Todo corre en la transacción del webhook, con la fila de la iniciativa
 * ya bloqueada: el asiento, los contadores y el pase se confirman juntos o no se confirma nada.
 */

export class TicketSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketSettlementError';
  }
}

export interface ContributionForSeat {
  id: number;
  initiativeId: number;
  organizationId: string;
  ticketQuantity: number | null;
  ticketHoldUntil: Date | null;
  guestEmail: string | null;
  userId: string | null;
  locale: 'es' | 'ca' | 'en';
}

export type SeatOutcome = { issued: true; passUuid: string; capacityFull: boolean } | { issued: false };

/**
 * Convierte la reserva en venta y emite el pase. Sin reserva vigente (pago tardío, o reintento tras un fallo) coge plaza solo si queda.
 * Si ya no queda, devuelve `issued: false` y quien llama reembolsa el cobro entero.
 *
 * En una venta de vales (Sprint 5.14a) es lo mismo con dos diferencias: puede no tener tope (`ticketMax` vacío) y el pase lleva el saldo de vales de toda
 * la compra (serie `VALE-`). Una aportación «sin producto» no pasa por aquí: no tiene vales ni pase.
 */
export async function settleTicketSeatInTx(tx: Db, contribution: ContributionForSeat, qrSecret: string, occurredAt: Date): Promise<SeatOutcome> {
  const quantity = contribution.ticketQuantity;
  if (quantity === null) throw new TicketSettlementError(`La entrada de la aportación ${contribution.id} no indica cuántas plazas son.`);
  const initiative = await tx.initiative.findUniqueOrThrow({
    where: { id: contribution.initiativeId },
    select: { ticketMax: true, ticketsSold: true, ticketsHeld: true, ticketSubtype: true }
  });
  const subtype = initiative.ticketSubtype ?? 'EVENT';
  if (initiative.ticketMax === null && subtype !== 'VOUCHER') throw new TicketSettlementError(`La iniciativa ${contribution.initiativeId} vende entradas sin aforo.`);

  const heldBefore = contribution.ticketHoldUntil !== null;
  if (!heldBefore && initiative.ticketMax !== null && initiative.ticketsSold + initiative.ticketsHeld + quantity > initiative.ticketMax) return { issued: false };

  const holderEmail = contribution.guestEmail ?? (contribution.userId ? (await tx.user.findUniqueOrThrow({ where: { id: contribution.userId }, select: { email: true } })).email : null);
  if (!holderEmail) throw new TicketSettlementError(`La entrada de la aportación ${contribution.id} no tiene a quién enviarse.`);

  if (heldBefore) await releaseTicketHoldInTx(tx, contribution);
  const updated = await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { ticketsSold: { increment: quantity } }, select: { ticketsSold: true } });

  const serialCode = `${subtype === 'VOUCHER' ? 'VALE' : 'PASE'}-${occurredAt.getUTCFullYear()}-${String(contribution.id).padStart(6, '0')}`;
  const uuid = randomUUID();
  await tx.ticketPass.create({
    data: { uuid, contributionId: contribution.id, initiativeId: contribution.initiativeId, serialCode, subtype, holderEmail, quantity, qrHmacSignature: signPass(qrSecret, uuid), createdAt: occurredAt }
  });

  // Una venta de vales no se agota en el sentido de un evento: sigue abierta (para la aportación «sin producto» y la devolución de 14 días) hasta su cierre.
  // Su email con el QR y el saldo llega con la ficha y la compra (Sprint 5.14b); hasta entonces no hay manera de comprar vales desde la aplicación.
  if (subtype === 'VOUCHER') return { issued: true, passUuid: uuid, capacityFull: false };

  // El mensaje lleva el identificador del pase, nunca el QR firmado: lo compone quien lo envía (Sprint 2.6).
  await tx.outboxMessage.create({
    data: {
      idempotencyKey: `ticket.pass:${contribution.id}`,
      templateKey: 'ticket.pass',
      locale: contribution.locale,
      toAddress: holderEmail,
      userId: contribution.userId,
      organizationId: contribution.organizationId,
      payloadJson: { passUuid: uuid, serialCode, initiativeId: contribution.initiativeId, quantity }
    }
  });
  return { issued: true, passUuid: uuid, capacityFull: initiative.ticketMax !== null && updated.ticketsSold >= initiative.ticketMax };
}

/**
 * Anula el pase de un cobro deshecho: deja de valer en la puerta. Devuelve las plazas
 * que ocupaba (0 si no tenía pase o ya estaba anulado), para que quien llama las descuente del aforo si procede.
 */
export async function revokePassInTx(tx: Db, contributionId: number, revokedAt: Date): Promise<number> {
  const pass = await tx.ticketPass.findUnique({ where: { contributionId }, select: { id: true, quantity: true, revokedAt: true } });
  if (!pass || pass.revokedAt) return 0;
  await tx.ticketPass.update({ where: { id: pass.id }, data: { revokedAt } });
  return pass.quantity;
}
