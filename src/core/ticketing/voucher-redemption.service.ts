import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { MemberRole } from '@/generated/prisma/enums';
import { isUniqueViolation } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, type SessionActor } from '@/repositories/tenant-guard';
import { assertGateSessionLive, type EventRef } from './check-in.service';
import { firstNotice } from './gate-limits';
import { parsePassQrPayload, verifyPassSignature } from './qr-signature';
import { MAX_VOUCHERS_PER_ORDER, voucherRedeemBlock, type VoucherRedeemBlock } from './voucher-rules';

/**
 * Canje de vales en el puesto (Sprint 5.14a, QA-VAL02). Quien atiende lee el QR de una compra, ve cuántos vales le quedan (`lookupVoucherBalance`) y teclea
 * cuántos se gastan (`redeemVouchers`): se descuentan del mismo pase y el resto sigue en él. **Un vale no se gasta dos veces**:
 *
 * - Dos lectores a la vez sobre el mismo QR van uno detrás de otro (se bloquea la fila del pase antes de leer su saldo) y el segundo ve lo que dejó el primero.
 * - La base de datos rechaza que lo gastado pase de lo comprado (`TicketPass_checkins_within_quantity`), aunque el bloqueo fallara.
 * - Cada canje lleva un identificador que genera el lector (`clientScanId`): reenviar la misma petición tras un corte no gasta otra vez. Un identificador ya usado
 *   en otro pase de la venta es un error del lector y se rechaza (nunca se responde con el saldo de otro pase).
 * - Sin cobertura **no se canjea**: un vale es una cuenta que solo lleva el servidor (la lista que se descarga la portería solo tiene entradas).
 *
 * **Quién canjea:** el puesto con el PIN de **esa** venta y las personas que firman por la entidad (`DIRECTOR`, `COSIGNER`); ni una cuenta de voluntario
 * (`GATEKEEPER`), que entraría en cualquier venta de la entidad, ni el Super-Admin (como en la portería, `L-125`). Cada canje, aceptado o no, queda como una
 * lectura (`TicketCheckIn`) con su puesto (la sesión con PIN) y su hora; el que hace una persona firmante deja además una fila de auditoría con quién fue
 * (`voucher.redeemed`), porque su lectura no tiene puesto. El puesto con lector y PIN es del Sprint 5.14c (`voucher-station.tsx`); una venta cancelada ya no canjea.
 */

export type VoucherLookupResult =
  | { status: 'OK'; balance: number; quantity: number; serialCode: string; validUntil: Date }
  | { status: 'INVALID_SIGNATURE' | 'OTHER_SALE' | 'EXHAUSTED' }
  | { status: VoucherRedeemBlock };

export type VoucherRedeemResult =
  | { status: 'REDEEMED'; spent: number; balance: number; quantity: number; serialCode: string }
  /** Esta petición ya se había recibido (reenvío tras un corte): no se gasta nada más. */
  | { status: 'DUPLICATE'; accepted: boolean; balance: number }
  | { status: 'INSUFFICIENT'; balance: number }
  | { status: 'EXHAUSTED' }
  | { status: 'INVALID_SIGNATURE' | 'OTHER_SALE' }
  | { status: VoucherRedeemBlock };

/** Motivo guardado en la lectura rechazada (como los de la portería). */
const REJECTION_REASON: Record<VoucherRedeemBlock | 'INSUFFICIENT' | 'EXHAUSTED', string> = {
  REVOKED: 'REVOKED',
  NOT_PAID: 'NOT_PAID',
  SALE_CLOSED: 'EVENT_CLOSED',
  SALE_CANCELLED: 'VENTA_CANCELADA',
  EXPIRED: 'VALE_CADUCADO',
  INSUFFICIENT: 'CANTIDAD_SUPERIOR',
  EXHAUSTED: 'PASE_AGOTADO'
};

const CLIENT_SCAN_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class VoucherRedeemInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'VoucherRedeemInputError';
  }
}

type ResolvedPass = { status: 'FOUND'; passId: number } | { status: 'INVALID_SIGNATURE' | 'OTHER_SALE' };

/** Quién deja la fila de auditoría de un QR rechazado: una por tipo y ventana por puesto o por persona (la auditoría no se puede purgar). */
const noticeKeyOf = (actor: SessionActor): string => (actor.kind === 'gate' ? `g:${actor.gateSessionId}` : actor.kind === 'user' ? `u:${actor.userId}` : 'a');

/**
 * Comprueba el QR fuera de la transacción: firma, que el pase sea de vales y de **esta** venta de **esta** entidad. Un QR inventado o de otra venta (o de un
 * evento) deja una sola fila de auditoría por tipo y ventana en cada puesto o persona.
 */
async function resolvePass(db: KorumPrismaClient, secret: string, actor: SessionActor, sale: EventRef, payload: string, now: Date): Promise<ResolvedPass> {
  const noteOnce = (kind: string) => firstNotice(db, `voucher:${kind}:${noticeKeyOf(actor)}`, now);
  const parsed = parsePassQrPayload(payload);
  if (!parsed || !verifyPassSignature(secret, parsed.passUuid, parsed.signature)) {
    if (await noteOnce('invalid')) await recordAudit(db, actor, { action: 'voucher.qr_invalid', organizationId: sale.organizationId, targetType: 'Initiative', targetId: String(sale.initiativeId), metadata: {} });
    return { status: 'INVALID_SIGNATURE' };
  }
  const reference = await db.ticketPass.findUnique({ where: { uuid: parsed.passUuid }, select: { id: true, subtype: true, initiativeId: true, initiative: { select: { organizationId: true } } } });
  if (!reference || reference.subtype !== 'VOUCHER' || reference.initiativeId !== sale.initiativeId || reference.initiative.organizationId !== sale.organizationId) {
    // Sin decir de qué venta, evento o entidad es: el identificador solo queda en la auditoría.
    if (await noteOnce('other_sale')) await recordAudit(db, actor, { action: 'voucher.qr_other_sale', organizationId: sale.organizationId, targetType: 'Initiative', targetId: String(sale.initiativeId), metadata: { passUuid: parsed.passUuid } });
    return { status: 'OTHER_SALE' };
  }
  return { status: 'FOUND', passId: reference.id };
}

/** Puesto de esta venta o persona firmante de esta entidad, y la venta es de la entidad (un identificador ajeno queda como sondeo, sin leer nada de ella). */
async function authorize(db: KorumPrismaClient, actor: SessionActor, sale: EventRef, action: string, now: Date): Promise<void> {
  const roles: readonly MemberRole[] = actor.kind === 'gate' ? ['GATEKEEPER'] : SIGNER_ROLES;
  // Una sesión del puesto solo canjea en su venta (`GATE_SESSION_OTHER_EVENT`); el Super-Admin no canjea (`L-125`).
  await authorizeTenant(db, actor, sale.organizationId, { roles, action, targetType: 'Initiative', targetId: sale.initiativeId, allowSuperadmin: false });
  await assertGateSessionLive(db, actor, now);
  const owner = await db.initiative.findUnique({ where: { id: sale.initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId: sale.organizationId, resourceType: 'Initiative', resourceId: sale.initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: owner?.organizationId ?? null });
}

/** Saldo de un pase de vales, sin gastar nada: lo que ve quien atiende al leer el QR. */
export async function lookupVoucherBalance(db: KorumPrismaClient, secret: string, actor: SessionActor, sale: EventRef, payload: string, now: Date = new Date()): Promise<VoucherLookupResult> {
  await authorize(db, actor, sale, 'voucher.lookup', now);
  const resolved = await resolvePass(db, secret, actor, sale, payload, now);
  if (resolved.status !== 'FOUND') return resolved;
  const pass = await db.ticketPass.findUniqueOrThrow({
    where: { id: resolved.passId },
    select: { quantity: true, checkedInCount: true, serialCode: true, revokedAt: true, contribution: { select: { status: true } }, initiative: { select: { status: true, voucherValidUntil: true, voucherCancelledAt: true } } }
  });
  const block = voucherRedeemBlock({ revokedAt: pass.revokedAt, contributionStatus: pass.contribution.status }, pass.initiative, now);
  if (block !== null) return { status: block };
  // Con todos los vales gastados no hay nada que teclear: se dice en rojo, como al canjear (revisión de experiencia del 5.14c).
  if (pass.quantity - pass.checkedInCount <= 0) return { status: 'EXHAUSTED' };
  return { status: 'OK', balance: pass.quantity - pass.checkedInCount, quantity: pass.quantity, serialCode: pass.serialCode, validUntil: pass.initiative.voucherValidUntil! };
}

/** Lo que responde un canje que ya se recibió: si fue sobre otro pase, el identificador está repetido por un error del lector y no se responde con otro saldo. */
async function duplicateOf(db: KorumPrismaClient, sale: EventRef, passId: number, clientScanId: string): Promise<VoucherRedeemResult | null> {
  const prior = await db.ticketCheckIn.findFirst({ where: { clientScanId, ticketPass: { initiativeId: sale.initiativeId } }, select: { accepted: true, ticketPassId: true } });
  if (!prior) return null;
  if (prior.ticketPassId !== passId) throw new VoucherRedeemInputError('El identificador del canje ya se usó con otro vale: el lector debe generar uno nuevo por canje.');
  const pass = await db.ticketPass.findUniqueOrThrow({ where: { id: passId }, select: { quantity: true, checkedInCount: true } });
  return { status: 'DUPLICATE', accepted: prior.accepted, balance: pass.quantity - pass.checkedInCount };
}

/** Gasta `quantity` vales de un pase. Dos canjes simultáneos del mismo pase van uno detrás de otro; ninguno gasta más que el saldo. */
export async function redeemVouchers(
  db: KorumPrismaClient,
  secret: string,
  actor: SessionActor,
  sale: EventRef,
  payload: string,
  quantity: number,
  clientScanId: string,
  now: Date = new Date()
): Promise<VoucherRedeemResult> {
  await authorize(db, actor, sale, 'voucher.redeem', now);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_VOUCHERS_PER_ORDER) throw new VoucherRedeemInputError('Los vales que se gastan deben ser un entero positivo.');
  if (!CLIENT_SCAN_ID.test(clientScanId)) throw new VoucherRedeemInputError('Falta el identificador del canje que genera el lector.');
  const resolved = await resolvePass(db, secret, actor, sale, payload, now);
  if (resolved.status !== 'FOUND') return resolved;
  const gateSessionId = actor.kind === 'gate' ? actor.gateSessionId : null;

  try {
    return await db.$transaction(async (tx): Promise<VoucherRedeemResult> => {
      // Bloquea el pase antes de leer su saldo: el segundo canje simultáneo espera aquí y después lee lo que dejó el primero.
      const pass = await tx.ticketPass.update({
        where: { id: resolved.passId },
        data: { checkedInCount: { increment: 0 } },
        select: {
          id: true, quantity: true, checkedInCount: true, serialCode: true, revokedAt: true, lastCheckedInAt: true,
          contribution: { select: { status: true } },
          initiative: { select: { status: true, voucherValidUntil: true, voucherCancelledAt: true } }
        }
      });
      // El mismo canje reenviado (tras un corte, o desde dos pestañas): con el pase ya bloqueado, un reenvío sobre este pase no tiene carrera.
      const duplicate = await duplicateOf(tx as KorumPrismaClient, sale, pass.id, clientScanId);
      if (duplicate) return duplicate;

      const record = { ticketPassId: pass.id, gateSessionId, clientScanId, offline: false, quantity, createdAt: now };
      const reject = async (reason: keyof typeof REJECTION_REASON) => tx.ticketCheckIn.create({ data: { ...record, accepted: false, reason: REJECTION_REASON[reason] } });

      const block = voucherRedeemBlock({ revokedAt: pass.revokedAt, contributionStatus: pass.contribution.status }, pass.initiative, now);
      if (block !== null) return (await reject(block), { status: block });
      const balance = pass.quantity - pass.checkedInCount;
      if (balance === 0) return (await reject('EXHAUSTED'), { status: 'EXHAUSTED' });
      if (quantity > balance) return (await reject('INSUFFICIENT'), { status: 'INSUFFICIENT', balance });

      await tx.ticketPass.update({ where: { id: pass.id }, data: { checkedInCount: { increment: quantity }, lastCheckedInAt: pass.lastCheckedInAt && pass.lastCheckedInAt > now ? pass.lastCheckedInAt : now } });
      await tx.ticketCheckIn.create({ data: { ...record, accepted: true } });
      // La lectura de una persona firmante no tiene puesto: la auditoría dice quién gastó esos vales (cifras y la serie del pase, sin datos de quien compró).
      if (actor.kind === 'user') await recordAudit(tx, actor, { action: 'voucher.redeemed', organizationId: sale.organizationId, targetType: 'Initiative', targetId: String(sale.initiativeId), metadata: { serialCode: pass.serialCode, quantity } }, { required: true });
      return { status: 'REDEEMED', spent: quantity, balance: balance - quantity, quantity: pass.quantity, serialCode: pass.serialCode };
    });
  } catch (error) {
    // Dos peticiones con el mismo identificador desde el mismo puesto sobre pases distintos chocan en la base (`gateSessionId + clientScanId` es único):
    // la segunda se responde como un canje repetido (o como un error del lector, si era de otro pase), nunca con un error del servidor.
    if (!isUniqueViolation(error)) throw error;
    const duplicate = await duplicateOf(db, sale, resolved.passId, clientScanId);
    if (duplicate) return duplicate;
    throw error;
  }
}
