import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance, getTrialBalance } from '@/core/finance/ledger.service';
import { checkSponsorMoney } from '@/core/jobs/handlers/sponsor-money-checks';
import { completeSignature } from '@/core/security/double-check.service';
import { PaymentProviderError } from '@/services/payments/payment-provider';
import type { MemberRole } from '@/generated/prisma/enums';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadActivityFundRows, loadFundReceiptRows } from '@/repositories/activity-fund.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadRenewalOffer, startSponsorRenewal } from '@/services/checkout/sponsor-renewal.service';
import { startSponsorship } from '@/services/checkout/sponsorship.service';
import { loadActivityFund } from '@/services/panel/activity-fund-data';
import { loadSplitsToResolve, resolveSplitToResolve } from '@/services/admin/payout-review.service';
import { resolveUnknownFundSplit, resumeFundPayouts, retryFundPayout, settleSignedFundPayout, splitUsageOf } from '@/services/payments/activity-fund-payout.service';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { cancelFundPayout, requestFundPayout } from '@/services/sponsors/activity-fund.service';
import { checkActivityFunds, checkBlockedSponsorMoney } from '@/services/sponsors/activity-fund-sweeps';
import { approveSponsor, rejectSponsor } from '@/services/sponsors/sponsor-moderation.service';
import { sendRenewalLink } from '@/services/sponsors/sponsor-renewal-panel.service';
import { expireCreditPools, sweepSponsorMoney } from '@/services/sponsors/sponsor-sweeps';
import { createInitiative, createOrganization, createTestClient, createUser, table, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 4.2f · Fondo de actividades de la entidad contra PostgreSQL real (QA-S02: una bolsa vencida pasa al Fondo y se liquida a la entidad con doble
 * firma, sin devolver nada al comercio). También: pedir y retirar la liquidación, contracargos antes y después, la ventana de 90 días, el reintento de
 * Paycomet, el cobro tardío que espera la moderación, la invitación a renovar, los avisos de dinero bloqueado, las defensas de la base y el aislamiento.
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const DAY = 86_400_000;
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-fondo' };
const invoicing = { issuerTaxId: 'A58818501', issuerName: 'KORUM Pruebas, S.L.', keyring: TEST_KEYRING };
const options = { hmacSecret: TEST_HMAC_SECRET };
const PURPOSE = 'Material para las colonias de primavera y la fiesta de fin de curso';
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let ipSequence = 0;
const createdOrganizations: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: createdOrganizations }, status: 'PENDING' } });
  await db.$disconnect();
});

// Rango propio (172.70.x.x): el límite de intentos agrupa por subred /24 y la base se comparte con otras pruebas de checkout.
const freshIp = () => {
  ipSequence += 1;
  return `172.${70 + (Math.floor(ipSequence / 250) % 10)}.${ipSequence % 250}.9`;
};
const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true });

async function team(overrides: { kybStatus?: 'VERIFIED' | 'SUBMITTED' } = {}) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: overrides.kybStatus ?? 'VERIFIED', sponsorRenewalRule: 'SOONEST' });
  createdOrganizations.push(organization.id);
  const origin = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, title: 'Toldos para el patio' });
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true, name: 'Marta Soler' });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER', roleLabel: 'Tesorería del AMPA' }] });
  return {
    organization,
    origin,
    director: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]),
    cosigner: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }])
  };
}

const deliver = (kind: 'PAYMENT' | 'CHARGEBACK' | 'REFUND', order: string, amountCents: number) => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET, invoicing, documentsSecret: TEST_HMAC_SECRET });
};

/** Un comercio que patrocina y paga por el checkout; con `approver`, la entidad lo aprueba. `closeFirst` cierra la campaña antes de que llegue el cobro. */
async function paidSponsor(slug: string, initiativeId: number, approver: SessionActor | null, extra: { closeFirst?: boolean } = {}) {
  const result = await startSponsorship(
    { db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET },
    { orgSlug: slug, initiativeId, locale: 'es', method: 'CARD', tierCents: 25_000, matchingPool: false, businessName: 'Papelería Nube', taxId: 'B-12345674', contactPerson: 'Iván Sanz', phone: '600 44 55 66', email: 'ivan@nube.example', sector: 'Papelería', promo: '10 % en material', promoCode: 'nube10', autoRenew: true },
    { session: null, ip: freshIp() }
  );
  if (result.status !== 'REDIRECT') throw new Error(`El patrocinio no arrancó: ${result.status}`);
  const order = new URL(result.url, 'http://localhost').searchParams.get('pedido')!;
  const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
  if (extra.closeFirst) await db.initiative.update({ where: { id: initiativeId }, data: { status: 'CLOSED' } });
  expect(await deliver('PAYMENT', order, contribution.totalChargedCents)).toMatchObject({ status: 200, outcome: 'PROCESSED' });
  if (approver) await approveSponsor(db, approver, contribution.organizationId, { sponsorId: contribution.sponsorId! }, options);
  return { sponsorId: contribution.sponsorId!, contribution, order };
}

/** La campaña del comercio fracasa, su dinero va a la bolsa y la bolsa vence: pasa al Fondo. Devuelve el momento «después». */
async function toFund(context: Awaited<ReturnType<typeof team>>) {
  const paid = await paidSponsor(context.organization.slug, context.origin.id, context.director);
  await db.initiative.update({ where: { id: context.origin.id }, data: { status: 'REFUNDING' } });
  await sweepSponsorMoney(db, new Date(), 50);
  const later = new Date(Date.now() + 61 * DAY);
  await expireCreditPools(db, later, 500);
  return { ...paid, later };
}

const fundOf = async (organizationId: string, sponsorId: number) => (await getAccountBalance(db, 'ORG_ACTIVITY_FUND', { organizationId, sponsorId })).balanceCents;
async function linkFor(userId: string) {
  const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId }, orderBy: { id: 'desc' } });
  return message.payloadJson as { token: string; otp: string; targetType: string; targetTitle: string };
}
const journalLines = async (where: { contributionId?: number; kind: 'CHARGEBACK' | 'ESCROW_REFUND_DONOR' | 'ACTIVITY_FUND_DEPOSIT' | 'ACTIVITY_FUND_PAYOUT_APPROVAL'; idempotencyKey?: string }) => {
  const journal = await db.ledgerJournal.findFirstOrThrow({ where, orderBy: { id: 'desc' }, include: { entries: true } });
  return Object.fromEntries(journal.entries.map((entry) => [`${entry.direction}:${entry.account}`, entry.amountCents]));
};

/** Pide la liquidación y la firman las dos personas con su enlace y su código. */
async function signedFundPayout(context: Awaited<ReturnType<typeof team>>, at: Date) {
  const { payoutId, amountCents, receipt } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, at);
  expect(receipt).not.toBeNull();
  const first = await linkFor(context.director.userId);
  expect(first).toMatchObject({ targetType: 'ACTIVITY_FUND_PAYOUT', targetTitle: PURPOSE });
  expect(await completeSignature(db, TEST_HMAC_SECRET, context.director, first, at)).toMatchObject({ status: 'SIGNED', complete: false, target: { targetType: 'ACTIVITY_FUND_PAYOUT', fundPayoutId: payoutId } });
  const second = await linkFor(context.cosigner.userId);
  expect(await completeSignature(db, TEST_HMAC_SECRET, context.cosigner, second, at)).toMatchObject({ status: 'SIGNED', complete: true });
  return { payoutId, amountCents };
}

describe('QA-S02 · una bolsa vencida pasa al Fondo de actividades y se liquida a la entidad con doble firma', () => {
  it('sin devolver nada al comercio: entra al Fondo, se pide con su destino, firman las dos personas y Paycomet reparte desde el cobro original', async () => {
    const context = await team();
    const { sponsorId, contribution, later } = await toFund(context);
    expect(await fundOf(context.organization.id, sponsorId)).toBe(25_000);
    expect(await journalLines({ kind: 'ACTIVITY_FUND_DEPOSIT', contributionId: contribution.id })).toEqual({ 'DEBIT:SPONSOR_CREDIT_POOL': 25_000, 'CREDIT:ORG_ACTIVITY_FUND': 25_000 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).toMatchObject({ status: 'COMPLETED', refundedCents: 0 });

    // El panel lo enseña disponible, con la fecha límite del cobro (90 días).
    const view = await loadActivityFund(db, TEST_HMAC_SECRET, context.director, context.organization.id, later);
    expect(view).toMatchObject({ availableCents: 25_000, stuckCents: 0, payable: true, pending: null });
    expect(new Date(view.deadline!).getTime()).toBe(contribution.createdAt.getTime() + 90 * DAY);
    expect(view.deposits[0]).toMatchObject({ sponsor: 'Papelería Nube', amountCents: 25_000, origin: 'Toldos para el patio' });

    const pspBefore = (await getAccountBalance(db, 'PSP_CLEARING')).balanceCents;
    const { payoutId } = await signedFundPayout(context, later);
    const pendingView = await loadActivityFund(db, TEST_HMAC_SECRET, context.cosigner, context.organization.id, later);
    expect(pendingView.pending).toMatchObject({ signed: 2, amountCents: 25_000, purpose: PURPOSE, mySlotOpen: false });
    expect(pendingView.availableCents).toBe(0);

    expect(await settleSignedFundPayout(db, async () => mock, payoutId, TEST_HMAC_SECRET, later)).toEqual({ status: 'EXECUTED' });
    expect(await journalLines({ kind: 'ACTIVITY_FUND_PAYOUT_APPROVAL', idempotencyKey: `fund:payout-approval:${payoutId}` })).toEqual({ 'DEBIT:ORG_ACTIVITY_FUND': 25_000, 'CREDIT:ORG_PAYABLE': 25_000 });
    const split = await db.activityFundSplit.findFirstOrThrow({ where: { payoutId } });
    expect(split).toMatchObject({ contributionId: contribution.id, amountCents: 25_000, status: 'DONE' });
    expect(mock.calls.filter((call) => call.operation === 'split' && call.order === contribution.paycometOrder)).toHaveLength(1);
    expect(await fundOf(context.organization.id, sponsorId)).toBe(0);
    expect((await getAccountBalance(db, 'ORG_PAYABLE', { organizationId: context.organization.id })).balanceCents).toBe(0);
    expect((await getAccountBalance(db, 'PSP_CLEARING')).balanceCents).toBe(pspBefore - 25_000);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'EXECUTED' });
    expect(await db.outboxMessage.count({ where: { templateKey: 'activityFund.paid', organizationId: context.organization.id } })).toBe(2);
    // Nada vuelve al comercio, y el justificante tiene de dónde salió el dinero y quién firmó.
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).toMatchObject({ status: 'COMPLETED', refundedCents: 0 });
    const receipt = await loadFundReceiptRows(db, context.director, context.organization.id, payoutId);
    expect(receipt).toMatchObject({ amountCents: 25_000, purpose: PURPOSE, splits: [{ amountCents: 25_000, sponsor: { name: 'Papelería Nube' } }] });
    expect(receipt?.signatures.map((signature) => signature.signerRole).sort()).toEqual(['COSIGNER', 'DIRECTOR']);
    // Un cobro nunca se reparte dos veces: lo repartido por el Fondo cuenta para cualquier otra liquidación.
    expect((await splitUsageOf(db, [contribution.id])).get(contribution.id)).toBe(25_000);
    expect(await checkSponsorMoney(db, later)).toBeGreaterThanOrEqual(0);
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `RECONCILIATION_MISMATCH:SPONSOR:${sponsorId}` } })).toBeNull();
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('pedirla exige documentos verificados, algo que liquidar, un destino sin enlaces y no tener otra esperando; el Super-Admin no la pide', async () => {
    const unverified = await team({ kybStatus: 'SUBMITTED' });
    const { later: laterUnverified } = await toFund(unverified);
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, unverified.director, unverified.organization.id, { purpose: PURPOSE }, laterUnverified)).rejects.toMatchObject({ reason: 'KYB_NOT_VERIFIED' });

    const empty = await team();
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, empty.director, empty.organization.id, { purpose: PURPOSE })).rejects.toMatchObject({ reason: 'NOTHING_TO_PAY' });

    const context = await team();
    const { later } = await toFund(context);
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: 'Ver https://ejemplo.test para más' }, later)).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: 'corto' }, later)).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    const { admin } = await verifiedSuperadmin(db);
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, { kind: 'user', userId: admin.id, isSuperadmin: true, memberships: [], secondFactor: true }, context.organization.id, { purpose: PURPOSE }, later)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, { ...context.director, secondFactor: false }, context.organization.id, { purpose: PURPOSE }, later)).rejects.toBeInstanceOf(TenantAccessError);

    const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, context.cosigner, context.organization.id, { purpose: PURPOSE }, later)).rejects.toMatchObject({ reason: 'PAYOUT_PENDING' });

    // Retirarla anula su enlace y deja el dinero disponible para pedirla de nuevo (con otro destino).
    const link = await linkFor(context.director.userId);
    await cancelFundPayout(db, context.cosigner, context.organization.id, { payoutId }, later);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'WITHDRAWN' });
    expect(await completeSignature(db, TEST_HMAC_SECRET, context.director, link, later)).toEqual({ status: 'INVALID_LINK' });
    await expect(cancelFundPayout(db, context.cosigner, context.organization.id, { payoutId }, later)).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
    expect((await loadActivityFund(db, TEST_HMAC_SECRET, context.director, context.organization.id, later)).availableCents).toBe(25_000);
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, context.cosigner, context.organization.id, { purpose: `${PURPOSE} (segunda vez)` }, later)).resolves.toMatchObject({ amountCents: 25_000 });
  });
});

describe('Contracargos de un comercio cuyo dinero está en el Fondo', () => {
  it('antes de liquidar sale del Fondo; la liquidación pendiente se anula al firmar porque el Fondo cambió', async () => {
    const context = await team();
    const { contribution, sponsorId, later } = await toFund(context);
    const { payoutId } = await signedFundPayout(context, later);
    expect(await deliver('CHARGEBACK', contribution.paycometOrder!, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect(await journalLines({ kind: 'CHARGEBACK', contributionId: contribution.id })).toMatchObject({ 'DEBIT:ORG_ACTIVITY_FUND': 25_000 });
    expect(await fundOf(context.organization.id, sponsorId)).toBe(0);

    expect(await settleSignedFundPayout(db, async () => mock, payoutId, TEST_HMAC_SECRET, later)).toEqual({ status: 'NOT_APPROVED', reason: 'FUND_CHANGED' });
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'FUND_CHANGED' });
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: `fund:payout-approval:${payoutId}` } })).toBe(0);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('la tarea diaria anula una liquidación pendiente cuyo Fondo cambió; ya liquidado, el contracargo lo asume KORUM', async () => {
    const context = await team();
    const { contribution, later } = await toFund(context);
    const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    expect(await deliver('CHARGEBACK', contribution.paycometOrder!, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    const link = await linkFor(context.director.userId);
    expect((await checkActivityFunds(db, later)).cancelled).toBeGreaterThanOrEqual(1);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'FUND_CHANGED' });
    expect(await completeSignature(db, TEST_HMAC_SECRET, context.director, link, later)).toEqual({ status: 'INVALID_LINK' });

    const executed = await team();
    const paid = await toFund(executed);
    const { payoutId: done } = await signedFundPayout(executed, paid.later);
    expect(await settleSignedFundPayout(db, async () => mock, done, TEST_HMAC_SECRET, paid.later)).toEqual({ status: 'EXECUTED' });
    expect(await deliver('CHARGEBACK', paid.contribution.paycometOrder!, paid.contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect(await journalLines({ kind: 'CHARGEBACK', contributionId: paid.contribution.id })).toEqual({ 'DEBIT:CHARGEBACK_LOSSES': 25_000, 'DEBIT:KORUM_REVENUE_SPONSOR_FEE': 3_750, 'DEBIT:TAX_PAYABLE_VAT': 788, 'CREDIT:PSP_CLEARING': 29_538 });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });
});

describe('Ventana de 90 días, recordatorios y reintentos de Paycomet', () => {
  it('a 10 días del final se recuerda una vez a quienes firman; pasado el día 90 ese dinero ya no entra y abre una alerta crítica', async () => {
    const context = await team();
    const { contribution } = await toFund(context);
    await db.$executeRawUnsafe(`UPDATE ${table('Contribution')} SET "createdAt" = now() - interval '85 days' WHERE id = ${contribution.id}`);
    const now = new Date();
    await checkActivityFunds(db, now);
    await checkActivityFunds(db, now);
    expect(await db.outboxMessage.count({ where: { templateKey: 'activityFund.reminder', organizationId: context.organization.id } })).toBe(2);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `ACTIVITY_FUND_WINDOW:${context.organization.id}` } })).toMatchObject({ status: 'OPEN', severity: 'WARNING' });

    await db.$executeRawUnsafe(`UPDATE ${table('Contribution')} SET "createdAt" = now() - interval '95 days' WHERE id = ${contribution.id}`);
    await checkActivityFunds(db, now);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `ACTIVITY_FUND_WINDOW:${context.organization.id}` } })).toMatchObject({ status: 'OPEN', severity: 'CRITICAL', detailJson: { stuckCents: 25_000, availableCents: 0 } });
    expect(await loadActivityFund(db, TEST_HMAC_SECRET, context.director, context.organization.id, now)).toMatchObject({ availableCents: 0, stuckCents: 25_000 });
    await expect(requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, now)).rejects.toMatchObject({ reason: 'NOTHING_TO_PAY' });
  });

  it('un rechazo de Paycomet deja la liquidación firmada pendiente y la tarea la termina; un resultado desconocido lo resuelve el Super-Admin', async () => {
    const context = await team();
    const { later } = await toFund(context);
    const { payoutId } = await signedFundPayout(context, later);
    const failing = new MockPaycometProvider({ secrets, failSplit: new PaymentProviderError('Rechazado', 'MOCK_SPLIT_REJECTED') });
    expect(await settleSignedFundPayout(db, async () => failing, payoutId, TEST_HMAC_SECRET, later)).toEqual({ status: 'FAILED' });
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'FAILED' });
    expect((await resumeFundPayouts(db, mock, later, 500)).executed).toBeGreaterThanOrEqual(1);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'EXECUTED' });

    const unknown = await team();
    const { later: laterUnknown } = await toFund(unknown);
    const { payoutId: hanging } = await signedFundPayout(unknown, laterUnknown);
    const cut = new MockPaycometProvider({ secrets, failSplit: new PaymentProviderError('Conexión cortada', 'MOCK_TIMEOUT', true) });
    expect(await settleSignedFundPayout(db, async () => cut, hanging, TEST_HMAC_SECRET, laterUnknown)).toEqual({ status: 'NEEDS_REVIEW' });
    const split = await db.activityFundSplit.findFirstOrThrow({ where: { payoutId: hanging } });
    expect(split.status).toBe('SENDING');
    // La tarea no lo reenvía a ciegas.
    await resumeFundPayouts(db, mock, laterUnknown, 500);
    expect((await db.activityFundSplit.findUniqueOrThrow({ where: { id: split.id } })).status).toBe('SENDING');
    const { actor } = await verifiedSuperadmin(db, new Date(), 'activity_fund.resolve_unknown_split');
    await resolveUnknownFundSplit(db, actor, split.id, { splitAuthCode: 'S-COMPROBADO' });
    await resumeFundPayouts(db, mock, laterUnknown, 500);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: hanging } })).toMatchObject({ status: 'EXECUTED' });
    await expect(resolveUnknownFundSplit(db, actor, split.id, { splitAuthCode: null })).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });
});

describe('Firma única (decisión de la entidad, Sprint 5.2) en el Fondo de actividades', () => {
  async function onlyDirectorSigned() {
    const context = await team();
    const { contribution, later } = await toFund(context);
    const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    expect(await completeSignature(db, TEST_HMAC_SECRET, context.director, await linkFor(context.director.userId), later)).toMatchObject({ status: 'SIGNED', complete: false });
    return { context, contribution, later, payoutId };
  }

  it('si la entidad pasa a firma única con la liquidación firmada solo por Dirección, la tarea diaria la aprueba y el dinero sale (no se queda esperando para siempre)', async () => {
    const { context, later, payoutId } = await onlyDirectorSigned();
    // Con dos firmas exigidas, una sola no basta: la tarea no la toca.
    expect((await resumeFundPayouts(db, mock, later, 500, TEST_HMAC_SECRET)).approved).toBe(0);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });

    await db.organization.update({ where: { id: context.organization.id }, data: { signatureMode: 'SINGLE' } });
    expect((await resumeFundPayouts(db, mock, later, 500, TEST_HMAC_SECRET)).approved).toBe(1);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'EXECUTED' });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('una persona firmante aprueba y envía ya la liquidación firmada solo por Dirección con «Reintentar», y con doble firma exigida no se salta la segunda firma (auditoría financiera del 5.2, H3)', async () => {
    const { context, later, payoutId } = await onlyDirectorSigned();
    // Con dos firmas exigidas, una sola no basta: se rechaza y no se mueve nada.
    await expect(retryFundPayout(db, async () => mock, context.director, context.organization.id, { payoutId }, later, TEST_HMAC_SECRET)).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });
    expect(await db.ledgerJournal.count({ where: { idempotencyKey: `fund:payout-approval:${payoutId}` } })).toBe(0);
    // Sin el secreto de firmas (llamada antigua) el estado sigue sin valer, como antes.
    await db.organization.update({ where: { id: context.organization.id }, data: { signatureMode: 'SINGLE' } });
    await expect(retryFundPayout(db, async () => mock, context.director, context.organization.id, { payoutId }, later)).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
    expect(await retryFundPayout(db, async () => mock, context.director, context.organization.id, { payoutId }, later, TEST_HMAC_SECRET)).toEqual({ status: 'EXECUTED' });
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'EXECUTED' });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('la alerta crítica de «firmada y sin aprobar» también salta con una sola firma cuando la entidad firma así, y no salta con dos firmas exigidas y una sola puesta', async () => {
    const { context, contribution, payoutId } = await onlyDirectorSigned();
    await db.$executeRawUnsafe(`UPDATE ${table('Contribution')} SET "createdAt" = now() - interval '85 days' WHERE id = ${contribution.id}`);
    const now = new Date();
    await checkActivityFunds(db, now);
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `ACTIVITY_FUND_WINDOW:payout:${payoutId}` } })).toBeNull();
    await db.organization.update({ where: { id: context.organization.id }, data: { signatureMode: 'SINGLE' } });
    await checkActivityFunds(db, now);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `ACTIVITY_FUND_WINDOW:payout:${payoutId}` } })).toMatchObject({ status: 'OPEN', severity: 'CRITICAL', detailJson: { reason: 'SIGNED_NOT_APPROVED' } });
  });
});

describe('Cobro tardío de un comercio (decisión del promotor, 2026-11-10: no se devuelve si se admite)', () => {
  it('espera la moderación en la bolsa con aviso a quienes firman; al admitirlo se coloca con la regla', async () => {
    const context = await team();
    const target = await createInitiative(db, context.organization.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, title: 'Huerto escolar', closesAt: new Date(Date.now() + 20 * DAY) });
    const { sponsorId, contribution } = await paidSponsor(context.organization.slug, context.origin.id, null, { closeFirst: true });
    expect(await db.sponsor.findUniqueOrThrow({ where: { id: sponsorId } })).toMatchObject({ status: 'PENDING', reassignedCents: 25_000 });
    expect(await db.outboxMessage.count({ where: { templateKey: 'sponsor.awaitingDecision', organizationId: context.organization.id } })).toBe(2);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: context.origin.id } })).raisedCents).toBe(0);

    await approveSponsor(db, context.cosigner, context.organization.id, { sponsorId }, options);
    expect(await db.sponsor.findUniqueOrThrow({ where: { id: sponsorId } })).toMatchObject({ status: 'APPROVED' });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: target.id }, select: { raisedCents: true, totalContributions: true } })).toEqual({ raisedCents: 25_000, totalContributions: 1 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).toMatchObject({ status: 'COMPLETED' });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('si no lo admite, se le devuelve el 100 % desde su bolsa con su rectificativa, sin tocar la campaña cerrada', async () => {
    const context = await team();
    const { sponsorId, contribution } = await paidSponsor(context.organization.slug, context.origin.id, null, { closeFirst: true });
    await rejectSponsor(db, context.director, context.organization.id, { sponsorId, reason: 'Ya teníamos otra papelería este curso.' }, { hmacSecret: TEST_HMAC_SECRET, invoicing });
    expect(await journalLines({ kind: 'ESCROW_REFUND_DONOR', contributionId: contribution.id })).toMatchObject({ 'DEBIT:SPONSOR_CREDIT_POOL': 25_000, 'CREDIT:REFUNDS_PAYABLE': 29_538 });
    expect(await db.invoice.count({ where: { sponsorId, invoiceType: 'R1' } })).toBe(1);
    expect(await db.initiative.findUniqueOrThrow({ where: { id: context.origin.id }, select: { raisedCents: true, totalContributions: true } })).toEqual({ raisedCents: 0, totalContributions: 0 });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('el dinero sin decidir con el plazo corriendo abre una alerta; al decidir, se cierra', async () => {
    const context = await team();
    const { sponsorId, contribution } = await paidSponsor(context.organization.slug, context.origin.id, null);
    await db.initiative.update({ where: { id: context.origin.id }, data: { status: 'REFUNDING' } });
    await db.$executeRawUnsafe(`UPDATE ${table('Contribution')} SET "createdAt" = now() - interval '55 days' WHERE id = ${contribution.id}`);
    await checkBlockedSponsorMoney(db, new Date(), 500);
    await checkBlockedSponsorMoney(db, new Date(), 500);
    expect(await db.outboxMessage.count({ where: { templateKey: 'sponsor.awaitingDecision', organizationId: context.organization.id } })).toBe(2);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `SPONSOR_MONEY_BLOCKED:${sponsorId}` } })).toMatchObject({ status: 'OPEN', detailJson: { reason: 'AWAITING_DECISION' } });
    await approveSponsor(db, context.director, context.organization.id, { sponsorId }, options);
    await checkBlockedSponsorMoney(db, new Date(), 500);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `SPONSOR_MONEY_BLOCKED:${sponsorId}` } })).toMatchObject({ status: 'RESOLVED' });
  });
});

describe('Invitación a renovar (decisión del promotor, 2026-11-10: una vez por año)', () => {
  it('a quien no pidió renovar se le invita una sola vez; el enlace sirve y su año nuevo sigue sin renovación automática', async () => {
    const context = await team();
    const { sponsorId } = await paidSponsor(context.organization.slug, context.origin.id, context.director);
    await db.sponsor.update({ where: { id: sponsorId }, data: { autoRenew: false, expiresAt: new Date(Date.now() + 10 * DAY) } });
    const { messageId } = await sendRenewalLink(db, context.director, context.organization.id, { sponsorId }, TEST_HMAC_SECRET);
    const message = await db.outboxMessage.findUniqueOrThrow({ where: { id: messageId! } });
    expect(message.templateKey).toBe('sponsor.renewalInvite');
    expect((await db.sponsor.findUniqueOrThrow({ where: { id: sponsorId } })).renewalInvitedAt).not.toBeNull();
    await expect(sendRenewalLink(db, context.cosigner, context.organization.id, { sponsorId }, TEST_HMAC_SECRET)).rejects.toMatchObject({ reason: 'ALREADY_INVITED' });
    expect(await db.auditLog.count({ where: { action: 'sponsor.renewal_invited', targetId: String(sponsorId) } })).toBe(1);

    const token = (message.payloadJson as { token: string }).token;
    expect(await loadRenewalOffer(db, TEST_HMAC_SECRET, context.organization.slug, token)).toMatchObject({ status: 'OK' });
    const start = await startSponsorRenewal({ db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { orgSlug: context.organization.slug, token, method: 'CARD', locale: 'es' }, { session: null, ip: freshIp() });
    const order = new URL((start as { url: string }).url, 'http://localhost').searchParams.get('pedido')!;
    const charge = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(await deliver('PAYMENT', order, charge.totalChargedCents)).toMatchObject({ outcome: 'PROCESSED' });
    expect(await db.sponsor.findUniqueOrThrow({ where: { id: charge.sponsorId! } })).toMatchObject({ autoRenew: false, renewedFromId: sponsorId });
  });
});

describe('Defensas en la base de datos y aislamiento entre entidades', () => {
  it('las entradas del Fondo no se editan, lo firmado no cambia, un reparto no puede ser de otra entidad y solo hay una pendiente por entidad', async () => {
    const context = await team();
    const { sponsorId, later } = await toFund(context);
    const deposit = await db.activityFundDeposit.findFirstOrThrow({ where: { sponsorId } });
    await expect(db.$executeRawUnsafe(`UPDATE ${table('ActivityFundDeposit')} SET "amountCents" = 1 WHERE id = ${deposit.id}`)).rejects.toThrow(/no se edita/);
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('ActivityFundDeposit')} WHERE id = ${deposit.id}`)).rejects.toThrow(/no se edita/);
    const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('ActivityFundPayout')} SET "amountCents" = 1 WHERE id = ${payoutId}`)).rejects.toThrow(/ya no se puede cambiar/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('ActivityFundPayout')} SET "purpose" = 'Otra cosa distinta' WHERE id = ${payoutId}`)).rejects.toThrow(/ya no se puede cambiar/);
    await expect(db.activityFundPayout.create({ data: { organizationId: context.organization.id, amountCents: 100, purpose: PURPOSE, requestedById: context.director.userId } })).rejects.toThrow();

    const other = await team();
    const foreign = await toFund(other);
    await expect(db.activityFundSplit.create({ data: { payoutId, sponsorId: foreign.sponsorId, contributionId: foreign.contribution.id, amountCents: 100 } })).rejects.toThrow(/no casa/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('GlobalConfig')} SET "creditPoolMaxDays" = 80 WHERE id = 'GLOBAL'`)).rejects.toThrow();
  });

  it('otra entidad no ve ni retira el Fondo de esta: responde como si no existiera y queda en la auditoría', async () => {
    const context = await team();
    const { later } = await toFund(context);
    const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    const intruder = await team();
    await expect(loadActivityFundRows(db, intruder.director, context.organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(cancelFundPayout(db, intruder.director, intruder.organization.id, { payoutId }, later)).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(await db.auditLog.count({ where: { action: 'tenant.resource_outside_tenant', targetType: 'ActivityFundPayout', targetId: String(payoutId) } })).toBe(1);
    expect(await loadFundReceiptRows(db, context.director, context.organization.id, payoutId)).toBeNull();
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });
  });
});

describe('Repetir la tarea y la conciliación', () => {
  it('la bolsa pasa al Fondo una sola vez aunque la tarea corra dos veces a la vez', async () => {
    const context = await team();
    const paid = await paidSponsor(context.organization.slug, context.origin.id, context.director);
    await db.initiative.update({ where: { id: context.origin.id }, data: { status: 'REFUNDING' } });
    await sweepSponsorMoney(db, new Date(), 50);
    const later = new Date(Date.now() + 61 * DAY);
    await Promise.all([expireCreditPools(db, later, 500), expireCreditPools(db, later, 500)]);
    expect(await db.activityFundDeposit.count({ where: { sponsorId: paid.sponsorId } })).toBe(1);
    expect(await fundOf(context.organization.id, paid.sponsorId)).toBe(25_000);
    await inTransaction(db, async (tx) => {
      expect(await tx.sponsor.findUniqueOrThrow({ where: { id: paid.sponsorId }, select: { status: true } })).toEqual({ status: 'APPROVED' });
    });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('Sprint 5.3 · un reparto del Fondo de resultado desconocido sale en la consola y se resuelve desde ella; «no salió» lo deja pendiente y la tarea lo termina', async () => {
    const unknown = await team();
    const { later } = await toFund(unknown);
    const { payoutId } = await signedFundPayout(unknown, later);
    const cut = new MockPaycometProvider({ secrets, failSplit: new PaymentProviderError('Conexión cortada', 'MOCK_TIMEOUT', true) });
    expect(await settleSignedFundPayout(db, async () => cut, payoutId, TEST_HMAC_SECRET, later)).toEqual({ status: 'NEEDS_REVIEW' });
    const split = await db.activityFundSplit.findFirstOrThrow({ where: { payoutId } });

    const listed = (await loadSplitsToResolve(db)).find((row) => row.kind === 'FUND' && row.splitId === split.id);
    expect(listed).toMatchObject({ payoutId, amountCents: split.amountCents, organizationSlug: unknown.organization.slug });
    expect(listed?.paycometOrder).toBeTruthy();

    const { actor } = await verifiedSuperadmin(db, new Date(), 'activity_fund.resolve_unknown_split');
    expect(await resolveSplitToResolve(db, actor, { kind: 'FUND', splitId: split.id, splitAuthCode: null }, new Date())).toEqual({ status: 'RESOLVED', done: false });
    expect(await db.activityFundSplit.findUniqueOrThrow({ where: { id: split.id } })).toMatchObject({ status: 'PENDING' });
    expect((await loadSplitsToResolve(db)).some((row) => row.kind === 'FUND' && row.splitId === split.id)).toBe(false);
    expect((await resumeFundPayouts(db, mock, later, 500)).executed).toBeGreaterThanOrEqual(1);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'EXECUTED' });
    // Resuelto: otra resolución no cambia nada.
    expect(await resolveSplitToResolve(db, actor, { kind: 'FUND', splitId: split.id, splitAuthCode: 'S-TARDE' }, new Date())).toEqual({ status: 'NOT_SENDING' });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });
});
