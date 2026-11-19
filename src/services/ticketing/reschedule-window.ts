import type { Db } from '@/lib/db';

/**
 * Plazo de devolución abierto por un cambio de fecha (Sprint 5.13, decisión del promotor del 2026-11-19): mientras quien compró pueda pedir su dinero, la
 * entidad no liquida, porque liquidar haría imposible devolverlo. Lo comprueban el panel y la petición de la liquidación (`payoutBlockers`) y la
 * aprobación que mueve el dinero (`approvePayout`).
 *
 * Solo cuenta un cambio con alguien a quien devolver: una compra empezada antes del cambio que esté pagada o aún pagándose. Un cambio sin compras de antes
 * no bloquea nada (revisión de experiencia del 5.13).
 */
export async function openRescheduleRefundUntil(db: Pick<Db, 'eventReschedule' | 'contribution'>, initiativeId: number, now: Date): Promise<Date | null> {
  const open = await db.eventReschedule.findMany({ where: { initiativeId, refundUntil: { gt: now } }, orderBy: { refundUntil: 'desc' }, select: { refundUntil: true, createdAt: true } });
  for (const reschedule of open) {
    const exposed = await db.contribution.count({ where: { initiativeId, type: 'TICKET', status: { in: ['COMPLETED', 'PENDING'] }, createdAt: { lte: reschedule.createdAt } } });
    if (exposed > 0) return reschedule.refundUntil;
  }
  return null;
}
