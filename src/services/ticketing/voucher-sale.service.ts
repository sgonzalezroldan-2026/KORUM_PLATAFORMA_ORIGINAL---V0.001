import { releaseInitiativeQuotas } from '@/core/finance/quota-reservation';
import { notifySigners } from '@/core/jobs/notify';
import { heldMaintenanceCents } from '@/core/ticketing/held-event';
import {
  cancelVoucherSaleSchema,
  changeVoucherDatesSchema,
  isSettledPayout,
  planVoucherDates,
  statusAfterVoucherCancel,
  voucherPinExpiry,
  VoucherSaleChangeError,
  voucherSaleChangeProblem
} from '@/core/ticketing/voucher-lifecycle-rules';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { SessionActor } from '@/repositories/tenant-guard';
import { recordStatusChange } from '@/services/audit/status-change-audit';
import { queueSupporterBroadcast } from '@/services/notifications/supporter-broadcast';
import { restartVoucherBroadcast } from '@/services/notifications/voucher-broadcasts';
import { authorizeSaleChange } from './sale-change-auth';

/**
 * Cancelar una venta de vales o cambiar sus fechas (Sprint 5.14c; reglas en `voucher-lifecycle-rules.ts`). Lo hace una persona firmante de **esa** entidad con
 * su segundo factor (`sale-change-auth.ts`); ninguna de las dos cosas lleva dinero a la entidad, así que basta una firma y la otra persona recibe el aviso. Las dos
 * bloquean la fila de la venta: un cobro, un canje que la lee, el cierre o la liquidación que lleguen a la vez esperan su turno.
 *
 * - **Cancelar (decisiones 49 y 69):** antes o después de liquidar. Los vales dejan de gastarse (el puesto se cierra: PIN y móviles) y nadie más compra.
 *   **Antes de liquidar**, el dinero sigue retenido: la plataforma devuelve a cada persona lo que no haya gastado (`voucher-cancel-refunds.ts`, por lotes desde
 *   `MASS_REFUND`; el panel lo adelanta) y lo gastado se liquida a la entidad (una venta abierta se cierra ya y pasa a liquidable; sin nada vendido, se cierra sin
 *   dinero). **Después de liquidar**, el dinero ya está en la entidad: se avisa a quien tiene vales sin gastar de que se lo pida a ella.
 * - **Cambiar las fechas:** el cierre (solo mientras se vende, sin aviso) y la validez. Alargarla avisa a quien tiene vales sin gastar; acortarla avisa y abre
 *   14 días para recuperar lo no gastado desde sus vales (la liquidación espera); ya liquidada, solo se alarga. El PIN del puesto caduca con la validez nueva.
 */

export interface VoucherSaleReceipt {
  initiativeId: number;
  status: string;
  /** Ya estaba liquidada al cancelarla: el dinero está en la entidad. */
  settled?: boolean;
  closesAt?: Date;
  validUntil?: Date;
}

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new VoucherSaleChangeError('INVALID_INPUT');
  return parsed.data;
}

const authorize = (db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: 'voucher.cancel' | 'voucher.change_dates', initiativeId: number, now: Date) =>
  authorizeSaleChange(db, actor, organizationId, action, initiativeId, now, (reason) => new VoucherSaleChangeError(reason));

/** Bloquea la fila de la venta y comprueba que aún se pueda cambiar (venta de vales viva, sin cancelar y con vales que aún valen). */
async function lockSale(tx: Db, initiativeId: number, now: Date) {
  await tx.initiative.updateMany({ where: { id: initiativeId }, data: { ticketsHeld: { increment: 0 } } });
  const sale = await tx.initiative.findUniqueOrThrow({
    where: { id: initiativeId },
    select: {
      id: true,
      organizationId: true,
      walletEscrowId: true,
      format: true,
      ticketSubtype: true,
      status: true,
      closesAt: true,
      voucherValidUntil: true,
      voucherCancelledAt: true,
      raisedCents: true,
      goalCents: true,
      ticketsSold: true,
      ticketMax: true,
      voucherTargetCount: true,
      maintFeeCents: true,
      quotaReservedMaintCents: true,
      quotaReservedAt: true,
      createdAt: true,
      gatePinHash: true,
      payout: { select: { status: true } }
    }
  });
  const problem = voucherSaleChangeProblem(sale, now);
  if (problem) throw new VoucherSaleChangeError(problem);
  return { ...sale, voucherValidUntil: sale.voucherValidUntil!, settled: isSettledPayout(sale.payout?.status ?? null) };
}

/** Cancela la venta: los vales dejan de valer. Antes de liquidar, la plataforma devuelve lo no gastado (por lotes); después, avisa de que responde la entidad. */
export async function cancelVoucherSale(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<VoucherSaleReceipt> {
  const { initiativeId } = parse(cancelVoucherSaleSchema, payload);
  const user = await authorize(db, actor, organizationId, 'voucher.cancel', initiativeId, now);
  return inTransaction(db, async (tx) => {
    const sale = await lockSale(tx, initiativeId, now);
    const to = statusAfterVoucherCancel(sale);
    const { count } = await tx.initiative.updateMany({
      where: { id: initiativeId, status: sale.status, voucherCancelledAt: null },
      // El puesto se cierra: sin PIN nadie vuelve a entrar, y los móviles que estaban dentro salen aquí abajo.
      data: { voucherCancelledAt: now, gatePinHash: null, gatePinExpiresAt: null }
    });
    if (count !== 1) throw new VoucherSaleChangeError('WRONG_STATUS');
    await tx.gateSession.updateMany({ where: { initiativeId, revokedAt: null }, data: { revokedAt: now } });
    if (to === 'GOAL_REACHED') {
      // Una venta abierta con algo vendido se cierra ya: se liquida por lo vendido (con su mantenimiento proporcional) cuando pasen los 14 días de devolución.
      await tx.initiative.update({ where: { id: initiativeId }, data: { status: 'GOAL_REACHED', stepIndex: 5, maintFeeCents: heldMaintenanceCents(sale), closesAt: sale.closesAt > now ? now : sale.closesAt } });
      await recordStatusChange(tx, { initiativeId, organizationId, from: sale.status, to: 'GOAL_REACHED', reason: 'VOUCHER_SALE_CANCELLED', actorUserId: user.userId });
    } else if (to === 'CANCELLED') {
      // Sin nada vendido no hay nada que liquidar: se cierra sin dinero y los cupos vuelven ya a la entidad.
      await tx.initiative.update({ where: { id: initiativeId }, data: { status: 'CANCELLED', stepIndex: 4 } });
      await recordStatusChange(tx, { initiativeId, organizationId, from: sale.status, to: 'CANCELLED', reason: 'VOUCHER_SALE_CANCELLED', actorUserId: user.userId });
      await releaseInitiativeQuotas(tx, initiativeId);
    }
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: user.userId,
        organizationId,
        action: 'voucher.sale_cancelled',
        targetType: 'Initiative',
        targetId: String(initiativeId),
        metadataJson: { previousStatus: sale.status, settled: sale.settled, vouchersSold: sale.ticketsSold, raisedCents: sale.raisedCents }
      }
    });
    await notifySigners(tx, organizationId, 'voucher.changed', `${initiativeId}:cancel`, { initiativeId, change: 'CANCELLED', settled: sale.settled, vouchersSold: sale.ticketsSold });
    // Ya liquidada: aviso por lotes a quien tiene vales sin gastar (que se lo pida a la entidad). Antes, el aviso sale con cada devolución.
    if (sale.settled && (sale.ticketsSold > 0 || sale.raisedCents > 0)) await queueSupporterBroadcast(tx, initiativeId, 'voucher.cancelledBuyer', now);
    return { initiativeId, status: to ?? sale.status, settled: sale.settled };
  });
}

/** Cambia el cierre de la venta o la validez de sus vales. Un cambio de validez avisa a quien tiene vales sin gastar (sin enlace de devolución). */
export async function changeVoucherDates(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<VoucherSaleReceipt> {
  const input = parse(changeVoucherDatesSchema, payload);
  if (input.closeDay === undefined && input.validDay === undefined) throw new VoucherSaleChangeError('NO_CHANGE');
  const user = await authorize(db, actor, organizationId, 'voucher.change_dates', input.initiativeId, now);
  return inTransaction(db, async (tx) => {
    const sale = await lockSale(tx, input.initiativeId, now);
    // Se publicó al reservar sus cupos (`publishInitiative`); una venta de antes de esa marca cuenta desde que se creó, que es antes: el límite es más estricto.
    const { maxCampaignDays } = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { maxCampaignDays: true } });
    const plan = planVoucherDates(input, { status: sale.status, closesAt: sale.closesAt, voucherValidUntil: sale.voucherValidUntil, publishedAt: sale.quotaReservedAt ?? sale.createdAt, settled: sale.settled, maxCampaignDays }, now);
    if ('problem' in plan) throw new VoucherSaleChangeError(plan.problem);
    const pinExpiresAt = sale.gatePinHash ? voucherPinExpiry(plan.validUntil, now) : null;
    await tx.initiative.update({
      where: { id: sale.id },
      // Acortarla abre los 14 días de devolución de lo no gastado para quien compró antes (decisión 69).
      data: { closesAt: plan.closesAt, voucherValidUntil: plan.validUntil, gatePinExpiresAt: pinExpiresAt ?? undefined, voucherValidityShortenedAt: plan.validity === 'SHORTENED' ? now : undefined }
    });
    // Con la validez acortada, ningún móvil del puesto sigue dentro más allá de lo que vale el PIN nuevo.
    if (pinExpiresAt) await tx.gateSession.updateMany({ where: { initiativeId: sale.id, revokedAt: null, expiresAt: { gt: pinExpiresAt } }, data: { expiresAt: pinExpiresAt } });
    if (plan.validity && sale.ticketsSold > 0) await restartVoucherBroadcast(tx, sale.id, now);
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: user.userId,
        organizationId,
        action: 'voucher.dates_changed',
        targetType: 'Initiative',
        targetId: String(sale.id),
        metadataJson: { previousClose: sale.closesAt.toISOString(), closesAt: plan.closesAt.toISOString(), previousValidUntil: sale.voucherValidUntil.toISOString(), validUntil: plan.validUntil.toISOString(), validity: plan.validity }
      }
    });
    await notifySigners(tx, organizationId, 'voucher.changed', `${sale.id}:dates:${plan.closesAt.getTime()}:${plan.validUntil.getTime()}`, {
      initiativeId: sale.id,
      change: 'DATES',
      closesAt: plan.closesAt.toISOString(),
      validUntil: plan.validUntil.toISOString(),
      ...(plan.validity ? { validity: plan.validity } : {})
    });
    return { initiativeId: sale.id, status: sale.status, closesAt: plan.closesAt, validUntil: plan.validUntil };
  });
}
