import type { SplitCandidate } from '@/core/finance/campaign-window';
import { getAccountBalance } from '@/core/finance/ledger.service';
import type { Db } from '@/lib/db';

/**
 * Cobros desde los que puede repartir la liquidación de una iniciativa (heredado del 4.2b, punto 1): los suyos y el dinero de comercios reasignado a
 * ella (`SponsorAllocation`), que reparte desde el cobro **original** del comercio, hasta lo asignado y con la ventana de ese cobro. Un patrocinio
 * propio que movió parte de su dinero a otra campaña solo aporta lo que no salió: entre todas las campañas, nunca se reparte un cobro dos veces.
 * Un reparto anulado (`CANCELLED`, Sprint 4.4a) no cuenta como usado: ese dinero nunca salió.
 */
export async function payoutCandidates(tx: Db, initiativeId: number, payoutId: number): Promise<SplitCandidate[]> {
  const usable = { status: 'COMPLETED' as const, paycometOrder: { not: null }, paycometAuthCode: { not: null } };
  // Una detrás de otra: dentro de una transacción solo hay una conexión.
  const charges = await tx.contribution.findMany({
    where: { initiativeId, totalChargedCents: { gt: 0 }, ...usable },
    select: { id: true, totalChargedCents: true, createdAt: true, sponsor: { select: { id: true, amountCents: true, reassignedCents: true, isMatchingPool: true } } }
  });
  const allocations = await tx.sponsorAllocation.findMany({
    where: { initiativeId, withdrawnAt: null, contribution: usable },
    select: { contributionId: true, amountCents: true, contribution: { select: { createdAt: true, totalChargedCents: true } } }
  });
  const ids = [...new Set([...charges.map((charge) => charge.id), ...allocations.map((allocation) => allocation.contributionId)])];
  // Lo repartido de cada cobro en otras liquidaciones de campaña y en las del Fondo de actividades (Sprint 4.2f): un cobro nunca se reparte dos veces.
  const used = await tx.escrowPayoutSplit.groupBy({ by: ['contributionId'], where: { contributionId: { in: ids }, payoutId: { not: payoutId }, status: { not: 'CANCELLED' } }, _sum: { amountCents: true } });
  const fundUsed = await tx.activityFundSplit.groupBy({ by: ['contributionId'], where: { contributionId: { in: ids }, payout: { status: { not: 'CANCELLED' } } }, _sum: { amountCents: true } });
  const usedByCharge = new Map<number, number>();
  for (const row of [...used, ...fundUsed]) usedByCharge.set(row.contributionId, (usedByCharge.get(row.contributionId) ?? 0) + (row._sum.amountCents ?? 0));
  const byCharge = new Map<number, SplitCandidate>();
  const add = (contributionId: number, cents: number, chargedAt: Date, totalChargedCents: number) => {
    const current = byCharge.get(contributionId);
    const cap = totalChargedCents - (usedByCharge.get(contributionId) ?? 0);
    const wanted = (current?.totalChargedCents ?? 0) + Math.max(0, cents);
    byCharge.set(contributionId, { contributionId, totalChargedCents: Math.max(0, Math.min(wanted, cap)), chargedAt });
  };
  for (const charge of charges) {
    const pool = charge.sponsor?.isMatchingPool ? (await getAccountBalance(tx, 'MATCHING_POOL', { initiativeId, sponsorId: charge.sponsor.id })).balanceCents : 0;
    // Un patrocinio que ya no tiene nada en esta campaña (renovación, cobro tardío o todo reasignado) no ofrece nada desde aquí: ni su gestión ni su IVA,
    // que no son de la entidad, para que una devolución posterior del 100 % no choque con un reparto ya hecho (auditoría financiera del 4.2f, M2).
    const offered = charge.sponsor && charge.sponsor.reassignedCents >= charge.sponsor.amountCents ? 0 : charge.totalChargedCents - (charge.sponsor?.reassignedCents ?? 0) - Math.max(0, pool);
    add(charge.id, offered, charge.createdAt, charge.totalChargedCents);
  }
  for (const allocation of allocations) add(allocation.contributionId, allocation.amountCents, allocation.contribution.createdAt, allocation.contribution.totalChargedCents);
  return [...byCharge.values()];
}
