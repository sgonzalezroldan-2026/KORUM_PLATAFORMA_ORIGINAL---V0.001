import { voucherRefundDeadline } from '@/core/ticketing/voucher-lifecycle-rules';
import type { Db } from '@/lib/db';

/**
 * Plazos de devolución que aún están abiertos: mientras quien compró pueda pedir su dinero, la entidad no liquida, porque liquidar haría imposible devolverlo. Lo
 * comprueban el panel y la petición de la liquidación (`payoutBlockers`) y la aprobación que mueve el dinero (`approvePayout`).
 *
 * - **Cambio de fecha de un evento** (Sprint 5.13, decisión del promotor del 2026-11-19): solo cuenta un cambio con alguien a quien devolver, una compra empezada
 *   antes del cambio que esté pagada o aún pagándose. Un cambio sin compras de antes no bloquea nada (revisión de experiencia del 5.13).
 * - **Venta de vales** (Sprint 5.14c, decisiones 32 y 69): cada compra se puede devolver durante 14 días desde que recibió sus vales si no ha gastado ninguno, y
 *   quien compró antes de que la entidad acortara la validez recupera lo no gastado durante 14 días desde ese cambio. Cuenta el último plazo que aún tiene a
 *   alguien a quien devolver. Un pago de vales en curso bloquea hasta 14 días desde ahora: si se completa, sus vales tendrán su propio plazo. Y una venta
 *   cancelada antes de liquidar no se liquida mientras quede alguna compra cuya parte no gastada la plataforma aún no haya devuelto (`voucher-cancel-refunds.ts`).
 */
export async function openRefundWindowUntil(db: Pick<Db, 'eventReschedule' | 'contribution' | 'initiative' | 'ticketPass'>, initiativeId: number, now: Date): Promise<Date | null> {
  const sale = await db.initiative.findUnique({ where: { id: initiativeId }, select: { ticketSubtype: true } });
  if (sale?.ticketSubtype === 'VOUCHER') return openVoucherRefundUntil(db, initiativeId, now);
  const open = await db.eventReschedule.findMany({ where: { initiativeId, refundUntil: { gt: now } }, orderBy: { refundUntil: 'desc' }, select: { refundUntil: true, createdAt: true } });
  for (const reschedule of open) {
    const exposed = await db.contribution.count({ where: { initiativeId, type: 'TICKET', status: { in: ['COMPLETED', 'PENDING'] }, createdAt: { lte: reschedule.createdAt } } });
    if (exposed > 0) return reschedule.refundUntil;
  }
  return null;
}

export interface VoucherRefundState {
  /** El último de los plazos de devolución que aún tiene a alguien a quien devolver, o `null`. */
  until: Date | null;
  /** Venta cancelada antes de liquidar con compras cuya parte no gastada la plataforma aún no ha aprobado devolver (cuestión de minutos, no de días). */
  cancellationPending: boolean;
}

/** Los plazos de devolución abiertos de una venta de vales: la liquidación espera al último de todos (y a que la cancelación esté tratada). */
export async function voucherRefundState(db: Pick<Db, 'contribution' | 'ticketPass' | 'initiative'>, initiativeId: number, now: Date): Promise<VoucherRefundState> {
  const windows: Date[] = [];
  const paying = await db.contribution.count({ where: { initiativeId, type: 'TICKET', voucherNoProduct: false, status: 'PENDING', ticketHoldUntil: { gt: now } } });
  if (paying > 0) windows.push(voucherRefundDeadline(now));
  const sale = await db.initiative.findUniqueOrThrow({ where: { id: initiativeId }, select: { voucherCancelledAt: true, voucherValidityShortenedAt: true } });
  // Acortada la validez: quien compró antes y aún tiene vales los puede recuperar durante 14 días.
  if (sale.voucherValidityShortenedAt) {
    const until = voucherRefundDeadline(sale.voucherValidityShortenedAt);
    if (until > now && (await unspentPassesIssuedBefore(db, initiativeId, sale.voucherValidityShortenedAt))) windows.push(until);
  }
  // La compra más reciente que aún se puede devolver por sus propios 14 días: sin ningún vale gastado, sin anular y cobrada.
  const latest = await db.ticketPass.findFirst({
    where: { initiativeId, subtype: 'VOUCHER', revokedAt: null, checkedInCount: 0, contribution: { status: 'COMPLETED' } },
    orderBy: { issuedAt: 'desc' },
    select: { issuedAt: true }
  });
  if (latest) windows.push(voucherRefundDeadline(latest.issuedAt));
  const open = windows.filter((until) => until > now).sort((a, b) => b.getTime() - a.getTime());
  const cancellationPending = sale.voucherCancelledAt !== null && (await cancellationRefundsLeft(db, initiativeId));
  return { until: open[0] ?? null, cancellationPending };
}

async function openVoucherRefundUntil(db: Pick<Db, 'contribution' | 'ticketPass' | 'initiative'>, initiativeId: number, now: Date): Promise<Date | null> {
  const state = await voucherRefundState(db, initiativeId, now);
  // Una cancelación por tratar también bloquea, aunque no tenga fecha: la tarea la trata en su siguiente ejecución.
  return state.until ?? (state.cancellationPending ? now : null);
}

/** ¿Queda alguna compra de una venta cancelada con algo que devolver? Una aportación «sin producto» o un pase sin anular con vales por gastar. */
async function cancellationRefundsLeft(db: Pick<Db, 'contribution' | 'ticketPass'>, initiativeId: number): Promise<boolean> {
  if ((await db.contribution.count({ where: { initiativeId, type: 'TICKET', status: 'COMPLETED', voucherNoProduct: true } })) > 0) return true;
  return unspentPassesIssuedBefore(db, initiativeId, null);
}

/** ¿Hay algún pase cobrado, sin anular y con vales por gastar (emitido antes de `before`, si se indica)? La base compara lo gastado con lo comprado. */
async function unspentPassesIssuedBefore(db: Pick<Db, 'ticketPass'>, initiativeId: number, before: Date | null): Promise<boolean> {
  const found = await db.ticketPass.findFirst({
    where: { initiativeId, subtype: 'VOUCHER', revokedAt: null, contribution: { status: 'COMPLETED' }, checkedInCount: { lt: db.ticketPass.fields.quantity }, ...(before ? { issuedAt: { lt: before } } : {}) },
    select: { id: true }
  });
  return found !== null;
}
