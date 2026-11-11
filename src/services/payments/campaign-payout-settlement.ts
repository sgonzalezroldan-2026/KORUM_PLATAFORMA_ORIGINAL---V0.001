import { planPayoutSplits } from '@/core/finance/campaign-window';
import { raiseAlert, resolveAlertsNotIn } from '@/core/jobs/ops-alerts';
import { CampaignPayoutError, payoutInitiativeSchema } from '@/core/payouts/campaign-payout-rules';
import type { Keyring } from '@/core/security/crypto';
import { inTransaction, type Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { SessionActor } from '@/repositories/tenant-guard';
import { authorizePayoutAction, parsePayoutPayload, reservePayoutAttempt } from '@/services/payouts/campaign-payout.service';
import { providerDestinationOf } from '@/services/payouts/provider-destination';
import { payoutCandidates } from './payout-candidates';
import type { PaymentProvider } from './payment-provider';
import { approvePayout, BLOCKED_PAYOUT_SPLIT_MESSAGES, executeApprovedPayout, PayoutNotAllowedError, type PayoutBlockCode, type PayoutExecutionStatus } from './split-transfer.service';

/**
 * Lo que pasa con la liquidación de una campaña tras la segunda firma (Sprint 4.4a, patrón del Fondo de actividades del 4.2f): se aprueba y se envía en el
 * acto. Si Paycomet falla, las firmas ya cuentan y la tarea diaria lo reanuda; quien firma ve el estado, no un error. Un reparto que ya no se puede enviar
 * (su cobro se contracargó o pasó de los 90 días) se anula y se replanifica desde otros cobros de la campaña (heredado del Sprint 2.1); si no hay de dónde,
 * alerta `PAYOUT_BLOCKED` para el Super-Admin.
 */

export interface SettlementDeps {
  secret: string;
  keyring: Keyring;
}

export type PayoutSettlement = { status: PayoutExecutionStatus } | { status: 'NOT_APPROVED'; reason: PayoutBlockCode };

/** Aprueba (si aún espera la doble firma) y envía. Devuelve qué ha pasado, sin lanzar por un bloqueo esperado. */
export async function settleSignedCampaignPayout(db: Db, providerFactory: () => Promise<PaymentProvider>, payoutId: number, deps: SettlementDeps, now: Date = new Date()): Promise<PayoutSettlement> {
  const provider = await providerFactory();
  try {
    const providerDestination = await providerDestinationOf(db, provider, deps, payoutId);
    const { approved } = await approvePayout(db, payoutId, deps.secret, now, providerDestination ? { providerDestination } : {});
    if (!approved) {
      // Ya no esperaba la doble firma: la aprobó otra ejecución (se sigue con el envío) o ya está hecha.
      const { status } = await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { status: true } });
      if (status === 'PENDING_DOUBLE_CHECK') return { status: 'NOT_APPROVED', reason: 'WRONG_STATUS' };
    }
  } catch (error) {
    if (error instanceof PayoutNotAllowedError) return { status: 'NOT_APPROVED', reason: error.code };
    throw error;
  }
  // Un envío que ya no se puede hacer (documentos retirados después de aprobar) es un motivo, no un error (auditoría financiera del 4.4a, M2).
  try {
    let result = await executeApprovedPayout(db, provider, payoutId, now);
    if (result.status === 'NEEDS_REVIEW' && (await replanBlockedSplits(db, payoutId, now)).replanned > 0) result = await executeApprovedPayout(db, provider, payoutId, now);
    return { status: result.status };
  } catch (error) {
    if (error instanceof PayoutNotAllowedError) return { status: 'NOT_APPROVED', reason: error.code };
    throw error;
  }
}

class ReplanImpossibleError extends Error {
  constructor(readonly blockedCents: number) {
    super(`No hay cobros desde los que replanificar ${blockedCents} céntimos.`);
  }
}

const blockedSplitWhere = { status: 'FAILED' as const, OR: BLOCKED_PAYOUT_SPLIT_MESSAGES.map((message) => ({ errorMessage: { startsWith: message } })) };

/**
 * Con algún reparto que ya no se puede enviar, anula **todos** los que aún no se han enviado y vuelve a repartir lo que falta (neto − hecho − en curso)
 * desde los cobros de la campaña con margen y dentro de su ventana; un cobro con un reparto anulado puede volver con otro importe (auditoría financiera
 * del 4.4a, I1). Los cobros con un reparto hecho o en curso no se vuelven a usar: varios repartos de un mismo pedido están pendientes de confirmar con
 * Paycomet. Todo o nada: si no alcanza, no se anula nada y se abre `PAYOUT_BLOCKED`. Bloquea antes la iniciativa (como los contracargos).
 */
export async function replanBlockedSplits(db: Db, payoutId: number, now: Date): Promise<{ replanned: number; blockedCents: number }> {
  const { initiativeId, organizationId } = await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { initiativeId: true, organizationId: true } });
  try {
    const replanned = await inTransaction(db, async (tx) => {
      await tx.initiative.update({ where: { id: initiativeId }, data: { updatedAt: now } });
      const payout = await tx.escrowPayout.findUniqueOrThrow({ where: { id: payoutId }, select: { status: true, netPaidCents: true } });
      if (payout.status !== 'APPROVED' && payout.status !== 'PROCESSING' && payout.status !== 'FAILED') return 0;
      if ((await tx.escrowPayoutSplit.count({ where: { payoutId, ...blockedSplitWhere } })) === 0) return 0;
      const unsent = await tx.escrowPayoutSplit.findMany({ where: { payoutId, status: { in: ['PENDING', 'FAILED'] } }, select: { id: true } });
      await tx.escrowPayoutSplit.updateMany({ where: { id: { in: unsent.map((split) => split.id) }, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED' } });
      const live = await tx.escrowPayoutSplit.findMany({ where: { payoutId, status: { in: ['DONE', 'SENDING'] } }, select: { contributionId: true, amountCents: true } });
      const missing = payout.netPaidCents - live.reduce((sum, split) => sum + split.amountCents, 0);
      const used = new Set(live.map((split) => split.contributionId));
      const candidates = (await payoutCandidates(tx, initiativeId, payoutId)).filter((candidate) => !used.has(candidate.contributionId));
      const blocked = unsent;
      let plan;
      try {
        plan = planPayoutSplits(candidates, missing, now);
      } catch {
        throw new ReplanImpossibleError(missing);
      }
      await tx.escrowPayoutSplit.createMany({ data: plan.map((split) => ({ payoutId, contributionId: split.contributionId, amountCents: split.amountCents, createdAt: now })) });
      await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId, action: 'payout.splits_replanned', targetType: 'EscrowPayout', targetId: String(payoutId), metadataJson: { cancelled: blocked.length, created: plan.length, amountCents: missing } } });
      return plan.length;
    });
    return { replanned, blockedCents: 0 };
  } catch (error) {
    if (!(error instanceof ReplanImpossibleError)) throw error;
    await raiseAlert(db, { type: 'PAYOUT_BLOCKED', severity: 'CRITICAL', dedupeKey: `PAYOUT_BLOCKED:${payoutId}`, organizationId, targetType: 'EscrowPayout', targetId: String(payoutId), detail: { initiativeId, blockedCents: error.blockedCents } }, now);
    return { replanned: 0, blockedCents: error.blockedCents };
  }
}

/**
 * Una persona firmante reintenta ya su liquidación: la que tiene las dos firmas y no se pudo aprobar (los documentos aún no estaban verificados) o la
 * aprobada que Paycomet no terminó. La tarea diaria hace lo mismo.
 */
export async function retryCampaignPayout(
  db: KorumPrismaClient,
  providerFactory: () => Promise<PaymentProvider>,
  deps: SettlementDeps,
  actor: SessionActor,
  organizationId: string,
  payload: unknown,
  now: Date = new Date()
): Promise<PayoutSettlement & { payoutId: number }> {
  const { initiativeId } = parsePayoutPayload(payoutInitiativeSchema, payload);
  await authorizePayoutAction(db, actor, organizationId, 'payout.retry', initiativeId);
  await reservePayoutAttempt(db, actor, organizationId, 'retry', now);
  const payout = await db.escrowPayout.findUnique({ where: { initiativeId }, select: { id: true, status: true } });
  if (!payout || payout.status === 'EXECUTED') throw new CampaignPayoutError('WRONG_STATUS');
  if (payout.status !== 'PENDING_DOUBLE_CHECK') await replanBlockedSplits(db, payout.id, now);
  return { ...(await settleSignedCampaignPayout(db, providerFactory, payout.id, deps, now)), payoutId: payout.id };
}

/**
 * Tarea diaria (`SPLIT_WINDOW_GUARD`), cada liquidación por separado: el fallo de una se informa y no deja sin tratar a las demás. Aprueba las que tienen
 * dos firmas y no se pudieron aprobar, replanifica los repartos bloqueados y reanuda los envíos. Las que tienen un reparto de resultado desconocido esperan
 * a que lo resuelva el Super-Admin (`resolveUnknownSplit`).
 */
export async function resumeCampaignPayouts(db: Db, provider: PaymentProvider, deps: SettlementDeps, now: Date, limit: number): Promise<{ executed: number; pending: number; errors: number }> {
  const result = { executed: 0, pending: 0, errors: 0 };
  // Solo las que tienen las dos firmas: las que esperan una no ocupan el lote (auditoría financiera del 4.4a, M5).
  const waiting = await db.escrowPayout.findMany({
    where: { status: 'PENDING_DOUBLE_CHECK', AND: [{ signatures: { some: { signerRole: 'DIRECTOR' } } }, { signatures: { some: { signerRole: 'COSIGNER' } } }] },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true, _count: { select: { signatures: true } } }
  });
  const open = await db.escrowPayout.findMany({ where: { status: { in: ['APPROVED', 'PROCESSING', 'FAILED'] }, splits: { none: { status: 'SENDING' } } }, orderBy: { id: 'asc' }, take: limit, select: { id: true } });
  for (const id of [...waiting.filter((row) => row._count.signatures >= 2).map((row) => row.id), ...open.map((row) => row.id)]) {
    try {
      const settlement = await settleSignedCampaignPayout(db, async () => provider, id, deps, now);
      if (settlement.status === 'EXECUTED') result.executed += 1;
      else result.pending += 1;
    } catch (error) {
      result.errors += 1;
      reportError(error, { stage: 'campaign-payout-resume', payoutId: id });
    }
  }
  // Las liquidaciones que ya no tienen repartos bloqueados (replanificadas o resueltas) cierran su alerta.
  const stillBlocked = await db.escrowPayout.findMany({ where: { status: { in: ['APPROVED', 'PROCESSING', 'FAILED'] }, splits: { some: blockedSplitWhere } }, select: { id: true } });
  await resolveAlertsNotIn(db, 'PAYOUT_BLOCKED', stillBlocked.map((row) => `PAYOUT_BLOCKED:${row.id}`), now);
  return result;
}
