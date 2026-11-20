import { z } from 'zod';
import { hashIpSubnet } from '@/core/security/device-signals';
import { verifyPassViewSignature } from '@/core/ticketing/qr-signature';
import { unspentRefundLines, voucherRefundOffer, type VoucherPurchaseState, type VoucherRefundBlock } from '@/core/ticketing/voucher-lifecycle-rules';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { EVENT_REFUND_RULE } from '@/lib/rate-limit-rules';
import { approvePartialRefundInTx } from '@/services/payments/partial-refunds';
import { approveRefundInTx, loadLockedContribution } from '@/services/payments/payment-reversals';

/**
 * Devolución de una compra de vales desde su pase (Sprint 5.14c; decisiones 32, 69 y 70; QA-VAL04). Se pide desde el pase (`/{entidad}/entrada/{pase}?sig=`), sin
 * cuenta: el enlace lleva la firma de **ver** el pase, la misma que ya da acceso a él, así que quien tiene el pase puede devolverlo, igual que puede gastarlo.
 *
 * - **14 días desde la compra, sin gastar ningún vale:** el 100 % (vales y Gastos de gestión digital) al medio de pago original, con su contra-asiento.
 * - **14 días desde que la entidad acortó la validez**, si compró antes: lo no gastado (el 100 % si no gastó nada; si no, la parte de lo pagado que corresponde a
 *   los vales sin gastar, `approvePartialRefundInTx`).
 * - Fuera de esos plazos, o con todos los vales gastados, no se devuelve: lo no gastado se queda en la entidad para su causa. Vale también con la venta cancelada
 *   por la entidad (la plataforma ya devuelve sola lo no gastado si no se había liquidado).
 * - Se aprueba aquí, con la venta y el pase bloqueados (un canje simultáneo espera y después ve el pase anulado), y se envía a Paycomet al momento; si no se
 *   puede, la tarea `MASS_REFUND` lo recoge. Hasta el Sprint 5.20b, la gestión devuelta y el coste de la devolución los asume KORUM (decisión 70).
 * - Con límite de intentos por red (el de los enlaces de devolución). La auditoría guarda la serie del pase, cuántos vales y cuánto, nunca quién.
 */

export type VoucherRefundRejection = 'INVALID_LINK' | 'RATE_LIMITED' | VoucherRefundBlock;

export class VoucherRefundError extends Error {
  readonly reason: VoucherRefundRejection;

  constructor(reason: VoucherRefundRejection) {
    super(`No se puede devolver la compra de vales: ${reason}.`);
    this.name = 'VoucherRefundError';
    this.reason = reason;
  }
}

export const voucherRefundSchema = z
  .object({
    orgSlug: z.string().min(1).max(64),
    passUuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  })
  .strict();

export interface VoucherRefundView {
  /** Lo que se puede pedir ahora, o por qué no. */
  offer: { kind: 'FULL' | 'UNSPENT'; until: Date } | null;
  block: VoucherRefundBlock | null;
  /** Lo que se devolvería ahora: el 100 % de la compra o la parte de lo no gastado. */
  amountCents: number;
  /** Vales que se devolverían. */
  vouchers: number;
}

const PASS_SELECT = {
  quantity: true,
  checkedInCount: true,
  revokedAt: true,
  issuedAt: true,
  serialCode: true,
  subtype: true,
  contribution: { select: { id: true, status: true, amountCents: true, totalChargedCents: true, organizationId: true, initiativeId: true } },
  initiative: { select: { voucherValidityShortenedAt: true, payout: { select: { status: true } } } }
} as const;

type PassRow = { quantity: number; checkedInCount: number; revokedAt: Date | null; issuedAt: Date; contribution: { status: string; amountCents: number; totalChargedCents: number }; initiative: { voucherValidityShortenedAt: Date | null; payout: { status: string } | null } };

const purchaseOf = (pass: PassRow): VoucherPurchaseState => ({
  contributionStatus: pass.contribution.status,
  revokedAt: pass.revokedAt,
  quantity: pass.quantity,
  checkedInCount: pass.checkedInCount,
  issuedAt: pass.issuedAt,
  payoutStatus: pass.initiative.payout?.status ?? null,
  shortenedAt: pass.initiative.voucherValidityShortenedAt
});

/** Lo que vuelve: el 100 % o, con algún vale gastado, la parte de cada línea del cobro que corresponde a lo no gastado, con la misma función que la aprobación. */
async function refundAmountOf(db: Db, contributionId: number, pass: PassRow, kind: 'FULL' | 'UNSPENT'): Promise<number> {
  if (kind === 'FULL') return pass.contribution.totalChargedCents;
  const journal = await db.ledgerJournal.findFirst({ where: { contributionId, kind: 'PAYIN_TICKET' }, select: { entries: { select: { direction: true, amountCents: true } } } });
  return unspentRefundLines(journal?.entries ?? [], pass.quantity - pass.checkedInCount, pass.quantity).reduce((total, line) => total + line.amountCents, 0);
}

/** Lo que enseña el pase sobre su devolución. `null` si el pase no es de vales. */
export async function loadVoucherRefund(db: KorumPrismaClient, passUuid: string, now: Date = new Date()): Promise<VoucherRefundView | null> {
  const pass = await db.ticketPass.findUnique({ where: { uuid: passUuid }, select: PASS_SELECT });
  if (!pass || pass.subtype !== 'VOUCHER') return null;
  const offer = voucherRefundOffer(purchaseOf(pass), now);
  if ('block' in offer) return { offer: null, block: offer.block, amountCents: 0, vouchers: 0 };
  return { offer, block: null, amountCents: await refundAmountOf(db, pass.contribution.id, pass, offer.kind), vouchers: pass.quantity - pass.checkedInCount };
}

export interface VoucherRefundReceipt {
  contributionId: number;
  refundedCents: number;
  partial: boolean;
}

/** Aprueba la devolución de la compra del pase. Lanza `VoucherRefundError` con el motivo si no se puede. */
export async function claimVoucherRefund(db: KorumPrismaClient, qrSecret: string, hmacSecret: string, payload: unknown, context: { ip: string | null }, now: Date = new Date()): Promise<VoucherRefundReceipt> {
  const parsed = voucherRefundSchema.safeParse(payload);
  if (!parsed.success) throw new VoucherRefundError('INVALID_LINK');
  const input = parsed.data;
  if (!verifyPassViewSignature(qrSecret, input.passUuid, input.sig)) throw new VoucherRefundError('INVALID_LINK');
  if (!(await reserveAttempt(db, `${EVENT_REFUND_RULE.prefix}${hashIpSubnet(hmacSecret, context.ip)}`, EVENT_REFUND_RULE, now))) throw new VoucherRefundError('RATE_LIMITED');

  return inTransaction(db, async (tx) => {
    const reference = await findPass(tx, input.orgSlug, input.passUuid);
    if (!reference) throw new VoucherRefundError('INVALID_LINK');
    // Primero la venta (el mismo orden que un cobro o una liquidación) y después el pase (el mismo que bloquea el puesto al canjear): lo que se lee ya no cambia.
    await loadLockedContribution(tx, { id: reference.contributionId });
    await tx.ticketPass.update({ where: { id: reference.id }, data: { checkedInCount: { increment: 0 } } });
    const pass = await tx.ticketPass.findUniqueOrThrow({ where: { id: reference.id }, select: PASS_SELECT });
    const offer = voucherRefundOffer(purchaseOf(pass), now);
    if ('block' in offer) throw new VoucherRefundError(offer.block);
    let refundedCents = pass.contribution.totalChargedCents;
    if (offer.kind === 'FULL') await approveRefundInTx(tx, pass.contribution.id, { at: now });
    else {
      const approval = await approvePartialRefundInTx(tx, pass.contribution.id, { reason: 'VOUCHER_VALIDITY_SHORTENED', at: now });
      if (!approval) throw new VoucherRefundError('NOT_PAID');
      refundedCents = approval.amountCents;
    }
    await tx.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        organizationId: pass.contribution.organizationId,
        action: 'voucher.purchase_refunded',
        targetType: 'Initiative',
        targetId: String(pass.contribution.initiativeId),
        metadataJson: { serialCode: pass.serialCode, vouchers: pass.quantity - pass.checkedInCount, refundedCents, kind: offer.kind }
      }
    });
    return { contributionId: pass.contribution.id, refundedCents, partial: offer.kind === 'UNSPENT' };
  });
}

/** El pase de vales del enlace, de **esa** entidad. Uno de otra entidad, de un evento o inexistente responde igual. */
function findPass(db: Db, orgSlug: string, passUuid: string): Promise<{ id: number; contributionId: number } | null> {
  return db.ticketPass.findFirst({ where: { uuid: passUuid, subtype: 'VOUCHER', initiative: { organization: { slug: orgSlug, archivedAt: null } } }, select: { id: true, contributionId: true } });
}
