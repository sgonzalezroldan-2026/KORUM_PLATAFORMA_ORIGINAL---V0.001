import { resolveAlert } from '@/core/jobs/ops-alerts';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeSuperadmin, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { InvoiceNotAllowedError, resolveUnknownInvoice, type UnknownInvoiceResolution } from '@/services/invoicing/invoice.service';
import { resolveUnknownRefund } from '@/services/payments/manual-resolutions';
import { RefundNotAllowedError } from '@/services/payments/payment-reversals';

/**
 * Cerrar alertas desde la consola (Sprint 5.1). Las alertas de cobros no se cierran solas (QA-OPS01): las resuelve una persona y queda en
 * la auditoría quién y cuándo. Si el problema reaparece, la alerta se reabre sola (`raiseAlert`).
 */

export type ResolveAlertResult = { status: 'RESOLVED' } | { status: 'NOT_OPEN' } | { status: 'USE_RESOLVER' };

/**
 * Alertas de dinero o facturas sin respuesta: solo se cierran resolviendo el caso (con su comprobación y su auditoría), nunca con un botón genérico.
 * Si el objetivo de la alerta no es un cobro o una factura identificable (dato mal formado), no hay caso que resolver y se puede cerrar sin más.
 */
const RESOLVED_BY_THEIR_CASE: Record<string, string> = { REFUND_STUCK: 'Contribution', INVOICE_STUCK: 'Invoice' };
const needsItsForm = (alert: { type: string; targetType: string | null; targetId: string | null }) =>
  RESOLVED_BY_THEIR_CASE[alert.type] === alert.targetType && alert.targetId !== null && /^\d{1,10}$/.test(alert.targetId);

/** Marca como resuelta una alerta abierta. Solo el Super-Admin (con el segundo factor de su sesión); un identificador que no está abierto no hace nada. */
export async function resolveOpsAlertById(db: KorumPrismaClient, actor: SessionActor, alertId: string): Promise<ResolveAlertResult> {
  // Una acción de servidor se puede llamar sin pasar por la página: el segundo factor de la sesión se comprueba aquí también, no solo en el `layout`.
  if (actor.kind === 'user' && actor.isSuperadmin && actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId: null, targetType: 'OpsAlert', targetId: '*', metadata: { attempted: 'alert.resolve', reason: 'SECOND_FACTOR_REQUIRED' } });
    throw new TenantAccessError('SUPERADMIN_ONLY');
  }
  await authorizeSuperadmin(db, actor, 'alert.resolve', 'OpsAlert');
  // Cerrar y dejar constancia van juntos: si la auditoría falla, la alerta sigue abierta.
  return inTransaction(db, async (tx): Promise<ResolveAlertResult> => {
    const alert = await tx.opsAlert.findFirst({ where: { id: alertId, status: 'OPEN' }, select: { dedupeKey: true, type: true, organizationId: true, targetType: true, targetId: true } });
    if (!alert) return { status: 'NOT_OPEN' };
    if (needsItsForm(alert)) return { status: 'USE_RESOLVER' };
    if (!(await resolveAlert(tx, alert.dedupeKey))) return { status: 'NOT_OPEN' };
    await recordAudit(tx, actor, { action: 'ops_alert.resolved', organizationId: alert.organizationId, targetType: 'OpsAlert', targetId: alertId, metadata: { type: alert.type } }, { required: true });
    return { status: 'RESOLVED' };
  });
}

/**
 * Resolución a mano de una devolución de resultado desconocido, cuando una persona ya ha mirado en Paycomet qué pasó. Exige el Super-Admin
 * verificado (TOTP de hace menos de 10 minutos) y que el cobro tenga abierta su alerta `REFUND_STUCK`: así nunca se da por devuelta ni se libera
 * una devolución que aún está en vuelo. La alerta se cierra en la misma transacción.
 */
export async function resolveStuckRefund(db: KorumPrismaClient, actor: VerifiedSuperadminActor, contributionId: number, refunded: boolean): Promise<void> {
  const dedupeKey = `REFUND_STUCK:${contributionId}`;
  await inTransaction(db, async (tx) => {
    const open = await tx.opsAlert.findFirst({ where: { dedupeKey, status: 'OPEN' }, select: { id: true } });
    if (!open) throw new RefundNotAllowedError(contributionId, 'no tiene una alerta de devolución atascada abierta');
    await resolveUnknownRefund(tx, actor, contributionId, { refunded });
    await resolveAlert(tx, dedupeKey);
  });
}

/** Igual para una factura enviada a Veri*factu sin respuesta: el proveedor no la tiene (vuelve a la cola) o la tiene (con su estado y referencia). */
export async function resolveStuckInvoice(db: KorumPrismaClient, actor: VerifiedSuperadminActor, invoiceId: number, resolution: UnknownInvoiceResolution): Promise<void> {
  const dedupeKey = `INVOICE_STUCK:${invoiceId}`;
  await inTransaction(db, async (tx) => {
    const open = await tx.opsAlert.findFirst({ where: { dedupeKey, status: 'OPEN' }, select: { id: true } });
    if (!open) throw new InvoiceNotAllowedError(invoiceId, 'no tiene una alerta de factura atascada abierta');
    await resolveUnknownInvoice(tx, actor, invoiceId, resolution);
    await resolveAlert(tx, dedupeKey);
  });
}
