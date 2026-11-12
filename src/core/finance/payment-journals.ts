import type { LedgerJournalKind } from '@/generated/prisma/enums';
import type { JournalLine } from './ledger-accounts';

/**
 * Apuntes de cada operación de dinero (skill korum-escrow-payments §2). Funciones puras: quien llama las registra con `postJournal`
 * dentro de su transacción. Devolver dinero no recalcula nada: refleja línea a línea el asiento del cobro original, así que incluye
 * exactamente lo que se cobró (donación, aportación voluntaria, gastos de gestión, fee e IVA).
 */

interface Scope {
  organizationId: string;
  initiativeId: number;
}

export const PAYIN_KINDS = ['PAYIN_DONATION', 'PAYIN_TICKET', 'PAYIN_SPONSOR'] as const satisfies readonly LedgerJournalKind[];

/**
 * Cobro de una donación o de una entrada. `serviceFeeCents` es lo que se cobra encima para KORUM: en una entrada, los gastos de gestión digital;
 * en una donación, solo existe en la aportación mensual de Mi Hucha (su gestión por cargo, Sprint 3.8). La campaña recibe siempre el 100 %.
 */
export function donationOrTicketPayinLines(
  scope: Scope,
  input: { type: 'DONATION' | 'TICKET'; amountCents: number; guaranteeCents: number; serviceFeeCents: number; totalChargedCents: number }
): JournalLine[] {
  const lines: JournalLine[] = [
    { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: input.totalChargedCents, organizationId: scope.organizationId },
    { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: input.amountCents, ...scope }
  ];
  if (input.guaranteeCents > 0) lines.push({ account: 'KORUM_REVENUE_GUARANTEE', direction: 'CREDIT', amountCents: input.guaranteeCents, organizationId: scope.organizationId });
  const feeAccount = input.type === 'TICKET' ? 'KORUM_REVENUE_TICKET_FEE' : 'KORUM_REVENUE_TOPUP_FEE';
  if (input.serviceFeeCents > 0) lines.push({ account: feeAccount, direction: 'CREDIT', amountCents: input.serviceFeeCents, organizationId: scope.organizationId });
  return lines;
}

/**
 * Cobro de un patrocinio de comercio (Regla 02 §5): el 100 % del nivel va íntegro a la hucha de la iniciativa —o a la bolsa *Matching 2x* si
 * el comercio la eligió—, y el fee de gestión publicitaria y su IVA quedan como ingreso e IVA repercutido de KORUM.
 */
export function sponsorshipPayinLines(
  scope: Scope,
  input: { sponsorId: number; amountCents: number; feeCents: number; vatCents: number; totalChargedCents: number; toMatchingPool: boolean; toCreditPool?: boolean }
): JournalLine[] {
  // Una renovación anual (Sprint 4.2d) entra en la bolsa del comercio y desde ella se coloca según la regla de la entidad.
  const level: JournalLine = input.toCreditPool
    ? { account: 'SPONSOR_CREDIT_POOL', direction: 'CREDIT', amountCents: input.amountCents, organizationId: scope.organizationId, sponsorId: input.sponsorId }
    : input.toMatchingPool
      ? { account: 'MATCHING_POOL', direction: 'CREDIT', amountCents: input.amountCents, ...scope, sponsorId: input.sponsorId }
      : { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: input.amountCents, ...scope };
  const lines: JournalLine[] = [{ account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: input.totalChargedCents, organizationId: scope.organizationId }, level];
  if (input.feeCents > 0) lines.push({ account: 'KORUM_REVENUE_SPONSOR_FEE', direction: 'CREDIT', amountCents: input.feeCents, organizationId: scope.organizationId });
  if (input.vatCents > 0) lines.push({ account: 'TAX_PAYABLE_VAT', direction: 'CREDIT', amountCents: input.vatCents, organizationId: scope.organizationId });
  return lines;
}

export function gatewayFeeLines(organizationId: string, feeCents: number): JournalLine[] {
  return [
    { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: feeCents, organizationId },
    { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: feeCents, organizationId }
  ];
}

/**
 * Auto-Impulso: KORUM completa la meta con dinero propio (skill korum-escrow-payments §2). El gasto sale de KORUM y la hucha de la iniciativa lo
 * recibe entero; no hay cobro, así que no toca `PSP_CLEARING` ni lleva pasarela.
 */
export function selfBoostLines(scope: Scope, amountCents: number): JournalLine[] {
  return [
    { account: 'AUTO_BOOST_EXPENSE', direction: 'DEBIT', amountCents, organizationId: scope.organizationId },
    { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents, ...scope }
  ];
}

export function matchingReleaseLines(scope: Scope, sponsorId: number, amountCents: number): JournalLine[] {
  return [
    { account: 'MATCHING_POOL', direction: 'DEBIT', amountCents, ...scope, sponsorId },
    { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents, ...scope }
  ];
}

/** Las líneas al haber del cobro original, puestas al debe: es lo que se deshace. */
function mirrorPayinCredits(payinLines: readonly JournalLine[]): JournalLine[] {
  return payinLines.filter((line) => line.direction === 'CREDIT').map((line) => ({ ...line, direction: 'DEBIT' as const }));
}

/** Aprobación del reembolso: el dinero sale de la hucha y de los ingresos de KORUM y queda pendiente de devolver. */
export function refundApprovalLines(payinLines: readonly JournalLine[], organizationId: string, totalChargedCents: number): JournalLine[] {
  return [...mirrorPayinCredits(payinLines), { account: 'REFUNDS_PAYABLE', direction: 'CREDIT', amountCents: totalChargedCents, organizationId }];
}

export function refundExecutionLines(organizationId: string, totalChargedCents: number): JournalLine[] {
  return [
    { account: 'REFUNDS_PAYABLE', direction: 'DEBIT', amountCents: totalChargedCents, organizationId },
    { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: totalChargedCents, organizationId }
  ];
}

/**
 * Contracargo: el banco retira el dinero de Paycomet. Lo que se deshace depende de dónde esté:
 * - `IN_ESCROW`: aún en la hucha, sale de ella y de los ingresos de ese cobro.
 * - `REFUND_PENDING`: ya estaba aprobado devolverlo; el banco lo hace por nosotros.
 * - `KORUM_LOSS`: ya liquidado o ya devuelto; lo asume KORUM (Regla 02 §7).
 */
export type ChargebackMode = 'IN_ESCROW' | 'REFUND_PENDING' | 'KORUM_LOSS';

export function chargebackLines(mode: ChargebackMode, payinLines: readonly JournalLine[], organizationId: string, totalChargedCents: number): JournalLine[] {
  const debit: JournalLine[] =
    mode === 'IN_ESCROW'
      ? mirrorPayinCredits(payinLines)
      : [{ account: mode === 'REFUND_PENDING' ? 'REFUNDS_PAYABLE' : 'CHARGEBACK_LOSSES', direction: 'DEBIT', amountCents: totalChargedCents, organizationId }];
  return [...debit, { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: totalChargedCents, organizationId }];
}

/** Aprobación de la liquidación con doble firma: la hucha se reparte entre la entidad, la comisión de KORUM y la pasarela recuperada. */
export function payoutApprovalLines(scope: Scope, input: { raisedCents: number; netPaidCents: number; bracketFeeCents: number; maintFeeCents: number; gatewayInGoalCents: number }): JournalLine[] {
  const { organizationId } = scope;
  const lines: JournalLine[] = [
    { account: 'INITIATIVE_ESCROW', direction: 'DEBIT', amountCents: input.raisedCents, ...scope },
    { account: 'ORG_PAYABLE', direction: 'CREDIT', amountCents: input.netPaidCents, organizationId }
  ];
  if (input.bracketFeeCents > 0) lines.push({ account: 'KORUM_REVENUE_BRACKET', direction: 'CREDIT', amountCents: input.bracketFeeCents, organizationId });
  if (input.maintFeeCents > 0) lines.push({ account: 'KORUM_REVENUE_MAINTENANCE', direction: 'CREDIT', amountCents: input.maintFeeCents, organizationId });
  if (input.gatewayInGoalCents > 0) lines.push({ account: 'GATEWAY_FEES_RECOVERED', direction: 'CREDIT', amountCents: input.gatewayInGoalCents, organizationId });
  return lines;
}

export function splitTransferLines(organizationId: string, amountCents: number): JournalLine[] {
  return [
    { account: 'ORG_PAYABLE', direction: 'DEBIT', amountCents, organizationId },
    { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents, organizationId }
  ];
}
