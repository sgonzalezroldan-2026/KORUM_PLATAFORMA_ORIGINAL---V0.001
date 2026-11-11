import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { postJournal } from '@/core/finance/ledger.service';
import { bpsOf } from '@/core/finance/money';
import { gatewayFeeLines, sponsorshipPayinLines } from '@/core/finance/payment-journals';
import { notifySigners } from '@/core/jobs/notify';
import type { Keyring } from '@/core/security/crypto';
import { signCheckoutResult } from '@/core/checkout/checkout-rules';
import { ACTIVITY_FUND_DAY, renewalExpiry } from '@/core/sponsors/sponsor-reassignment-rules';
import { SPONSOR_FEE_VAT_BPS, sponsorshipExpiry } from '@/core/sponsors/sponsorship-rules';
import { openSponsorTaxId } from '@/core/tax/tax-id-vault';
import type { Db } from '@/lib/db';
import { issueInvoice } from '@/services/invoicing/invoice.service';
import { relocateSponsor } from '@/services/sponsors/sponsor-reassignment.service';
import { markGoalReached } from './goal-reached';
import { approveRefundInTx, isSettled, PaymentReconciliationError, type ContributionRow } from './payment-reversals';

/**
 * Efecto del cobro confirmado de un patrocinio (Sprint 3.5, QA-F05), dentro de la transacción del webhook. El 100 % del nivel suma íntegro a
 * la iniciativa (o queda en la bolsa *Matching 2x* hasta que el centro apruebe al comercio), el fee y su IVA van a KORUM y se emite la factura
 * del fee. El patrocinio sigue `PENDING` hasta que el centro lo aprueba (moderación, Sprint 4.2): esa decisión no es de este flujo.
 *
 * Un cobro que llega con la campaña ya cerrada (o iniciado tras su fecha límite) ya no se devuelve (decisión del promotor del 2026-11-10, Sprint 4.2f):
 * entra en la bolsa del comercio sin sumar a esa campaña, se factura su fee y espera a la moderación. Si la entidad lo admite, se coloca con su regla
 * (o acaba en el Fondo de actividades); si no lo admite, se le devuelve el 100 % con su rectificativa, como a cualquier comercio no admitido.
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

  // Un patrocinio **iniciado** después de la fecha límite no cuenta aunque la campaña siga `FUNDRAISING` (la tarea de vencimiento corre una vez al día).
  // La iniciativa ya está bloqueada por quien llama: su estado no cambia hasta confirmar.
  const origin = contribution.initiative;
  const startedAfterDeadline = origin.status === 'FUNDRAISING' && contribution.createdAt >= origin.closesAt;
  const accepting = !startedAfterDeadline && (origin.status === 'FUNDRAISING' || (origin.status === 'GOAL_REACHED' && !isSettled(origin.payout?.status)));
  const late = sponsor.renewedFromId === null && !accepting;

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
      toCreditPool: sponsor.renewedFromId !== null || late
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
  if (late) {
    await completeLateSponsorshipInTx(tx, sponsor, order, occurredAt, invoicing, contribution.locale);
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

  if (initiative.status === 'FUNDRAISING' && !sponsor.isMatchingPool && initiative.raisedCents >= initiative.goalCents) {
    await markGoalReached(tx, contribution.organizationId, contribution.initiativeId, occurredAt);
  }

  // Sin el NIF emisor se deshace todo y se reintenta: no se asienta un fee que no se pueda facturar.
  await issueFeeInvoice(tx, sponsor, order, occurredAt, invoicing, false);
}

/**
 * Patrocinio cobrado con su campaña ya fuera de juego (Sprint 4.2f): su dinero ya está en la bolsa del comercio (lo dice su asiento), no suma a la campaña
 * ni a su 💛 y cuenta como salido de ella (`reassignedCents`). Sigue `PENDING`: la entidad decide si lo admite (se coloca con su regla) o no (se le
 * devuelve el 100 %). Se avisa al momento a quienes firman, porque su plazo corre desde el cobro.
 */
async function completeLateSponsorshipInTx(tx: Db, sponsor: SponsorRow, order: string, occurredAt: Date, invoicing: InvoicingContext | undefined, locale: ContributionRow['locale']): Promise<void> {
  // Su bolsa Matching 2x ya no se activará en esa campaña: deja de serlo, para que deshacerlo después no toque la bolsa de otro comercio (auditoría
  // financiera del 4.2f, M1).
  await tx.sponsor.update({ where: { id: sponsor.id }, data: { paidAt: occurredAt, expiresAt: sponsorshipExpiry(occurredAt), reassignedCents: sponsor.amountCents, isMatchingPool: false } });
  await issueFeeInvoice(tx, sponsor, order, occurredAt, invoicing, false);
  const deadline = new Date(occurredAt.getTime() + ACTIVITY_FUND_DAY * 86_400_000).toISOString();
  await notifySigners(tx, sponsor.organizationId, 'sponsor.awaitingDecision', `sponsor:${sponsor.id}`, { sponsorId: sponsor.id, amountCents: sponsor.amountCents, deadline });
  // También al comercio, al momento: su pago llegó con la campaña cerrada y la entidad decidirá (auditoría de seguridad y legal del 4.2f, I3).
  await tx.outboxMessage.createMany({
    data: [{ idempotencyKey: `sponsor.lateReceived:${sponsor.id}`, templateKey: 'sponsor.lateReceived', locale, toAddress: sponsor.email, organizationId: sponsor.organizationId, payloadJson: { sponsorId: sponsor.id, amountCents: sponsor.amountCents } }],
    skipDuplicates: true
  });
  await tx.auditLog.create({ data: { actorType: 'WEBHOOK', organizationId: sponsor.organizationId, action: 'sponsor.late_charge_pooled', targetType: 'Sponsor', targetId: String(sponsor.id), metadataJson: { amountCents: sponsor.amountCents } } });
}

type SponsorRow = Awaited<ReturnType<Db['sponsor']['findUniqueOrThrow']>>;
/** Años encadenados que se siguen como mucho al buscar el último pagado (en la práctica, uno o dos). */
const MAX_CHAINED_RENEWALS = 10;

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
 *
 * Una renovación pagada dos veces (dos pestañas, un reintento) ya no se devuelve (decisión del promotor del 2026-11-10, Sprint 4.2f): el segundo pago
 * renueva el año siguiente (encadenado a la renovación ya pagada) y su dinero entra en la bolsa como cualquier otro. Solo se devuelve si el año anterior
 * ya no estaba vigente (no admitido o devuelto).
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
  // renovación automática es correcto: este cobro lo renueva. Si ya estaba renovado, se sigue la cadena hasta el último año pagado.
  const lockYear = (id: number) =>
    tx.sponsor.update({ where: { id }, data: { autoRenew: false }, select: { expiresAt: true, status: true, renewals: { where: { paidAt: { not: null } }, select: { id: true }, take: 1 } } });
  let renewedFromId = sponsor.renewedFromId;
  let previous = await lockYear(renewedFromId);
  for (let hop = 0; hop < MAX_CHAINED_RENEWALS; hop += 1) {
    const next = previous.renewals[0];
    if (!next) break;
    renewedFromId = next.id;
    previous = await lockYear(renewedFromId);
  }
  if (previous.renewals.length > 0 || (previous.status !== 'APPROVED' && previous.status !== 'CREDIT_POOL')) {
    // El año anterior ya no está vigente (no admitido o devuelto): este cobro se devuelve entero, sin factura. Su dinero está en la bolsa (lo dijo su
    // asiento de cobro): marcado como salido del origen, la devolución lo saca de ahí y no toca la campaña de referencia.
    await tx.sponsor.update({ where: { id: sponsor.id }, data: { reassignedCents: sponsor.amountCents } });
    await approveRefundInTx(tx, contribution.id, { lateCharge: true, at: occurredAt });
    await tx.auditLog.create({
      data: { actorType: 'WEBHOOK', organizationId: sponsor.organizationId, action: 'sponsor.renewal_refunded', targetType: 'Sponsor', targetId: String(sponsor.id), metadataJson: { reason: previous.renewals.length > 0 ? 'ALREADY_RENEWED' : 'PREVIOUS_NOT_ACTIVE', renewedFromId } }
    });
    return;
  }
  if (renewedFromId !== sponsor.renewedFromId) {
    // Segundo pago de la misma renovación: renueva el año siguiente al ya pagado (el índice único sigue valiendo: un año, una renovación pagada).
    await tx.sponsor.update({ where: { id: sponsor.id }, data: { renewedFromId } });
    await tx.auditLog.create({ data: { actorType: 'WEBHOOK', organizationId: sponsor.organizationId, action: 'sponsor.renewal_chained', targetType: 'Sponsor', targetId: String(sponsor.id), metadataJson: { requestedFromId: sponsor.renewedFromId, renewedFromId } } });
  }
  const expiresAt = renewalExpiry(previous.expiresAt, occurredAt);
  await tx.sponsor.update({ where: { id: sponsor.id }, data: { status: 'CREDIT_POOL', creditPoolAt: occurredAt, paidAt: occurredAt, expiresAt, reassignedCents: sponsor.amountCents } });
  // El distintivo anterior termina donde empieza el nuevo: el directorio no enseña dos veces al mismo comercio, y ya no se le vuelve a pedir renovar.
  await tx.sponsor.update({ where: { id: renewedFromId }, data: { expiresAt: new Date(Math.min(previous.expiresAt.getTime(), occurredAt.getTime())) } });
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
        // `chained`: segundo pago de la misma renovación; el email se lo dice al comercio (auditoría de seguridad y legal del 4.2f, I2).
        payloadJson: { sponsorId: sponsor.id, level: sponsor.categoryLevel, amountCents: sponsor.amountCents, expiresAt: expiresAt.toISOString(), chained: renewedFromId !== sponsor.renewedFromId, ...destination, ...(documentsSecret ? { order, sig: signCheckoutResult(documentsSecret, order) } : {}) }
      }
    ],
    skipDuplicates: true
  });
}
