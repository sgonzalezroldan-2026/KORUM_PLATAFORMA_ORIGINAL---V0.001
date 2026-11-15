import { toSafeNumber } from '@/core/finance/ledger-balances';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';

/**
 * Qué sigue contando en lo recaudado de una campaña cuando el estado de una aportación ya no lo dice (Sprint 5.8b): se lee del libro mayor. Lo usa la
 * tabla de aportaciones del expediente, cuyas líneas tienen que sumar lo recaudado también después de una devolución o un contracargo.
 */

/** Asientos que deshacen un cobro: la devolución y el contracargo. */
const UNDO_KINDS = ['CHARGEBACK', 'ESCROW_REFUND_DONOR'] as const;

/**
 * Lo que las bolsas Matching 2x han añadido a la hucha de la campaña y sigue contando en lo recaudado, **según el libro mayor** y bolsa a bolsa (una
 * campaña puede tener una segunda bolsa cuando la primera se devolvió): de cada comercio, lo que entró al emparejar donaciones, menos lo anulado al
 * devolverse una donación emparejada, menos lo que salió de la hucha al devolver o contracargar su cobro antes de liquidar, sin bajar de cero (esa salida
 * puede llevar además el sobrante que había vuelto a la campaña como patrocinio colocado, que baja en su línea y no en esta). No se mira el estado de
 * cada liberación: si al comercio le llega un contracargo con la campaña ya liquidada, sus liberaciones quedan como devueltas, pero ese dinero ya se
 * envió al proyecto (la pérdida la asume KORUM) y lo recaudado no baja. Consultas una detrás de otra; las bolsas de una campaña son muy pocas.
 */
export async function matchingStillInEscrow(db: Db, initiativeId: number): Promise<number> {
  const escrow = { account: 'INITIATIVE_ESCROW' as const, initiativeId };
  const sum = async (where: Prisma.EscrowLedgerEntryWhereInput) => toSafeNumber((await db.escrowLedgerEntry.aggregate({ where, _sum: { amountCents: true } }))._sum.amountCents);
  const pools = await db.escrowLedgerEntry.groupBy({ by: ['sponsorId'], where: { account: 'MATCHING_POOL', initiativeId, sponsorId: { not: null } }, orderBy: { sponsorId: 'asc' } });
  let total = 0;
  for (const { sponsorId } of pools) {
    if (sponsorId === null) continue;
    const ofPool = { kind: 'MATCHING_RELEASE' as const, entries: { some: { account: 'MATCHING_POOL' as const, sponsorId } } };
    const released = await sum({ ...escrow, direction: 'CREDIT', journal: ofPool });
    const undone = await sum({ ...escrow, direction: 'DEBIT', journal: { kind: 'REVERSAL', reversesJournal: ofPool } });
    const takenBack = await sum({ ...escrow, direction: 'DEBIT', journal: { kind: { in: [...UNDO_KINDS] }, contribution: { initiativeId, type: 'SPONSORSHIP', sponsorId } } });
    total += Math.max(0, released - undone - takenBack);
  }
  return toSafeNumber(total);
}

/** Estado, solo del expediente, de una aportación devuelta o contracargada con la campaña ya liquidada: su dinero se envió y sigue en lo recaudado. */
export const afterPayout = (status: string) => `${status}_AFTER_PAYOUT`;
/**
 * Aportaciones devueltas o contracargadas **sin que saliera nada de la hucha**: llegaron con la campaña ya liquidada, la pérdida la asumió KORUM y lo
 * recaudado no bajó. Se reconocen por el libro: tienen su asiento de devolución o de contracargo y ninguno de ellos toca la hucha.
 */
export const keptAfterPayout = (initiativeId: number): Prisma.ContributionWhereInput => ({
  initiativeId,
  status: { in: ['CHARGEBACK', 'REFUNDED'] },
  AND: [{ ledgerJournals: { some: { kind: { in: [...UNDO_KINDS] } } } }, { ledgerJournals: { none: { kind: { in: [...UNDO_KINDS] }, entries: { some: { account: 'INITIATIVE_ESCROW' } } } } }]
});

/**
 * Asignaciones de un patrocinio a esta campaña que **se cerraron sin que saliera nada de su hucha**: el cobro del comercio se devolvió o se contracargó
 * con la campaña ya liquidada, ese dinero ya se había enviado (lo asumió KORUM) y lo recaudado no bajó. Como arriba, se reconocen por el libro y no por
 * la fecha del cierre, que viene de la hora que envía Paycomet: el cobro tiene su asiento de devolución o de contracargo y ninguno toca la hucha de esta
 * campaña. Solo vale para una campaña liquidada: en una que fracasó, la asignación se cierra al sacar su dinero con otro asiento.
 */
export const allocationKeptAfterPayout = (initiativeId: number): Prisma.SponsorAllocationWhereInput => ({
  withdrawnAt: { not: null },
  contribution: {
    AND: [
      { ledgerJournals: { some: { kind: { in: [...UNDO_KINDS] } } } },
      { ledgerJournals: { none: { kind: { in: [...UNDO_KINDS] }, entries: { some: { account: 'INITIATIVE_ESCROW', initiativeId } } } } }
    ]
  }
});
