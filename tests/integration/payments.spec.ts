import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignDurationError, publishInitiative } from '@/core/finance/campaign-window';
import { getAccountBalance, getBalancesByAccount, getRaisedFromLedger, getTrialBalance } from '@/core/finance/ledger.service';
import { computeSignatureHash, payoutTargetDigest } from '@/core/security/signature-hash';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadCardToken, tokenizeAndStoreCard } from '@/services/payments/card-tokens';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { PaymentProviderError } from '@/services/payments/payment-provider';
import { resolveUnknownRefund } from '@/services/payments/manual-resolutions';
import { executePendingRefund, refundContribution, RefundNotAllowedError } from '@/services/payments/payment-reversals';
import { approvePayout, executeApprovedPayout, PayoutNotAllowedError, resolveUnknownSplit } from '@/services/payments/split-transfer.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_KEYRING, uniqueId, verifiedSuperadmin } from './test-database';

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración' };
const IP = '10.0.0.1';
const HMAC_SECRET = 'secreto-de-integracion-de-las-firmas-0123456789';
let db: KorumPrismaClient;
let mock: MockPaycometProvider;

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.$disconnect();
});

async function setup(overrides: Parameters<typeof createInitiative>[2] = {}) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
  const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 100_000, ...overrides });
  return { organization, initiative };
}

async function pendingDonation(organizationId: string, initiativeId: number, amountCents = 2_500, guaranteeCents = 0, extra: { groupName?: string; createdAt?: Date; guestEmail?: string } = {}) {
  return db.contribution.create({
    data: {
      organizationId,
      initiativeId,
      fiscalYear: 2026,
      type: 'DONATION',
      amountCents,
      guaranteeContributionCents: guaranteeCents,
      totalChargedCents: amountCents + guaranteeCents,
      paymentMethod: 'BIZUM',
      paycometOrder: uniqueId('ORD'),
      status: 'PENDING',
      guestEmail: `${uniqueId('donante')}@pruebas.example`,
      ...extra
    }
  });
}

const deliver = (kind: 'PAYMENT' | 'REFUND' | 'CHARGEBACK', order: string, amountCents: number, response: 'OK' | 'KO' = 'OK') => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents, response });
  return handlePaymentWebhook(db, mock, rawBody, contentType);
};

async function paidDonation(organizationId: string, initiativeId: number, amountCents = 2_500, guaranteeCents = 0, extra: { groupName?: string; createdAt?: Date; guestEmail?: string } = {}) {
  const contribution = await pendingDonation(organizationId, initiativeId, amountCents, guaranteeCents, extra);
  expect(await deliver('PAYMENT', contribution.paycometOrder!, contribution.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

const counters = (id: number) => db.initiative.findUniqueOrThrow({ where: { id }, select: { raisedCents: true, totalContributions: true, status: true, matchingPoolRemainingCents: true, firstPayinAt: true } });
const statusOf = async (id: number) => (await db.contribution.findUniqueOrThrow({ where: { id } })).status;

describe('QA-P01 · webhooks firmados e idempotentes', () => {
  it('firma inválida: 401, queda como REJECTED y no toca nada de negocio', async () => {
    const { organization, initiative } = await setup();
    const contribution = await pendingDonation(organization.id, initiative.id);
    const forged = new MockPaycometProvider({ secrets: { ...secrets, password: 'la-del-atacante' } }).buildNotification({ kind: 'PAYMENT', order: contribution.paycometOrder!, amountCents: contribution.totalChargedCents });

    expect(await handlePaymentWebhook(db, mock, forged.rawBody, forged.contentType)).toEqual({ status: 401, outcome: 'REJECTED' });
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect(await statusOf(contribution.id)).toBe('PENDING');
    const rejected = await db.webhookEvent.findMany({ where: { status: 'REJECTED', signatureValid: false }, orderBy: { id: 'desc' }, take: 1 });
    expect(rejected[0]?.externalEventId).toMatch(/^rejected:\d{4}-\d{2}-\d{2}T\d{2}:BAD_SIGNATURE$/);
    expect(JSON.stringify(rejected[0]?.payloadJson)).not.toContain(contribution.paycometOrder!);
  });

  it('una firma falsa no puede reservar el identificador de un pago real', async () => {
    const { organization, initiative } = await setup();
    const contribution = await pendingDonation(organization.id, initiative.id);
    const forged = new MockPaycometProvider({ secrets: { ...secrets, password: 'la-del-atacante' } }).buildNotification({ kind: 'PAYMENT', order: contribution.paycometOrder!, amountCents: contribution.totalChargedCents });
    await handlePaymentWebhook(db, mock, forged.rawBody, forged.contentType);
    expect(await deliver('PAYMENT', contribution.paycometOrder!, contribution.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 2_500 });
  });

  it('las firmas inválidas se cuentan sin crear una fila por cada cuerpo distinto', async () => {
    const now = new Date('2031-05-05T10:15:00Z');
    for (const body of ['a=1', 'a=2', 'a=3']) expect(await handlePaymentWebhook(db, mock, body, 'application/x-www-form-urlencoded', now)).toEqual({ status: 401, outcome: 'REJECTED' });
    const rows = await db.webhookEvent.findMany({ where: { externalEventId: { startsWith: 'rejected:2031-05-05T10' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'REJECTED', signatureValid: false, attempts: 3, payloadJson: { reason: 'MALFORMED' } });
  });

  it('dos entregas simultáneas del mismo pago suben los contadores una vez y crean un asiento', async () => {
    const { organization, initiative } = await setup();
    const contribution = await pendingDonation(organization.id, initiative.id, 2_500, 180);
    const results = await Promise.all([deliver('PAYMENT', contribution.paycometOrder!, 2_680), deliver('PAYMENT', contribution.paycometOrder!, 2_680)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['DUPLICATE', 'PROCESSED']);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 2_500, totalContributions: 1 });
    expect(await db.ledgerJournal.count({ where: { contributionId: contribution.id, kind: 'PAYIN_DONATION' } })).toBe(1);
    expect(await db.ledgerJournal.count({ where: { contributionId: contribution.id, kind: 'GATEWAY_FEE' } })).toBe(1);
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(2_500);
    // El recibo se escribe con el asiento y una sola vez, aunque el aviso llegue dos veces a la vez.
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `contribution.receipt:${contribution.id}` } })).toBe(1);
  });

  it('una entrega posterior repetida tampoco hace nada', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id);
    expect(await deliver('PAYMENT', contribution.paycometOrder!, 2_500)).toEqual({ status: 200, outcome: 'DUPLICATE' });
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 2_500, totalContributions: 1 });
  });
});

describe('cobros confirmados', () => {
  it('asienta el cobro y la comisión real, y fija el primer cobro de la ventana de 90 días', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id, 2_500, 180);
    expect(await statusOf(contribution.id)).toBe('COMPLETED');
    expect((await counters(initiative.id)).firstPayinAt).not.toBeNull();
    const balances = Object.fromEntries((await getBalancesByAccount(db, { organizationId: organization.id })).map((row) => [row.account, row.balanceCents]));
    // 1 % de 26,80 € + 0,09 € = 0,36 €.
    expect(balances).toMatchObject({ INITIATIVE_ESCROW: 2_500, KORUM_REVENUE_GUARANTEE: 180, GATEWAY_FEES_EXPENSE: 36, PSP_CLEARING: 2_644 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id }, select: { paycometAuthCode: true } })).toMatchObject({ paycometAuthCode: expect.stringMatching(/^A/) });
  });

  it('un cobro por otro importe del esperado no se acredita: falla y se puede investigar', async () => {
    const { organization, initiative } = await setup();
    const contribution = await pendingDonation(organization.id, initiative.id);
    expect(await deliver('PAYMENT', contribution.paycometOrder!, 1)).toEqual({ status: 500, outcome: 'FAILED' });
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0 });
    expect(await statusOf(contribution.id)).toBe('PENDING');
    const event = await db.webhookEvent.findFirstOrThrow({ where: { payloadJson: { path: ['Order'], equals: contribution.paycometOrder! } } });
    expect(event).toMatchObject({ status: 'FAILED', errorMessage: expect.stringContaining('se esperaban 2500') });
  });

  it('un pedido desconocido falla y Paycomet puede reintentar; al aparecer, se procesa', async () => {
    const { organization, initiative } = await setup();
    const order = uniqueId('ORD');
    expect(await deliver('PAYMENT', order, 2_500)).toEqual({ status: 500, outcome: 'FAILED' });
    await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, amountCents: 2_500, totalChargedCents: 2_500, paymentMethod: 'CARD', paycometOrder: order } });
    expect(await deliver('PAYMENT', order, 2_500)).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 2_500 });
  });

  it('un cobro fallido marca la aportación, sin asiento; si luego se confirma, cuenta', async () => {
    const { organization, initiative } = await setup();
    const contribution = await pendingDonation(organization.id, initiative.id);
    await deliver('PAYMENT', contribution.paycometOrder!, 2_500, 'KO');
    expect(await statusOf(contribution.id)).toBe('FAILED');
    expect(await db.ledgerJournal.count({ where: { contributionId: contribution.id } })).toBe(0);
    await deliver('PAYMENT', contribution.paycometOrder!, 2_500);
    expect(await statusOf(contribution.id)).toBe('COMPLETED');
  });

  it('QA-NOT01 · el recibo sale con el cobro: importes, titular legal y, según la Ley 49/2002, certificado o justificante', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id, 2_500, 180, { groupName: '3º de Primaria', guestEmail: 'madre@pruebas.example' });
    const receipt = await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `contribution.receipt:${contribution.id}` } });
    expect(receipt).toMatchObject({ templateKey: 'contribution.receipt', status: 'PENDING', toAddress: 'madre@pruebas.example', organizationId: organization.id, locale: 'es' });
    expect(receipt.payloadJson).toEqual({ initiativeId: initiative.id, amountCents: 2_500, guaranteeCents: 180, totalCents: 2_680, reference: contribution.paycometOrder, groupName: '3º de Primaria', fiscalCertificate: false });

    const verified = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', ley49: true, ley49VerifiedAt: new Date() });
    const other = await createInitiative(db, verified.id, { status: 'FUNDRAISING', goalCents: 100_000 });
    const certified = await paidDonation(verified.id, other.id);
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `contribution.receipt:${certified.id}` } })).payloadJson).toMatchObject({ fiscalCertificate: true });
  });

  it('QA-NOT01 · una donación de una cuenta se envía al email de la cuenta y en su idioma; sin destinatario no se escribe nada', async () => {
    const { organization, initiative } = await setup();
    const donor = await createUser(db, { locale: 'ca' });
    const withAccount = await pendingDonation(organization.id, initiative.id, 1_000, 0, { guestEmail: undefined });
    await db.contribution.update({ where: { id: withAccount.id }, data: { userId: donor.id, guestEmail: null, locale: 'ca' } });
    expect((await deliver('PAYMENT', withAccount.paycometOrder!, 1_000)).outcome).toBe('PROCESSED');
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `contribution.receipt:${withAccount.id}` } })).toMatchObject({ toAddress: donor.email, userId: donor.id, locale: 'ca' });

    const anonymous = await pendingDonation(organization.id, initiative.id, 1_000);
    await db.contribution.update({ where: { id: anonymous.id }, data: { guestEmail: null } });
    expect((await deliver('PAYMENT', anonymous.paycometOrder!, 1_000)).outcome).toBe('PROCESSED');
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `contribution.receipt:${anonymous.id}` } })).toBe(0);
  });

  it('QA-NOT01 · al lograr la meta se avisa una vez a quienes firman, en el propio flujo del cobro', async () => {
    const { organization, initiative } = await setup({ goalCents: 5_000 });
    const [director, cosigner] = await Promise.all([createUser(db), createUser(db, { locale: 'en' })]);
    await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
    await paidDonation(organization.id, initiative.id, 3_000);
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'initiative.goalReached' } })).toBe(0);

    await paidDonation(organization.id, initiative.id, 3_000);
    await paidDonation(organization.id, initiative.id, 500);
    const notices = await db.outboxMessage.findMany({ where: { organizationId: organization.id, templateKey: 'initiative.goalReached' }, orderBy: { toAddress: 'asc' } });
    expect(notices.map((notice) => notice.userId).sort()).toEqual([director.id, cosigner.id].sort());
    expect(notices.find((notice) => notice.userId === cosigner.id)?.locale).toBe('en');
    expect(notices[0]?.payloadJson).toEqual({ initiativeId: initiative.id });
  });

  it('al cruzar la meta pasa a GOAL_REACHED, y lo que entra después es excedente de la entidad', async () => {
    const { organization, initiative } = await setup({ goalCents: 5_000 });
    await paidDonation(organization.id, initiative.id, 3_000);
    expect((await counters(initiative.id)).status).toBe('FUNDRAISING');
    await paidDonation(organization.id, initiative.id, 3_000);
    expect(await counters(initiative.id)).toMatchObject({ status: 'GOAL_REACHED', raisedCents: 6_000 });
    await paidDonation(organization.id, initiative.id, 500);
    expect(await counters(initiative.id)).toMatchObject({ status: 'GOAL_REACHED', raisedCents: 6_500 });
  });

  it('un cobro que se confirma con la campaña ya cerrada no suma y queda pendiente de devolver entero', async () => {
    const { organization, initiative } = await setup({ status: 'REFUNDING' });
    const contribution = await paidDonation(organization.id, initiative.id, 2_500, 180);
    expect(await statusOf(contribution.id)).toBe('REFUND_PENDING');
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect((await getAccountBalance(db, 'REFUNDS_PAYABLE', { organizationId: organization.id })).balanceCents).toBe(2_680);
    expect(await executePendingRefund(db, mock, contribution.id, IP)).toMatchObject({ refunded: true, outcome: 'REFUNDED' });
    expect((await getAccountBalance(db, 'REFUNDS_PAYABLE', { organizationId: organization.id })).balanceCents).toBe(0);
  });

  it('un cobro confirmado sin código de autorización falla: no se podría devolver ni repartir', async () => {
    const { organization, initiative } = await setup();
    const contribution = await pendingDonation(organization.id, initiative.id);
    const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: contribution.paycometOrder!, amountCents: 2_500, authCode: '' });
    expect(await handlePaymentWebhook(db, mock, rawBody, contentType)).toEqual({ status: 500, outcome: 'FAILED' });
    expect(await statusOf(contribution.id)).toBe('PENDING');
  });

  it('un cobro tardío tras liquidar se asienta y queda para devolver: ni se pierde ni se queda atrapado en la hucha', async () => {
    for (const status of ['CLOSED', 'GOAL_REACHED'] as const) {
      const { organization, initiative } = await setup({ status, goalCents: 2_500, raisedCents: 0 });
      const payout = await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId: initiative.id, destinationType: 'ORGANIZATION', beneficiaryName: 'AFA', beneficiaryIban: 'ES0000000000000000000000', netPaidCents: 2_500, korumFeeSettledCents: 0, status: 'EXECUTED' } });
      const late = await paidDonation(organization.id, initiative.id, 500);
      expect(await statusOf(late.id), status).toBe('REFUND_PENDING');
      expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: initiative.id })).balanceCents).toBe(0);
      expect((await getAccountBalance(db, 'REFUNDS_PAYABLE', { organizationId: organization.id })).balanceCents).toBe(500);
      expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
      expect(payout.status).toBe('EXECUTED');
      expect(await executePendingRefund(db, mock, late.id, IP)).toMatchObject({ refunded: true });
    }
  });

  it('suma al reto del curso', async () => {
    const { organization, initiative } = await setup();
    await db.initiativeCourseProgress.create({ data: { initiativeId: initiative.id, groupName: '3º de Primaria', familiesCount: 4 } });
    await paidDonation(organization.id, initiative.id, 2_500, 0, { groupName: '3º de Primaria' });
    expect((await db.initiativeCourseProgress.findFirstOrThrow({ where: { initiativeId: initiative.id } })).familiesCount).toBe(5);
  });

  it('Matching 2x libera min(donación, bolsa) y suma a la meta', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 100_000, matchingPoolTotalCents: 4_000, matchingPoolRemainingCents: 4_000 });
    const sponsor = await db.sponsor.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, name: 'Comercio', cifEnc: null, contactPerson: 'Persona', phone: '600000000', email: 'c@pruebas.example', sector: 'Comercio', categoryLevel: 'PLATA', tierRank: 2, tierLabel: 'Plata', amountCents: 4_000, feeGeneratedCents: 600, isMatchingPool: true, promo: 'x', code: uniqueId('C'), status: 'APPROVED', expiresAt: new Date('2027-01-01') }
    });
    await db.ledgerJournal.create({
      data: {
        idempotencyKey: uniqueId('pool'),
        kind: 'PAYIN_SPONSOR',
        description: 'Bolsa',
        organizationId: organization.id,
        initiativeId: initiative.id,
        entries: {
          create: [
            { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 4_000, organizationId: organization.id },
            { account: 'MATCHING_POOL', direction: 'CREDIT', amountCents: 4_000, organizationId: organization.id, initiativeId: initiative.id, sponsorId: sponsor.id }
          ]
        }
      }
    });

    const first = await paidDonation(organization.id, initiative.id, 2_500);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 5_000, matchingPoolRemainingCents: 1_500, totalContributions: 1 });
    await paidDonation(organization.id, initiative.id, 2_500);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 9_000, matchingPoolRemainingCents: 0 });
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(9_000);
    await paidDonation(organization.id, initiative.id, 1_000);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 10_000 });

    // Un contracargo de la donación emparejada devuelve su bonus a la bolsa.
    await deliver('CHARGEBACK', first.paycometOrder!, 2_500);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 5_000, matchingPoolRemainingCents: 2_500, totalContributions: 2 });
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(5_000);
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: initiative.id })).balanceCents).toBe(2_500);
  });
});

describe('QA-P02 · reembolso al medio de pago original', () => {
  it('devuelve el 100 % de lo cobrado, con dos asientos que deshacen el cobro', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id, 2_500, 180);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    mock.registerCharge(contribution.paycometOrder!, 2_680);

    expect(await refundContribution(db, mock, contribution.id, IP)).toMatchObject({ refunded: true });
    const stored = await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } });
    expect(mock.calls.at(-1)).toEqual({ operation: 'refund', order: contribution.paycometOrder, amountCents: 2_680, authCode: stored.paycometAuthCode });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).toMatchObject({ status: 'REFUNDED', refundedCents: 2_680 });
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    const balances = Object.fromEntries((await getBalancesByAccount(db, { organizationId: organization.id })).map((row) => [row.account, row.balanceCents]));
    expect(balances).toMatchObject({ INITIATIVE_ESCROW: 0, KORUM_REVENUE_GUARANTEE: 0, REFUNDS_PAYABLE: 0 });
    // Solo queda la comisión de Paycomet, que asume KORUM como garantía de devolución.
    expect(balances.PSP_CLEARING).toBe(-36);
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(0);
    // El aviso de devolución sale con el asiento y por el importe total devuelto, voluntaria incluida (QA-NOT01).
    const notice = await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `refund.issued:${contribution.id}` } });
    expect(notice).toMatchObject({ templateKey: 'refund.issued', status: 'PENDING', toAddress: contribution.guestEmail });
    expect(notice.payloadJson).toEqual({ initiativeId: initiative.id, amountCents: 2_680 });
  });

  it('repetirlo no devuelve dos veces; el aviso posterior del webhook tampoco', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    await refundContribution(db, mock, contribution.id, IP);
    const calls = mock.calls.length;
    expect(await refundContribution(db, mock, contribution.id, IP)).toEqual({ refunded: false, outcome: 'ALREADY_REFUNDED' });
    expect(mock.calls.length).toBe(calls);
    expect((await deliver('REFUND', contribution.paycometOrder!, 2_500)).status).toBe(200);
    expect(await db.ledgerJournal.count({ where: { contributionId: contribution.id, kind: 'ESCROW_REFUND_DONOR' } })).toBe(2);
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `refund.issued:${contribution.id}` } })).toBe(1);
  });

  it('si Paycomet la rechaza, sigue pendiente, queda auditado y se puede reintentar', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CANCELLED' } });
    const failing = new MockPaycometProvider({ secrets, failRefund: new PaymentProviderError('rechazado', '130') });
    expect(await refundContribution(db, failing, contribution.id, IP)).toEqual({ refunded: false, outcome: 'REJECTED', code: '130' });
    expect(await statusOf(contribution.id)).toBe('REFUND_PENDING');
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0 });
    expect(await db.auditLog.count({ where: { action: 'payment.refund_rejected', targetId: String(contribution.id) } })).toBe(1);
    expect(await refundContribution(db, mock, contribution.id, IP)).toMatchObject({ refunded: true });
    expect(await statusOf(contribution.id)).toBe('REFUNDED');
  });

  it('tras un corte de conexión nunca se vuelve a pedir a ciegas: espera a la notificación o a una persona', async () => {
    const { organization, initiative } = await setup();
    const viaWebhook = await paidDonation(organization.id, initiative.id);
    const viaPerson = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CANCELLED' } });
    const cut = new MockPaycometProvider({ secrets, failRefund: new PaymentProviderError('corte', 'NETWORK', true) });
    expect(await refundContribution(db, cut, viaWebhook.id, IP)).toEqual({ refunded: false, outcome: 'UNKNOWN', code: 'NETWORK' });
    expect(await refundContribution(db, cut, viaPerson.id, IP)).toMatchObject({ outcome: 'UNKNOWN' });

    const retry = new MockPaycometProvider({ secrets });
    expect(await refundContribution(db, retry, viaWebhook.id, IP)).toEqual({ refunded: false, outcome: 'IN_PROGRESS' });
    expect(retry.calls).toHaveLength(0);

    // Llega la confirmación: sí se hizo.
    expect((await deliver('REFUND', viaWebhook.paycometOrder!, 2_500)).status).toBe(200);
    expect(await statusOf(viaWebhook.id)).toBe('REFUNDED');

    // Una persona comprueba que no se hizo: se puede volver a pedir, y queda en la auditoría.
    const { actor: person } = await verifiedSuperadmin(db);
    await resolveUnknownRefund(db, person, viaPerson.id, { refunded: false });
    await expect(resolveUnknownRefund(db, person, viaPerson.id, { refunded: true })).rejects.toBeInstanceOf(RefundNotAllowedError);
    expect(await refundContribution(db, retry, viaPerson.id, IP)).toMatchObject({ refunded: true });
    expect(retry.calls).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: 'payment.refund_resolved', targetId: String(viaPerson.id) } })).toBe(1);
  });

  it('dos ejecuciones simultáneas piden la devolución una sola vez', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CANCELLED' } });
    const shared = new MockPaycometProvider({ secrets });
    const results = await Promise.all([refundContribution(db, shared, contribution.id, IP), refundContribution(db, shared, contribution.id, IP)]);
    expect(results.filter((result) => result.refunded)).toHaveLength(1);
    expect(shared.calls).toHaveLength(1);
    expect(await statusOf(contribution.id)).toBe('REFUNDED');
  });

  it('una devolución que Paycomet confirma como fallida se puede volver a pedir', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CANCELLED' } });
    const cut = new MockPaycometProvider({ secrets, failRefund: new PaymentProviderError('corte', 'NETWORK', true) });
    await refundContribution(db, cut, contribution.id, IP);

    // El aviso atrasado de un intento anterior no libera la reserva del intento en curso.
    const stale = mock.buildNotification({ kind: 'REFUND', order: contribution.paycometOrder!, amountCents: 2_500, response: 'KO', bankDateTime: '20200101000000' });
    await handlePaymentWebhook(db, mock, stale.rawBody, stale.contentType);
    expect(await refundContribution(db, mock, contribution.id, IP)).toEqual({ refunded: false, outcome: 'IN_PROGRESS' });

    const failed = mock.buildNotification({ kind: 'REFUND', order: contribution.paycometOrder!, amountCents: 2_500, response: 'KO', bankDateTime: '20991231000000' });
    await handlePaymentWebhook(db, mock, failed.rawBody, failed.contentType);
    expect(await refundContribution(db, mock, contribution.id, IP)).toMatchObject({ refunded: true });
  });

  it('los patrocinios no se reembolsan por esta vía: se reasignan', async () => {
    const { organization, initiative } = await setup({ status: 'REFUNDING' });
    const sponsorship = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'SPONSORSHIP', amountCents: 2_500, totalChargedCents: 2_875, paymentMethod: 'CARD', paycometOrder: uniqueId('ORD'), paycometAuthCode: 'A', status: 'COMPLETED' } });
    await expect(refundContribution(db, mock, sponsorship.id, IP)).rejects.toThrow(/SPONSORSHIP/);
  });

  it('no se reembolsa una campaña que sigue recaudando', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id);
    await expect(refundContribution(db, mock, contribution.id, IP)).rejects.toBeInstanceOf(RefundNotAllowedError);
    expect(await statusOf(contribution.id)).toBe('COMPLETED');
  });

  it('un reembolso hecho desde el panel de Paycomet se refleja igual; uno parcial se revisa a mano', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id, 2_500, 180);
    expect((await deliver('REFUND', contribution.paycometOrder!, 100)).status).toBe(500);
    expect(await statusOf(contribution.id)).toBe('COMPLETED');
    expect((await deliver('REFUND', contribution.paycometOrder!, 2_680)).status).toBe(200);
    expect(await statusOf(contribution.id)).toBe('REFUNDED');
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0 });
  });

  it('un reembolso desde el panel de Paycomet tras liquidar lo asume KORUM y se refleja', async () => {
    const { organization, initiative } = await setup({ goalCents: 2_500 });
    const contribution = await paidDonation(organization.id, initiative.id);
    await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId: initiative.id, destinationType: 'ORGANIZATION', beneficiaryName: 'AFA', beneficiaryIban: 'ES0000000000000000000000', netPaidCents: 2_500, korumFeeSettledCents: 0, status: 'EXECUTED' } });
    expect((await deliver('REFUND', contribution.paycometOrder!, 2_500)).status).toBe(200);
    expect(await statusOf(contribution.id)).toBe('REFUNDED');
    expect((await getAccountBalance(db, 'CHARGEBACK_LOSSES', { organizationId: organization.id })).balanceCents).toBe(2_500);
    expect(await db.auditLog.count({ where: { action: 'payment.refund_after_settlement', targetId: String(contribution.id) } })).toBe(1);
  });
});

describe('QA-P04 · contracargos y publicación', () => {
  it('antes de liquidar: asiento, estado CHARGEBACK y progreso recalculado; vuelve a recaudar si baja de la meta', async () => {
    const { organization, initiative } = await setup({ goalCents: 2_500 });
    const contribution = await paidDonation(organization.id, initiative.id, 2_500, 180);
    expect((await counters(initiative.id)).status).toBe('GOAL_REACHED');
    expect(await deliver('CHARGEBACK', contribution.paycometOrder!, 2_680)).toMatchObject({ status: 200 });
    expect(await statusOf(contribution.id)).toBe('CHARGEBACK');
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0, totalContributions: 0, status: 'FUNDRAISING' });
    expect(await db.ledgerJournal.count({ where: { contributionId: contribution.id, kind: 'CHARGEBACK' } })).toBe(1);
    expect((await getAccountBalance(db, 'KORUM_REVENUE_GUARANTEE', { organizationId: organization.id })).balanceCents).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'payment.chargeback', targetId: String(contribution.id) } })).toBe(1);
  });

  it('un contracargo repetido no descuenta dos veces', async () => {
    const { organization, initiative } = await setup();
    const contribution = await paidDonation(organization.id, initiative.id);
    await paidDonation(organization.id, initiative.id);
    await deliver('CHARGEBACK', contribution.paycometOrder!, 2_500);
    await deliver('CHARGEBACK', contribution.paycometOrder!, 2_500);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 2_500, totalContributions: 1 });
  });

  it('después de devolver lo asume KORUM; con la devolución pendiente, no se devuelve también', async () => {
    const { organization, initiative } = await setup();
    const refunded = await paidDonation(organization.id, initiative.id);
    const pending = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    await refundContribution(db, mock, refunded.id, IP);
    await refundContribution(db, new MockPaycometProvider({ secrets, failRefund: new PaymentProviderError('caído', 'DOWN') }), pending.id, IP);

    await deliver('CHARGEBACK', refunded.paycometOrder!, 2_500);
    expect((await getAccountBalance(db, 'CHARGEBACK_LOSSES', { organizationId: organization.id })).balanceCents).toBe(2_500);
    await deliver('CHARGEBACK', pending.paycometOrder!, 2_500);
    expect(await statusOf(pending.id)).toBe('CHARGEBACK');
    expect((await getAccountBalance(db, 'REFUNDS_PAYABLE', { organizationId: organization.id })).balanceCents).toBe(0);
    await expect(executePendingRefund(db, mock, pending.id, IP)).rejects.toBeInstanceOf(RefundNotAllowedError);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 0 });
  });

  it('rechaza publicar una campaña más larga que maxCampaignDays y no reserva cupos', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 100_000 });
    const now = new Date('2026-11-01T00:00:00Z');
    const tooLong = await createInitiative(db, organization.id, { closesAt: new Date('2027-01-15T00:00:00Z'), defaultExemptAppliedCents: 100_000 });
    await expect(publishInitiative(db, tooLong.id, now)).rejects.toBeInstanceOf(CampaignDurationError);
    expect(await db.initiative.findUniqueOrThrow({ where: { id: tooLong.id }, select: { status: true, quotaReservedAt: true } })).toEqual({ status: 'BUDGETING', quotaReservedAt: null });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(100_000);
  });

  it('publica una campaña válida, reserva sus cupos y repetirlo no hace nada', async () => {
    const organization = await createOrganization(db, { exemptRemainingCents: 100_000 });
    const now = new Date('2026-11-01T00:00:00Z');
    const initiative = await createInitiative(db, organization.id, { closesAt: new Date('2026-12-20T00:00:00Z'), defaultExemptAppliedCents: 60_000 });
    expect(await publishInitiative(db, initiative.id, now)).toEqual({ published: true });
    expect(await publishInitiative(db, initiative.id, now)).toEqual({ published: false });
    expect((await counters(initiative.id)).status).toBe('FUNDRAISING');
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(40_000);
  });
});

describe('liquidación con doble firma y reparto cobro a cobro', () => {
  const now = new Date('2026-11-10T00:00:00Z');

  /** Campaña lograda: 3 cobros de 10 € (30 €) = neto 27 € + comisión 2 € + pasarela 1 €. */
  async function reachedCampaign(options: { sign?: Array<'DIRECTOR' | 'COSIGNER'>; sameSigner?: boolean; destinationType?: 'ORGANIZATION' | 'PROVIDER'; chargedAt?: Date } = {}) {
    const { organization, initiative } = await setup({ goalCents: 3_000, bracketFeeCents: 200, gatewayFeeCents: 100 });
    const createdAt = options.chargedAt ?? new Date('2026-11-01T00:00:00Z');
    const charges = [];
    for (let i = 0; i < 3; i += 1) charges.push(await paidDonation(organization.id, initiative.id, 1_000, 0, { createdAt }));
    const payout = await db.escrowPayout.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, destinationType: options.destinationType ?? 'ORGANIZATION', beneficiaryName: 'AFA', beneficiaryIban: 'ES0000000000000000000000', netPaidCents: 2_700, korumFeeSettledCents: 200 }
    });
    const signer = await createUser(db);
    for (const role of options.sign ?? ['DIRECTOR', 'COSIGNER']) {
      const user = options.sameSigner ? signer : await createUser(db);
      const membership = await db.organizationMember.create({ data: { organizationId: organization.id, userId: user.id, role } });
      const signedAt = new Date('2026-11-09T10:00:00.000Z');
      const signatureHash = computeSignatureHash(HMAC_SECRET, { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: payoutTargetDigest(HMAC_SECRET, payout, organization.paycometSplitId), signerUserId: user.id, signerRole: role, membershipId: membership.id, signedAt, otpVerifiedAt: signedAt });
      await db.doubleCheckSignature.create({ data: { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: user.id, signerRole: role, signatureHash, otpVerifiedAt: signedAt, signedAt } });
    }
    return { organization, initiative, payout, charges };
  }

  it('sin las dos firmas de dos personas distintas no se aprueba ni mueve dinero', async () => {
    const single = await reachedCampaign({ sign: ['DIRECTOR'] });
    await expect(approvePayout(db, single.payout.id, HMAC_SECRET, now)).rejects.toBeInstanceOf(PayoutNotAllowedError);
    expect(await db.escrowPayout.findUniqueOrThrow({ where: { id: single.payout.id } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: single.initiative.id })).balanceCents).toBe(3_000);

    const same = await reachedCampaign({ sameSigner: true });
    await expect(approvePayout(db, same.payout.id, HMAC_SECRET, now)).rejects.toThrow(/dos personas distintas/);
  });

  it('una persona con los dos roles y una tercera fila no suman dos firmas', async () => {
    const { organization, payout } = await reachedCampaign({ sameSigner: true });
    const third = await createUser(db);
    await db.doubleCheckSignature.create({ data: { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: third.id, signerRole: 'GATEKEEPER', signatureHash: uniqueId('h') } });
    await expect(approvePayout(db, payout.id, HMAC_SECRET, now)).rejects.toThrow(/dos personas distintas/);
  });

  describe('QA-SEC03 · las firmas se verifican al aprobar', () => {
    const rejected = async (payoutId: number, reason: string) => {
      await expect(approvePayout(db, payoutId, HMAC_SECRET, now)).rejects.toThrow(reason);
      expect(await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });
      expect(await db.escrowPayoutSplit.count({ where: { payoutId } })).toBe(0);
    };

    it('una firma editada a mano no vale y queda en la auditoría', async () => {
      const { organization, payout } = await reachedCampaign();
      const row = await db.doubleCheckSignature.findFirstOrThrow({ where: { payoutId: payout.id, signerRole: 'COSIGNER' } });
      await db.doubleCheckSignature.update({ where: { id: row.id }, data: { signedAt: new Date('2026-11-09T11:00:00.000Z') } });
      await rejected(payout.id, 'HASH_MISMATCH');
      expect(await db.auditLog.count({ where: { action: 'payout.signatures_rejected', organizationId: organization.id, targetId: String(payout.id) } })).toBe(1);
    });

    it('una firma sin OTP no vale', async () => {
      const { payout } = await reachedCampaign();
      await db.doubleCheckSignature.updateMany({ where: { payoutId: payout.id, signerRole: 'DIRECTOR' }, data: { otpVerifiedAt: null } });
      await rejected(payout.id, 'OTP_MISSING');
    });

    it('si cambia el importe neto, las firmas dejan de valer', async () => {
      const { payout } = await reachedCampaign();
      await db.escrowPayout.update({ where: { id: payout.id }, data: { netPaidCents: 2_699 } });
      await rejected(payout.id, 'HASH_MISMATCH');
    });

    it('si cambia la cuenta destino antes de aprobar, las firmas dejan de valer', async () => {
      const { organization, payout } = await reachedCampaign();
      await db.organization.update({ where: { id: organization.id }, data: { paycometSplitId: uniqueId('split-nueva') } });
      await rejected(payout.id, 'HASH_MISMATCH');
    });

    it('si un firmante pierde su rol, su firma deja de valer', async () => {
      const { organization, payout } = await reachedCampaign();
      const row = await db.doubleCheckSignature.findFirstOrThrow({ where: { payoutId: payout.id, signerRole: 'COSIGNER' } });
      await db.organizationMember.deleteMany({ where: { organizationId: organization.id, userId: row.signerUserId } });
      await rejected(payout.id, 'ROLE_LOST');
    });

    it('una firma no revive al devolver el rol a quien lo perdió', async () => {
      const { organization, payout } = await reachedCampaign();
      const row = await db.doubleCheckSignature.findFirstOrThrow({ where: { payoutId: payout.id, signerRole: 'COSIGNER' } });
      await db.organizationMember.deleteMany({ where: { organizationId: organization.id, userId: row.signerUserId } });
      await db.organizationMember.create({ data: { organizationId: organization.id, userId: row.signerUserId, role: 'COSIGNER' } });
      await rejected(payout.id, 'HASH_MISMATCH');
    });

    it('con otro secreto no se puede dar por buena ninguna firma', async () => {
      const { payout } = await reachedCampaign();
      await expect(approvePayout(db, payout.id, `${HMAC_SECRET}-otro`, now)).rejects.toThrow('HASH_MISMATCH');
    });
  });

  it('no vale una firma de otra entidad ni de otro tipo de aprobación', async () => {
    const { payout } = await reachedCampaign({ sign: ['DIRECTOR'] });
    const other = await createOrganization(db);
    const outsider = await createUser(db);
    await db.doubleCheckSignature.create({ data: { organizationId: other.id, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: outsider.id, signerRole: 'COSIGNER', signatureHash: uniqueId('h') } });
    await expect(approvePayout(db, payout.id, HMAC_SECRET, now)).rejects.toThrow(/dos personas distintas/);
  });

  it('una entidad sin verificar o archivada no cobra', async () => {
    const pending = await reachedCampaign();
    await db.organization.update({ where: { id: pending.organization.id }, data: { kybStatus: 'PENDING' } });
    await expect(approvePayout(db, pending.payout.id, HMAC_SECRET, now)).rejects.toThrow(/KYB/);

    const archived = await reachedCampaign();
    await approvePayout(db, archived.payout.id, HMAC_SECRET, now);
    await db.organization.update({ where: { id: archived.organization.id }, data: { archivedAt: now } });
    await expect(executeApprovedPayout(db, mock, archived.payout.id, now)).rejects.toThrow(/archivada/);
  });

  it('la cuenta destino se fija al aprobar: cambiarla después no desvía los repartos', async () => {
    const { organization, payout } = await reachedCampaign();
    const approvedAccount = (await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).paycometSplitId;
    await approvePayout(db, payout.id, HMAC_SECRET, now);
    await db.organization.update({ where: { id: organization.id }, data: { paycometSplitId: uniqueId('split-nueva') } });
    const provider = new MockPaycometProvider({ secrets });
    await executeApprovedPayout(db, provider, payout.id, now);
    expect(new Set(provider.calls.map((call) => call.splitId))).toEqual(new Set([approvedAccount]));
  });

  it('QA-P02 · el reparto va a la cuenta destino de la entidad: el IBAN guardado no interviene', async () => {
    const { organization, payout, charges } = await reachedCampaign();
    await approvePayout(db, payout.id, HMAC_SECRET, now);
    const provider = new MockPaycometProvider({ secrets });
    await executeApprovedPayout(db, provider, payout.id, now);
    const account = (await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).paycometSplitId;
    expect(JSON.stringify(provider.calls)).not.toContain('ES0000000000000000000000');
    expect(provider.calls.every((call) => call.splitId === account && charges.some((charge) => charge.paycometOrder === call.order))).toBe(true);
  });

  it('pagar directamente a un proveedor no existe hasta que lo confirme Paycomet', async () => {
    const { payout } = await reachedCampaign({ destinationType: 'PROVIDER' });
    await expect(approvePayout(db, payout.id, HMAC_SECRET, now)).rejects.toThrow(/pendiente de confirmar con Paycomet/);
  });

  it('una ejecución sin aprobar se niega', async () => {
    const { payout } = await reachedCampaign();
    await expect(executeApprovedPayout(db, mock, payout.id, now)).rejects.toBeInstanceOf(PayoutNotAllowedError);
  });

  it('aprueba, reparte cobro a cobro hasta el neto exacto y deja el libro cuadrado', async () => {
    const { organization, initiative, payout, charges } = await reachedCampaign();
    expect(await approvePayout(db, payout.id, HMAC_SECRET, now)).toEqual({ approved: true, splits: 3 });
    expect(await approvePayout(db, payout.id, HMAC_SECRET, now)).toEqual({ approved: false, splits: 0 });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: initiative.id })).balanceCents).toBe(0);
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(3_000);

    expect(await executeApprovedPayout(db, mock, payout.id, now)).toEqual({ status: 'EXECUTED', doneCents: 2_700 });
    const sent = mock.calls.filter((call) => call.operation === 'split' && charges.some((charge) => charge.paycometOrder === call.order));
    expect(sent.map((call) => call.amountCents)).toEqual([1_000, 1_000, 700]);
    expect(await db.escrowPayout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: 'EXECUTED', paycometTransferId: expect.stringMatching(/^S/) });
    const balances = Object.fromEntries((await getBalancesByAccount(db, { organizationId: organization.id })).map((row) => [row.account, row.balanceCents]));
    expect(balances).toMatchObject({ ORG_PAYABLE: 0, KORUM_REVENUE_BRACKET: 200, GATEWAY_FEES_RECOVERED: 100 });

    const calls = mock.calls.length;
    expect(await executeApprovedPayout(db, mock, payout.id, now)).toEqual({ status: 'EXECUTED', doneCents: 2_700 });
    expect(mock.calls.length).toBe(calls);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('no se aprueba si los cobros ya no caben en la ventana de 90 días', async () => {
    const { payout } = await reachedCampaign({ chargedAt: new Date('2026-01-01T00:00:00Z') });
    await expect(approvePayout(db, payout.id, HMAC_SECRET, now)).rejects.toThrow(/ventana de 90 días/);
    expect(await db.escrowPayout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });
  });

  it('un contracargo tras aprobar lo asume KORUM; uno antes hace que la aprobación se niegue', async () => {
    const before = await reachedCampaign();
    await deliver('CHARGEBACK', before.charges[0]!.paycometOrder!, 1_000);
    await expect(approvePayout(db, before.payout.id, HMAC_SECRET, now)).rejects.toThrow(/no ha alcanzado la meta/);

    const after = await reachedCampaign();
    await approvePayout(db, after.payout.id, HMAC_SECRET, now);
    await deliver('CHARGEBACK', after.charges[0]!.paycometOrder!, 1_000);
    expect((await getAccountBalance(db, 'CHARGEBACK_LOSSES', { organizationId: after.organization.id })).balanceCents).toBe(1_000);
    expect(await getRaisedFromLedger(db, after.initiative.id)).toBe(3_000);
  });

  it('un contracargo con la liquidación fallida no toca la hucha vacía: lo asume KORUM', async () => {
    const { organization, initiative, payout, charges } = await reachedCampaign();
    await approvePayout(db, payout.id, HMAC_SECRET, now);
    const firstOrder = charges[0]!.paycometOrder!;
    const rejecting = new MockPaycometProvider({ secrets, failSplit: (order) => (order === firstOrder ? new PaymentProviderError('rechazado', '130') : null) });
    expect(await executeApprovedPayout(db, rejecting, payout.id, now)).toMatchObject({ status: 'FAILED' });
    await deliver('CHARGEBACK', charges[2]!.paycometOrder!, 1_000);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: initiative.id })).balanceCents).toBe(0);
    expect((await getAccountBalance(db, 'CHARGEBACK_LOSSES', { organizationId: organization.id })).balanceCents).toBe(1_000);
    expect(await counters(initiative.id)).toMatchObject({ raisedCents: 3_000, status: 'GOAL_REACHED' });
  });

  it('un reparto de un cobro que ya no vale no se envía y queda para revisión', async () => {
    const { payout, charges } = await reachedCampaign();
    await approvePayout(db, payout.id, HMAC_SECRET, now);
    await deliver('CHARGEBACK', charges[0]!.paycometOrder!, 1_000);
    const provider = new MockPaycometProvider({ secrets });
    expect(await executeApprovedPayout(db, provider, payout.id, now)).toMatchObject({ status: 'NEEDS_REVIEW' });
    expect(provider.calls.map((call) => call.order)).not.toContain(charges[0]!.paycometOrder);
  });

  it('un error definitivo se puede reintentar sin repetir lo ya hecho', async () => {
    const { payout, charges } = await reachedCampaign();
    await approvePayout(db, payout.id, HMAC_SECRET, now);
    const secondOrder = charges[1]!.paycometOrder!;
    const flaky = new MockPaycometProvider({ secrets, failSplit: (order) => (order === secondOrder ? new PaymentProviderError('rechazado', '130') : null) });
    expect(await executeApprovedPayout(db, flaky, payout.id, now)).toEqual({ status: 'FAILED', doneCents: 1_000 });
    expect(await db.escrowPayout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: 'FAILED' });

    const healthy = new MockPaycometProvider({ secrets });
    expect(await executeApprovedPayout(db, healthy, payout.id, now)).toEqual({ status: 'EXECUTED', doneCents: 2_700 });
    expect(healthy.calls.map((call) => call.order)).not.toContain(charges[0]!.paycometOrder);
  });

  it('un corte de conexión nunca se reenvía a ciegas: espera a que una persona compruebe qué pasó', async () => {
    const { payout, charges } = await reachedCampaign();
    await approvePayout(db, payout.id, HMAC_SECRET, now);
    const firstOrder = charges[0]!.paycometOrder!;
    const cut = new MockPaycometProvider({ secrets, failSplit: (order) => (order === firstOrder ? new PaymentProviderError('corte', 'NETWORK', true) : null) });
    expect(await executeApprovedPayout(db, cut, payout.id, now)).toEqual({ status: 'NEEDS_REVIEW', doneCents: 0 });

    const retry = new MockPaycometProvider({ secrets });
    const result = await executeApprovedPayout(db, retry, payout.id, now);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(retry.calls.map((call) => call.order)).not.toContain(firstOrder);

    const unknown = await db.escrowPayoutSplit.findFirstOrThrow({ where: { payoutId: payout.id, status: 'SENDING' } });
    const { actor: person } = await verifiedSuperadmin(db, now);
    await expect(resolveUnknownSplit(db, person, unknown.id, { splitAuthCode: '  ' }, now)).rejects.toThrow(/vacío/);
    await resolveUnknownSplit(db, person, unknown.id, { splitAuthCode: 'S-COMPROBADO' }, now);
    expect(await executeApprovedPayout(db, retry, payout.id, now)).toEqual({ status: 'EXECUTED', doneCents: 2_700 });
    expect(retry.calls.map((call) => call.order)).not.toContain(firstOrder);
    expect(await db.auditLog.count({ where: { action: 'payout.split_resolved', targetId: String(unknown.id) } })).toBe(1);
    await expect(resolveUnknownSplit(db, person, unknown.id, { splitAuthCode: null }, now)).rejects.toBeInstanceOf(PayoutNotAllowedError);
    expect(await db.escrowPayoutSplit.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ status: 'DONE' });
  });

  it('dos ejecuciones simultáneas no envían dos veces el mismo reparto', async () => {
    const { payout, charges } = await reachedCampaign();
    await approvePayout(db, payout.id, HMAC_SECRET, now);
    const shared = new MockPaycometProvider({ secrets });
    await Promise.all([executeApprovedPayout(db, shared, payout.id, now), executeApprovedPayout(db, shared, payout.id, now)]);
    for (const charge of charges) expect(shared.calls.filter((call) => call.order === charge.paycometOrder).length).toBeLessThanOrEqual(1);
    expect(shared.calls.reduce((total, call) => total + call.amountCents, 0)).toBe(2_700);
    expect((await db.escrowPayout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('EXECUTED');
  });
});

describe('aislamiento entre entidades', () => {
  it('un cobro de una entidad no toca a otra', async () => {
    const a = await setup();
    const b = await setup();
    await paidDonation(a.organization.id, a.initiative.id);
    expect(await counters(b.initiative.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect(await getBalancesByAccount(db, { organizationId: b.organization.id })).toEqual([]);
  });
});

describe('tarjetas tokenizadas', () => {
  it('se guardan cifradas y se recuperan para cobrar; solo su propietario; una revocada no se usa', async () => {
    const encryption = TEST_KEYRING;
    const owner = await createUser(db);
    const stranger = await createUser(db);
    const { paymentMethodTokenId } = await tokenizeAndStoreCard(db, mock, { jetToken: 'jet-de-prueba', userId: owner.id, brand: 'VISA', last4: '4242' }, encryption);
    const row = await db.paymentMethodToken.findUniqueOrThrow({ where: { id: paymentMethodTokenId } });
    const expected = await mock.tokenizeCard({ jetToken: 'jet-de-prueba' });
    expect(row.tokenUserEnc).not.toContain(expected.tokenUser);
    expect(row.idUserEnc).not.toContain(String(expected.idUser));
    expect(await loadCardToken(db, paymentMethodTokenId, { userId: owner.id }, encryption)).toEqual(expected);
    await expect(loadCardToken(db, paymentMethodTokenId, { userId: stranger.id }, encryption)).rejects.toThrow();
    await expect(loadCardToken(db, paymentMethodTokenId, { userId: '' }, encryption)).rejects.toThrow(/propietario/);
    await expect(loadCardToken(db, paymentMethodTokenId, { userId: undefined as unknown as string }, encryption)).rejects.toThrow(/propietario/);
    await db.paymentMethodToken.update({ where: { id: paymentMethodTokenId }, data: { revokedAt: new Date() } });
    await expect(loadCardToken(db, paymentMethodTokenId, { userId: owner.id }, encryption)).rejects.toThrow(/revocada/);
  });
});
