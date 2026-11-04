import type { PspCharge } from '@/services/payments/payment-provider';

/**
 * Comparación pura entre los cobros que Paycomet dice haber confirmado y los que KORUM tiene asentados (`PSP_RECONCILIATION`, QA-OPS02).
 * Se concilia cobro a cobro, no por saldos globales: un saldo que cuadra puede esconder dos errores que se compensan, y el cobro con su
 * `AuthCode` es lo que luego hace falta para devolver o repartir (QA-P02). Una diferencia es dinero cobrado sin asentar, un asiento sin
 * cobro, un importe distinto o un `AuthCode` distinto.
 */

export interface LocalCharge {
  contributionId: number;
  organizationId: string;
  order: string;
  totalChargedCents: number;
  authCode: string | null;
  createdAt: Date;
}

export type ReconciliationDifference =
  /** Paycomet cobró y KORUM no lo tiene: el dinero entró sin asiento. */
  | { kind: 'MISSING_LOCALLY'; order: string; amountCents: number }
  /** KORUM tiene el cobro como confirmado y Paycomet no lo conoce. */
  | { kind: 'MISSING_AT_PSP'; order: string; contributionId: number; organizationId: string; amountCents: number }
  | { kind: 'AMOUNT_MISMATCH'; order: string; contributionId: number; organizationId: string; pspCents: number; localCents: number }
  | { kind: 'AUTHCODE_MISMATCH'; order: string; contributionId: number; organizationId: string };

export interface ReconcileOptions {
  now: Date;
  /** Los cobros más recientes que esto se ignoran: el webhook puede estar aún en camino. */
  graceMs: number;
  /** Inicio de la ventana: solo los asientos creados desde aquí se echan en falta en Paycomet. */
  from: Date;
}

export function reconcileCharges(psp: readonly PspCharge[], local: readonly LocalCharge[], options: ReconcileOptions): ReconciliationDifference[] {
  const settledBefore = options.now.getTime() - options.graceMs;
  const localByOrder = new Map(local.map((charge) => [charge.order, charge]));
  const pspOrders = new Set(psp.map((charge) => charge.order));
  const differences: ReconciliationDifference[] = [];

  for (const charge of psp) {
    const own = localByOrder.get(charge.order);
    if (!own) {
      if (charge.occurredAt.getTime() <= settledBefore) differences.push({ kind: 'MISSING_LOCALLY', order: charge.order, amountCents: charge.amountCents });
      continue;
    }
    const scope = { order: charge.order, contributionId: own.contributionId, organizationId: own.organizationId };
    if (own.totalChargedCents !== charge.amountCents) differences.push({ kind: 'AMOUNT_MISMATCH', ...scope, pspCents: charge.amountCents, localCents: own.totalChargedCents });
    else if (own.authCode !== charge.authCode) differences.push({ kind: 'AUTHCODE_MISMATCH', ...scope });
  }

  for (const own of local) {
    if (pspOrders.has(own.order)) continue;
    const created = own.createdAt.getTime();
    if (created >= options.from.getTime() && created <= settledBefore) {
      differences.push({ kind: 'MISSING_AT_PSP', order: own.order, contributionId: own.contributionId, organizationId: own.organizationId, amountCents: own.totalChargedCents });
    }
  }
  return differences;
}
