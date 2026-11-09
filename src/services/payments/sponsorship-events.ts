import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { postJournal } from '@/core/finance/ledger.service';
import { bpsOf } from '@/core/finance/money';
import { gatewayFeeLines, sponsorshipPayinLines } from '@/core/finance/payment-journals';
import { notifySigners } from '@/core/jobs/notify';
import type { Keyring } from '@/core/security/crypto';
import { SPONSOR_FEE_VAT_BPS, sponsorshipExpiry } from '@/core/sponsors/sponsorship-rules';
import { openSponsorTaxId } from '@/core/tax/tax-id-vault';
import type { Db } from '@/lib/db';
import { issueInvoice } from '@/services/invoicing/invoice.service';
import { approveRefundInTx, isSettled, PaymentReconciliationError, type ContributionRow } from './payment-reversals';

/**
 * Efecto del cobro confirmado de un patrocinio (Sprint 3.5, QA-F05), dentro de la transacción del webhook. El 100 % del nivel suma íntegro a
 * la iniciativa (o queda en la bolsa *Matching 2x* hasta que el centro apruebe al comercio), el fee y su IVA van a KORUM y se emite la factura
 * del fee. El patrocinio sigue `PENDING` hasta que el centro lo aprueba (moderación, Sprint 4.2): esa decisión no es de este flujo.
 */

/**
 * Lo necesario para facturar dentro del cobro. Sin el NIF emisor o sin la razón social el webhook falla y se reintenta: no se asienta un fee que no
 * se pueda facturar.
 */
export interface InvoicingContext {
  issuerTaxId: string;
  /** Razón social del emisor (`invoicing.issuerName`): la llevan la factura y la rectificativa impresas. */
  issuerName: string;
  keyring: Keyring;
}

export async function completeSponsorshipInTx(
  tx: Db,
  contribution: ContributionRow,
  notification: { order: string; authCode: string | null },
  occurredAt: Date,
  invoicing: InvoicingContext | undefined
): Promise<void> {
  const { order } = notification;
  if (!contribution.sponsorId) throw new PaymentReconciliationError(`Cobro ${order} de patrocinio sin comercio asociado.`);
  const sponsor = await tx.sponsor.findUniqueOrThrow({ where: { id: contribution.sponsorId } });
  const feeCents = sponsor.feeGeneratedCents;
  const vatCents = bpsOf(feeCents, SPONSOR_FEE_VAT_BPS);
  if (contribution.amountCents + feeCents + vatCents !== contribution.totalChargedCents || contribution.amountCents !== sponsor.amountCents) {
    throw new PaymentReconciliationError(`Cobro ${order}: el total no cuadra con el nivel, el fee y el IVA del patrocinio.`);
  }

  // Dos notificaciones distintas del mismo pedido no pueden acreditarlo dos veces.
  const { count } = await tx.contribution.updateMany({
    where: { id: contribution.id, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'COMPLETED', paycometAuthCode: notification.authCode, fiscalYear: spanishFiscalYear(occurredAt) }
  });
  if (count === 0) return;

  const scope = { organizationId: contribution.organizationId, initiativeId: contribution.initiativeId };
  const common = { ...scope, contributionId: contribution.id, paycometReference: order, occurredAt, createdById: 'webhook' };
  await postJournal(tx, {
    ...common,
    idempotencyKey: `payment:payin:${order}`,
    kind: 'PAYIN_SPONSOR',
    description: `Cobro ${order}`,
    lines: sponsorshipPayinLines(scope, {
      sponsorId: sponsor.id,
      amountCents: contribution.amountCents,
      feeCents,
      vatCents,
      totalChargedCents: contribution.totalChargedCents,
      toMatchingPool: sponsor.isMatchingPool
    })
  });
  const config = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { gatewayPctBps: true, gatewayFixedCents: true } });
  const gatewayFeeCents = bpsOf(contribution.totalChargedCents, config.gatewayPctBps) + config.gatewayFixedCents;
  if (gatewayFeeCents > 0) {
    await postJournal(tx, { ...common, idempotencyKey: `payment:gateway:${order}`, kind: 'GATEWAY_FEE', description: `Comisión de Paycomet de ${order}`, lines: gatewayFeeLines(contribution.organizationId, gatewayFeeCents) });
  }
  await tx.sponsor.update({ where: { id: sponsor.id }, data: { paidAt: occurredAt, expiresAt: sponsorshipExpiry(occurredAt) } });

  // Lo que va a la bolsa Matching 2x no suma a lo recaudado hasta que una donación lo libere, pero el comercio sí cuenta como una aportación más (💛).
  const initiative = await tx.initiative.update({
    where: { id: contribution.initiativeId },
    data: { raisedCents: { increment: sponsor.isMatchingPool ? 0 : contribution.amountCents }, totalContributions: { increment: 1 } },
    select: { status: true, goalCents: true, firstPayinAt: true, raisedCents: true }
  });
  if (!initiative.firstPayinAt) await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { firstPayinAt: occurredAt } });

  // Un patrocinio **iniciado** después de la fecha límite no cuenta aunque la campaña siga `FUNDRAISING` (la tarea de vencimiento corre una vez al día).
  const startedAfterDeadline = initiative.status === 'FUNDRAISING' && contribution.createdAt >= contribution.initiative.closesAt;
  const accepting = !startedAfterDeadline && (initiative.status === 'FUNDRAISING' || (initiative.status === 'GOAL_REACHED' && !isSettled(contribution.initiative.payout?.status)));
  if (!accepting) {
    // El dinero entró en una campaña que ya no admite aportaciones: se devuelve entero y no se factura un servicio que no se prestó.
    await approveRefundInTx(tx, contribution.id, { lateCharge: true });
    return;
  }
  if (initiative.status === 'FUNDRAISING' && !sponsor.isMatchingPool && initiative.raisedCents >= initiative.goalCents) {
    await tx.initiative.update({ where: { id: contribution.initiativeId }, data: { status: 'GOAL_REACHED', stepIndex: 5 } });
    await notifySigners(tx, contribution.organizationId, 'initiative.goalReached', String(contribution.initiativeId), { initiativeId: contribution.initiativeId });
  }

  if (feeCents > 0) {
    // Solo un cobro que se queda necesita factura: uno tardío (arriba) se devuelve entero y no depende del NIF emisor. Sin él, se deshace todo y se reintenta.
    if (!invoicing) throw new PaymentReconciliationError(`Cobro ${order}: falta el NIF emisor para facturar el fee del patrocinio.`);
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: contribution.organizationId }, select: { name: true } });
    await issueInvoice(
      tx,
      {
        idempotencyKey: `sponsor:fee:${sponsor.id}`,
        organizationId: contribution.organizationId,
        issuerTaxId: invoicing.issuerTaxId,
        issuerName: invoicing.issuerName,
        recipientName: sponsor.name,
        recipientTaxId: sponsor.cifEnc ? openSponsorTaxId(invoicing.keyring, { organizationId: sponsor.organizationId, cifEnc: sponsor.cifEnc, cifKeyVersion: sponsor.cifKeyVersion }) : '',
        keyring: invoicing.keyring,
        concept: `Servicio de gestión publicitaria · Comercio amigo ${sponsor.categoryLevel} · ${organization.name}`,
        baseAmountCents: feeCents,
        taxRateBps: SPONSOR_FEE_VAT_BPS,
        sponsorId: sponsor.id
      },
      occurredAt
    );
  }
}
