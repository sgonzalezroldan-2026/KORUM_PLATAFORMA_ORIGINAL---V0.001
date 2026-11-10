import { getAccountBalance } from '@/core/finance/ledger-balances';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import type { Db } from '@/lib/db';
import { isFailedInitiative, lockInitiatives, payoutSettled } from '@/services/sponsors/sponsor-money';

/**
 * Deshacer el cobro de un comercio cuyo dinero ya no está (todo) donde lo puso su cobro (Sprint 4.2d, heredado del 4.2b, punto 1): reasignado a otras
 * campañas, esperando en la bolsa o, si era una bolsa *Matching 2x* sobrante, en parte en su campaña y en parte fuera. Una devolución o un contracargo
 * reflejan el asiento del cobro (`mirrorPayinCredits`); aquí se sustituye su línea del nivel por **dónde está ahora** cada céntimo:
 *
 * - lo que sigue en el origen, como siempre (si el origen ya se liquidó, ese dinero salió: lo asume KORUM);
 * - lo que espera en la bolsa (`SPONSOR_CREDIT_POOL`);
 * - lo colocado en campañas sin liquidar (`INITIATIVE_ESCROW` de cada una, que baja su recaudado);
 * - lo que está en el Fondo de actividades de la entidad sin liquidar (`ORG_ACTIVITY_FUND`, Sprint 4.2f);
 * - lo colocado en campañas ya liquidadas o liquidado con el Fondo, que ya salió: `CHARGEBACK_LOSSES`.
 *
 * Las líneas que devuelve son un «cobro virtual» (al haber): quien llama las refleja al debe como con cualquier cobro.
 */

export interface MovedUndo {
  /** Asignaciones aún abiertas del comercio: se cierran todas, el dinero ya no está en ellas. */
  allocationIds: number[];
  /** Lo que baja el recaudado (y el 💛) de cada campaña sin liquidar que tenía parte del dinero. */
  decrements: Array<{ initiativeId: number; cents: number }>;
  /** La campaña de origen aún cuenta al comercio en su 💛 (no fracasó, no se liquidó y no es una renovación). */
  originCounted: boolean;
}

const LEVEL_ACCOUNTS = new Set(['INITIATIVE_ESCROW', 'MATCHING_POOL', 'SPONSOR_CREDIT_POOL']);

interface ChargeToUndo {
  id: number;
  type: string;
  sponsorId: number | null;
  organizationId: string;
  initiativeId: number;
  initiative: { status: string; payout: { status: string } | null };
}

/**
 * Las líneas del cobro con la del nivel repartida según dónde está el dinero, o `null` si el comercio no ha movido nada (se deshace como siempre).
 * Bloquea las campañas que tienen parte del dinero antes de leer si están liquidadas.
 */
export async function movedPayinLines(tx: Db, contribution: ChargeToUndo, payinLines: readonly JournalLine[], now: Date): Promise<{ lines: JournalLine[]; originLines: JournalLine[]; undo: MovedUndo } | null> {
  if (contribution.type !== 'SPONSORSHIP' || !contribution.sponsorId) return null;
  const sponsor = await tx.sponsor.findUniqueOrThrow({ where: { id: contribution.sponsorId }, select: { id: true, amountCents: true, reassignedCents: true, renewedFromId: true } });
  if (sponsor.reassignedCents === 0) return null;
  const levelLine = payinLines.find((line) => line.direction === 'CREDIT' && LEVEL_ACCOUNTS.has(line.account));
  if (!levelLine || levelLine.amountCents !== sponsor.amountCents) throw new Error(`El cobro del comercio ${sponsor.id} no tiene una línea de nivel que cuadre.`);
  const rest = payinLines.filter((line) => line !== levelLine);
  const { organizationId } = contribution;

  const allocations = await tx.sponsorAllocation.findMany({ where: { sponsorId: sponsor.id, withdrawnAt: null }, orderBy: { id: 'asc' }, select: { id: true, initiativeId: true, amountCents: true } });
  await lockInitiatives(tx, contribution.initiativeId, allocations.map((allocation) => allocation.initiativeId), now);
  const targets = await tx.initiative.findMany({ where: { id: { in: allocations.map((allocation) => allocation.initiativeId) } }, select: { id: true, payout: { select: { status: true } } } });
  const settledTargets = new Set(targets.filter((target) => payoutSettled(target.payout)).map((target) => target.id));

  const lines: JournalLine[] = [...rest];
  let lossCents = 0;
  // Lo que no salió del origen sigue allí como en el cobro; si el origen ya se liquidó, ya no está.
  const originPart = sponsor.amountCents - sponsor.reassignedCents;
  const originSettled = payoutSettled(contribution.initiative.payout);
  const originLines: JournalLine[] = originPart > 0 && !originSettled ? [{ ...levelLine, amountCents: originPart }] : [];
  if (originPart > 0 && originSettled) lossCents += originPart;

  const poolCents = Math.max(0, (await getAccountBalance(tx, 'SPONSOR_CREDIT_POOL', { organizationId, sponsorId: sponsor.id })).balanceCents);
  if (poolCents > 0) lines.push({ account: 'SPONSOR_CREDIT_POOL', direction: 'CREDIT', amountCents: poolCents, organizationId, sponsorId: sponsor.id });
  const fundCents = Math.max(0, (await getAccountBalance(tx, 'ORG_ACTIVITY_FUND', { organizationId, sponsorId: sponsor.id })).balanceCents);
  if (fundCents > 0) lines.push({ account: 'ORG_ACTIVITY_FUND', direction: 'CREDIT', amountCents: fundCents, organizationId, sponsorId: sponsor.id });
  const decrements: MovedUndo['decrements'] = [];
  let placedCents = 0;
  for (const allocation of allocations) {
    placedCents += allocation.amountCents;
    if (settledTargets.has(allocation.initiativeId)) lossCents += allocation.amountCents;
    else {
      lines.push({ account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: allocation.amountCents, organizationId, initiativeId: allocation.initiativeId });
      decrements.push({ initiativeId: allocation.initiativeId, cents: allocation.amountCents });
    }
  }
  // Lo reasignado que ya no está ni en la bolsa, ni en el Fondo, ni en una campaña abierta se liquidó (con una campaña o con el Fondo): salió de Paycomet
  // y lo asume KORUM.
  const consumed = sponsor.reassignedCents - poolCents - fundCents - placedCents;
  if (consumed < 0) throw new Error(`El comercio ${sponsor.id} tiene más dinero colocado (${poolCents + fundCents + placedCents}) del que salió de su origen (${sponsor.reassignedCents}).`);
  lossCents += consumed;
  if (lossCents > 0) lines.push({ account: 'CHARGEBACK_LOSSES', direction: 'CREDIT', amountCents: lossCents, organizationId });

  // Un cobro que entró directamente en la bolsa (renovación, o patrocinio que llegó con la campaña ya cerrada, Sprint 4.2f) nunca contó en su campaña.
  const originCounted = levelLine.account !== 'SPONSOR_CREDIT_POOL' && sponsor.renewedFromId === null && !isFailedInitiative(contribution.initiative.status) && !originSettled;
  return { lines, originLines, undo: { allocationIds: allocations.map((allocation) => allocation.id), decrements, originCounted } };
}

/** Efecto en las campañas de un cobro reasignado que se deshace: cierra sus asignaciones y baja lo recaudado de las que aún lo tenían. */
export async function applyMovedUndo(tx: Db, undo: MovedUndo, at: Date): Promise<void> {
  if (undo.allocationIds.length > 0) await tx.sponsorAllocation.updateMany({ where: { id: { in: undo.allocationIds }, withdrawnAt: null }, data: { withdrawnAt: at } });
  for (const { initiativeId, cents } of undo.decrements) {
    const initiative = await tx.initiative.update({
      where: { id: initiativeId },
      data: { raisedCents: { decrement: cents }, totalContributions: { decrement: 1 } },
      select: { status: true, raisedCents: true, goalCents: true }
    });
    // Como con cualquier aportación deshecha: si una campaña de presupuesto sin liquidar baja de su meta, vuelve a recaudar.
    if (initiative.status === 'GOAL_REACHED' && initiative.raisedCents < initiative.goalCents) await tx.initiative.update({ where: { id: initiativeId }, data: { status: 'FUNDRAISING', stepIndex: 4 } });
  }
}
