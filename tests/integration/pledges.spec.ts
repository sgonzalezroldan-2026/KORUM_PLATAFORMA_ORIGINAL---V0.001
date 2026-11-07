import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPaymentSimulator } from '@/core/checkout/checkout-rules';
import { getAccountBalance } from '@/core/finance/ledger-balances';
import { monthlyTopupHandler } from '@/core/jobs/handlers/recurring-billing';
import type { JobDeps } from '@/core/jobs/job-types';
import { erasePersonalData } from '@/core/privacy/erasure.service';
import { retryCardDeletions } from '@/core/privacy/retention-accounts';
import { CRYPTO_CONTEXT, openValue } from '@/core/security/crypto';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadPledgeResult, loadUserPledges } from '@/repositories/hucha.repository';
import { settleSimulatedPayment } from '@/services/checkout/payment-simulator';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { PaymentProviderError, type PaymentProvider } from '@/services/payments/payment-provider';
import { chargePledgeCycle } from '@/services/pledges/pledge-billing';
import { cancelPledge, changePledgeCampaign, pausePledge, resumePledge, startPledge, type PledgeStart } from '@/services/pledges/pledge.service';
import { invalidateSettingsCache } from '@/services/settings/settings.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, testJobDeps, uniqueId } from './test-database';

/**
 * QA-F08 (modo `PLEDGE`) · Mi Hucha contra PostgreSQL real: el alta, el primer pago que guarda la tarjeta cifrada, el cobro de cada mes con su
 * asiento (donación íntegra a la hucha + gestión a ingresos), el mes sin campaña, el rechazo que pausa, el resultado desconocido que no se repite,
 * la concurrencia de la tarea, el final que borra la tarjeta y que nadie puede tocar la aportación de otra persona.
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-mi-hucha' };
const DAY_MS = 86_400_000;
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let ipSequence = 0;
const createdOrganizations: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
  // Mi Hucha en su modo por defecto (`PLEDGE`): sin fila en la consola.
  await db.platformSetting.deleteMany({ where: { key: 'hucha.mode' } });
  invalidateSettingsCache('hucha.mode');
});

afterAll(async () => {
  // Ninguna aportación de este archivo queda viva: la tarea de otras pruebas no debe intentar cobrarlas.
  await db.walletSubscription.updateMany({ where: { organizationId: { in: createdOrganizations }, status: { in: ['PENDING', 'ACTIVE', 'PAUSED'] } }, data: { status: 'CANCELLED' } });
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: createdOrganizations }, status: 'PENDING' } });
  await db.$disconnect();
});

const freshIp = () => {
  ipSequence += 1;
  return `10.88.${ipSequence % 250}.9`;
};

async function setup(overrides: { ley49?: boolean; campaigns?: number } = {}) {
  const org = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', ...(overrides.ley49 ? { ley49: true, ley49VerifiedAt: new Date() } : {}) });
  createdOrganizations.push(org.id);
  const campaigns = [];
  for (let index = 0; index < (overrides.campaigns ?? 1); index += 1) {
    campaigns.push(await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, closesAt: new Date(Date.now() + (120 + index * 10) * DAY_MS) }));
  }
  const family = await createUser(db);
  return { org, campaigns, family };
}

const input = (orgSlug: string, extra: Record<string, unknown> = {}) => ({ orgSlug, initiativeId: null, amountCents: 1_000, months: 9, fiscal: null, locale: 'es', ...extra });
const deps = (provider: PaymentProvider = mock, now?: Date) => ({ db, provider, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET, now });
const sessionOf = (user: { id: string; email: string }) => ({ session: { userId: user.id, email: user.email }, ip: freshIp() });
const billing = (provider: PaymentProvider = mock) => ({ db, provider, keyring: TEST_KEYRING, originalIp: '127.0.0.1' });

function orderOf(result: PledgeStart): string {
  expect(result.status).toBe('REDIRECT');
  if (result.status !== 'REDIRECT') throw new Error('sin redirección');
  return new URL(result.url, 'http://localhost').searchParams.get('pedido') ?? '';
}

async function payFirstMonth(orgSlug: string, order: string, approve = true) {
  const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, select: { initiativeId: true } });
  return settleSimulatedPayment(
    db,
    mock,
    { orgSlug, initiativeId: contribution.initiativeId, order, signature: signPaymentSimulator(TEST_HMAC_SECRET, order), approve },
    { hmacSecret: TEST_HMAC_SECRET, qrSecret: QR_SECRET, keyring: TEST_KEYRING }
  );
}

/** Alta + primer mes pagado: la aportación queda activa y con su tarjeta. */
async function activePledge(overrides: { ley49?: boolean; months?: number; fiscal?: unknown } = {}) {
  const context = await setup({ ley49: overrides.ley49 });
  const order = orderOf(await startPledge(deps(), input(context.org.slug, { months: overrides.months ?? 9, fiscal: overrides.fiscal ?? null }), sessionOf(context.family)));
  expect(await payFirstMonth(context.org.slug, order)).toBe('SETTLED');
  const pledge = await db.walletSubscription.findFirstOrThrow({ where: { userId: context.family.id, organizationId: context.org.id } });
  return { ...context, order, pledge };
}

/** Pone el siguiente cobro en el pasado y devuelve un «ahora» posterior. */
async function makeDue(pledgeId: number): Promise<Date> {
  const now = new Date(Date.now() + 2 * DAY_MS);
  await db.walletSubscription.update({ where: { id: pledgeId }, data: { nextChargeAt: new Date(now.getTime() - 3_600_000) } });
  return now;
}

describe('Alta y primer pago', () => {
  it('el primer mes se paga en la página de pago con la tarjeta guardada; se activa y asienta donación íntegra + gestión', async () => {
    const { org, campaigns, family } = await setup();
    const result = await startPledge(deps(), input(org.slug), sessionOf(family));
    const order = orderOf(result);
    expect(order).toMatch(/^KH[0-9A-F]{16}$/);
    const pending = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(pending).toMatchObject({ type: 'DONATION', amountCents: 1_000, guaranteeContributionCents: 0, totalChargedCents: 1_025, paymentMethod: 'CARD', pledgeCycle: 1, status: 'PENDING', userId: family.id, initiativeId: campaigns[0]?.id });
    expect(mock.calls.at(-1)).toMatchObject({ operation: 'hosted', order, amountCents: 1_025 });

    expect(await payFirstMonth(org.slug, order)).toBe('SETTLED');
    const pledge = await db.walletSubscription.findFirstOrThrow({ where: { userId: family.id }, include: { paymentMethodToken: true } });
    expect(pledge).toMatchObject({ status: 'ACTIVE', executedMonths: 1, monthlyAmountCents: 1_000, feePerMonthCents: 25, totalMonths: 9 });
    expect(pledge.nextChargeAt.getTime()).toBeGreaterThan(Date.now());
    // La tarjeta se guarda cifrada, de la familia, y solo se abre con el contexto de su propia fila.
    const card = mock.savedCardFor(order);
    const token = pledge.paymentMethodToken;
    expect(token).toMatchObject({ userId: family.id, brand: 'VISA', revokedAt: null });
    expect(token?.tokenUserEnc).not.toContain(card.tokenUser);
    expect(openValue(TEST_KEYRING, token?.tokenUserEnc ?? '', token?.keyVersion ?? 0, CRYPTO_CONTEXT.cardTokenUser(token?.id ?? 0))).toBe(card.tokenUser);

    const journal = await db.ledgerJournal.findFirstOrThrow({ where: { contributionId: pending.id, kind: 'PAYIN_DONATION' }, include: { entries: true } });
    const credits = Object.fromEntries(journal.entries.filter((entry) => entry.direction === 'CREDIT').map((entry) => [entry.account, entry.amountCents]));
    expect(credits).toEqual({ INITIATIVE_ESCROW: 1_000, KORUM_REVENUE_TOPUP_FEE: 25 });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: campaigns[0]?.id ?? 0 }, select: { raisedCents: true } })).toEqual({ raisedCents: 1_000 });
    // Un único email al mes: el de Mi Hucha, no además el recibo genérico.
    const mail = await db.outboxMessage.findMany({ where: { organizationId: org.id }, select: { templateKey: true } });
    expect(mail.map((row) => row.templateKey)).toEqual(['pledge.charged']);
    expect(await loadPledgeResult(db, family.id, order)).toMatchObject({ status: 'COMPLETED', walletSubscription: { status: 'ACTIVE' } });
  });

  it('un primer pago rechazado no cobra nada y la aportación no llega a empezar (ni se enseña)', async () => {
    const { org, family } = await setup();
    const order = orderOf(await startPledge(deps(), input(org.slug), sessionOf(family)));
    expect(await payFirstMonth(org.slug, order, false)).toBe('SETTLED');
    expect(await db.walletSubscription.findFirstOrThrow({ where: { userId: family.id } })).toMatchObject({ status: 'CANCELLED', statusReason: 'FIRST_PAYMENT_FAILED', paymentMethodTokenId: null });
    expect(await loadUserPledges(db, family.id, new Date())).toEqual([]);
  });

  it('si Paycomet no devuelve la tarjeta, el primer mes cuenta como donación y la aportación se cancela con su motivo', async () => {
    const { org, family } = await setup();
    const order = orderOf(await startPledge(deps(), input(org.slug), sessionOf(family)));
    const notification = mock.buildNotification({ kind: 'PAYMENT', order, amountCents: 1_025 });
    expect((await handlePaymentWebhook(db, mock, notification.rawBody, notification.contentType, new Date(), { keyring: () => TEST_KEYRING })).outcome).toBe('PROCESSED');
    expect(await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, select: { status: true } })).toEqual({ status: 'COMPLETED' });
    expect(await db.walletSubscription.findFirstOrThrow({ where: { userId: family.id } })).toMatchObject({ status: 'CANCELLED', statusReason: 'CARD_NOT_SAVED' });
  });

  it('sin el llavero, la notificación falla entera y se puede reintentar: nunca se pierde la tarjeta', async () => {
    const { org, family } = await setup();
    const order = orderOf(await startPledge(deps(), input(org.slug), sessionOf(family)));
    const notification = mock.buildNotification({ kind: 'PAYMENT', order, amountCents: 1_025, card: mock.savedCardFor(order) });
    expect((await handlePaymentWebhook(db, mock, notification.rawBody, notification.contentType)).outcome).toBe('FAILED');
    expect(await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, select: { status: true } })).toEqual({ status: 'PENDING' });
    expect((await handlePaymentWebhook(db, mock, notification.rawBody, notification.contentType, new Date(), { keyring: () => TEST_KEYRING })).outcome).toBe('PROCESSED');
    expect(await db.walletSubscription.findFirstOrThrow({ where: { userId: family.id } })).toMatchObject({ status: 'ACTIVE' });
  });

  it('rechaza lo que no se puede programar: sin campañas, campaña de otra entidad, certificado sin Ley 49, ya activa o Mi Hucha desactivada', async () => {
    const { org, family } = await setup();
    const empty = await createOrganization(db);
    createdOrganizations.push(empty.id);
    const other = await setup();
    expect(await startPledge(deps(), input(empty.slug), sessionOf(family))).toEqual({ status: 'NO_CAMPAIGN' });
    expect(await startPledge(deps(), input(org.slug, { initiativeId: other.campaigns[0]?.id }), sessionOf(family))).toEqual({ status: 'INVALID', field: 'campaign' });
    expect(await startPledge(deps(), input(org.slug, { fiscal: { taxId: '12345678Z', fullName: 'GARCIA LOPEZ ANA', provinceCode: '08' } }), sessionOf(family))).toEqual({ status: 'INVALID', field: 'fiscal' });
    expect(await startPledge(deps(), input(org.slug, { months: 5 }), sessionOf(family))).toEqual({ status: 'INVALID', field: 'months' });
    expect(await startPledge(deps(), input('no-existe-esta-entidad'), sessionOf(family))).toEqual({ status: 'NOT_FOUND' });

    const active = await activePledge();
    expect(await startPledge(deps(), input(active.org.slug), sessionOf(active.family))).toEqual({ status: 'ALREADY_ACTIVE' });

    await db.platformSetting.create({ data: { key: 'hucha.mode', valueJson: 'DISABLED' } });
    invalidateSettingsCache('hucha.mode');
    try {
      expect(await startPledge(deps(), input(org.slug), sessionOf(family))).toEqual({ status: 'DISABLED' });
    } finally {
      await db.platformSetting.deleteMany({ where: { key: 'hucha.mode' } });
      invalidateSettingsCache('hucha.mode');
    }
  });

  it('un alta nueva sin pagar sustituye a la anterior sin pagar con la misma entidad', async () => {
    const { org, family } = await setup();
    orderOf(await startPledge(deps(), input(org.slug), sessionOf(family)));
    orderOf(await startPledge(deps(), input(org.slug, { amountCents: 2_000 }), sessionOf(family)));
    const rows = await db.walletSubscription.findMany({ where: { userId: family.id }, orderBy: { id: 'asc' }, select: { status: true, statusReason: true, monthlyAmountCents: true } });
    expect(rows).toEqual([
      { status: 'CANCELLED', statusReason: 'REPLACED', monthlyAmountCents: 1_000 },
      { status: 'PENDING', statusReason: null, monthlyAmountCents: 2_000 }
    ]);
  });
});

describe('Cobro de cada mes (MONTHLY_TOPUP)', () => {
  it('cobra con la tarjeta guardada sin la persona delante, asienta y copia el NIF del primer mes', async () => {
    const { pledge, campaigns, org } = await activePledge({ ley49: true, fiscal: { taxId: '12345678Z', fullName: 'García López, Ana', provinceCode: '08' } });
    const now = await makeDue(pledge.id);
    expect(await chargePledgeCycle(billing(), pledge.id, now)).toBe('CHARGED');
    const month = await db.contribution.findUniqueOrThrow({ where: { walletSubscriptionId_pledgeCycle: { walletSubscriptionId: pledge.id, pledgeCycle: 2 } } });
    const first = await db.contribution.findUniqueOrThrow({ where: { walletSubscriptionId_pledgeCycle: { walletSubscriptionId: pledge.id, pledgeCycle: 1 } } });
    expect(month).toMatchObject({ status: 'COMPLETED', amountCents: 1_000, totalChargedCents: 1_025, initiativeId: campaigns[0]?.id, isTaxDeductible: true, donorTaxIdHmac: first.donorTaxIdHmac, donorFullName: 'GARCÍA LÓPEZ, ANA' });
    expect(month.paycometAuthCode).toBeTruthy();
    expect(await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id } })).toMatchObject({ status: 'ACTIVE', executedMonths: 2 });
    expect((await getAccountBalance(db, 'KORUM_REVENUE_TOPUP_FEE', { organizationId: org.id })).balanceCents).toBe(50);

    // La notificación de Paycomet que llega después ya no hace nada.
    const late = mock.buildNotification({ kind: 'PAYMENT', order: month.paycometOrder ?? '', amountCents: 1_025, authCode: month.paycometAuthCode ?? undefined });
    expect((await handlePaymentWebhook(db, mock, late.rawBody, late.contentType)).outcome).toBe('PROCESSED');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: campaigns[0]?.id ?? 0 }, select: { raisedCents: true } })).toEqual({ raisedCents: 2_000 });
  });

  it('dos ejecuciones a la vez nunca cobran dos veces el mismo mes', async () => {
    const { pledge } = await activePledge();
    const now = await makeDue(pledge.id);
    const outcomes = await Promise.all([chargePledgeCycle(billing(), pledge.id, now), chargePledgeCycle(billing(), pledge.id, now)]);
    expect(outcomes.sort()).toEqual(['CHARGED', 'NOT_DUE']);
    expect(await db.contribution.count({ where: { walletSubscriptionId: pledge.id } })).toBe(2);
  });

  it('si la entidad no tiene ninguna campaña recaudando, ese mes no se cobra y se avisa a la familia', async () => {
    const { pledge, campaigns, org } = await activePledge();
    await db.initiative.update({ where: { id: campaigns[0]?.id ?? 0 }, data: { status: 'GOAL_REACHED' } });
    const now = await makeDue(pledge.id);
    const charges = mock.calls.filter((call) => call.operation === 'charge').length;
    expect(await chargePledgeCycle(billing(), pledge.id, now)).toBe('SKIPPED');
    expect(mock.calls.filter((call) => call.operation === 'charge')).toHaveLength(charges);
    expect(await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id } })).toMatchObject({ status: 'ACTIVE', executedMonths: 2, skippedMonths: 1 });
    expect(await db.contribution.count({ where: { walletSubscriptionId: pledge.id } })).toBe(1);
    expect(await db.outboxMessage.count({ where: { organizationId: org.id, templateKey: 'pledge.skipped' } })).toBe(1);
  });

  it('un cobro rechazado deja el mes sin cobrar, pausa la aportación y avisa', async () => {
    const { pledge, org } = await activePledge();
    const now = await makeDue(pledge.id);
    const declining = new MockPaycometProvider({ secrets, failCharge: new PaymentProviderError('Tarjeta denegada', '190') });
    expect(await chargePledgeCycle(billing(declining), pledge.id, now)).toBe('FAILED');
    expect(await db.contribution.findUniqueOrThrow({ where: { walletSubscriptionId_pledgeCycle: { walletSubscriptionId: pledge.id, pledgeCycle: 2 } }, select: { status: true } })).toEqual({ status: 'FAILED' });
    expect(await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id } })).toMatchObject({ status: 'PAUSED', statusReason: 'CHARGE_FAILED' });
    expect(await db.outboxMessage.count({ where: { organizationId: org.id, templateKey: 'pledge.failed' } })).toBe(1);
  });

  it('con el resultado desconocido no se repite: el mes queda pendiente de confirmar y no se vuelve a cobrar', async () => {
    const { pledge } = await activePledge();
    const now = await makeDue(pledge.id);
    const cut = new MockPaycometProvider({ secrets, failCharge: new PaymentProviderError('Se cortó la conexión', 'NETWORK', true) });
    expect(await chargePledgeCycle(billing(cut), pledge.id, now)).toBe('UNKNOWN');
    expect(await chargePledgeCycle(billing(), pledge.id, now)).toBe('NOT_DUE');
    expect(await db.contribution.findUniqueOrThrow({ where: { walletSubscriptionId_pledgeCycle: { walletSubscriptionId: pledge.id, pledgeCycle: 2 } }, select: { status: true } })).toEqual({ status: 'PENDING' });
  });

  it('el último mes termina la aportación y borra la tarjeta en Paycomet', async () => {
    const { pledge } = await activePledge({ months: 3 });
    await db.walletSubscription.update({ where: { id: pledge.id }, data: { executedMonths: 2 } });
    const now = await makeDue(pledge.id);
    const before = mock.deletedCards.length;
    expect(await chargePledgeCycle(billing(), pledge.id, now)).toBe('CHARGED');
    const done = await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id }, include: { paymentMethodToken: true } });
    expect(done).toMatchObject({ status: 'FINISHED', executedMonths: 3 });
    expect(done.paymentMethodToken).toMatchObject({ idUserEnc: '', tokenUserEnc: '' });
    expect(done.paymentMethodToken?.revokedAt).not.toBeNull();
    expect(mock.deletedCards.length).toBe(before + 1);
  });

  it('la tarea diaria cobra lo vencido y no toca lo pausado; con Mi Hucha desactivada no cobra nada', async () => {
    const due = await activePledge();
    const paused = await activePledge();
    const now = await makeDue(due.pledge.id);
    await makeDue(paused.pledge.id);
    await pausePledge(db, paused.family.id, paused.pledge.id);
    const jobDeps: JobDeps = { ...testJobDeps(), paymentProvider: async () => mock, invoicingProvider: () => { throw new Error('sin facturación'); }, refundOriginalIp: async () => '127.0.0.1' };

    await db.platformSetting.create({ data: { key: 'hucha.mode', valueJson: 'DISABLED' } });
    invalidateSettingsCache('hucha.mode');
    try {
      expect(await monthlyTopupHandler({ db, now, batchSize: 100, deps: jobDeps })).toMatchObject({ processed: 0 });
    } finally {
      await db.platformSetting.deleteMany({ where: { key: 'hucha.mode' } });
      invalidateSettingsCache('hucha.mode');
    }

    const result = await monthlyTopupHandler({ db, now, batchSize: 100, deps: jobDeps });
    expect(result.detail?.charged).toBeGreaterThanOrEqual(1);
    expect(await db.walletSubscription.findUniqueOrThrow({ where: { id: due.pledge.id } })).toMatchObject({ executedMonths: 2 });
    expect(await db.walletSubscription.findUniqueOrThrow({ where: { id: paused.pledge.id } })).toMatchObject({ status: 'PAUSED', executedMonths: 1 });
  });
});

describe('Gestión por la familia', () => {
  it('pausar, reanudar (desde hoy), cambiar de campaña y cancelar borrando la tarjeta; nadie más puede', async () => {
    const { pledge, family, org } = await activePledge();
    const stranger = await createUser(db);
    const other = await setup();
    const second = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'BUDGET', closesAt: new Date(Date.now() + 200 * DAY_MS) });

    expect(await pausePledge(db, stranger.id, pledge.id)).toEqual({ status: 'NOT_FOUND' });
    expect(await changePledgeCampaign(db, stranger.id, pledge.id, second.id)).toEqual({ status: 'NOT_FOUND' });
    expect(await cancelPledge({ db, keyring: TEST_KEYRING, paymentProvider: async () => mock }, stranger.id, pledge.id)).toEqual({ status: 'NOT_FOUND' });
    expect(await loadUserPledges(db, stranger.id, new Date())).toEqual([]);

    expect(await pausePledge(db, family.id, pledge.id)).toEqual({ status: 'DONE' });
    expect(await pausePledge(db, family.id, pledge.id)).toEqual({ status: 'NOT_FOUND' });
    await db.walletSubscription.update({ where: { id: pledge.id }, data: { nextChargeAt: new Date(Date.now() - 40 * DAY_MS) } });
    expect(await resumePledge(db, family.id, pledge.id)).toEqual({ status: 'DONE' });
    expect((await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id } })).nextChargeAt.getTime()).toBeGreaterThan(Date.now());

    expect(await changePledgeCampaign(db, family.id, pledge.id, other.campaigns[0]?.id ?? 0)).toEqual({ status: 'INVALID' });
    expect(await changePledgeCampaign(db, family.id, pledge.id, second.id)).toEqual({ status: 'DONE' });
    expect(await changePledgeCampaign(db, family.id, pledge.id, null)).toEqual({ status: 'DONE' });

    const before = mock.deletedCards.length;
    expect(await cancelPledge({ db, keyring: TEST_KEYRING, paymentProvider: async () => mock }, family.id, pledge.id)).toEqual({ status: 'DONE' });
    const cancelled = await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id }, include: { paymentMethodToken: true } });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', statusReason: 'BY_FAMILY' });
    expect(cancelled.paymentMethodToken?.revokedAt).not.toBeNull();
    expect(mock.deletedCards.length).toBe(before + 1);
    expect(await resumePledge(db, family.id, pledge.id)).toEqual({ status: 'NOT_FOUND' });

    const listed = await loadUserPledges(db, family.id, new Date());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: 'CANCELLED', contributedCents: 1_000 });
    expect(JSON.stringify(listed)).not.toMatch(/tokenUser|idUserEnc|donorTaxId/);
  });

  it('reanudar no es posible si la tarjeta ya no se puede usar', async () => {
    const { pledge, family } = await activePledge();
    await pausePledge(db, family.id, pledge.id);
    await db.paymentMethodToken.update({ where: { id: pledge.paymentMethodTokenId ?? 0 }, data: { revokedAt: new Date() } });
    expect(await resumePledge(db, family.id, pledge.id)).toEqual({ status: 'CARD_UNAVAILABLE' });
  });

  it('el resultado del primer pago solo lo ve quien lo hizo', async () => {
    const { order } = await activePledge();
    const stranger = await createUser(db);
    expect(await loadPledgeResult(db, stranger.id, order)).toBeNull();
  });
});

describe('Auditoría del Sprint 3.8: tarjetas, contracargos, pausas y rastro', () => {
  const cardDeps = () => ({ paymentProvider: async () => mock as PaymentProvider, keyring: TEST_KEYRING });
  const jobDeps = (): JobDeps => ({
    ...testJobDeps(),
    paymentProvider: async () => mock,
    invoicingProvider: () => {
      throw new Error('sin facturación');
    },
    refundOriginalIp: async () => '127.0.0.1'
  });

  it('un contracargo de un mes cancela la aportación, revoca la tarjeta y deshace también la gestión', async () => {
    const { pledge, order, org } = await activePledge();
    const chargeback = mock.buildNotification({ kind: 'CHARGEBACK', order, amountCents: 1_025 });
    expect((await handlePaymentWebhook(db, mock, chargeback.rawBody, chargeback.contentType)).outcome).toBe('PROCESSED');
    const after = await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id }, include: { paymentMethodToken: true } });
    expect(after).toMatchObject({ status: 'CANCELLED', statusReason: 'CHARGEBACK' });
    expect(after.paymentMethodToken?.revokedAt).not.toBeNull();
    // El contracargo refleja el asiento del cobro: la gestión de Mi Hucha vuelve también.
    expect((await getAccountBalance(db, 'KORUM_REVENUE_TOPUP_FEE', { organizationId: org.id })).balanceCents).toBe(0);
  });

  it('una tarjeta que llega a un alta ya sustituida se guarda revocada y la purga pide borrarla', async () => {
    const { org, family } = await setup();
    const first = orderOf(await startPledge(deps(), input(org.slug), sessionOf(family)));
    orderOf(await startPledge(deps(), input(org.slug), sessionOf(family)));
    expect(await payFirstMonth(org.slug, first)).toBe('SETTLED');
    const replaced = await db.walletSubscription.findFirstOrThrow({ where: { userId: family.id, statusReason: 'REPLACED' }, include: { paymentMethodToken: true } });
    expect(replaced.status).toBe('CANCELLED');
    expect(replaced.paymentMethodToken?.revokedAt).not.toBeNull();
    await retryCardDeletions(db, cardDeps(), new Date(), 200);
    const card = await db.paymentMethodToken.findUniqueOrThrow({ where: { id: replaced.paymentMethodTokenId ?? 0 }, select: { providerDeletedAt: true, tokenUserEnc: true } });
    expect(card.providerDeletedAt).not.toBeNull();
    expect(card.tokenUserEnc).toBe('');
  });

  it('dos altas pagadas a la vez con la misma entidad: solo una queda viva (también lo impide la base)', async () => {
    const { pledge, family, org, campaigns } = await activePledge();
    // Una segunda alta que se coló antes de que la primera se activara.
    const second = await db.walletSubscription.create({ data: { userId: family.id, organizationId: org.id, monthlyAmountCents: 1_000, feePerMonthCents: 25, status: 'PENDING', nextChargeAt: new Date() } });
    const order = `KH${Date.now().toString(16).toUpperCase().padStart(16, '0').slice(-16)}`;
    await db.contribution.create({
      data: { organizationId: org.id, initiativeId: campaigns[0]?.id ?? 0, userId: family.id, fiscalYear: 2026, type: 'DONATION', amountCents: 1_000, totalChargedCents: 1_025, paymentMethod: 'CARD', paycometOrder: order, walletSubscriptionId: second.id, pledgeCycle: 1 }
    });
    const notification = mock.buildNotification({ kind: 'PAYMENT', order, amountCents: 1_025, card: mock.savedCardFor(order) });
    expect((await handlePaymentWebhook(db, mock, notification.rawBody, notification.contentType, new Date(), { keyring: () => TEST_KEYRING })).outcome).toBe('PROCESSED');
    expect(await db.walletSubscription.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'CANCELLED', statusReason: 'REPLACED' });
    expect(await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id } })).toMatchObject({ status: 'ACTIVE' });
    await expect(db.walletSubscription.update({ where: { id: second.id }, data: { status: 'PAUSED' } })).rejects.toThrow();
  });

  it('si el último mes acaba con resultado desconocido, la tarjeta se revoca igualmente', async () => {
    const { pledge } = await activePledge({ months: 3 });
    await db.walletSubscription.update({ where: { id: pledge.id }, data: { executedMonths: 2 } });
    const now = await makeDue(pledge.id);
    const cut = new MockPaycometProvider({ secrets, failCharge: new PaymentProviderError('Se cortó la conexión', 'NETWORK', true) });
    expect(await chargePledgeCycle(billing(cut), pledge.id, now)).toBe('UNKNOWN');
    const done = await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id }, include: { paymentMethodToken: true } });
    expect(done.status).toBe('FINISHED');
    expect(done.paymentMethodToken?.revokedAt).not.toBeNull();
  });

  it('el último mes sin campaña avisa de que la aportación ha terminado', async () => {
    const { pledge, campaigns, org } = await activePledge({ months: 3 });
    await db.walletSubscription.update({ where: { id: pledge.id }, data: { executedMonths: 2 } });
    await db.initiative.update({ where: { id: campaigns[0]?.id ?? 0 }, data: { status: 'GOAL_REACHED' } });
    expect(await chargePledgeCycle(billing(), pledge.id, await makeDue(pledge.id))).toBe('SKIPPED');
    const notice = await db.outboxMessage.findFirstOrThrow({ where: { organizationId: org.id, templateKey: 'pledge.skipped' } });
    expect(notice.payloadJson).toMatchObject({ last: true, cycle: 3 });
  });

  it('más de 6 meses en pausa: la tarea la cancela y pide borrar la tarjeta', async () => {
    const { pledge, family } = await activePledge();
    await pausePledge(db, family.id, pledge.id);
    await db.walletSubscription.update({ where: { id: pledge.id }, data: { statusChangedAt: new Date(Date.now() - 200 * DAY_MS) } });
    const result = await monthlyTopupHandler({ db, now: new Date(), batchSize: 100, deps: jobDeps() });
    expect(result.detail?.pauseExpired).toBeGreaterThanOrEqual(1);
    const expired = await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id }, include: { paymentMethodToken: true } });
    expect(expired).toMatchObject({ status: 'CANCELLED', statusReason: 'PAUSE_EXPIRED' });
    expect(expired.paymentMethodToken?.providerDeletedAt).not.toBeNull();
  });

  it('queda rastro: el alta con la versión de los textos aceptada, cada cambio y el intento sobre una aportación ajena', async () => {
    const { pledge, family } = await activePledge();
    const stranger = await createUser(db);
    expect(pledge.termsVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await pausePledge(db, family.id, pledge.id);
    await pausePledge(db, stranger.id, pledge.id);
    const actions = await db.auditLog.findMany({ where: { targetType: 'WalletSubscription', targetId: String(pledge.id) }, orderBy: { id: 'asc' }, select: { action: true, actorUserId: true, metadataJson: true } });
    expect(actions.map((row) => row.action)).toEqual(['pledge.started', 'pledge.paused', 'pledge.access_denied']);
    expect(actions[0]?.metadataJson).toMatchObject({ amountCents: 1_000, months: 9, termsVersion: pledge.termsVersion });
    expect(actions[2]?.actorUserId).toBe(stranger.id);
  });

  it('suprimir la cuenta cancela sus aportaciones y revoca su tarjeta', async () => {
    const { pledge, family } = await activePledge();
    await erasePersonalData(db, { ...cardDeps(), hmacSecret: TEST_HMAC_SECRET }, { userId: family.id, requestedBy: { kind: 'system', reason: 'INACTIVITY' } });
    const erased = await db.walletSubscription.findUniqueOrThrow({ where: { id: pledge.id }, include: { paymentMethodToken: true } });
    expect(erased).toMatchObject({ status: 'CANCELLED', statusReason: 'ACCOUNT_ERASED' });
    expect(erased.paymentMethodToken?.revokedAt).not.toBeNull();
  });
});
