import type { LedgerAccount, LedgerDirection, LedgerJournalKind } from '@/generated/prisma/enums';

/**
 * Plan de cuentas de KORUM (Regla 02 §3 y skill korum-escrow-payments §2).
 * - `nature`: lado en el que crece la cuenta. Activo y gasto crecen al DEBE; pasivo e ingreso, al HABER. El saldo que se
 *   muestra es siempre positivo cuando la cuenta «tiene» dinero en su sentido natural.
 * - `requires`: dimensiones de subcuenta obligatorias en cada apunte, para poder calcular saldos por iniciativa, entidad,
 *   familia o comercio sin ambigüedad.
 */
export type AccountNature = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE';
export type LedgerDimension = 'organizationId' | 'initiativeId' | 'userId' | 'sponsorId';

interface AccountRule {
  nature: AccountNature;
  requires: readonly LedgerDimension[];
}

export const ACCOUNT_RULES: Record<LedgerAccount, AccountRule> = {
  PSP_CLEARING: { nature: 'ASSET', requires: [] },
  INITIATIVE_ESCROW: { nature: 'LIABILITY', requires: ['organizationId', 'initiativeId'] },
  FAMILY_WALLET: { nature: 'LIABILITY', requires: ['userId'] },
  SPONSOR_CREDIT_POOL: { nature: 'LIABILITY', requires: ['organizationId', 'sponsorId'] },
  MATCHING_POOL: { nature: 'LIABILITY', requires: ['initiativeId', 'sponsorId'] },
  ORG_PAYABLE: { nature: 'LIABILITY', requires: ['organizationId'] },
  REFUNDS_PAYABLE: { nature: 'LIABILITY', requires: [] },
  TAX_PAYABLE_VAT: { nature: 'LIABILITY', requires: [] },
  KORUM_REVENUE_GUARANTEE: { nature: 'REVENUE', requires: [] },
  KORUM_REVENUE_BRACKET: { nature: 'REVENUE', requires: [] },
  KORUM_REVENUE_SPONSOR_FEE: { nature: 'REVENUE', requires: [] },
  KORUM_REVENUE_TICKET_FEE: { nature: 'REVENUE', requires: [] },
  KORUM_REVENUE_MAINTENANCE: { nature: 'REVENUE', requires: [] },
  KORUM_REVENUE_TOPUP_FEE: { nature: 'REVENUE', requires: [] },
  GATEWAY_FEES_RECOVERED: { nature: 'REVENUE', requires: [] },
  GATEWAY_FEES_EXPENSE: { nature: 'EXPENSE', requires: [] },
  AUTO_BOOST_EXPENSE: { nature: 'EXPENSE', requires: [] },
  CHARGEBACK_LOSSES: { nature: 'EXPENSE', requires: [] }
};

/** Cuentas que crecen al DEBE. */
export function isDebitNormal(account: LedgerAccount): boolean {
  const { nature } = ACCOUNT_RULES[account];
  return nature === 'ASSET' || nature === 'EXPENSE';
}

/** Saldo en el sentido natural de la cuenta a partir de las sumas del debe y del haber. */
export function naturalBalance(account: LedgerAccount, debitCents: number, creditCents: number): number {
  return isDebitNormal(account) ? debitCents - creditCents : creditCents - debitCents;
}

export interface JournalLine {
  account: LedgerAccount;
  direction: LedgerDirection;
  /** Céntimos, entero estrictamente positivo: el signo lo da `direction`. */
  amountCents: number;
  organizationId?: string | null;
  initiativeId?: number | null;
  userId?: string | null;
  sponsorId?: number | null;
}

export interface PostJournalInput {
  /** Identifica la operación de origen (p. ej. `paycomet:payin:ORD-123`). Repetirla devuelve el asiento existente. */
  idempotencyKey: string;
  kind: LedgerJournalKind;
  description: string;
  lines: JournalLine[];
  organizationId?: string | null;
  initiativeId?: number | null;
  contributionId?: number | null;
  walletTxId?: number | null;
  payoutId?: number | null;
  paycometReference?: string | null;
  occurredAt?: Date;
  /** `userId` de quien lo provoca, o `system` / `webhook`. */
  createdById?: string | null;
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
