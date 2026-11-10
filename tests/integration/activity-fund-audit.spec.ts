import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance, getTrialBalance } from '@/core/finance/ledger.service';
import { completeSignature, DoubleCheckNotAllowedError } from '@/core/security/double-check.service';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { SessionActor } from '@/repositories/tenant-guard';
import { startSponsorship } from '@/services/checkout/sponsorship.service';
import { executeFundPayout, resumeFundPayouts, retryFundPayout, settleSignedFundPayout } from '@/services/payments/activity-fund-payout.service';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { PaymentProviderError } from '@/services/payments/payment-provider';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { cancelFundPayout, requestFundPayout, requestFundSignature } from '@/services/sponsors/activity-fund.service';
import { checkActivityFunds } from '@/services/sponsors/activity-fund-sweeps';
import { approveSponsor } from '@/services/sponsors/sponsor-moderation.service';
import { expireCreditPools, sweepSponsorMoney } from '@/services/sponsors/sponsor-sweeps';
import { createInitiative, createOrganization, createTestClient, createUser, table, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 4.2f · correcciones de las auditorías del War Room sobre el Fondo de actividades, contra PostgreSQL real: aprobación y contracargo simultáneos
 * (financiera B1), repartos que reintentar no arregla (I1), liquidaciones firmadas que no se pudieron aprobar (I2) y aisladas entre sí (I3), cobros fuera
 * de su ventana (M4), y los ataques de la auditoría de seguridad (cuenta destino cambiada, cargo perdido, misma bandeja, otra entidad, Super-Admin,
 * triggers y límite de peticiones).
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const DAY = 86_400_000;
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-auditoría-fondo' };
const invoicing = { issuerTaxId: 'A58818501', issuerName: 'KORUM Pruebas, S.L.', keyring: TEST_KEYRING };
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

// Rango propio (172.80.x.x): el límite de intentos agrupa por subred /24 y la base se comparte con otras pruebas de checkout.
const freshIp = () => {
  ipSequence += 1;
  return `172.${80 + (Math.floor(ipSequence / 250) % 10)}.${ipSequence % 250}.9`;
};
const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true });

async function team(emails?: { director: string; cosigner: string }) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', sponsorRenewalRule: 'SOONEST' });
  createdOrganizations.push(organization.id);
  const origin = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, title: 'Toldos para el patio' });
  const director = await createUser(db, { twoFactorEnabled: true, ...(emails ? { email: emails.director } : {}) });
  const cosigner = await createUser(db, { twoFactorEnabled: true, ...(emails ? { email: emails.cosigner } : {}) });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, origin, director: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]), cosigner: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }]) };
}
type Team = Awaited<ReturnType<typeof team>>;

const deliver = (kind: 'PAYMENT' | 'CHARGEBACK', order: string, amountCents: number) => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET, invoicing, documentsSecret: TEST_HMAC_SECRET });
};

/** Un comercio admitido cuya campaña fracasa y cuya bolsa vence: su dinero pasa al Fondo. */
async function toFund(context: Team) {
  const result = await startSponsorship(
    { db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET },
    { orgSlug: context.organization.slug, initiativeId: context.origin.id, locale: 'es', method: 'CARD', tierCents: 25_000, matchingPool: false, businessName: 'Papelería Nube', taxId: 'B-12345674', contactPerson: 'Iván Sanz', phone: '600 44 55 66', email: 'ivan@nube.example', sector: 'Papelería', promo: '10 %', promoCode: 'nube10', autoRenew: true },
    { session: null, ip: freshIp() }
  );
  if (result.status !== 'REDIRECT') throw new Error(result.status);
  const order = new URL(result.url, 'http://localhost').searchParams.get('pedido')!;
  const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
  await deliver('PAYMENT', order, contribution.totalChargedCents);
  await approveSponsor(db, context.director, context.organization.id, { sponsorId: contribution.sponsorId! }, { hmacSecret: TEST_HMAC_SECRET });
  await db.initiative.update({ where: { id: context.origin.id }, data: { status: 'REFUNDING' } });
  await sweepSponsorMoney(db, new Date(), 50);
  const later = new Date(Date.now() + 61 * DAY);
  await expireCreditPools(db, later, 500);
  return { contribution, later };
}

async function linkFor(userId: string) {
  const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId }, orderBy: { id: 'desc' } });
  return message.payloadJson as { token: string; otp: string };
}

/** Pide la liquidación y la firman las dos personas (sin aprobarla todavía). */
async function signed(context: Team, at: Date) {
  const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, at);
  await completeSignature(db, TEST_HMAC_SECRET, context.director, await linkFor(context.director.userId), at);
  expect(await completeSignature(db, TEST_HMAC_SECRET, context.cosigner, await linkFor(context.cosigner.userId), at)).toMatchObject({ status: 'SIGNED', complete: true });
  return payoutId;
}

const fundOf = async (organizationId: string, sponsorId: number) => (await getAccountBalance(db, 'ORG_ACTIVITY_FUND', { organizationId, sponsorId })).balanceCents;

describe('Auditoría financiera del 4.2f', () => {
  it('B1 · aprobar y un contracargo a la vez nunca dejan el Fondo en negativo ni el libro descuadrado', async () => {
    for (let run = 0; run < 3; run += 1) {
      const context = await team();
      const { contribution, later } = await toFund(context);
      const payoutId = await signed(context, later);
      const [settlement] = await Promise.all([
        settleSignedFundPayout(db, async () => mock, payoutId, TEST_HMAC_SECRET, later).catch(() => null),
        deliver('CHARGEBACK', contribution.paycometOrder!, contribution.totalChargedCents)
      ]);
      expect(await fundOf(context.organization.id, contribution.sponsorId!)).toBeGreaterThanOrEqual(0);
      const payout = await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } });
      // O se aprobó antes (y el contracargo es pérdida de KORUM) o el contracargo llegó antes (y la liquidación se anula o sigue esperando).
      if (payout.status === 'CANCELLED') expect(payout.cancelReason).toBe('FUND_CHANGED');
      expect(['EXECUTED', 'PROCESSING', 'CANCELLED', 'PENDING_DOUBLE_CHECK']).toContain(payout.status);
      expect(settlement === null || typeof settlement.status === 'string').toBe(true);
      expect((await getTrialBalance(db)).balanced).toBe(true);
    }
  });

  it('I1 · un reparto que ya no se puede enviar (cobro contracargado tras aprobar) abre una alerta crítica y la tarea no lo reintenta', async () => {
    const context = await team();
    const { contribution, later } = await toFund(context);
    const payoutId = await signed(context, later);
    const failing = new MockPaycometProvider({ secrets, failSplit: new PaymentProviderError('Rechazado', 'MOCK_SPLIT_REJECTED') });
    expect(await settleSignedFundPayout(db, async () => failing, payoutId, TEST_HMAC_SECRET, later)).toEqual({ status: 'FAILED' });
    expect(await deliver('CHARGEBACK', contribution.paycometOrder!, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect((await executeFundPayout(db, mock, payoutId, later)).status).toBe('NEEDS_REVIEW');
    await checkActivityFunds(db, later);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `ACTIVITY_FUND_WINDOW:payout:${payoutId}` } })).toMatchObject({ status: 'OPEN', severity: 'CRITICAL', detailJson: { reason: 'SPLIT_BLOCKED', blockedCents: 25_000 } });
    const calls = mock.calls.length;
    await resumeFundPayouts(db, mock, later, 500, TEST_HMAC_SECRET);
    expect(mock.calls.length).toBe(calls);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('I2 e I3 · una liquidación firmada que no se pudo aprobar (KYB pendiente) la aprueba y envía la tarea; un fallo en otra no la frena', async () => {
    const stuck = await team();
    const first = await toFund(stuck);
    const stuckPayout = await signed(stuck, first.later);
    const failing = new MockPaycometProvider({ secrets, failSplit: new PaymentProviderError('Rechazado', 'MOCK_SPLIT_REJECTED') });
    expect(await settleSignedFundPayout(db, async () => failing, stuckPayout, TEST_HMAC_SECRET, first.later)).toEqual({ status: 'FAILED' });
    // Tras aprobarla, la entidad pierde su verificación: reanudarla falla, pero no debe impedir las demás.
    await db.organization.update({ where: { id: stuck.organization.id }, data: { kybStatus: 'SUBMITTED' } });

    const context = await team();
    const { later } = await toFund(context);
    const payoutId = await signed(context, later);
    // Entre la segunda firma y la aprobación, la entidad deja de estar verificada: la aprobación espera.
    await db.organization.update({ where: { id: context.organization.id }, data: { kybStatus: 'SUBMITTED' } });
    expect(await settleSignedFundPayout(db, async () => mock, payoutId, TEST_HMAC_SECRET, later)).toEqual({ status: 'NOT_APPROVED', reason: 'KYB_NOT_VERIFIED' });
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });
    // Firmada y sin aprobar con el día 90 cerca: alerta crítica en la consola.
    await checkActivityFunds(db, new Date(Date.now() + 82 * DAY));
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `ACTIVITY_FUND_WINDOW:payout:${payoutId}` } })).toMatchObject({ status: 'OPEN', severity: 'CRITICAL', detailJson: { reason: 'SIGNED_NOT_APPROVED' } });
    await db.organization.update({ where: { id: context.organization.id }, data: { kybStatus: 'VERIFIED' } });

    const result = await resumeFundPayouts(db, mock, later, 500, TEST_HMAC_SECRET);
    expect(result.approved).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'EXECUTED' });
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: stuckPayout } })).toMatchObject({ status: 'FAILED' });
  });

  it('M4 · firmar cuando un cobro ya pasó su ventana anula la liquidación con su propio motivo', async () => {
    const context = await team();
    const { contribution, later } = await toFund(context);
    const payoutId = await signed(context, later);
    await db.$executeRawUnsafe(`UPDATE ${table('Contribution')} SET "createdAt" = now() - interval '95 days' WHERE id = ${contribution.id}`);
    expect(await settleSignedFundPayout(db, async () => mock, payoutId, TEST_HMAC_SECRET, new Date())).toEqual({ status: 'NOT_APPROVED', reason: 'WINDOW_EXPIRED' });
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'WINDOW_EXPIRED' });
  });

  it('M1 · un comercio con bolsa Matching cuyo pago llega con la campaña cerrada deja de ser Matching, y recibe su aviso', async () => {
    const context = await team();
    const result = await startSponsorship(
      { db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET },
      { orgSlug: context.organization.slug, initiativeId: context.origin.id, locale: 'es', method: 'CARD', tierCents: 25_000, matchingPool: true, businessName: 'Óptica Sol', taxId: 'B-12345674', contactPerson: 'Eva Ruiz', phone: '600 12 34 56', email: 'eva@optica.example', sector: 'Óptica', promo: '', promoCode: '', autoRenew: false },
      { session: null, ip: freshIp() }
    );
    if (result.status !== 'REDIRECT') throw new Error(result.status);
    const order = new URL(result.url, 'http://localhost').searchParams.get('pedido')!;
    const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    await db.initiative.update({ where: { id: context.origin.id }, data: { status: 'CLOSED' } });
    await deliver('PAYMENT', order, contribution.totalChargedCents);
    expect(await db.sponsor.findUniqueOrThrow({ where: { id: contribution.sponsorId! } })).toMatchObject({ status: 'PENDING', isMatchingPool: false, reassignedCents: 25_000 });
    expect(await db.outboxMessage.count({ where: { templateKey: 'sponsor.lateReceived', toAddress: 'eva@optica.example', organizationId: context.organization.id } })).toBe(1);
  });
});

describe('Auditoría de seguridad del 4.2f · nadie mueve el Fondo sin dos personas distintas', () => {
  it('A1 y A2 · si cambia la cuenta destino entre firmas o después, no se firma ni se paga', async () => {
    const context = await team();
    const { later } = await toFund(context);
    await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    await completeSignature(db, TEST_HMAC_SECRET, context.director, await linkFor(context.director.userId), later);
    await db.organization.update({ where: { id: context.organization.id }, data: { paycometSplitId: uniqueId('split-otra') } });
    expect(await completeSignature(db, TEST_HMAC_SECRET, context.cosigner, await linkFor(context.cosigner.userId), later)).toMatchObject({ status: 'TARGET_CHANGED' });

    const other = await team();
    const second = await toFund(other);
    const payoutId = await signed(other, second.later);
    await db.organization.update({ where: { id: other.organization.id }, data: { paycometSplitId: uniqueId('split-otra') } });
    const calls = mock.calls.length;
    expect(await settleSignedFundPayout(db, async () => mock, payoutId, TEST_HMAC_SECRET, second.later)).toEqual({ status: 'NOT_APPROVED', reason: 'WRONG_STATUS' });
    expect(mock.calls.length).toBe(calls);
    // La tarea diaria lo vuelve a intentar sin repetir el rastro en la auditoría.
    await resumeFundPayouts(db, mock, second.later, 500, TEST_HMAC_SECRET);
    expect(await db.auditLog.count({ where: { action: 'activity_fund.signatures_rejected', targetId: String(payoutId) } })).toBe(1);
  });

  it('B · quien pierde el cargo y lo recupera ya no tiene su firma', async () => {
    const context = await team();
    const { later } = await toFund(context);
    const payoutId = await signed(context, later);
    await db.organizationMember.deleteMany({ where: { organizationId: context.organization.id, userId: context.cosigner.userId } });
    await db.organizationMember.create({ data: { organizationId: context.organization.id, userId: context.cosigner.userId, role: 'COSIGNER' } });
    expect(await settleSignedFundPayout(db, async () => mock, payoutId, TEST_HMAC_SECRET, later)).toEqual({ status: 'NOT_APPROVED', reason: 'WRONG_STATUS' });
  });

  it('C · dos cuentas que dan a la misma bandeja cuentan como una sola persona', async () => {
    const tag = uniqueId('x').replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
    const context = await team({ director: `ana.lopez${tag}@gmail.com`, cosigner: `analopez${tag}+ampa@gmail.com` });
    const { later } = await toFund(context);
    const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    await completeSignature(db, TEST_HMAC_SECRET, context.director, await linkFor(context.director.userId), later);
    const second = await db.outboxMessage.findFirst({ where: { templateKey: 'doubleCheck.pending', userId: context.cosigner.userId } });
    if (second) expect(await completeSignature(db, TEST_HMAC_SECRET, context.cosigner, second.payloadJson as { token: string; otp: string }, later)).toMatchObject({ status: 'NOT_ALLOWED', reason: 'SAME_PERSON' });
    else await expect(requestFundSignature(db, TEST_HMAC_SECRET, context.cosigner, context.organization.id, { payoutId }, later)).rejects.toBeInstanceOf(DoubleCheckNotAllowedError);
    expect(await db.activityFundPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'PENDING_DOUBLE_CHECK' });
  });

  it('D y E · otra entidad no pide enlaces ni reintenta liquidaciones ajenas; el Super-Admin no firma con un enlace ajeno', async () => {
    const context = await team();
    const { later } = await toFund(context);
    const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, context.director, context.organization.id, { purpose: PURPOSE }, later);
    const intruder = await team();
    await expect(requestFundSignature(db, TEST_HMAC_SECRET, intruder.director, intruder.organization.id, { payoutId }, later)).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    await expect(retryFundPayout(db, async () => mock, intruder.cosigner, intruder.organization.id, { payoutId }, later)).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(await db.auditLog.count({ where: { action: 'tenant.resource_outside_tenant', targetType: 'ActivityFundPayout', targetId: String(payoutId) } })).toBe(2);
    const { admin } = await verifiedSuperadmin(db);
    expect(await completeSignature(db, TEST_HMAC_SECRET, { kind: 'user', userId: admin.id, isSuperadmin: true, memberships: [], secondFactor: true }, await linkFor(context.director.userId), later)).toEqual({ status: 'INVALID_LINK' });
  });

  it('F · en la base, la cuenta destino fijada y el estado ya avanzado no se pueden cambiar', async () => {
    const context = await team();
    const { later } = await toFund(context);
    const payoutId = await signed(context, later);
    const failing = new MockPaycometProvider({ secrets, failSplit: new PaymentProviderError('Rechazado', 'MOCK_SPLIT_REJECTED') });
    await settleSignedFundPayout(db, async () => failing, payoutId, TEST_HMAC_SECRET, later);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('ActivityFundPayout')} SET "destinationSplitId" = 'split-atacante' WHERE id = ${payoutId}`)).rejects.toThrow(/ya no se puede cambiar/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('ActivityFundPayout')} SET "status" = 'PENDING_DOUBLE_CHECK' WHERE id = ${payoutId}`)).rejects.toThrow(/no puede pasar/);
  });

  it('M4 · pedir, retirar y volver a pedir tiene un límite por entidad', async () => {
    const context = await team();
    const { later } = await toFund(context);
    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      try {
        const { payoutId } = await requestFundPayout(db, TEST_HMAC_SECRET, attempt % 2 === 0 ? context.director : context.cosigner, context.organization.id, { purpose: `${PURPOSE} (${attempt})` }, later);
        await cancelFundPayout(db, context.director, context.organization.id, { payoutId }, later);
      } catch (error) {
        expect(error).toMatchObject({ reason: 'RATE_LIMITED' });
        limited = true;
      }
    }
    expect(limited).toBe(true);
    expect(await db.auditLog.count({ where: { action: 'activity_fund.rate_limited', organizationId: context.organization.id } })).toBeGreaterThanOrEqual(1);
  });
});
