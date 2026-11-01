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

/** Los `count` números libres más bajos entre `1` y `max`. */
export function lowestFreeNumbers(taken: readonly number[], count: number, max: number): number[] {
  const occupied = new Set(taken);
  const free: number[] = [];
  for (let candidate = 1; candidate <= max && free.length < count; candidate += 1) {
    if (!occupied.has(candidate)) free.push(candidate);
  }
  return free;
}

/**
 * Convierte la reserva en venta y emite el pase. Sin reserva vigente (pago tardío, o reintento tras un fallo) coge plaza solo si queda.
 * Si ya no queda, o la rifa ya se sorteó, devuelve `issued: false` y quien llama reembolsa el cobro: una papeleta vendida después del
 * sorteo no habría podido ganar.
 */
export async function settleTicketSeatInTx(tx: Db, contribution: ContributionForSeat, qrSecret: string, occurredAt: Date): Promise<SeatOutcome> {
  const quantity = contribution.ticketQuantity;
  if (quantity === null) throw new TicketSettlementError(`La entrada de la aportación ${contribution.id} no indica cuántas plazas son.`);
  const initiative = await tx.initiative.findUniqueOrThrow({
    where: { id: contribution.initiativeId },
    select: { ticketMax: true, ticketsSold: true, ticketsHeld: true, ticketSubtype: true, _count: { select: { raffleDraws: true } } }
  });
  if (initiative.ticketMax === null) throw new TicketSettlementError(`La iniciativa ${contribution.initiativeId} vende entradas sin aforo.`);

  const heldBefore = contribution.ticketHoldUntil !== null;
  if (initiative._count.raffleDraws > 0) {
    await releaseTicketHoldInTx(tx, contribution);
    return { issued: false };
  }
  if (!heldBefore && initiative.ticketsSold + initiative.ticketsHeld + quantity > initiative.ticketMax) return { issued: false };

  const holderEmail = contribution.guestEmail ?? (contribution.userId ? (await tx.user.findUniqueOrThrow({ where: { id: contribution.userId }, select: { email: true } })).email : null);
  if (!holderEmail) throw new TicketSettlementError(`La entrada de la aportación ${contribution.id} no tiene a quién enviarse.`);

  if (heldBefore) await releaseTicketHoldInTx(tx, contribution);
  const updated = await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { ticketsSold: { increment: quantity } }, select: { ticketsSold: true } });

  const subtype = initiative.ticketSubtype ?? 'EVENT';
  const serialCode = `${subtype === 'RAFFLE' ? 'RIFA' : 'PASE'}-${occurredAt.getUTCFullYear()}-${String(contribution.id).padStart(6, '0')}`;
  const uuid = randomUUID();
  const pass = await tx.ticketPass.create({
    data: { uuid, contributionId: contribution.id, initiativeId: contribution.initiativeId, serialCode, subtype, holderEmail, quantity, qrHmacSignature: signPass(qrSecret, uuid), createdAt: occurredAt }
  });

  let raffleNumbers: number[] = [];
  if (subtype === 'RAFFLE') {
    const taken = await tx.raffleNumber.findMany({ where: { initiativeId: contribution.initiativeId }, select: { number: true } });
    raffleNumbers = lowestFreeNumbers(taken.map((row) => row.number), quantity, initiative.ticketMax);
    if (raffleNumbers.length !== quantity) throw new TicketSettlementError(`La rifa ${contribution.initiativeId} no tiene ${quantity} números libres.`);
    await tx.raffleNumber.createMany({ data: raffleNumbers.map((number) => ({ initiativeId: contribution.initiativeId, number, ticketPassId: pass.id })) });
    await tx.ticketPass.update({ where: { id: pass.id }, data: { raffleNumbers } });
  }

  // El mensaje lleva el identificador del pase, nunca el QR firmado: lo compone quien lo envía (Sprint 2.6).
  await tx.outboxMessage.create({
    data: {
      idempotencyKey: `ticket.pass:${contribution.id}`,
      templateKey: 'ticket.pass',
      locale: contribution.locale,
      toAddress: holderEmail,
      userId: contribution.userId,
      organizationId: contribution.organizationId,
      payloadJson: { passUuid: uuid, serialCode, initiativeId: contribution.initiativeId, quantity, raffleNumbers }
    }
  });
  return { issued: true, passUuid: uuid, capacityFull: updated.ticketsSold >= initiative.ticketMax };
}

/**
 * Anula el pase de un cobro deshecho: deja de valer en la puerta y en el sorteo, y sus números de rifa quedan libres. Devuelve las plazas
 * que ocupaba (0 si no tenía pase o ya estaba anulado), para que quien llama las descuente del aforo si procede.
 */
export async function revokePassInTx(tx: Db, contributionId: number, revokedAt: Date): Promise<number> {
  const pass = await tx.ticketPass.findUnique({ where: { contributionId }, select: { id: true, quantity: true, revokedAt: true } });
  if (!pass || pass.revokedAt) return 0;
  await tx.ticketPass.update({ where: { id: pass.id }, data: { revokedAt } });
  await tx.raffleNumber.deleteMany({ where: { ticketPassId: pass.id } });
  return pass.quantity;
}
