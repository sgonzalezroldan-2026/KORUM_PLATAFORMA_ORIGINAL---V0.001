import type { Db } from '@/lib/db';
import { raiseAlert } from '../ops-alerts';

/**
 * Controles de la conciliación diaria sobre el dinero de los comercios (Sprint 4.2d, auditoría financiera I4; Regla 02 §3: todo saldo se reconstruye
 * desde el libro). Sin datos del comercio en las alertas: solo identificadores e importes.
 *
 * - `SPONSOR_POOL_NEGATIVE`: la bolsa de un comercio (`SPONSOR_CREDIT_POOL`) nunca puede quedar en negativo.
 * - `SPONSOR_MONEY_MISMATCH`: un comercio devuelto o no admitido no puede tener dinero en su bolsa, y lo que tiene en la bolsa más lo colocado en campañas
 *   nunca pasa de lo que salió de su origen (`reassignedCents`), que a su vez nunca pasa de su nivel.
 * - `MATCHING_POOL_NEGATIVE`: lo mismo con la bolsa *Matching 2x* de cada campaña (y sin dinero en un comercio cerrado).
 * - `SPLIT_OVERUSE`: lo repartido desde un cobro, entre todas las liquidaciones, nunca pasa de lo cobrado (un mismo cobro no se reparte dos veces).
 */

const PREFIX = 'RECONCILIATION_MISMATCH:SPONSOR:';
const SPLIT_PREFIX = 'RECONCILIATION_MISMATCH:SPLIT:';
const CHUNK = 1_000;

export async function checkSponsorMoney(db: Db, now: Date): Promise<number> {
  const wrong: string[] = [];
  const pools = await db.escrowLedgerEntry.groupBy({ by: ['sponsorId', 'direction'], where: { account: 'SPONSOR_CREDIT_POOL', sponsorId: { not: null } }, _sum: { amountCents: true } });
  const allocated = await db.sponsorAllocation.groupBy({ by: ['sponsorId'], where: { withdrawnAt: null }, _sum: { amountCents: true } });
  const poolOf = new Map<number, number>();
  for (const row of pools) {
    if (row.sponsorId === null) continue;
    const cents = row._sum.amountCents ?? 0;
    poolOf.set(row.sponsorId, (poolOf.get(row.sponsorId) ?? 0) + (row.direction === 'CREDIT' ? cents : -cents));
  }
  const allocatedOf = new Map(allocated.map((row) => [row.sponsorId, row._sum.amountCents ?? 0]));
  const sponsorIds = [...new Set([...poolOf.keys(), ...allocatedOf.keys()])];
  for (let start = 0; start < sponsorIds.length; start += CHUNK) {
    const sponsors = await db.sponsor.findMany({ where: { id: { in: sponsorIds.slice(start, start + CHUNK) } }, select: { id: true, organizationId: true, status: true, amountCents: true, reassignedCents: true } });
    for (const sponsor of sponsors) {
      const pool = poolOf.get(sponsor.id) ?? 0;
      const placed = allocatedOf.get(sponsor.id) ?? 0;
      const closed = sponsor.status === 'REFUNDED' || sponsor.status === 'REJECTED';
      const kind = pool < 0 ? 'SPONSOR_POOL_NEGATIVE' : (closed && pool !== 0) || pool + placed > sponsor.reassignedCents || sponsor.reassignedCents > sponsor.amountCents ? 'SPONSOR_MONEY_MISMATCH' : null;
      if (!kind) continue;
      const dedupeKey = `${PREFIX}${sponsor.id}`;
      wrong.push(dedupeKey);
      await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey, organizationId: sponsor.organizationId, targetType: 'Sponsor', targetId: String(sponsor.id), detail: { kind, poolCents: pool, placedCents: placed, reassignedCents: sponsor.reassignedCents, status: sponsor.status } }, now);
    }
  }

  const matching = await db.escrowLedgerEntry.groupBy({ by: ['sponsorId', 'initiativeId', 'direction'], where: { account: 'MATCHING_POOL', sponsorId: { not: null } }, _sum: { amountCents: true } });
  const matchingOf = new Map<string, { sponsorId: number; initiativeId: number | null; cents: number }>();
  for (const row of matching) {
    if (row.sponsorId === null) continue;
    const key = `${row.sponsorId}:${row.initiativeId ?? ''}`;
    const cents = row._sum.amountCents ?? 0;
    const current = matchingOf.get(key) ?? { sponsorId: row.sponsorId, initiativeId: row.initiativeId, cents: 0 };
    current.cents += row.direction === 'CREDIT' ? cents : -cents;
    matchingOf.set(key, current);
  }
  const suspicious = [...matchingOf.values()].filter((row) => row.cents !== 0);
  const matchingSponsors = new Map((await db.sponsor.findMany({ where: { id: { in: suspicious.map((row) => row.sponsorId) } }, select: { id: true, organizationId: true, status: true } })).map((row) => [row.id, row]));
  for (const row of suspicious) {
    const sponsor = matchingSponsors.get(row.sponsorId);
    const closed = sponsor?.status === 'REFUNDED' || sponsor?.status === 'REJECTED';
    if (row.cents > 0 && !closed) continue;
    const dedupeKey = `${PREFIX}${row.sponsorId}:MATCHING`;
    wrong.push(dedupeKey);
    await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey, organizationId: sponsor?.organizationId ?? null, targetType: 'Sponsor', targetId: String(row.sponsorId), detail: { kind: row.cents < 0 ? 'MATCHING_POOL_NEGATIVE' : 'SPONSOR_MONEY_MISMATCH', matchingCents: row.cents, initiativeId: row.initiativeId } }, now);
  }

  const splits = await db.escrowPayoutSplit.groupBy({ by: ['contributionId'], _sum: { amountCents: true } });
  for (let start = 0; start < splits.length; start += CHUNK) {
    const slice = splits.slice(start, start + CHUNK);
    const charges = new Map((await db.contribution.findMany({ where: { id: { in: slice.map((row) => row.contributionId) } }, select: { id: true, organizationId: true, totalChargedCents: true } })).map((row) => [row.id, row]));
    for (const row of slice) {
      const charge = charges.get(row.contributionId);
      const splitCents = row._sum.amountCents ?? 0;
      if (!charge || splitCents <= charge.totalChargedCents) continue;
      const dedupeKey = `${SPLIT_PREFIX}${row.contributionId}`;
      wrong.push(dedupeKey);
      await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey, organizationId: charge.organizationId, targetType: 'Contribution', targetId: String(row.contributionId), detail: { kind: 'SPLIT_OVERUSE', splitCents, chargedCents: charge.totalChargedCents } }, now);
    }
  }

  await db.opsAlert.updateMany({ where: { type: 'RECONCILIATION_MISMATCH', status: 'OPEN', OR: [{ dedupeKey: { startsWith: PREFIX } }, { dedupeKey: { startsWith: SPLIT_PREFIX } }], dedupeKey: { notIn: wrong } }, data: { status: 'RESOLVED', resolvedAt: now } });
  return wrong.length;
}
