import { getAccountBalance, postJournal } from '@/core/finance/ledger.service';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import { notifySigners } from '@/core/jobs/notify';
import type { Placement } from '@/core/sponsors/sponsor-reassignment-rules';
import type { Db } from '@/lib/db';
import { PaymentReconciliationError } from '@/services/payments/payment-reversals';

/**
 * Dónde está el dinero de un comercio y cómo se mueve (Sprint 4.2d). Todo dentro de la transacción de quien llama, con las campañas implicadas ya
 * bloqueadas (`lockInitiatives`). Cada movimiento es un asiento `CREDIT_POOL_TRANSFER` y el contador de cada campaña cambia en la misma transacción:
 *
 * - **A la bolsa** (`SPONSOR_CREDIT_POOL`, por comercio): desde la hucha de su campaña de origen, desde su bolsa *Matching 2x* o desde una campaña a la
 *   que se había llevado antes (`SponsorAllocation`, que se cierra).
 * - **Desde la bolsa** a una o varias campañas activas: cada una con su `SponsorAllocation`, que dice a su liquidación de qué cobro repartir.
 *
 * `Sponsor.reassignedCents` es lo que salió del origen: lo que sigue allí se deshace como siempre; lo reasignado, desde donde esté ahora.
 */

/** Estados en los que una campaña ya no va a usar el dinero de un comercio: se reasigna. */
export const FAILED_INITIATIVE_STATUSES = ['REFUNDING', 'CANCELLED', 'REFUNDED'] as const;
const FAILED = new Set<string>(FAILED_INITIATIVE_STATUSES);
export const isFailedInitiative = (status: string): boolean => FAILED.has(status);
/** Una liquidación aprobada ya vació la hucha de la campaña (como `isSettled` de los reembolsos). */
export const payoutSettled = (payout: { status: string } | null): boolean => payout !== null && payout.status !== 'PENDING_DOUBLE_CHECK';

/** Bloquea las campañas en orden de id (dos operaciones que bloqueen las mismas nunca se esperan en círculo). La de origen va primero: es la que bloquean los cobros. */
export async function lockInitiatives(tx: Db, anchorId: number, others: readonly number[], now: Date): Promise<void> {
  await tx.initiative.update({ where: { id: anchorId }, data: { updatedAt: now } });
  const rest = [...new Set(others)].filter((id) => id !== anchorId).sort((a, b) => a - b);
  for (const id of rest) await tx.initiative.update({ where: { id }, data: { updatedAt: now } });
}

export const poolBalanceOf = async (tx: Db, organizationId: string, sponsorId: number): Promise<number> =>
  (await getAccountBalance(tx, 'SPONSOR_CREDIT_POOL', { organizationId, sponsorId })).balanceCents;

export interface MovableSponsor {
  id: number;
  organizationId: string;
  amountCents: number;
  reassignedCents: number;
  isMatchingPool: boolean;
  contributionId: number;
  paycometOrder: string | null;
  /** Fecha del cobro: de él reparte la liquidación de la campaña que reciba el dinero, y con su ventana de 90 días. */
  chargedAt: Date;
}

function transfer(tx: Db, sponsor: MovableSponsor, input: { key: string; initiativeId: number; description: string; lines: JournalLine[] }, now: Date) {
  return postJournal(tx, {
    idempotencyKey: input.key,
    kind: 'CREDIT_POOL_TRANSFER',
    description: input.description,
    organizationId: sponsor.organizationId,
    initiativeId: input.initiativeId,
    contributionId: sponsor.contributionId,
    paycometReference: sponsor.paycometOrder,
    occurredAt: now,
    createdById: 'system',
    lines: input.lines
  });
}

const poolLine = (sponsor: MovableSponsor, direction: 'DEBIT' | 'CREDIT', amountCents: number): JournalLine => ({
  account: 'SPONSOR_CREDIT_POOL',
  direction,
  amountCents,
  organizationId: sponsor.organizationId,
  sponsorId: sponsor.id
});
const escrowLine = (sponsor: MovableSponsor, initiativeId: number, direction: 'DEBIT' | 'CREDIT', amountCents: number): JournalLine => ({
  account: 'INITIATIVE_ESCROW',
  direction,
  amountCents,
  organizationId: sponsor.organizationId,
  initiativeId
});

/**
 * Lleva a la bolsa lo que el comercio tiene aún en su campaña de origen. Sin bolsa Matching 2x, su nivel entero sale de la hucha (que debe tenerlo);
 * con bolsa, lo que quede en ella (lo ya liberado se quedó en la campaña con las donaciones que duplicó). `failed` dice si la campaña fracasó: entonces el
 * comercio deja de contar en su 💛 y su bolsa se apaga del todo; si no (bolsa sobrante de una campaña liquidada), solo deja de liberar.
 *
 * Una bolsa Matching cuyo sobrante ya salió al llegar a la meta y cuya campaña fracasa después sigue encendida en ella (y contando en su 💛) aunque ya no
 * quede dinero por mover: se apaga igualmente (heredado del 4.2d, punto 8, Sprint 4.2f).
 */
export async function moveOriginToPool(tx: Db, sponsor: MovableSponsor, originId: number, failed: boolean, now: Date): Promise<number> {
  const left = sponsor.amountCents - sponsor.reassignedCents;
  if (left <= 0 && !(sponsor.isMatchingPool && failed)) return 0;
  let moved: number;
  if (sponsor.isMatchingPool) {
    const { balanceCents } = await getAccountBalance(tx, 'MATCHING_POOL', { initiativeId: originId, sponsorId: sponsor.id });
    moved = Math.min(Math.max(balanceCents, 0), Math.max(left, 0));
    if (moved > 0) {
      await transfer(tx, sponsor, {
        key: `sponsor:to-pool:${sponsor.id}:matching`,
        initiativeId: originId,
        description: `Bolsa Matching 2x del comercio ${sponsor.id} a su bolsa de reasignación`,
        lines: [{ account: 'MATCHING_POOL', direction: 'DEBIT', amountCents: moved, organizationId: sponsor.organizationId, initiativeId: originId, sponsorId: sponsor.id }, poolLine(sponsor, 'CREDIT', moved)]
      }, now);
    }
    // Sigue contando en el 💛 de su campaña hasta que sale de ella por fracaso: nunca salió nada, o su bolsa sigue encendida (un sobrante que salió al
    // llegar a la meta solo deja de liberar). Apagar la bolsa es la marca de esa salida: repetir la tarea no vuelve a restar.
    const origin = await tx.initiative.findUniqueOrThrow({ where: { id: originId }, select: { matchingPoolTotalCents: true } });
    const stillCounted = sponsor.reassignedCents === 0 || origin.matchingPoolTotalCents > 0;
    await tx.initiative.update({
      where: { id: originId },
      data: failed ? { matchingPoolTotalCents: 0, matchingPoolRemainingCents: 0, matchingSponsorName: null, ...(stillCounted ? { totalContributions: { decrement: 1 } } : {}) } : { matchingPoolRemainingCents: 0 }
    });
  } else {
    const { balanceCents } = await getAccountBalance(tx, 'INITIATIVE_ESCROW', { initiativeId: originId });
    if (balanceCents < left) throw new PaymentReconciliationError(`La hucha de la iniciativa ${originId} tiene ${balanceCents} céntimos y el comercio ${sponsor.id} aportó ${left}.`);
    moved = left;
    await transfer(tx, sponsor, { key: `sponsor:to-pool:${sponsor.id}:origin`, initiativeId: originId, description: `Patrocinio del comercio ${sponsor.id} a su bolsa de reasignación`, lines: [escrowLine(sponsor, originId, 'DEBIT', moved), poolLine(sponsor, 'CREDIT', moved)] }, now);
    await tx.initiative.update({ where: { id: originId }, data: { raisedCents: { decrement: moved }, ...(failed ? { totalContributions: { decrement: 1 } } : {}) } });
  }
  if (moved > 0) await tx.sponsor.update({ where: { id: sponsor.id }, data: { reassignedCents: { increment: moved } } });
  return moved;
}

/** Devuelve a la bolsa lo que el comercio tenía en una campaña que fracasó. La asignación se cierra: su liquidación ya no repartirá desde ese cobro. */
export async function withdrawAllocation(tx: Db, sponsor: MovableSponsor, allocation: { id: number; initiativeId: number; amountCents: number }, now: Date): Promise<void> {
  const { count } = await tx.sponsorAllocation.updateMany({ where: { id: allocation.id, withdrawnAt: null }, data: { withdrawnAt: now } });
  if (count !== 1) return;
  await transfer(tx, sponsor, {
    key: `sponsor:to-pool:allocation:${allocation.id}`,
    initiativeId: allocation.initiativeId,
    description: `Patrocinio del comercio ${sponsor.id} de vuelta a su bolsa de reasignación`,
    lines: [escrowLine(sponsor, allocation.initiativeId, 'DEBIT', allocation.amountCents), poolLine(sponsor, 'CREDIT', allocation.amountCents)]
  }, now);
  await tx.initiative.update({ where: { id: allocation.initiativeId }, data: { raisedCents: { decrement: allocation.amountCents }, totalContributions: { decrement: 1 } } });
}

/**
 * Coloca la bolsa entera del comercio en las campañas del plan. Cada una suma el dinero a lo recaudado y al 💛, como un patrocinio nuevo; si con él
 * llega a su meta, pasa a `GOAL_REACHED` y se avisa a quienes firman (igual que un cobro). Devuelve los títulos, para el aviso al comercio.
 */
export async function placeFromPool(tx: Db, sponsor: MovableSponsor, placements: readonly Placement[], now: Date): Promise<string[]> {
  const pool = await poolBalanceOf(tx, sponsor.organizationId, sponsor.id);
  const total = placements.reduce((sum, placement) => sum + placement.amountCents, 0);
  if (total !== pool) throw new PaymentReconciliationError(`El plan coloca ${total} céntimos y la bolsa del comercio ${sponsor.id} tiene ${pool}.`);
  const titles: string[] = [];
  for (const placement of placements) {
    const allocation = await tx.sponsorAllocation.create({
      data: { organizationId: sponsor.organizationId, sponsorId: sponsor.id, contributionId: sponsor.contributionId, initiativeId: placement.initiativeId, amountCents: placement.amountCents, createdAt: now },
      select: { id: true }
    });
    await transfer(tx, sponsor, {
      key: `sponsor:place:${allocation.id}`,
      initiativeId: placement.initiativeId,
      description: `Patrocinio del comercio ${sponsor.id} reasignado a la iniciativa ${placement.initiativeId}`,
      lines: [poolLine(sponsor, 'DEBIT', placement.amountCents), escrowLine(sponsor, placement.initiativeId, 'CREDIT', placement.amountCents)]
    }, now);
    const initiative = await tx.initiative.update({
      where: { id: placement.initiativeId },
      data: { raisedCents: { increment: placement.amountCents }, totalContributions: { increment: 1 } },
      select: { status: true, raisedCents: true, goalCents: true, title: true, firstPayinAt: true }
    });
    // La ventana de 90 días de esta campaña empieza en su cobro más antiguo, y este lo es si el patrocinio se cobró antes (aviso `SPLIT_WINDOW_GUARD`).
    if (!initiative.firstPayinAt || initiative.firstPayinAt > sponsor.chargedAt) await tx.initiative.update({ where: { id: placement.initiativeId }, data: { firstPayinAt: sponsor.chargedAt } });
    if (initiative.status === 'FUNDRAISING' && initiative.goalCents > 0 && initiative.raisedCents >= initiative.goalCents) {
      await tx.initiative.update({ where: { id: placement.initiativeId }, data: { status: 'GOAL_REACHED', stepIndex: 5 } });
      await notifySigners(tx, sponsor.organizationId, 'initiative.goalReached', String(placement.initiativeId), { initiativeId: placement.initiativeId });
    }
    titles.push(initiative.title);
  }
  return titles;
}
