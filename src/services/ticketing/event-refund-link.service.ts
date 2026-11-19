import { hashIpSubnet } from '@/core/security/device-signals';
import { eventRefundTokenSchema, readEventRefundToken } from '@/core/ticketing/event-schedule-rules';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { EVENT_REFUND_RULE } from '@/lib/rate-limit-rules';
import { DONOR_RECIPIENT_SELECT, donorCandidatesWhere, donorRecipient } from '@/services/notifications/donor-recipient';
import { approveRefundInTx } from '@/services/payments/payment-reversals';

/**
 * Devolución de las entradas tras un cambio de fecha (Sprint 5.13, decisión 30 del promotor). Se llega desde el enlace personal del aviso
 * (`/{entidad}/entrada/devolucion?d=`), sin cuenta: el enlace firma el cambio de fecha y una compra, y de la compra sale la persona (su email canónico).
 *
 * - Devuelve el **100 %** (precio y Gastos de gestión digital) de **todas** las entradas de esa persona en el evento compradas **antes** del cambio y que no
 *   se han usado: quien ya entró al evento no puede pedirla. Se aprueba aquí y la tarea `MASS_REFUND` la envía al medio de pago original.
 * - Vale durante 14 días desde el cambio, mientras el evento siga vivo y sin liquidar (la liquidación espera a que se cierre el plazo). Si el evento se
 *   cancela, se devuelve a todas las personas sin pedirlo.
 * - Con límite de intentos por red, sin gastarlos con enlaces mal formados. La auditoría guarda cuántas compras y cuánto, nunca quién.
 */

export type EventRefundRejection = 'INVALID_LINK' | 'CLOSED' | 'NOTHING_TO_REFUND' | 'RATE_LIMITED';

export class EventRefundError extends Error {
  readonly reason: EventRefundRejection;

  constructor(reason: EventRefundRejection) {
    super(`No se puede devolver: ${reason}.`);
    this.name = 'EventRefundError';
    this.reason = reason;
  }
}

export type EventRefundView =
  | { status: 'INVALID' }
  | {
      /** `OPEN`: se puede pedir; `REQUESTED`: ya se pidió; `CANCELLED`: el evento se canceló y se devuelve todo solo; `CLOSED`: el plazo terminó o ya no hay nada que devolver. */
      status: 'OPEN' | 'REQUESTED' | 'CANCELLED' | 'CLOSED';
      title: string;
      walletEscrowId: string;
      organizationName: string;
      previousDate: Date;
      newDate: Date;
      refundUntil: Date;
      /** Lo que se le devolvería ahora (el 100 % de sus compras devolvibles). */
      refundableCents: number;
      /** Compras suyas de antes del cambio con alguna entrada usada: no se devuelven. */
      usedPurchases: number;
    };

const LIVE = new Set(['FUNDRAISING', 'GOAL_REACHED']);
const REFUNDING = new Set(['REFUNDING', 'REFUNDED', 'CANCELLED']);

/** La compra del enlace y su cambio de fecha, o `null` si el enlace no casa (firma, entidad, evento o persona). */
async function loadLinked(db: Db, secret: string, orgSlug: string, token: string) {
  const parsed = readEventRefundToken(secret, token);
  if (!parsed) return null;
  const contribution = await db.contribution.findUnique({
    where: { id: parsed.contributionId },
    select: { id: true, type: true, initiativeId: true, organization: { select: { slug: true, name: true } }, ...DONOR_RECIPIENT_SELECT }
  });
  if (!contribution || contribution.type !== 'TICKET' || contribution.organization.slug !== orgSlug) return null;
  const reschedule = await db.eventReschedule.findUnique({ where: { id: parsed.rescheduleId }, select: { id: true, initiativeId: true, previousDate: true, newDate: true, refundUntil: true, createdAt: true } });
  const recipient = donorRecipient(contribution);
  if (!reschedule || reschedule.initiativeId !== contribution.initiativeId || !recipient) return null;
  const initiative = await db.initiative.findUniqueOrThrow({ where: { id: reschedule.initiativeId }, select: { status: true, title: true, walletEscrowId: true, payout: { select: { status: true } } } });
  return { contribution, reschedule, initiative, canonical: recipient.canonical };
}

/** Las compras de esta persona en el evento hechas antes del cambio, separadas en devolvibles (completadas y sin usar), usadas y ya devueltas o en curso. */
async function purchasesOf(db: Db, initiativeId: number, canonical: string, before: Date) {
  const rows = await db.contribution.findMany({
    // «Antes del cambio» es empezada antes: quien estaba pagando en ese momento también puede pedirla (recibe su aviso al terminar de pagar).
    where: { initiativeId, type: 'TICKET', status: { in: ['COMPLETED', 'REFUND_PENDING', 'REFUNDED'] }, createdAt: { lte: before }, ...donorCandidatesWhere(canonical) },
    orderBy: { id: 'asc' },
    select: { id: true, status: true, totalChargedCents: true, ticketPass: { select: { checkedInCount: true } }, ...DONOR_RECIPIENT_SELECT }
  });
  const own = rows.filter((row) => donorRecipient(row)?.canonical === canonical);
  const completed = own.filter((row) => row.status === 'COMPLETED');
  return {
    refundable: completed.filter((row) => (row.ticketPass?.checkedInCount ?? 0) === 0),
    used: completed.filter((row) => (row.ticketPass?.checkedInCount ?? 0) > 0).length,
    requested: own.some((row) => row.status !== 'COMPLETED')
  };
}

type Linked = NonNullable<Awaited<ReturnType<typeof loadLinked>>>;
const isOpen = (linked: Linked, now: Date) => linked.reschedule.refundUntil > now && LIVE.has(linked.initiative.status) && (linked.initiative.payout === null || linked.initiative.payout.status === 'PENDING_DOUBLE_CHECK');

export async function loadEventRefund(db: KorumPrismaClient, secret: string, orgSlug: string, token: string, now: Date = new Date()): Promise<EventRefundView> {
  const linked = await loadLinked(db, secret, orgSlug, token);
  if (!linked) return { status: 'INVALID' };
  const purchases = await purchasesOf(db, linked.reschedule.initiativeId, linked.canonical, linked.reschedule.createdAt);
  const refundableCents = purchases.refundable.reduce((sum, row) => sum + row.totalChargedCents, 0);
  const status = REFUNDING.has(linked.initiative.status) ? 'CANCELLED' : !isOpen(linked, now) ? 'CLOSED' : refundableCents > 0 ? 'OPEN' : purchases.requested ? 'REQUESTED' : 'CLOSED';
  return {
    status,
    title: linked.initiative.title,
    walletEscrowId: linked.initiative.walletEscrowId,
    organizationName: linked.contribution.organization.name,
    previousDate: linked.reschedule.previousDate,
    newDate: linked.reschedule.newDate,
    refundUntil: linked.reschedule.refundUntil,
    refundableCents: status === 'OPEN' ? refundableCents : 0,
    usedPurchases: purchases.used
  };
}

export interface EventRefundReceipt {
  purchases: number;
  refundedCents: number;
}

/** Aprueba la devolución de todas sus entradas devolvibles. Lanza `EventRefundError` con el motivo si no se puede. */
export async function claimEventRefund(db: KorumPrismaClient, secret: string, payload: unknown, context: { ip: string | null }, now: Date = new Date()): Promise<EventRefundReceipt> {
  const parsed = eventRefundTokenSchema.safeParse(payload);
  if (!parsed.success) throw new EventRefundError('INVALID_LINK');
  const input = parsed.data;
  if (!readEventRefundToken(secret, input.token)) throw new EventRefundError('INVALID_LINK');
  if (!(await reserveAttempt(db, `${EVENT_REFUND_RULE.prefix}${hashIpSubnet(secret, context.ip)}`, EVENT_REFUND_RULE, now))) throw new EventRefundError('RATE_LIMITED');

  return inTransaction(db, async (tx) => {
    const reference = await loadLinked(tx, secret, input.orgSlug, input.token);
    if (!reference) throw new EventRefundError('INVALID_LINK');
    // Bloquea el evento y vuelve a leer: una cancelación, la liquidación o la portería que lee la entrada a la vez esperan a que termine.
    await tx.initiative.updateMany({ where: { id: reference.reschedule.initiativeId }, data: { ticketsHeld: { increment: 0 } } });
    const linked = await loadLinked(tx, secret, input.orgSlug, input.token);
    if (!linked) throw new EventRefundError('INVALID_LINK');
    if (!isOpen(linked, now)) throw new EventRefundError('CLOSED');
    const candidates = await purchasesOf(tx, linked.reschedule.initiativeId, linked.canonical, linked.reschedule.createdAt);
    if (candidates.refundable.length === 0) throw new EventRefundError('NOTHING_TO_REFUND');
    // La portería bloquea el pase al leerlo: se bloquean también aquí y se vuelve a mirar, para no devolver una entrada que acaba de usarse.
    await tx.ticketPass.updateMany({ where: { contributionId: { in: candidates.refundable.map((row) => row.id) } }, data: { checkedInCount: { increment: 0 } } });
    const { refundable } = await purchasesOf(tx, linked.reschedule.initiativeId, linked.canonical, linked.reschedule.createdAt);
    if (refundable.length === 0) throw new EventRefundError('NOTHING_TO_REFUND');
    let refundedCents = 0;
    for (const purchase of refundable) {
      await approveRefundInTx(tx, purchase.id, { at: now });
      refundedCents += purchase.totalChargedCents;
    }
    const organizationId = (await tx.initiative.findUniqueOrThrow({ where: { id: linked.reschedule.initiativeId }, select: { organizationId: true } })).organizationId;
    // Sin email ni compra: queda qué cambio de fecha, cuántas compras y cuánto, no quién (la auditoría no se anonimiza).
    await tx.auditLog.create({
      data: { actorType: 'SYSTEM', organizationId, action: 'event.reschedule_refund', targetType: 'Initiative', targetId: String(linked.reschedule.initiativeId), metadataJson: { rescheduleId: linked.reschedule.id, purchases: refundable.length, refundedCents } }
    });
    return { purchases: refundable.length, refundedCents };
  });
}
