import type { LedgerAccount } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import { naturalBalance } from './ledger-accounts';

/**
 * Saldos del libro mayor reconstruidos únicamente a partir de los apuntes (Regla 02 §3). Los contadores de otras tablas
 * (`raisedCents`, saldos de Mi Hucha) son cachés que se comparan con estos saldos en la conciliación.
 */

export interface LedgerDimensions {
  organizationId?: string;
  initiativeId?: number;
  userId?: string;
  sponsorId?: number;
}

export interface AccountBalance {
  account: LedgerAccount;
  debitCents: number;
  creditCents: number;
  /** Saldo en el sentido natural de la cuenta (positivo = la cuenta «tiene» dinero). */
  balanceCents: number;
}

const toSafeNumber = (value: number | bigint | null | undefined): number => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new RangeError('Un saldo del libro mayor no cabe en un entero seguro de céntimos');
  return result;
};

/** Saldos de todas las cuentas con movimientos, opcionalmente filtrados por dimensión (entidad, iniciativa, familia, comercio). */
export async function getBalancesByAccount(db: Db, dimensions: LedgerDimensions = {}): Promise<AccountBalance[]> {
  const rows = await db.escrowLedgerEntry.groupBy({
    by: ['account', 'direction'],
    where: { ...dimensions },
    _sum: { amountCents: true },
    orderBy: [{ account: 'asc' }, { direction: 'asc' }]
  });
  const byAccount = new Map<LedgerAccount, { debit: number; credit: number }>();
  for (const row of rows) {
    const totals = byAccount.get(row.account) ?? { debit: 0, credit: 0 };
    if (row.direction === 'DEBIT') totals.debit += toSafeNumber(row._sum.amountCents);
    else totals.credit += toSafeNumber(row._sum.amountCents);
    byAccount.set(row.account, totals);
  }
  return [...byAccount].map(([account, { debit, credit }]) => ({
    account,
    debitCents: debit,
    creditCents: credit,
    balanceCents: naturalBalance(account, debit, credit)
  }));
}

/** Saldo de una cuenta concreta (0 si no tiene movimientos). Ej.: hucha de una iniciativa = `INITIATIVE_ESCROW` + `initiativeId`. */
export async function getAccountBalance(db: Db, account: LedgerAccount, dimensions: LedgerDimensions = {}): Promise<AccountBalance> {
  const rows = await db.escrowLedgerEntry.groupBy({ by: ['direction'], where: { account, ...dimensions }, _sum: { amountCents: true } });
  const debit = toSafeNumber(rows.find((row) => row.direction === 'DEBIT')?._sum.amountCents);
  const credit = toSafeNumber(rows.find((row) => row.direction === 'CREDIT')?._sum.amountCents);
  return { account, debitCents: debit, creditCents: credit, balanceCents: naturalBalance(account, debit, credit) };
}

/**
 * Lo recaudado por una iniciativa según el libro: abonos a su hucha menos devoluciones, contracargos y anulaciones.
 * La liquidación a la entidad (`PAYOUT_APPROVAL`) no cuenta —lo recaudado sigue siendo lo recaudado aunque ya se haya
 * pagado—, ni tampoco su anulación. Debe coincidir siempre con `Initiative.raisedCents` (la conciliación lo vigila).
 */
export async function getRaisedFromLedger(db: Db, initiativeId: number): Promise<number> {
  const rows = await db.escrowLedgerEntry.groupBy({
    by: ['direction'],
    where: {
      account: 'INITIATIVE_ESCROW',
      initiativeId,
      journal: { kind: { not: 'PAYOUT_APPROVAL' }, NOT: { kind: 'REVERSAL', reversesJournal: { kind: 'PAYOUT_APPROVAL' } } }
    },
    _sum: { amountCents: true }
  });
  const debit = toSafeNumber(rows.find((row) => row.direction === 'DEBIT')?._sum.amountCents);
  const credit = toSafeNumber(rows.find((row) => row.direction === 'CREDIT')?._sum.amountCents);
  return credit - debit;
}

/** Balance de sumas de todo el libro: el total del debe debe ser igual al del haber (diagnóstico de la conciliación). */
export async function getTrialBalance(db: Db): Promise<{ debitCents: number; creditCents: number; balanced: boolean }> {
  const rows = await db.escrowLedgerEntry.groupBy({ by: ['direction'], _sum: { amountCents: true } });
  const debit = toSafeNumber(rows.find((row) => row.direction === 'DEBIT')?._sum.amountCents);
  const credit = toSafeNumber(rows.find((row) => row.direction === 'CREDIT')?._sum.amountCents);
  return { debitCents: debit, creditCents: credit, balanced: debit === credit };
}
