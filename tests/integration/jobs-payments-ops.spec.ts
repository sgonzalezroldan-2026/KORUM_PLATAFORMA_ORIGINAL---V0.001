import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveRefundInTx } from '@/services/payments/payment-reversals';
import { DoubleCheckNotAllowedError, requestSignature } from '@/core/security/double-check.service';
import { computeSignatureHash, payoutTargetDigest } from '@/core/security/signature-hash';
import { invoiceSubmitHandler } from '@/core/jobs/handlers/ticketing-invoicing';
import { massRefundHandler, MAX_REFUND_ATTEMPTS, reactivateRejectedRefund } from '@/core/jobs/handlers/mass-refund';
import { LAST_RECONCILED_KEY, pspReconciliationHandler } from '@/core/jobs/handlers/psp-reconciliation';
import { postJournal } from '@/core/finance/ledger.service';
import { runJob } from '@/core/jobs/job-runner';
import type { JobDeps, JobHandler } from '@/core/jobs/job-types';
import type { JobType } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { issueInvoice, resolveUnknownInvoice, InvoiceNotAllowedError } from '@/services/invoicing/invoice.service';
import { MockInvoicingProvider, unknownOutcome } from '@/services/invoicing/mock-invoicing';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { PaymentConfigurationError } from '@/services/payments/provider-factory';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { PaymentProviderError, type PaymentProvider } from '@/services/payments/payment-provider';
import { resolveUnknownRefund } from '@/services/payments/manual-resolutions';
import { approvePayout, PayoutNotAllowedError } from '@/services/payments/split-transfer.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_KEYRING, testJobDeps, uniqueId, verifiedSuperadmin } from './test-database';

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración' };
const HMAC_SECRET = 'secreto-de-integracion-de-las-firmas-0123456789';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let db: KorumPrismaClient;
let mock: MockPaycometProvider;
const refundFailures = new Map<string, PaymentProviderError>();
const refundAttempts = new Map<string, number>();

const deps = (provider: () => Promise<PaymentProvider>, invoicing: MockInvoicingProvider = new MockInvoicingProvider()): JobDeps => ({ paymentProvider: provider, invoicingProvider: () => invoicing, refundOriginalIp: async () => '10.0.0.1', ...testJobDeps() });
const run = (type: JobType, handler: JobHandler, now: Date, jobDeps: JobDeps) => runJob({ db, type, handler, deps: jobDeps, now });

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({
    secrets,
    failRefund: (order) => {
      refundAttempts.set(order, (refundAttempts.get(order) ?? 0) + 1);
      return refundFailures.get(order) ?? null;
    }
  });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.$disconnect();
});

async function setup(overrides: Parameters<typeof createInitiative>[2] = {}, orgOverrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', ...orgOverrides });
  const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 100_000, ...overrides });
  return { organization, initiative };
}

async function pendingDonation(organizationId: string, initiativeId: number, amountCents = 2_500, extra: { createdAt?: Date } = {}) {
  return db.contribution.create({
    data: { organizationId, initiativeId, fiscalYear: 2026, type: 'DONATION', amountCents, totalChargedCents: amountCents, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING', ...extra }
  });
}

const deliver = (kind: 'PAYMENT' | 'REFUND' | 'CHARGEBACK', order: string, amountCents: number, options: { response?: 'OK' | 'KO'; bankDateTime?: string } = {}) => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents, ...options });
  return handlePaymentWebhook(db, mock, rawBody, contentType);
};

async function paidDonation(organizationId: string, initiativeId: number, amountCents = 2_500, extra: { createdAt?: Date } = {}) {
  const contribution = await pendingDonation(organizationId, initiativeId, amountCents, extra);
  expect(await deliver('PAYMENT', contribution.paycometOrder!, amountCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

const statusOf = async (id: number) => (await db.contribution.findUniqueOrThrow({ where: { id } })).status;
const mockDeps = deps(async () => mock);
const refundsOf = (order: string) => mock.calls.filter((call) => call.operation === 'refund' && call.order === order).length;

describe('QA-OPS01 · MASS_REFUND', () => {
  /** Ejecuta la tarea en huecos de 11 minutos hasta que se cumpla la condición. */
  async function untilTrue(start: Date, done: () => Promise<boolean>, maxSteps = 40) {
    for (let step = 0; step < maxSteps; step += 1) {
      await run('MASS_REFUND', massRefundHandler, new Date(start.getTime() + step * 11 * MINUTE), mockDeps);
      if (await done()) return step;
    }
    throw new Error('La condición no se cumplió en el tiempo previsto');
  }

  it('devuelve a cada persona una sola vez, aunque la tarea se ejecute varias veces; el fallido se reintenta con espera creciente y, agotado, queda en la consola', { timeout: 240_000 }, async () => {
    const start = new Date();
    const { organization, initiative } = await setup();
    const good = [await paidDonation(organization.id, initiative.id), await paidDonation(organization.id, initiative.id)];
    const bad = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    refundFailures.set(bad.paycometOrder!, new PaymentProviderError('rechazada', 'MOCK_REJECT'));

    await untilTrue(start, async () => (await Promise.all(good.map((donation) => statusOf(donation.id)))).every((status) => status === 'REFUNDED'));
    // El resto de las ejecuciones: el rechazo cuenta cada fallo hasta el límite y luego no se vuelve a pedir.
    await untilTrue(new Date(start.getTime() + 41 * 11 * MINUTE), async () => (await db.opsAlert.findUnique({ where: { dedupeKey: `REFUND_REJECTED:${bad.id}` } }))?.occurrences === MAX_REFUND_ATTEMPTS);
    const attemptsAtLimit = refundAttempts.get(bad.paycometOrder!);
    expect(attemptsAtLimit).toBe(MAX_REFUND_ATTEMPTS);
    for (let step = 0; step < 4; step += 1) await run('MASS_REFUND', massRefundHandler, new Date(start.getTime() + (100 + step) * 11 * MINUTE), mockDeps);

    for (const donation of good) {
      expect(refundsOf(donation.paycometOrder!)).toBe(1);
      expect(await db.ledgerJournal.count({ where: { idempotencyKey: `payment:refund-execution:${donation.id}` } })).toBe(1);
    }
    expect(refundAttempts.get(bad.paycometOrder!)).toBe(attemptsAtLimit);
    expect(await statusOf(bad.id)).toBe('REFUND_PENDING');
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${bad.id}` } })).toMatchObject({ type: 'REFUND_REJECTED', status: 'OPEN', occurrences: MAX_REFUND_ATTEMPTS, organizationId: organization.id, detailJson: { code: 'MOCK_REJECT' } });
    // Con algo pendiente, la iniciativa no se da por devuelta.
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('REFUNDING');
  });

  it('cuando ya no queda nada por devolver, la iniciativa pasa a REFUNDED una sola vez', async () => {
    const start = new Date(Date.now() + 2 * DAY);
    const { organization, initiative } = await setup();
    const donations = [await paidDonation(organization.id, initiative.id), await paidDonation(organization.id, initiative.id)];
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    await untilTrue(start, async () => (await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status === 'REFUNDED');
    await run('MASS_REFUND', massRefundHandler, new Date(start.getTime() + 50 * 11 * MINUTE), mockDeps);
    expect(await Promise.all(donations.map((donation) => statusOf(donation.id)))).toEqual(['REFUNDED', 'REFUNDED']);
    expect(await db.auditLog.count({ where: { action: 'initiative.refunded', targetId: String(initiative.id) } })).toBe(1);
  });

  it('recoge también el cobro tardío de una campaña ya cerrada, y no toca los patrocinios', async () => {
    const start = new Date(Date.now() + 4 * DAY);
    const { organization, initiative } = await setup();
    const late = await paidDonation(organization.id, initiative.id);
    // Un cobro tardío acaba en REFUND_PENDING aunque la iniciativa no esté en REFUNDING.
    await db.$transaction((tx) => approveRefundInTx(tx, late.id, { lateCharge: true }));
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CLOSED' } });
    const sponsorship = await db.contribution.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'SPONSORSHIP', amountCents: 25_000, totalChargedCents: 25_000, paymentMethod: 'CARD', paycometOrder: uniqueId('SPO'), status: 'COMPLETED' }
    });
    expect(await statusOf(late.id)).toBe('REFUND_PENDING');

    await untilTrue(start, async () => (await statusOf(late.id)) === 'REFUNDED');
    expect(await statusOf(sponsorship.id)).toBe('COMPLETED');
    expect(refundsOf(sponsorship.paycometOrder!)).toBe(0);
  });

  it('un resultado desconocido no se reintenta: queda como alerta crítica hasta que una persona lo resuelva', async () => {
    const start = new Date(Date.now() + 6 * DAY);
    const { organization, initiative } = await setup();
    const donation = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    refundFailures.set(donation.paycometOrder!, new PaymentProviderError('se cortó la conexión', 'MOCK_CUT', true));

    await untilTrue(start, async () => (await db.opsAlert.findUnique({ where: { dedupeKey: `REFUND_STUCK:${donation.id}` } })) !== null);
    for (let step = 20; step < 24; step += 1) await run('MASS_REFUND', massRefundHandler, new Date(start.getTime() + step * 11 * MINUTE), mockDeps);
    expect(refundAttempts.get(donation.paycometOrder!)).toBe(1);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_STUCK:${donation.id}` } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });

    const { actor: admin } = await verifiedSuperadmin(db);
    await resolveUnknownRefund(db, admin, donation.id, { refunded: true });
    await run('MASS_REFUND', massRefundHandler, new Date(start.getTime() + 40 * 11 * MINUTE), mockDeps);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_STUCK:${donation.id}` } })).toMatchObject({ status: 'RESOLVED' });
    expect(refundAttempts.get(donation.paycometOrder!)).toBe(1);
  });

  it('una reserva antigua sin resolver (caída entre la reserva y la llamada) se avisa', async () => {
    const now = new Date(Date.now() + 8 * DAY);
    const { organization, initiative } = await setup();
    const donation = await paidDonation(organization.id, initiative.id);
    await db.$transaction((tx) => approveRefundInTx(tx, donation.id, { lateCharge: true }));
    await db.contribution.update({ where: { id: donation.id }, data: { refundSendingAt: new Date(now.getTime() - 3 * HOUR) } });
    await run('MASS_REFUND', massRefundHandler, now, mockDeps);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_STUCK:${donation.id}` } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', detailJson: { initiativeId: initiative.id } });
    expect(refundsOf(donation.paycometOrder!)).toBe(0);
  });
});

describe('QA-OPS02 · PSP_RECONCILIATION', () => {
  it('cada diferencia con Paycomet abre su alerta con el detalle, y lo que cuadra no genera ninguna', { timeout: 240_000 }, async () => {
    const created = new Date();
    // Más que el margen de la conciliación (3 h): los cobros recién creados no se juzgan todavía.
    const now = new Date(created.getTime() + 4 * HOUR);
    const { organization, initiative } = await setup();
    const matching = await paidDonation(organization.id, initiative.id, 2_500);
    const wrongAmount = await paidDonation(organization.id, initiative.id, 3_000);
    const wrongAuth = await paidDonation(organization.id, initiative.id, 1_500);
    const missingAtPsp = await paidDonation(organization.id, initiative.id, 1_000);
    mock.registerCharge(matching.paycometOrder!, 2_500, created);
    mock.registerCharge(wrongAmount.paycometOrder!, 3_100, created);
    mock.registerCharge(wrongAuth.paycometOrder!, 1_500, created, 'OTRO-CODIGO');
    mock.forgetCharge(missingAtPsp.paycometOrder!);
    const unknownOrder = uniqueId('FUERA');
    mock.registerCharge(unknownOrder, 999, created);

    const unconfirmed = await paidDonation(organization.id, initiative.id, 700);
    expect(await deliver('CHARGEBACK', unconfirmed.paycometOrder!, 700, { response: 'KO' })).toMatchObject({ status: 200 });
    mock.registerCharge(unconfirmed.paycometOrder!, 700, created);

    const results = await run('PSP_RECONCILIATION', pspReconciliationHandler, now, mockDeps);
    expect(results).toMatchObject([{ outcome: 'DONE' }]);

    const alert = (kind: string, order: string) => db.opsAlert.findUnique({ where: { dedupeKey: `RECONCILIATION_MISMATCH:${kind}:${order}` } });
    expect(await alert('AMOUNT_MISMATCH', wrongAmount.paycometOrder!)).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', organizationId: organization.id, targetId: wrongAmount.paycometOrder!, detailJson: { pspCents: 3_100, localCents: 3_000 } });
    expect(await alert('AUTHCODE_MISMATCH', wrongAuth.paycometOrder!)).toMatchObject({ severity: 'WARNING', status: 'OPEN' });
    expect(await alert('MISSING_AT_PSP', missingAtPsp.paycometOrder!)).toMatchObject({ severity: 'CRITICAL', detailJson: { amountCents: 1_000 } });
    expect(await alert('MISSING_LOCALLY', unknownOrder)).toMatchObject({ severity: 'CRITICAL', organizationId: null, detailJson: { amountCents: 999 } });
    for (const kind of ['AMOUNT_MISMATCH', 'AUTHCODE_MISMATCH', 'MISSING_AT_PSP', 'MISSING_LOCALLY']) expect(await alert(kind, matching.paycometOrder!)).toBeNull();
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `RECONCILIATION_MISMATCH:RAISED:${initiative.id}` } })).toBeNull();

    const chargeback = await db.opsAlert.findFirstOrThrow({ where: { type: 'CHARGEBACK_UNCONFIRMED', detailJson: { path: ['order'], equals: unconfirmed.paycometOrder! } } });
    expect(chargeback).toMatchObject({ severity: 'WARNING', status: 'OPEN', targetType: 'WebhookEvent' });

    // Al día siguiente, el mismo problema cuenta una repetición más en la misma alerta.
    await run('PSP_RECONCILIATION', pspReconciliationHandler, new Date(now.getTime() + DAY), mockDeps);
    expect(await alert('AMOUNT_MISMATCH', wrongAmount.paycometOrder!)).toMatchObject({ occurrences: 2 });
  });

  it('detecta una hucha cuyo contador no coincide con el libro mayor, y la alerta se cierra al corregirse', async () => {
    const now = new Date(Date.now() + 10 * DAY);
    const { organization, initiative } = await setup();
    await paidDonation(organization.id, initiative.id, 2_500);
    await db.initiative.update({ where: { id: initiative.id }, data: { raisedCents: 9_999 } });
    await run('PSP_RECONCILIATION', pspReconciliationHandler, now, mockDeps);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `RECONCILIATION_MISMATCH:RAISED:${initiative.id}` } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', detailJson: { kind: 'RAISED_MISMATCH', cachedCents: 9_999, ledgerCents: 2_500 } });
    await db.initiative.update({ where: { id: initiative.id }, data: { raisedCents: 2_500 } });
    await run('PSP_RECONCILIATION', pspReconciliationHandler, new Date(now.getTime() + DAY), mockDeps);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `RECONCILIATION_MISMATCH:RAISED:${initiative.id}` } })).toMatchObject({ status: 'RESOLVED' });
  });

  it('si Paycomet no puede dar la lista completa, la tarea falla y se reintenta: no se concilia con datos recortados', async () => {
    const now = new Date(Date.now() + 12 * DAY);
    const broken = { listCharges: async () => Promise.reject(new PaymentProviderError('límite alcanzado', 'SEARCH_TRUNCATED')) } as unknown as PaymentProvider;
    const results = await run('PSP_RECONCILIATION', pspReconciliationHandler, now, deps(async () => broken));
    expect(results).toMatchObject([{ outcome: 'RETRY', error: 'PaymentProviderError: límite alcanzado' }]);
  });
});

describe('INVOICE_SUBMIT · facturas Veri*factu', () => {
  const invoiceInput = (organizationId: string) => ({ idempotencyKey: uniqueId('factura'), organizationId, issuerTaxId: '89890001K', recipientName: 'Comercio del Barrio SL', recipientTaxId: 'B12345674', keyring: TEST_KEYRING, concept: 'Fee de gestión publicitaria', baseAmountCents: 3_750, taxRateBps: 2100 });

  it('envía las pendientes en orden; una de resultado desconocido detiene las siguientes, se avisa y una persona la resuelve', { timeout: 240_000 }, async () => {
    // Cola limpia: lo que dejaron otras pruebas (pendientes o de resultado desconocido) bloquearía el orden de envío de las facturas de esta.
    await db.invoice.updateMany({ where: { verifactuStatus: { in: ['PENDING', 'SENT'] } }, data: { verifactuStatus: 'ACCEPTED' } });
    const organization = await createOrganization(db);
    const provider = new MockInvoicingProvider();
    const jobDeps = deps(async () => mock, provider);
    // Con la fecha de hoy: la cadena de facturas nunca retrocede, y una fecha lejana adelantaría la numeración de las demás pruebas.
    const first = await issueInvoice(db, invoiceInput(organization.id));
    const second = await issueInvoice(db, invoiceInput(organization.id));

    // Deja libre la cola de lo que hayan dejado otras pruebas.
    let start = new Date(Date.now() + 14 * DAY);
    const drain = async () => {
      for (let step = 0; step < 10; step += 1) {
        start = new Date(start.getTime() + 11 * MINUTE);
        await run('INVOICE_SUBMIT', invoiceSubmitHandler, start, jobDeps);
        if ((await db.invoice.count({ where: { verifactuStatus: 'PENDING' } })) === 0) return;
      }
    };
    provider.failNext = unknownOutcome();
    await drain();
    // Alguna de las pendientes (la primera en orden) quedó en SENT con resultado desconocido; las demás esperan.
    const stuck = await db.invoice.findFirstOrThrow({ where: { verifactuStatus: 'SENT' }, orderBy: { id: 'asc' } });
    expect(stuck.sentAt).not.toBeNull();
    expect(await db.invoice.count({ where: { id: { in: [first.id, second.id] }, verifactuStatus: 'ACCEPTED' } })).toBeLessThan(2);

    // Pasada más de una hora, se avisa.
    const later = new Date(start.getTime() + 2 * HOUR);
    await run('INVOICE_SUBMIT', invoiceSubmitHandler, later, jobDeps);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `INVOICE_STUCK:${stuck.id}` } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', organizationId: stuck.organizationId });

    const { actor: admin } = await verifiedSuperadmin(db);
    await resolveUnknownInvoice(db, admin, stuck.id, { registered: true, status: 'ACCEPTED', providerReference: 'AEAT-OK' });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ verifactuStatus: 'ACCEPTED', providerReference: 'AEAT-OK' });
    await expect(resolveUnknownInvoice(db, admin, stuck.id, { registered: false })).rejects.toBeInstanceOf(InvoiceNotAllowedError);
    expect(await db.auditLog.count({ where: { action: 'invoice.registration_resolved', targetId: String(stuck.id) } })).toBe(1);

    // La alerta se cierra y las demás siguen su curso.
    start = new Date(later.getTime() + DAY);
    await drain();
    await run('INVOICE_SUBMIT', invoiceSubmitHandler, new Date(start.getTime() + 11 * MINUTE), jobDeps);
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `INVOICE_STUCK:${stuck.id}` } })).status).toBe('RESOLVED');
    expect(await db.invoice.count({ where: { verifactuStatus: 'PENDING' } })).toBe(0);
  });

  it('«el proveedor no la tiene» devuelve la factura a la cola de envío', async () => {
    const organization = await createOrganization(db);
    const invoice = await issueInvoice(db, invoiceInput(organization.id));
    await db.invoice.update({ where: { id: invoice.id }, data: { verifactuStatus: 'SENT', sentAt: new Date() } });
    const { actor: admin } = await verifiedSuperadmin(db);
    await resolveUnknownInvoice(db, admin, invoice.id, { registered: false });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ verifactuStatus: 'PENDING', sentAt: null });
  });
});

describe('decisión del 01-11-2026 · un evento ya celebrado no se reabre por un contracargo', () => {
  const bankDate = (date: Date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);

  async function reachedEvent(closesAt: Date, format: 'TICKETING' | 'BUDGET') {
    const { organization, initiative } = await setup({ format, goalCents: 2_000 });
    const donations = [await paidDonation(organization.id, initiative.id, 1_000), await paidDonation(organization.id, initiative.id, 1_000)];
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('GOAL_REACHED');
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt } });
    return { organization, initiative, donations };
  }

  it('con el evento ya celebrado, la iniciativa sigue en GOAL_REACHED y se liquida lo recaudado', async () => {
    const closesAt = new Date(Date.now() - 2 * DAY);
    const { initiative, donations } = await reachedEvent(closesAt, 'TICKETING');
    // La fecha del banco es anterior al evento, pero se procesa después: lo que cuenta es cuándo se procesa.
    expect(await deliver('CHARGEBACK', donations[0]!.paycometOrder!, 1_000, { bankDateTime: bankDate(new Date(closesAt.getTime() - DAY)) })).toMatchObject({ status: 200 });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'GOAL_REACHED', raisedCents: 1_000 });
  });

  it('un evento que aún no se ha celebrado, o una campaña de presupuesto, sí vuelven a recaudar', async () => {
    const future = await reachedEvent(new Date(Date.now() + 10 * DAY), 'TICKETING');
    await deliver('CHARGEBACK', future.donations[0]!.paycometOrder!, 1_000);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: future.initiative.id } })).status).toBe('FUNDRAISING');

    const closesAt = new Date(Date.now() - 2 * DAY);
    const budget = await reachedEvent(closesAt, 'BUDGET');
    await deliver('CHARGEBACK', budget.donations[0]!.paycometOrder!, 1_000, { bankDateTime: bankDate(new Date(closesAt.getTime() + HOUR)) });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: budget.initiative.id } })).status).toBe('FUNDRAISING');
  });

  /** Campaña lograda con su liquidación firmada por dos personas distintas; después sube la meta por encima de lo recaudado. */
  async function signedPayout(format: 'TICKETING' | 'BUDGET', closesAt: Date) {
    const { organization, initiative } = await setup({ format, goalCents: 3_000, bracketFeeCents: 200, gatewayFeeCents: 100, closesAt });
    for (let i = 0; i < 3; i += 1) await paidDonation(organization.id, initiative.id, 1_000, { createdAt: new Date() });
    await db.initiative.update({ where: { id: initiative.id }, data: { goalCents: 5_000 } });
    const payout = await db.escrowPayout.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, destinationType: 'ORGANIZATION', beneficiaryName: 'AFA', beneficiaryIban: 'ES0000000000000000000000', netPaidCents: 2_700, korumFeeSettledCents: 200 }
    });
    for (const role of ['DIRECTOR', 'COSIGNER'] as const) {
      const user = await createUser(db);
      const membership = await db.organizationMember.create({ data: { organizationId: organization.id, userId: user.id, role } });
      const signedAt = new Date(Date.now() - HOUR);
      const signatureHash = computeSignatureHash(HMAC_SECRET, { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: payoutTargetDigest(HMAC_SECRET, payout, organization.paycometSplitId), signerUserId: user.id, signerRole: role, membershipId: membership.id, signedAt, otpVerifiedAt: signedAt });
      await db.doubleCheckSignature.create({ data: { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: user.id, signerRole: role, signatureHash, otpVerifiedAt: signedAt, signedAt } });
    }
    return payout;
  }

  it('la liquidación de un evento celebrado se aprueba aunque no llegue a la meta; la de uno futuro o la de presupuesto, no', async () => {
    const past = new Date(Date.now() - DAY);
    const held = await signedPayout('TICKETING', past);
    await approvePayout(db, held.id, HMAC_SECRET, new Date());
    expect((await db.escrowPayout.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('APPROVED');

    const upcoming = await signedPayout('TICKETING', new Date(Date.now() + 10 * DAY));
    await expect(approvePayout(db, upcoming.id, HMAC_SECRET, new Date())).rejects.toThrow(/meta/);
    const budget = await signedPayout('BUDGET', past);
    await expect(approvePayout(db, budget.id, HMAC_SECRET, new Date())).rejects.toBeInstanceOf(PayoutNotAllowedError);
  });
});

describe('límite de peticiones de firma', () => {
  it('quien pide enlace y código demasiadas veces seguidas queda bloqueado un rato, y queda en la auditoría', async () => {
    const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    const director = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
    const actor = { kind: 'user' as const, userId: director.id, isSuperadmin: false, memberships: [{ organizationId: organization.id, role: 'DIRECTOR' as const }], secondFactor: true };
    const idea = await db.idea.create({ data: { organizationId: organization.id, alias: uniqueId('#FAM'), authorCanonicalEmail: `${uniqueId('autor')}@pruebas.example`, title: 'Taller', category: 'Cultura', description: 'x', phase: 'DOUBLE_CHECK', verifiedVotes: 5, expiresAt: new Date(Date.now() + DAY) } });
    const target = { targetType: 'IDEA_APPROVAL' as const, ideaId: idea.id };
    const now = new Date();

    for (let i = 0; i < 5; i += 1) await requestSignature(db, HMAC_SECRET, actor, organization.id, target, now);
    await expect(requestSignature(db, HMAC_SECRET, actor, organization.id, target, now)).rejects.toMatchObject({ reason: 'RATE_LIMITED' });
    await expect(requestSignature(db, HMAC_SECRET, actor, organization.id, target, now)).rejects.toBeInstanceOf(DoubleCheckNotAllowedError);
    expect(await db.auditLog.count({ where: { action: 'double_check.request_rate_limited', organizationId: organization.id } })).toBe(2);
    // Pasada la ventana, vuelve a poder pedirlo.
    const challenge = await requestSignature(db, HMAC_SECRET, actor, organization.id, target, new Date(now.getTime() + 11 * MINUTE));
    // El código ya no se devuelve a quien llama: va por email.
    expect(challenge).not.toHaveProperty('otp');
    const sent = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId: actor.userId }, orderBy: { id: 'desc' } });
    expect((sent.payloadJson as { otp: string }).otp).toMatch(/^\d{6}$/);
  });
});

describe('MASS_REFUND · espera entre intentos, configuración y restos en la hucha', () => {
  const ctx = (now: Date, jobDeps: JobDeps = mockDeps) => ({ db, now, batchSize: 25, deps: jobDeps });

  async function refundingWithOneDonation() {
    const { organization, initiative } = await setup();
    const donation = await paidDonation(organization.id, initiative.id);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    return { organization, initiative, donation };
  }

  it('una devolución rechazada espera su turno: no se vuelve a pedir antes de 10, 20, 40 y 80 minutos', async () => {
    const t0 = new Date(Date.now() + 20 * DAY);
    const { donation } = await refundingWithOneDonation();
    const order = donation.paycometOrder!;
    refundFailures.set(order, new PaymentProviderError('rechazada', 'MOCK_REJECT'));
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MINUTE);

    await massRefundHandler(ctx(at(0)));
    expect(refundAttempts.get(order)).toBe(1);
    const early = await massRefundHandler(ctx(at(9)));
    expect(refundAttempts.get(order)).toBe(1);
    expect(early.detail?.waiting).toBeGreaterThanOrEqual(1);

    await massRefundHandler(ctx(at(11)));
    expect(refundAttempts.get(order)).toBe(2);
    await massRefundHandler(ctx(at(11 + 19)));
    expect(refundAttempts.get(order)).toBe(2);
    await massRefundHandler(ctx(at(11 + 21)));
    expect(refundAttempts.get(order)).toBe(3);
    await massRefundHandler(ctx(at(32 + 39)));
    expect(refundAttempts.get(order)).toBe(3);
    await massRefundHandler(ctx(at(32 + 41)));
    expect(refundAttempts.get(order)).toBe(4);
  });

  it('agotados los intentos queda en la consola, y una persona puede reactivarla con registro en la auditoría', async () => {
    const t0 = new Date(Date.now() + 22 * DAY);
    const { donation } = await refundingWithOneDonation();
    const order = donation.paycometOrder!;
    refundFailures.set(order, new PaymentProviderError('rechazada', 'MOCK_REJECT'));
    let now = t0;
    for (let attempt = 1; attempt <= MAX_REFUND_ATTEMPTS; attempt += 1) {
      await massRefundHandler(ctx(now));
      expect(refundAttempts.get(order)).toBe(attempt);
      now = new Date(now.getTime() + 11 * MINUTE * 2 ** (attempt - 1));
    }
    await massRefundHandler(ctx(new Date(now.getTime() + 30 * DAY)));
    expect(refundAttempts.get(order)).toBe(MAX_REFUND_ATTEMPTS);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${donation.id}` } })).toMatchObject({ status: 'OPEN', occurrences: MAX_REFUND_ATTEMPTS });

    // Paycomet ya funciona y una persona la reactiva.
    refundFailures.delete(order);
    const { actor: admin } = await verifiedSuperadmin(db, now);
    expect(await reactivateRejectedRefund(db, admin, donation.id, now)).toBe(true);
    await massRefundHandler(ctx(now));
    expect(await statusOf(donation.id)).toBe('REFUNDED');
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${donation.id}` } })).toMatchObject({ status: 'RESOLVED' });
    expect(await db.auditLog.count({ where: { action: 'payment.refund_reactivated', targetId: String(donation.id) } })).toBe(1);
  });

  it('sin la IP del servidor la tarea falla entera y no gasta intentos de ninguna devolución', async () => {
    const now = new Date(Date.now() + 24 * DAY);
    const { donation } = await refundingWithOneDonation();
    const misconfigured = deps(async () => mock);
    misconfigured.refundOriginalIp = async () => Promise.reject(new PaymentConfigurationError(['paycomet.serverIp']));
    const results = await run('MASS_REFUND', massRefundHandler, now, misconfigured);
    expect(results).toMatchObject([{ outcome: 'RETRY', error: expect.stringContaining('PaymentConfigurationError') }]);
    expect(await statusOf(donation.id)).toBe('COMPLETED');
    expect(refundAttempts.get(donation.paycometOrder!)).toBeUndefined();
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `REFUND_REJECTED:${donation.id}` } })).toBeNull();
  });

  it('al cerrar una campaña devuelta que conserva dinero en la hucha que no es de donantes, avisa', async () => {
    const start = new Date(Date.now() + 26 * DAY);
    const { organization, initiative, donation } = await refundingWithOneDonation();
    await postJournal(db, {
      idempotencyKey: uniqueId('sobrante'),
      kind: 'PAYIN_SPONSOR',
      description: 'Patrocinio de prueba que no se devuelve con MASS_REFUND',
      organizationId: organization.id,
      initiativeId: initiative.id,
      createdById: 'system',
      lines: [
        { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 25_000 },
        { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 25_000, organizationId: organization.id, initiativeId: initiative.id }
      ]
    });
    for (let step = 0; step < 6; step += 1) {
      await massRefundHandler(ctx(new Date(start.getTime() + step * 11 * MINUTE)));
      if ((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status === 'REFUNDED') break;
    }
    expect(await statusOf(donation.id)).toBe('REFUNDED');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('REFUNDED');
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `ESCROW_LEFTOVER:${initiative.id}` } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', organizationId: organization.id, detailJson: { balanceCents: 25_000 } });
  });

  it('cierra la alerta de rechazo si la devolución acabó hecha por otra vía', async () => {
    const now = new Date(Date.now() + 28 * DAY);
    const { donation } = await refundingWithOneDonation();
    refundFailures.set(donation.paycometOrder!, new PaymentProviderError('rechazada', 'MOCK_REJECT'));
    await massRefundHandler(ctx(now));
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${donation.id}` } })).status).toBe('OPEN');
    // Se devuelve desde el panel de Paycomet y llega su notificación.
    expect(await deliver('REFUND', donation.paycometOrder!, 2_500)).toMatchObject({ status: 200 });
    await massRefundHandler(ctx(new Date(now.getTime() + 11 * MINUTE)));
    expect(await statusOf(donation.id)).toBe('REFUNDED');
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${donation.id}` } })).status).toBe('RESOLVED');
  });
});

describe('PSP_RECONCILIATION · recuperación tras días sin ejecutarse', () => {
  it('desde la última conciliación buena, no solo las últimas 48 horas', async () => {
    const now = new Date(Date.now() + 30 * DAY);
    const { organization, initiative } = await setup();
    const fourDaysAgo = new Date(now.getTime() - 4 * DAY);
    const missed = await paidDonation(organization.id, initiative.id, 1_100, { createdAt: fourDaysAgo });
    mock.forgetCharge(missed.paycometOrder!);
    await db.platformSetting.upsert({ where: { key: LAST_RECONCILED_KEY }, create: { key: LAST_RECONCILED_KEY, valueJson: new Date(now.getTime() - 5 * DAY).toISOString() }, update: { valueJson: new Date(now.getTime() - 5 * DAY).toISOString() } });

    await run('PSP_RECONCILIATION', pspReconciliationHandler, now, mockDeps);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `RECONCILIATION_MISMATCH:MISSING_AT_PSP:${missed.paycometOrder!}` } })).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: LAST_RECONCILED_KEY } })).valueJson).toBe(now.toISOString());
  });

  it('si la tarea falla, la marca no avanza: la siguiente ejecución recupera lo que quedó sin conciliar', async () => {
    const now = new Date(Date.now() + 32 * DAY);
    const before = new Date(now.getTime() - 3 * DAY).toISOString();
    await db.platformSetting.upsert({ where: { key: LAST_RECONCILED_KEY }, create: { key: LAST_RECONCILED_KEY, valueJson: before }, update: { valueJson: before } });
    const broken = { listCharges: async () => Promise.reject(new PaymentProviderError('Paycomet caído', 'NETWORK', true)) } as unknown as PaymentProvider;
    expect(await run('PSP_RECONCILIATION', pspReconciliationHandler, now, deps(async () => broken))).toMatchObject([{ outcome: 'RETRY' }]);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: LAST_RECONCILED_KEY } })).valueJson).toBe(before);
  });
});

describe('MASS_REFUND · una aportación rota no hace fallar la tarea para siempre', () => {
  const ctx = (now: Date) => ({ db, now, batchSize: 25, deps: mockDeps });

  it('un fallo interno de una sola aportación cuenta como intento suyo, no frena a las demás y, agotado, se aparta', async () => {
    const t0 = new Date(Date.now() + 40 * DAY);
    const { organization, initiative } = await setup();
    const healthy = await paidDonation(organization.id, initiative.id);
    // Sin su asiento de cobro no se puede deshacer: falla por dentro, no por Paycomet.
    const broken = await db.contribution.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'DONATION', amountCents: 1_000, totalChargedCents: 1_000, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ROTA'), paycometAuthCode: 'A-ROTA', status: 'COMPLETED' }
    });
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });

    // La sana se devuelve en la misma pasada y la tarea no falla.
    await expect(massRefundHandler(ctx(t0))).resolves.toBeDefined();
    expect(await statusOf(healthy.id)).toBe('REFUNDED');
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${broken.id}` } })).toMatchObject({ status: 'OPEN', occurrences: 1, detailJson: { code: 'PaymentReconciliationError' } });

    // Los siguientes intentos respetan la espera; al quinto se aparta y la tarea deja de fallar por ella.
    let now = t0;
    for (let attempt = 2; attempt <= MAX_REFUND_ATTEMPTS; attempt += 1) {
      now = new Date(now.getTime() + 11 * MINUTE * 2 ** (attempt - 2));
      await massRefundHandler(ctx(now)).catch(() => undefined);
    }
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${broken.id}` } })).occurrences).toBe(MAX_REFUND_ATTEMPTS);
    await expect(massRefundHandler(ctx(new Date(now.getTime() + 30 * DAY)))).resolves.toBeDefined();
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_REJECTED:${broken.id}` } })).occurrences).toBe(MAX_REFUND_ATTEMPTS);
    // Nunca llegó a moverse dinero por ella.
    expect(refundsOf(broken.paycometOrder!)).toBe(0);
    expect(await statusOf(broken.id)).toBe('COMPLETED');
  });
});
