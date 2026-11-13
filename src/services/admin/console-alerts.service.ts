import { isNoteClosedAlertType, resolveWithNoteSchema } from '@/core/admin/console-support-rules';
import { resolveAlert } from '@/core/jobs/ops-alerts';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeSuperadmin, coarseUserAgent, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { writeAudit } from '@/services/audit/audit.service';
import { InvoiceNotAllowedError, resolveUnknownInvoice, type UnknownInvoiceResolution } from '@/services/invoicing/invoice.service';
import { secretFieldsOf } from '@/services/email/templates/catalog';
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

/**
 * Una acción de servidor se puede llamar sin pasar por la página: el segundo factor de la sesión se comprueba aquí también, no solo en el `layout`.
 * Solo el Super-Admin; cualquier otra sesión se deniega y queda en la auditoría.
 */
export async function authorizeConsoleSession(db: KorumPrismaClient, actor: SessionActor, operation: string, targetType: string): Promise<void> {
  if (actor.kind === 'user' && actor.isSuperadmin && actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId: null, targetType, targetId: '*', metadata: { attempted: operation, reason: 'SECOND_FACTOR_REQUIRED' } });
    throw new TenantAccessError('SUPERADMIN_ONLY');
  }
  await authorizeSuperadmin(db, actor, operation, targetType);
}

/** Marca como resuelta una alerta abierta. Solo el Super-Admin (con el segundo factor de su sesión); un identificador que no está abierto no hace nada. */
export async function resolveOpsAlertById(db: KorumPrismaClient, actor: SessionActor, alertId: string): Promise<ResolveAlertResult> {
  await authorizeConsoleSession(db, actor, 'alert.resolve', 'OpsAlert');
  // Cerrar y dejar constancia van juntos: si la auditoría falla, la alerta sigue abierta.
  return inTransaction(db, async (tx): Promise<ResolveAlertResult> => {
    const alert = await tx.opsAlert.findFirst({ where: { id: alertId, status: 'OPEN' }, select: { dedupeKey: true, type: true, organizationId: true, targetType: true, targetId: true } });
    if (!alert) return { status: 'NOT_OPEN' };
    if (needsItsForm(alert) || isNoteClosedAlertType(alert.type)) return { status: 'USE_RESOLVER' };
    if (!(await resolveAlert(tx, alert.dedupeKey))) return { status: 'NOT_OPEN' };
    await recordAudit(tx, actor, { action: 'ops_alert.resolved', organizationId: alert.organizationId, targetType: 'OpsAlert', targetId: alertId, metadata: { type: alert.type } }, { required: true });
    return { status: 'RESOLVED' };
  });
}

export type ResolveWithNoteResult = { status: 'RESOLVED' } | { status: 'NOT_OPEN' } | { status: 'NOT_ALLOWED' } | { status: 'INVALID' };

/**
 * Cierra con una nota una alerta de dinero que solo se arregla fuera de la plataforma (`PAYOUT_BLOCKED`, `ACTIVITY_FUND_WINDOW`: un reparto que no se puede enviar y
 * no hay otro cobro desde el que rehacerlo). Decisión del promotor (2026-11-13): la consola **no mueve dinero ni escribe asientos** para estos casos; enseña las cifras
 * y el procedimiento, y quien lo gestiona con Paycomet lo anota aquí. Sin nota no se cierra. La nota queda en la auditoría con quién y cuándo. Si el problema sigue,
 * la tarea diaria reabre la alerta sola (`raiseAlert`): cerrarla no lo arregla, solo deja constancia de que alguien lo está llevando.
 */
export async function resolveOpsAlertWithNote(db: KorumPrismaClient, actor: SessionActor, payload: unknown): Promise<ResolveWithNoteResult> {
  await authorizeConsoleSession(db, actor, 'alert.resolve_with_note', 'OpsAlert');
  const parsed = resolveWithNoteSchema.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  const { alertId, note } = parsed.data;
  return inTransaction(db, async (tx): Promise<ResolveWithNoteResult> => {
    const alert = await tx.opsAlert.findFirst({ where: { id: alertId, status: 'OPEN' }, select: { dedupeKey: true, type: true, organizationId: true } });
    if (!alert) return { status: 'NOT_OPEN' };
    if (!isNoteClosedAlertType(alert.type)) return { status: 'NOT_ALLOWED' };
    if (!(await resolveAlert(tx, alert.dedupeKey))) return { status: 'NOT_OPEN' };
    // Con `writeAudit`: segunda barrera (limpia direcciones, IP y otros datos que la regla de la nota no detecta) y el mismo criterio que el resto de auditorías del sprint.
    await writeAudit(tx, { actorType: 'USER', actorUserId: actor.kind === 'user' ? actor.userId : null, ipHash: actor.requestMeta?.ipHash ?? null, userAgent: coarseUserAgent(actor.requestMeta?.userAgent), organizationId: alert.organizationId, action: 'ops_alert.resolved_with_note', targetType: 'OpsAlert', targetId: alertId, metadata: { type: alert.type, note } });
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

export type RequeueEmailsResult = { status: 'REQUEUED'; requeued: number; skipped: number } | { status: 'NOT_OPEN' } | { status: 'NOT_REQUEUEABLE' };

/** Plantilla de una alerta `email:failed:{plantilla}`: la única forma de alerta de email cuyos mensajes se pueden volver a poner en cola. */
const EMAIL_FAILED_KEY = /^email:failed:([A-Za-z][A-Za-z0-9.]{0,79})$/;
export const requeueTemplateOf = (dedupeKey: string): string | null => EMAIL_FAILED_KEY.exec(dedupeKey)?.[1] ?? null;
const REQUEUE_BATCH = 500;

/**
 * «Volver a poner en cola» (Sprint 5.2, heredado del 2.6): los mensajes de una plantilla que agotaron sus reintentos o fueron rechazados vuelven a
 * `PENDING` con los intentos a cero, para cuando ya se ha arreglado la causa (clave del proveedor, remitente, plantilla). Los de plantillas con un
 * código o enlace de un solo uso (acceso, invitación) **no** se reactivan: su secreto ya se borró al fallar y caducaría igualmente. Cierra la alerta
 * en la misma transacción; si los mensajes vuelven a fallar, la alerta se reabre sola. Queda en la auditoría con los recuentos, sin direcciones.
 */
export async function requeueFailedEmails(db: KorumPrismaClient, actor: SessionActor, alertId: string, now: Date = new Date()): Promise<RequeueEmailsResult> {
  await authorizeConsoleSession(db, actor, 'outbox.requeue', 'OpsAlert');
  return inTransaction(db, async (tx): Promise<RequeueEmailsResult> => {
    const alert = await tx.opsAlert.findFirst({ where: { id: alertId, status: 'OPEN', type: 'EMAIL_DELIVERY_FAILED' }, select: { dedupeKey: true } });
    if (!alert) return { status: 'NOT_OPEN' };
    const templateKey = requeueTemplateOf(alert.dedupeKey);
    if (templateKey === null) return { status: 'NOT_REQUEUEABLE' };
    const failed = await tx.outboxMessage.findMany({ where: { status: 'FAILED', templateKey }, orderBy: { id: 'asc' }, take: REQUEUE_BATCH, select: { id: true } });
    const requeueable = secretFieldsOf(templateKey).length === 0;
    const ids = requeueable ? failed.map((row) => row.id) : [];
    // La condición `FAILED` en la escritura cubre la carrera con otra persona que lo haga a la vez: solo pasa a la cola quien sigue fallido.
    const { count } = ids.length === 0 ? { count: 0 } : await tx.outboxMessage.updateMany({ where: { id: { in: ids }, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, lastError: null } });
    // Con más mensajes fallidos que el lote la alerta sigue abierta: quien la atiende vuelve a pulsar hasta vaciarla.
    if (failed.length < REQUEUE_BATCH) await resolveAlert(tx, alert.dedupeKey, now);
    await recordAudit(tx, actor, { action: 'outbox.requeued', organizationId: null, targetType: 'OpsAlert', targetId: alertId, metadata: { templateKey, requeued: count, skipped: failed.length - count } }, { required: true });
    return { status: 'REQUEUED', requeued: count, skipped: failed.length - count };
  });
}
