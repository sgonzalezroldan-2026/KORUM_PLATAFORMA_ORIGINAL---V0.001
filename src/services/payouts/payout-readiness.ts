import { planPayoutSplits } from '@/core/finance/campaign-window';
import { payoutFigures, type CampaignPayoutRejection } from '@/core/payouts/campaign-payout-rules';
import type { Db } from '@/lib/db';
import { payoutCandidates } from '@/services/payments/payout-candidates';
import { openRefundWindowUntil } from '@/services/ticketing/reschedule-window';

/**
 * ¿Se puede pedir ya la liquidación de esta campaña? (Sprint 4.4a). Lo comparten la petición (que lo vuelve a comprobar con la fila bloqueada) y el panel
 * (que enseña qué falta antes de pedirla, con su enlace). Las mismas condiciones que exige `approvePayout` al mover el dinero, para no pedir dos firmas en
 * balde.
 */

export type PayoutBlocker = Extract<CampaignPayoutRejection, 'NOT_READY' | 'SPONSORS_PENDING' | 'KYB_NOT_VERIFIED' | 'DESTINATION_ACCOUNT_MISSING' | 'NOTHING_TO_PAY' | 'WINDOW_EXPIRED' | 'REFUND_WINDOW_OPEN'>;

export interface ReadinessInitiative {
  id: number;
  status: string;
  raisedCents: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  absorbsGatewayCostByKorum: boolean;
}

export interface ReadinessOrganization {
  kybStatus: string;
  archivedAt: Date | null;
  paycometSplitId: string | null;
}

/**
 * Lo que impide hoy liquidar, en el orden en que la entidad lo resuelve. `destination` decide si hace falta la cuenta de la entidad en Paycomet (un pago al
 * proveedor no la usa). `payoutId` excluye los repartos de la propia liquidación al medir cuánto queda de cada cobro.
 */
export async function payoutBlockers(tx: Db, initiative: ReadinessInitiative, organization: ReadinessOrganization, options: { destination: 'ORGANIZATION' | 'PROVIDER'; payoutId: number | null; now: Date }): Promise<PayoutBlocker[]> {
  const blockers: PayoutBlocker[] = [];
  if (initiative.status !== 'GOAL_REACHED') return ['NOT_READY'];
  // Un cambio de fecha (Sprint 5.13) o una compra de vales (Sprint 5.14c) deja 14 días para pedir la devolución: liquidar antes la haría imposible.
  if (await openRefundWindowUntil(tx, initiative.id, options.now)) blockers.push('REFUND_WINDOW_OPEN');
  // Un comercio cobrado sin revisar aún se puede rechazar y devolver: liquidar antes lo impediría (heredado del 3.5).
  const unreviewed = await tx.sponsor.count({ where: { initiativeId: initiative.id, status: 'PENDING', paidAt: { not: null }, contribution: { status: 'COMPLETED' } } });
  if (unreviewed > 0) blockers.push('SPONSORS_PENDING');
  if (organization.kybStatus !== 'VERIFIED' || organization.archivedAt) blockers.push('KYB_NOT_VERIFIED');
  if (options.destination === 'ORGANIZATION' && !organization.paycometSplitId) blockers.push('DESTINATION_ACCOUNT_MISSING');
  const { netPaidCents } = payoutFigures(initiative);
  if (netPaidCents <= 0) {
    blockers.push('NOTHING_TO_PAY');
    return blockers;
  }
  const candidates = await payoutCandidates(tx, initiative.id, options.payoutId ?? 0);
  try {
    planPayoutSplits(candidates, netPaidCents, options.now);
  } catch {
    // Los cobros que quedan dentro de los 90 días de Paycomet no alcanzan para el neto: lo resuelve KORUM con Paycomet (alerta del Super-Admin).
    blockers.push('WINDOW_EXPIRED');
  }
  return blockers;
}

export const READINESS_INITIATIVE_SELECT = {
  id: true,
  organizationId: true,
  status: true,
  format: true,
  title: true,
  walletEscrowId: true,
  raisedCents: true,
  goalCents: true,
  bracketFeeCents: true,
  maintFeeCents: true,
  gatewayFeeCents: true,
  absorbsGatewayCostByKorum: true,
  firstPayinAt: true
} as const;
