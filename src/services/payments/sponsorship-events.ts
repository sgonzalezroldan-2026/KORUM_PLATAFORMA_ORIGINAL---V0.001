import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { postJournal } from '@/core/finance/ledger.service';
import { bpsOf } from '@/core/finance/money';
import { gatewayFeeLines, sponsorshipPayinLines } from '@/core/finance/payment-journals';
import { notifySigners } from '@/core/jobs/notify';
import type { Keyring } from '@/core/security/crypto';
import { signCheckoutResult } from '@/core/checkout/checkout-rules';
import { renewalExpiry } from '@/core/sponsors/sponsor-reassignment-rules';
import { SPONSOR_FEE_VAT_BPS, sponsorshipExpiry } from '@/core/sponsors/sponsorship-rules';
import { openSponsorTaxId } from '@/core/tax/tax-id-vault';
import type { Db } from '@/lib/db';
import { issueInvoice } from '@/services/invoicing/invoice.service';
import { relocateSponsor } from '@/services/sponsors/sponsor-reassignment.service';
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
  invoicing: InvoicingContext | undefined,
  documentsSecret?: string
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
      toMatchingPool: sponsor.isMatchingPool,
      toCreditPool: sponsor.renewedFromId !== null
    })
  });
  const config = await tx.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { gatewayPctBps: true, gatewayFixedCents: true } });
  const gatewayFeeCents = bpsOf(contribution.totalChargedCents, config.gatewayPctBps) + config.gatewayFixedCents;
  if (gatewayFeeCents > 0) {
    await postJournal(tx, { ...common, idempotencyKey: `payment:gateway:${order}`, kind: 'GATEWAY_FEE', description: `Comisión de Paycomet de ${order}`, lines: gatewayFeeLines(contribution.organizationId, gatewayFeeCents) });
  }
  if (sponsor.renewedFromId !== null) {
    await completeRenewalInTx(tx, { ...sponsor, renewedFromId: sponsor.renewedFromId }, contribution, order, occurredAt, invoicing, documentsSecret);
    return;
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

  // Solo un cobro que se queda necesita factura: uno tardío (arriba) se devuelve entero y no depende del NIF emisor. Sin él, se deshace todo y se reintenta.
  await issueFeeInvoice(tx, sponsor, order, occurredAt, invoicing, false);
}

type SponsorRow = Awaited<ReturnType<Db['sponsor']['findUniqueOrThrow']>>;

/** Factura del fee de gestión publicitaria de este cobro (una por patrocinio: cada renovación es una fila nueva con su propia factura). */
async function issueFeeInvoice(tx: Db, sponsor: SponsorRow, order: string, occurredAt: Date, invoicing: InvoicingContext | undefined, renewal: boolean): Promise<void> {
  if (sponsor.feeGeneratedCents <= 0) return;
  if (!invoicing) throw new PaymentReconciliationError(`Cobro ${order}: falta el NIF emisor para facturar el fee del patrocinio.`);
  const organization = await tx.organization.findUniqueOrThrow({ where: { id: sponsor.organizationId }, select: { name: true } });
  await issueInvoice(
    tx,
    {
      idempotencyKey: `sponsor:fee:${sponsor.id}`,
      organizationId: sponsor.organizationId,
      issuerTaxId: invoicing.issuerTaxId,
      issuerName: invoicing.issuerName,
      recipientName: sponsor.name,
      recipientTaxId: sponsor.cifEnc ? openSponsorTaxId(invoicing.keyring, { organizationId: sponsor.organizationId, cifEnc: sponsor.cifEnc, cifKeyVersion: sponsor.cifKeyVersion }) : '',
      keyring: invoicing.keyring,
      concept: `Servicio de gestión publicitaria · Comercio amigo ${sponsor.categoryLevel}${renewal ? ' · Renovación anual' : ''} · ${organization.name}`,
      baseAmountCents: sponsor.feeGeneratedCents,
      taxRateBps: SPONSOR_FEE_VAT_BPS,
      sponsorId: sponsor.id
    },
    occurredAt
  );
}

/**
 * Renovación anual pagada (Sprint 4.2d). La entidad ya admitió a este comercio, así que no vuelve a la moderación: queda aprobado y su distintivo sigue
 * al anterior sin perder días. Su dinero ha entrado en su bolsa y se coloca en la misma transacción según la regla de la entidad (o espera en la bolsa,
 * con su plazo). El cobro nunca es «tardío»: no va a una campaña concreta. El comercio recibe un email con lo que ha pasado y sus documentos.
 */
async function completeRenewalInTx(
  tx: Db,
  sponsor: SponsorRow & { renewedFromId: number },
  contribution: ContributionRow,
  order: string,
  occurredAt: Date,
  invoicing: InvoicingContext | undefined,
  documentsSecret: string | undefined
): Promise<void> {
  // Bloquea el año anterior (la escritura toma su fila): dos pedidos `KR` del mismo enlace pagados a la vez van uno detrás de otro. Quitarle la
  // renovación automática es correcto en los dos casos: o la renueva este cobro o ya la renovó otro.
  const previous = await tx.sponsor.update({
    where: { id: sponsor.renewedFromId },
    data: { autoRenew: false },
    select: { expiresAt: true, status: true, renewals: { where: { paidAt: { not: null } }, select: { id: true }, take: 1 } }
  });
  if (previous.renewals.length > 0 || (previous.status !== 'APPROVED' && previous.status !== 'CREDIT_POOL')) {
    // Ya renovado (otra pestaña, un reintento) o el año anterior ya no está vigente: este cobro se devuelve entero, sin factura. Su dinero está en la bolsa
    // (lo dijo su asiento de cobro): marcado como salido del origen, la devolución lo saca de ahí y no toca la campaña de referencia.
    await tx.sponsor.update({ where: { id: sponsor.id }, data: { reassignedCents: sponsor.amountCents } });
    await approveRefundInTx(tx, contribution.id, { lateCharge: true, at: occurredAt });
    await tx.auditLog.create({
      data: { actorType: 'WEBHOOK', organizationId: sponsor.organizationId, action: 'sponsor.renewal_refunded', targetType: 'Sponsor', targetId: String(sponsor.id), metadataJson: { reason: previous.renewals.length > 0 ? 'ALREADY_RENEWED' : 'PREVIOUS_NOT_ACTIVE', renewedFromId: sponsor.renewedFromId } }
    });
    return;
  }
  const expiresAt = renewalExpiry(previous.expiresAt, occurredAt);
  await tx.sponsor.update({ where: { id: sponsor.id }, data: { status: 'CREDIT_POOL', creditPoolAt: occurredAt, paidAt: occurredAt, expiresAt, reassignedCents: sponsor.amountCents } });
  // El distintivo anterior termina donde empieza el nuevo: el directorio no enseña dos veces al mismo comercio, y ya no se le vuelve a pedir renovar.
  await tx.sponsor.update({ where: { id: sponsor.renewedFromId }, data: { expiresAt: new Date(Math.min(previous.expiresAt.getTime(), occurredAt.getTime())) } });
  await issueFeeInvoice(tx, sponsor, order, occurredAt, invoicing, true);
  const outcome = await relocateSponsor(tx, sponsor.id, occurredAt, { notice: 'NONE' });
  const destination =
    outcome.kind === 'PLACED' ? { placed: outcome.titles.slice(0, 5), more: Math.max(0, outcome.titles.length - 5) } : outcome.kind === 'POOLED' ? { poolDeadline: outcome.deadline.toISOString(), manual: outcome.manual } : {};
  await tx.outboxMessage.createMany({
    data: [
      {
        idempotencyKey: `sponsor.renewed:${sponsor.id}`,
        templateKey: 'sponsor.renewed',
        locale: contribution.locale,
        toAddress: sponsor.email,
        organizationId: sponsor.organizationId,
        payloadJson: { sponsorId: sponsor.id, level: sponsor.categoryLevel, amountCents: sponsor.amountCents, expiresAt: expiresAt.toISOString(), ...destination, ...(documentsSecret ? { order, sig: signCheckoutResult(documentsSecret, order) } : {}) }
      }
    ],
    skipDuplicates: true
  });
}
