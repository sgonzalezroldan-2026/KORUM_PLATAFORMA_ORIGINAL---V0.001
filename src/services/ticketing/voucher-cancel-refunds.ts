import { raiseAlert, resolveAlert } from '@/core/jobs/ops-alerts';
import { dataHmac } from '@/core/security/data-hmac';
import { inTransaction, type Db } from '@/lib/db';
import { DONOR_RECIPIENT_SELECT, donorRecipient } from '@/services/notifications/donor-recipient';
import { approvePartialRefundInTx, executePartialRefund } from '@/services/payments/partial-refunds';
import type { PaymentProvider } from '@/services/payments/payment-provider';
import { approveRefundInTx, loadLockedContribution, RefundNotAllowedError } from '@/services/payments/payment-reversals';

/**
 * Devoluciones de una venta de vales que la entidad canceló **antes de liquidarla** (Sprint 5.14c, decisión 69; condiciones de entradas y vales §4.5 y §4.6). El
 * dinero sigue retenido en Paycomet, así que la plataforma devuelve a cada persona, sin que lo pida:
 *
 * - una compra sin ningún vale gastado y cada aportación «sin producto»: el 100 % (`approveRefundInTx`; la envía `MASS_REFUND` como cualquier devolución);
 * - una compra con algún vale gastado: lo no gastado, en proporción a lo pagado (`approvePartialRefundInTx`; la envía `executePendingPartialRefunds`);
 * - una compra con todos sus vales gastados: nada (ya recibió lo que pagó).
 *
 * Lo gastado se queda en la hucha y se liquida a la entidad cuando se cierran los plazos (`openRefundWindowUntil` bloquea la liquidación mientras quede alguna
 * compra por tratar). Cada persona recibe una vez el aviso de la cancelación (`voucher.cancelledBuyer`) y, por cada devolución, «Devolución realizada». Lo hace
 * la tarea `MASS_REFUND` por lotes, y el panel lo adelanta al cancelar. **Hasta el Sprint 5.20b lo asume KORUM** (gestión devuelta, pasarela y devoluciones);
 * desde entonces lo paga la entidad (decisiones 63 y 69).
 */

/**
 * Compras de una venta cancelada que aún tienen algo que devolver: una aportación «sin producto» o un pase sin anular con algún vale por gastar (la base compara
 * lo gastado con lo comprado). Las ya tratadas y las gastadas del todo no vuelven a leerse.
 */
const pendingPurchases = (db: Db) => ({
  type: 'TICKET' as const,
  status: 'COMPLETED' as const,
  OR: [{ voucherNoProduct: true }, { ticketPass: { is: { revokedAt: null, checkedInCount: { lt: db.ticketPass.fields.quantity } } } }]
});

/** Ventas canceladas, sin liquidar y con alguna compra por tratar: las ya tratadas no ocupan sitio en el lote. */
const cancelledWithWork = (db: Db) => ({
  ticketSubtype: 'VOUCHER' as const,
  voucherCancelledAt: { not: null },
  status: 'GOAL_REACHED' as const,
  OR: [{ payout: null }, { payout: { status: 'PENDING_DOUBLE_CHECK' as const } }],
  contributions: { some: pendingPurchases(db) }
});

/** Qué devolución corresponde a una compra de una venta cancelada. */
export function cancellationRefundOf(row: { voucherNoProduct: boolean; ticketPass: { quantity: number; checkedInCount: number; revokedAt: Date | null } | null }): 'FULL' | 'UNSPENT' | null {
  if (row.voucherNoProduct) return 'FULL';
  const pass = row.ticketPass;
  if (!pass || pass.revokedAt !== null || pass.checkedInCount >= pass.quantity) return null;
  return pass.checkedInCount === 0 ? 'FULL' : 'UNSPENT';
}

const ROW_SELECT = { id: true, locale: true, voucherNoProduct: true, ticketPass: { select: { quantity: true, checkedInCount: true, revokedAt: true } }, ...DONOR_RECIPIENT_SELECT } as const;

/**
 * Aprueba las devoluciones pendientes de las ventas canceladas (todas, o solo la indicada), lote a lote y cada compra en su transacción. Devuelve cuántas aprobó
 * y si queda trabajo (por tiempo). Lo que no se pudo (un fallo de una compra concreta) se reintenta en la ejecución siguiente.
 */
export async function approveCancelledVoucherRefunds(db: Db, options: { now: Date; batchSize: number; hmacSecret: string; deadline?: number; initiativeId?: number }): Promise<{ approved: number; hasMore: boolean }> {
  const sales = await db.initiative.findMany({ where: { ...cancelledWithWork(db), ...(options.initiativeId ? { id: options.initiativeId } : {}) }, orderBy: { id: 'asc' }, take: 50, select: { id: true, organizationId: true } });
  let approved = 0;
  for (const sale of sales) {
    let cursor = 0;
    for (;;) {
      if (options.deadline !== undefined && Date.now() > options.deadline) return { approved, hasMore: true };
      const rows = await db.contribution.findMany({ where: { initiativeId: sale.id, ...pendingPurchases(db), id: { gt: cursor } }, orderBy: { id: 'asc' }, take: options.batchSize, select: ROW_SELECT });
      for (const row of rows) {
        if (cancellationRefundOf(row) === null) continue;
        try {
          if (await approveOne(db, sale, row.id, options)) approved += 1;
        } catch (error) {
          // Una compra que no se puede tratar no frena a las demás ni la tarea de devoluciones de toda la plataforma: se vuelve a mirar en la ejecución
          // siguiente y, si no es algo esperable (la venta se liquidó a la vez), queda una alerta crítica con la compra para que la revise una persona.
          if (!(error instanceof RefundNotAllowedError)) {
            await raiseAlert(db, { type: 'JOB_FAILED', severity: 'CRITICAL', dedupeKey: `VOUCHER_CANCEL_REFUND:${row.id}`, organizationId: sale.organizationId, targetType: 'Contribution', targetId: String(row.id), detail: { job: 'MASS_REFUND', initiativeId: sale.id, error: error instanceof Error ? error.message.slice(0, 300) : 'desconocido' } }, options.now);
          }
        }
      }
      const last = rows[rows.length - 1];
      if (!last || rows.length < options.batchSize) break;
      cursor = last.id;
    }
  }
  return { approved, hasMore: false };
}

async function approveOne(db: Db, sale: { id: number; organizationId: string }, contributionId: number, options: { now: Date; hmacSecret: string }): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    // Con la venta bloqueada se vuelve a mirar: un canje, una devolución de 14 días o la liquidación que llegaron a la vez ya están hechos.
    const locked = await loadLockedContribution(tx, { id: contributionId });
    if (!locked || locked.status !== 'COMPLETED' || locked.initiative.status !== 'GOAL_REACHED') return false;
    await tx.ticketPass.updateMany({ where: { contributionId }, data: { checkedInCount: { increment: 0 } } });
    const row = await tx.contribution.findUniqueOrThrow({ where: { id: contributionId }, select: ROW_SELECT });
    const kind = cancellationRefundOf(row);
    if (kind === 'FULL') await approveRefundInTx(tx, contributionId, { at: options.now });
    else if (kind === 'UNSPENT') {
      if (!(await approvePartialRefundInTx(tx, contributionId, { reason: 'VOUCHER_SALE_CANCELLED', at: options.now }))) return false;
    } else return false;
    // Un aviso de la cancelación por persona (aunque comprara varias veces); cada devolución lleva además su «Devolución realizada».
    const recipient = donorRecipient(row);
    if (recipient) {
      await tx.outboxMessage.createMany({
        data: [
          {
            idempotencyKey: `voucher.cancelledBuyer:${sale.id}:${dataHmac(options.hmacSecret, 'supporter-notice', recipient.canonical)}`,
            templateKey: 'voucher.cancelledBuyer',
            locale: row.locale,
            toAddress: recipient.toAddress,
            organizationId: sale.organizationId,
            payloadJson: { initiativeId: sale.id, settled: false }
          }
        ],
        skipDuplicates: true
      });
    }
    return true;
  });
}

export const partialRejectedAlertKey = (contributionId: number) => `REFUND_REJECTED:partial:${contributionId}`;

/**
 * Envía a Paycomet las devoluciones parciales aprobadas (las de una venta, o todas), hasta el tiempo indicado. Un rechazo deja su alerta y se reintenta con la
 * misma espera creciente y el mismo tope que las completas: quien llama indica en `skip` las que aún esperan o se agotaron (`MASS_REFUND`). Un resultado
 * desconocido no se reintenta: abre su alerta `REFUND_STUCK` en el acto.
 */
export async function executePendingPartialRefunds(
  db: Db,
  provider: PaymentProvider,
  originalIp: string,
  options: { now: Date; batchSize: number; deadline?: number; initiativeId?: number; skip?: ReadonlySet<number> }
): Promise<{ refunded: number; failed: number }> {
  const skip = options.skip && options.skip.size > 0 ? { contributionId: { notIn: [...options.skip] } } : {};
  const pending = await db.partialRefund.findMany({
    where: { status: 'PENDING', sendingAt: null, ...skip, ...(options.initiativeId ? { initiativeId: options.initiativeId } : {}) },
    orderBy: { id: 'asc' },
    take: options.batchSize,
    select: { contributionId: true, organizationId: true, amountCents: true }
  });
  let refunded = 0;
  let failed = 0;
  for (const row of pending) {
    if (options.deadline !== undefined && Date.now() > options.deadline) break;
    const result = await executePartialRefund(db, provider, row.contributionId, originalIp, options.now);
    if (result.refunded || result.outcome === 'ALREADY_REFUNDED') {
      refunded += 1;
      await resolveAlert(db, partialRejectedAlertKey(row.contributionId), options.now);
    } else if (result.outcome === 'REJECTED') {
      failed += 1;
      await raiseAlert(db, { type: 'REFUND_REJECTED', severity: 'WARNING', dedupeKey: partialRejectedAlertKey(row.contributionId), organizationId: row.organizationId, targetType: 'Contribution', targetId: String(row.contributionId), detail: { amountCents: row.amountCents, partial: true, code: result.code ?? 'REJECTED' } }, options.now);
    } else if (result.outcome === 'UNKNOWN') {
      await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: `REFUND_STUCK:partial:${row.contributionId}`, organizationId: row.organizationId, targetType: 'Contribution', targetId: String(row.contributionId), detail: { amountCents: row.amountCents, partial: true, code: result.code ?? 'UNKNOWN', unknown: true } }, options.now);
    }
  }
  return { refunded, failed };
}
