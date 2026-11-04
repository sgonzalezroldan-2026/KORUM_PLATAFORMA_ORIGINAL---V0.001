import { getAccountBalance, getRaisedFromLedger } from '@/core/finance/ledger-balances';
import { reconcileCharges, type LocalCharge, type ReconciliationDifference } from '@/core/finance/reconciliation';
import type { ContributionStatus, ContributionType } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import { PaymentProviderError, type PaymentProvider, type PspCharge } from '@/services/payments/payment-provider';
import type { JobHandler } from '../job-types';
import { raiseAlert, resolveAlert } from '../ops-alerts';

/** Cuánto atrás se concilia cada día: las ejecuciones se solapan a propósito, para no perder un cobro que caiga en el límite de dos días. */
export const RECONCILIATION_WINDOW_MS = 48 * 3_600_000;
/**
 * Los cobros de las últimas 3 horas no se comparan: su notificación puede estar en camino, y las fechas de Paycomet se suponen en UTC sin haberlo
 * comprobado en su sandbox (si fueran de Madrid, hay hasta 2 h de desfase). Ampliar el margen evita falsas alarmas críticas mientras tanto.
 */
export const RECONCILIATION_GRACE_MS = 3 * 3_600_000;
/** Marca de hasta dónde se concilió bien la última vez: tras una caída larga, la siguiente ejecución recupera desde ahí. */
export const LAST_RECONCILED_KEY = 'reconciliation.lastWindowEnd';
/** Nunca se recupera de más atrás de esto: Paycomet solo reparte durante 90 días y una consulta tan larga no compensa. */
export const MAX_CATCH_UP_MS = 14 * 86_400_000;
const MIN_SPLIT_SPAN_MS = 60_000;
const CHARGEBACK_LOOKBACK_MS = 7 * 86_400_000;
const CHARGED_STATUSES: ContributionStatus[] = ['COMPLETED', 'REFUND_PENDING', 'REFUNDED', 'CHARGEBACK'];
/** Solo lo que pasó por Paycomet: el Auto-Impulso y la bolsa Matching son dinero de la plataforma, sin cobro. */
const CHARGED_TYPES: ContributionType[] = ['DONATION', 'TICKET', 'SPONSORSHIP'];
const MAX_ORDERS_PER_QUERY = 1000;
const RAISED_PREFIX = 'RECONCILIATION_MISMATCH:RAISED:';

const severityOf = (difference: ReconciliationDifference) => (difference.kind === 'AUTHCODE_MISMATCH' ? 'WARNING' : 'CRITICAL');


async function loadLocalCharges(db: Db, orders: string[], from: Date, graceEnd: Date): Promise<LocalCharge[]> {
  const select = { id: true, organizationId: true, paycometOrder: true, totalChargedCents: true, paycometAuthCode: true, createdAt: true } as const;
  const base = { status: { in: CHARGED_STATUSES }, type: { in: CHARGED_TYPES }, paycometOrder: { not: null } };
  const rows = [];
  for (let start = 0; start < orders.length; start += MAX_ORDERS_PER_QUERY) {
    rows.push(...(await db.contribution.findMany({ where: { ...base, paycometOrder: { in: orders.slice(start, start + MAX_ORDERS_PER_QUERY) } }, select })));
  }
  rows.push(...(await db.contribution.findMany({ where: { ...base, createdAt: { gte: from, lte: graceEnd } }, select })));
  const unique = new Map(rows.map((row) => [row.id, row]));
  return [...unique.values()].flatMap((row) => (row.paycometOrder ? [{ contributionId: row.id, organizationId: row.organizationId, order: row.paycometOrder, totalChargedCents: row.totalChargedCents, authCode: row.paycometAuthCode, createdAt: row.createdAt }] : []));
}

/** Controles internos: lo que el libro debe cumplir con independencia de Paycomet. */
async function checkLedger(db: Db, now: Date): Promise<number> {
  let problems = 0;
  const clearing = await getAccountBalance(db, 'PSP_CLEARING');
  if (clearing.balanceCents < 0) {
    problems += 1;
    await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey: 'RECONCILIATION_MISMATCH:CLEARING_NEGATIVE', detail: { kind: 'CLEARING_NEGATIVE', balanceCents: clearing.balanceCents } }, now);
  } else {
    await resolveAlert(db, 'RECONCILIATION_MISMATCH:CLEARING_NEGATIVE', now);
  }

  const active = await db.initiative.findMany({ where: { status: { in: ['FUNDRAISING', 'GOAL_REACHED'] } }, select: { id: true, organizationId: true, raisedCents: true } });
  const wrong: string[] = [];
  for (const initiative of active) {
    const ledger = await getRaisedFromLedger(db, initiative.id);
    if (ledger === initiative.raisedCents) continue;
    problems += 1;
    wrong.push(`${RAISED_PREFIX}${initiative.id}`);
    await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey: `${RAISED_PREFIX}${initiative.id}`, organizationId: initiative.organizationId, targetType: 'Initiative', targetId: String(initiative.id), detail: { kind: 'RAISED_MISMATCH', cachedCents: initiative.raisedCents, ledgerCents: ledger } }, now);
  }
  await db.opsAlert.updateMany({ where: { type: 'RECONCILIATION_MISMATCH', status: 'OPEN', dedupeKey: { startsWith: RAISED_PREFIX, notIn: wrong } }, data: { status: 'RESOLVED', resolvedAt: now } });
  return problems;
}

/** Contracargos que Paycomet notificó sin confirmar: no se aplican (Regla 02 §7), pero una persona tiene que verlos. */
async function flagUnconfirmedChargebacks(db: Db, now: Date): Promise<number> {
  const events = await db.webhookEvent.findMany({
    where: { status: 'PROCESSED', receivedAt: { gte: new Date(now.getTime() - CHARGEBACK_LOOKBACK_MS) }, AND: [{ payloadJson: { path: ['TransactionType'], equals: '106' } }, { NOT: { payloadJson: { path: ['Response'], equals: 'OK' } } }] },
    take: 100,
    select: { id: true, payloadJson: true }
  });
  for (const event of events) {
    const order = (event.payloadJson as { Order?: unknown } | null)?.Order;
    await raiseAlert(db, { type: 'CHARGEBACK_UNCONFIRMED', severity: 'WARNING', dedupeKey: `CHARGEBACK_UNCONFIRMED:${event.id}`, targetType: 'WebhookEvent', targetId: String(event.id), detail: { order: typeof order === 'string' ? order : null } }, now);
  }
  return events.length;
}

/**
 * `PSP_RECONCILIATION` (diaria, de madrugada): cobros de Paycomet frente a los de KORUM, controles del libro y contracargos sin confirmar.
 * Cada diferencia abre su propia alerta crítica con el detalle (pedido, importes); las de cobros no se cierran solas, porque las resuelve
 * una persona. Si Paycomet no puede devolver la lista completa, la tarea falla y se reintenta: no se concilia con datos recortados.
 */
/**
 * Pide los cobros del rango. Si Paycomet devuelve el máximo de resultados (la lista podría estar recortada), parte el rango por la mitad y lo
 * pide por tramos, hasta que cada tramo cabe: así el volumen de una campaña grande no hace fallar la conciliación todos los días.
 */
export async function listChargesInChunks(provider: PaymentProvider, from: Date, to: Date): Promise<PspCharge[]> {
  try {
    return await provider.listCharges({ from, to });
  } catch (error) {
    const span = to.getTime() - from.getTime();
    if (!(error instanceof PaymentProviderError) || error.code !== 'SEARCH_TRUNCATED' || span <= MIN_SPLIT_SPAN_MS) throw error;
    const middle = new Date(from.getTime() + Math.floor(span / 2));
    const [first, second] = [await listChargesInChunks(provider, from, middle), await listChargesInChunks(provider, new Date(middle.getTime() + 1), to)];
    const unique = new Map([...first, ...second].map((charge) => [charge.order, charge]));
    return [...unique.values()];
  }
}

async function windowStart(db: Db, now: Date): Promise<{ from: Date; lostFrom: Date | null }> {
  const base = now.getTime() - RECONCILIATION_WINDOW_MS;
  const setting = await db.platformSetting.findUnique({ where: { key: LAST_RECONCILED_KEY } });
  const last = typeof setting?.valueJson === 'string' ? Date.parse(setting.valueJson) : Number.NaN;
  // Desde la última conciliación buena (menos el margen, que entonces no se juzgó), pero nunca de más atrás del tope.
  const wanted = Number.isNaN(last) ? base : Math.min(base, last - RECONCILIATION_GRACE_MS);
  const earliest = now.getTime() - MAX_CATCH_UP_MS;
  // Si hace más de 14 días que no se concilia, el hueco anterior no se recupera: que se sepa.
  return { from: new Date(Math.max(wanted, earliest)), lostFrom: wanted < earliest ? new Date(wanted) : null };
}

export const pspReconciliationHandler: JobHandler = async ({ db, now, deps }) => {
  const provider = await deps.paymentProvider();
  const { from, lostFrom } = await windowStart(db, now);
  if (lostFrom) {
    await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey: `RECONCILIATION_MISMATCH:GAP:${lostFrom.toISOString().slice(0, 10)}`, detail: { kind: 'GAP', unreconciledFrom: lostFrom.toISOString(), recoveredFrom: from.toISOString() } }, now);
  }
  const psp = await listChargesInChunks(provider, from, now);
  const local = await loadLocalCharges(db, psp.map((charge) => charge.order), from, new Date(now.getTime() - RECONCILIATION_GRACE_MS));
  const differences = reconcileCharges(psp, local, { now, graceMs: RECONCILIATION_GRACE_MS, from });

  for (const difference of differences) {
    const organizationId = 'organizationId' in difference ? difference.organizationId : null;
    await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: severityOf(difference), dedupeKey: `RECONCILIATION_MISMATCH:${difference.kind}:${difference.order}`, organizationId, targetType: 'PaymentOrder', targetId: difference.order, detail: { ...difference } }, now);
  }
  const ledgerProblems = await checkLedger(db, now);
  const chargebacks = await flagUnconfirmedChargebacks(db, now);
  await db.platformSetting.upsert({ where: { key: LAST_RECONCILED_KEY }, create: { key: LAST_RECONCILED_KEY, valueJson: now.toISOString() }, update: { valueJson: now.toISOString() } });
  return { processed: psp.length, hasMore: false, detail: { differences: differences.length, ledgerProblems, chargebacks } };
};
