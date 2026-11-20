import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance } from '@/core/finance/ledger.service';
import { reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { massRefundHandler } from '@/core/jobs/handlers/mass-refund';
import { supporterBroadcastHandler } from '@/core/jobs/handlers/supporter-broadcast';
import type { JobDeps } from '@/core/jobs/job-types';
import { payoutFigures } from '@/core/payouts/campaign-payout-rules';
import { purgeOldGateReadings } from '@/core/privacy/retention-purge';
import { computeSignatureHash, payoutDigestFor } from '@/core/security/signature-hash';
import { madridIsoDate } from '@/core/studio/studio-draft';
import { GatePinNotAllowedError, openGateSession, setGatePin } from '@/core/ticketing/gate-session.service';
import { buildPassQrPayload, signPassView } from '@/core/ticketing/qr-signature';
import { lookupVoucherBalance, redeemVouchers } from '@/core/ticketing/voucher-redemption.service';
import { reserveVouchers } from '@/core/ticketing/voucher-reservation.service';
import { VoucherSaleChangeError } from '@/core/ticketing/voucher-lifecycle-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadGateAdmin } from '@/repositories/gate-admin.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { PaymentProviderError } from '@/services/payments/payment-provider';
import { resolveStuckRefund } from '@/services/admin/console-alerts.service';
import { executePendingPartialRefunds } from '@/services/ticketing/voucher-cancel-refunds';
import { executePartialRefund } from '@/services/payments/partial-refunds';
import { executePendingRefund } from '@/services/payments/payment-reversals';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { approvePayout, executeApprovedPayout } from '@/services/payments/split-transfer.service';
import { payoutBlockers } from '@/services/payouts/payout-readiness';
import { claimVoucherRefund, loadVoucherRefund, VoucherRefundError } from '@/services/ticketing/voucher-refund.service';
import { cancelVoucherSale, changeVoucherDates } from '@/services/ticketing/voucher-sale.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, testJobDeps, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.14c · Vales después de publicarse, contra PostgreSQL real (QA-VAL04 y QA-VAL05; decisiones 32, 66, 67 y 68 del promotor):
 *
 * - Devolución de 14 días: el día 3 y sin gastar, el 100 % con un clic, con su contra-asiento; con un vale gastado o el día 15, no.
 * - Puesto: el PIN vale hasta la validez de los vales (también con la venta cerrada o liquidada), se lee el saldo y se descuenta lo tecleado.
 * - Recordatorio una semana antes de caducar, solo a quien tiene vales sin gastar y una vez por fecha.
 * - Al cerrarse, se liquida por lo vendido (mantenimiento proporcional a los vales vendidos) cuando pasan los 14 días de devolución de todas las compras.
 * - Cancelar antes de liquidar (decisión 69): los vales dejan de valer y la plataforma devuelve a cada persona lo no gastado (el 100 % si no gastó nada; la parte
 *   proporcional si gastó algo), con sus asientos; lo gastado se liquida a la entidad. Después de liquidar: avisa de que responde la entidad y no mueve dinero.
 * - Cambiar las fechas avisa a quien tiene vales si cambia la validez; acortarla abre 14 días para recuperar lo no gastado y la liquidación espera; ya
 *   liquidada, la validez solo se alarga.
 * - Un contracargo de un cobro ya devuelto en parte se revisa a mano.
 * - Los canjes y las sesiones del puesto se borran al año de liquidarse la venta.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-ciclo-vales' };
const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-ciclo-vales-01';
const PIN_SECRET = 'secreto-de-integracion-del-puesto-ciclo-vales-012345';
const SIGNATURE_SECRET = 'secreto-de-integracion-de-las-firmas-ciclo-vales-01';
const DAY = 86_400_000;
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let jobDeps: JobDeps;
const created: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  jobDeps = { ...testJobDeps(), paymentProvider: async () => mock, invoicingProvider: () => { throw new Error('sin facturación'); }, refundOriginalIp: async () => '10.0.0.1' };
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: created }, status: 'PENDING' } });
  await db.$disconnect();
});

const actorFor = (userId: string, organizationId: string, role: 'DIRECTOR' | 'COSIGNER', secondFactor = true): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor });

/** Entidad verificada con sus dos firmantes y una venta de vales de 2 € (gestión 45 cts por compra + 2 %) con 30 € de mantenimiento, a la venta. */
async function voucherSale(options: { ticketMax?: number | null; validInDays?: number; maintFeeCents?: number; noProduct?: boolean } = {}) {
  const organization = await createOrganization(db, { customRules: true, paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', maintAnnualCapCents: 100_000, voucherFeeFixedCents: 45, voucherFeeBps: 200, ticketFeeFixedCents: 30, ticketFeeBps: 0 });
  created.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  const ticketMax = options.ticketMax === undefined ? 100 : options.ticketMax;
  const initiative = await createInitiative(db, organization.id, {
    status: 'FUNDRAISING',
    format: 'TICKETING',
    category: 'Taquilla',
    title: 'Fichas de la feria de primavera',
    ticketSubtype: 'VOUCHER',
    ticketPriceCents: 200,
    ticketMax,
    ticketFeeMode: 'ADD',
    goalCents: 200 * (ticketMax ?? 150),
    voucherTargetCount: ticketMax === null ? 150 : null,
    voucherValidUntil: new Date(Date.now() + (options.validInDays ?? 40) * DAY),
    maintFeeCents: options.maintFeeCents ?? 3_000,
    voucherNoProductEnabled: options.noProduct ?? false
  });
  await reserveInitiativeQuotas(db, initiative.id);
  return {
    organization,
    initiative,
    director: actorFor(director.id, organization.id, 'DIRECTOR'),
    cosigner: actorFor(cosigner.id, organization.id, 'COSIGNER'),
    sale: { organizationId: organization.id, initiativeId: initiative.id }
  };
}

const deliver = (order: string, amountCents: number) => {
  const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order, amountCents });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET });
};

async function buy(initiativeId: number, quantity: number, email = `${uniqueId('familia')}@pruebas.example`) {
  const reservation = await reserveVouchers(db, { initiativeId, quantity, mode: 'VOUCHERS', buyer: { guestEmail: email }, paymentMethod: 'BIZUM' });
  expect(await deliver(reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  const pass = await db.ticketPass.findUniqueOrThrow({ where: { contributionId: reservation.contributionId } });
  return { reservation, pass, email };
}

async function standFor(organizationId: string, initiativeId: number, signer: SessionActor): Promise<SessionActor> {
  const { pin } = await setGatePin(db, PIN_SECRET, signer, organizationId, initiativeId);
  const opened = await openGateSession(db, PIN_SECRET, { initiativeId, pin, requestMeta: { ipHash: uniqueId('ip') } });
  if (opened.status !== 'OPENED') throw new Error(`No se abrió el puesto: ${opened.status}`);
  return { kind: 'gate', gateSessionId: opened.gateSessionId, organizationId, initiativeId };
}

const spend = (stand: SessionActor, sale: { organizationId: string; initiativeId: number }, uuid: string, quantity: number) => redeemVouchers(db, QR_SECRET, stand, sale, buildPassQrPayload(QR_SECRET, uuid), quantity, uniqueId('canje'));

const refundPayload = async (organizationId: string, uuid: string) => {
  const { slug } = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } });
  return { orgSlug: slug, passUuid: uuid, sig: signPassView(QR_SECRET, uuid) };
};

/** Liquidación firmada por las dos personas con las cifras de ahora (lo que pide y firma el panel). */
async function signedPayout(organizationId: string, initiativeId: number) {
  const initiative = await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } });
  const figures = payoutFigures(initiative);
  const payout = await db.escrowPayout.create({ data: { organizationId, initiativeId, destinationType: 'ORGANIZATION', beneficiaryName: 'Entidad', netPaidCents: figures.netPaidCents, korumFeeSettledCents: figures.korumFeeSettledCents } });
  const { paycometSplitId } = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { paycometSplitId: true } });
  const digest = payoutDigestFor(SIGNATURE_SECRET, { ...payout, providerInvoiceFile: null }, paycometSplitId);
  const members = await db.organizationMember.findMany({ where: { organizationId, role: { in: ['DIRECTOR', 'COSIGNER'] } } });
  for (const membership of members) {
    const role = membership.role as 'DIRECTOR' | 'COSIGNER';
    const signedAt = new Date();
    const otpVerifiedAt = new Date();
    const signatureHash = computeSignatureHash(SIGNATURE_SECRET, { organizationId, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: digest, signerUserId: membership.userId, signerRole: role, membershipId: membership.id, signedAt, otpVerifiedAt });
    await db.doubleCheckSignature.create({ data: { organizationId, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: membership.userId, signerRole: role, signatureHash, targetDigest: digest, membershipId: membership.id, signedAt, otpVerifiedAt } });
  }
  return payout;
}

const readiness = async (initiativeId: number, now: Date) => {
  const initiative = await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } });
  const organization = await db.organization.findUniqueOrThrow({ where: { id: initiative.organizationId } });
  return payoutBlockers(db, initiative, organization, { destination: 'ORGANIZATION', payoutId: null, now });
};

/** Cierra la venta (su último día pasa a hace un minuto) con la tarea diaria. */
async function closeSale(initiativeId: number) {
  await db.initiative.update({ where: { id: initiativeId }, data: { closesAt: new Date(Date.now() - 60_000) } });
  await campaignExpiryHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
  return db.initiative.findUniqueOrThrow({ where: { id: initiativeId } });
}

/** Liquida de verdad: firmas, aprobación (pasados los 14 días) y reparto simulado. */
async function settle(organizationId: string, initiativeId: number, at: Date) {
  const payout = await signedPayout(organizationId, initiativeId);
  expect(await approvePayout(db, payout.id, SIGNATURE_SECRET, at)).toMatchObject({ approved: true });
  expect((await executeApprovedPayout(db, mock, payout.id, at)).status).toBe('EXECUTED');
  return payout;
}

const outboxFor = (templateKey: string, initiativeId: number) => db.outboxMessage.findMany({ where: { templateKey, idempotencyKey: { startsWith: `${templateKey}:${initiativeId}:` } } });
const broadcasts = () => supporterBroadcastHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });

describe('QA-VAL04 · devolución de 14 días', () => {
  it('el día 3 y sin gastar: el 100 % con un clic, automático y con su contra-asiento; los vales dejan de valer', async () => {
    const { organization, initiative, sale, director } = await voucherSale();
    const { reservation, pass } = await buy(initiative.id, 5);
    const day3 = new Date(pass.issuedAt.getTime() + 3 * DAY);
    expect(await loadVoucherRefund(db, pass.uuid, day3)).toMatchObject({ block: null, amountCents: reservation.totalChargedCents });

    const receipt = await claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, await refundPayload(organization.id, pass.uuid), { ip: '10.0.0.9' }, day3);
    expect(receipt).toEqual({ contributionId: reservation.contributionId, refundedCents: 1_065, partial: false });
    expect(await executePendingRefund(db, mock, reservation.contributionId, '10.0.0.1')).toMatchObject({ refunded: true });
    expect(mock.calls.filter((call) => call.operation === 'refund' && call.order === reservation.paycometOrder).map((call) => call.amountCents)).toEqual([1_065]);

    const contribution = await db.contribution.findUniqueOrThrow({ where: { id: reservation.contributionId }, include: { ticketPass: true } });
    expect(contribution).toMatchObject({ status: 'REFUNDED', refundedCents: 1_065 });
    expect(contribution.ticketPass?.revokedAt).not.toBeNull();
    const refundJournals = await db.ledgerJournal.findMany({ where: { contributionId: reservation.contributionId, kind: 'ESCROW_REFUND_DONOR' }, include: { entries: true } });
    expect(refundJournals).toHaveLength(2);
    for (const journal of refundJournals) {
      const debit = journal.entries.filter((entry) => entry.direction === 'DEBIT').reduce((total, entry) => total + entry.amountCents, 0);
      expect(debit).toBe(journal.entries.filter((entry) => entry.direction === 'CREDIT').reduce((total, entry) => total + entry.amountCents, 0));
    }
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ ticketsSold: 0, raisedCents: 0 });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { organizationId: organization.id, initiativeId: initiative.id })).balanceCents).toBe(0);
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `refund.issued:${reservation.contributionId}` } })).toBe(1);
    // En el puesto ya no se gasta, y la auditoría guarda la serie y el importe, nunca quién.
    const stand = await standFor(organization.id, initiative.id, director);
    expect(await spend(stand, sale, pass.uuid, 1)).toEqual({ status: 'REVOKED' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'voucher.purchase_refunded', targetId: String(initiative.id) } });
    expect(audit.metadataJson).toEqual({ serialCode: pass.serialCode, vouchers: 5, refundedCents: 1_065, kind: 'FULL' });
    // Pedirla otra vez no devuelve dos veces.
    await expect(claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, await refundPayload(organization.id, pass.uuid), { ip: '10.0.0.9' }, day3)).rejects.toMatchObject({ reason: 'ALREADY_REFUNDED' });
  });

  it('con un vale gastado se rechaza con un mensaje claro; el día 15, también', async () => {
    const { organization, initiative, sale, director } = await voucherSale();
    const spent = await buy(initiative.id, 3);
    const late = await buy(initiative.id, 2);
    const stand = await standFor(organization.id, initiative.id, director);
    expect(await spend(stand, sale, spent.pass.uuid, 1)).toMatchObject({ status: 'REDEEMED', balance: 2 });
    const day3 = new Date(spent.pass.issuedAt.getTime() + 3 * DAY);
    await expect(claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, await refundPayload(organization.id, spent.pass.uuid), { ip: '10.0.0.9' }, day3)).rejects.toMatchObject({ reason: 'SPENT' });
    const day15 = new Date(late.pass.issuedAt.getTime() + 15 * DAY);
    expect(await loadVoucherRefund(db, late.pass.uuid, day15)).toMatchObject({ block: 'WINDOW_CLOSED' });
    await expect(claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, await refundPayload(organization.id, late.pass.uuid), { ip: '10.0.0.9' }, day15)).rejects.toMatchObject({ reason: 'WINDOW_CLOSED' });
    // Nada se ha devuelto.
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, status: { not: 'COMPLETED' } } })).toBe(0);
  });

  it('un enlace sin la firma del pase, de otra entidad o de una entrada no devuelve nada', async () => {
    const { organization, initiative } = await voucherSale();
    const { pass } = await buy(initiative.id, 1);
    const other = await voucherSale();
    const good = await refundPayload(organization.id, pass.uuid);
    const attempt = (payload: unknown) => claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, payload, { ip: '10.0.0.9' });
    await expect(attempt({ ...good, sig: signPassView(QR_SECRET, '00000000-0000-4000-8000-000000000000') })).rejects.toBeInstanceOf(VoucherRefundError);
    await expect(attempt({ ...good, orgSlug: (await refundPayload(other.organization.id, pass.uuid)).orgSlug })).rejects.toMatchObject({ reason: 'INVALID_LINK' });
    await expect(attempt({ ...good, extra: 1 })).rejects.toMatchObject({ reason: 'INVALID_LINK' });
    expect((await db.contribution.findUniqueOrThrow({ where: { id: pass.contributionId } })).status).toBe('COMPLETED');
  });
});

describe('QA-VAL05 · puesto, caducidad, cierre, cancelación y liquidación', () => {
  it('el PIN del puesto vale hasta la validez de los vales; el lector enseña lo que queda y descuenta lo tecleado', async () => {
    const { organization, initiative, sale, director } = await voucherSale({ validInDays: 200 });
    const { pass } = await buy(initiative.id, 6);
    const { expiresAt } = await setGatePin(db, PIN_SECRET, director, organization.id, initiative.id);
    const { voucherValidUntil } = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(expiresAt).toEqual(voucherValidUntil);
    const stand = await standFor(organization.id, initiative.id, director);
    const session = await db.gateSession.findUniqueOrThrow({ where: { id: (stand as { gateSessionId: string }).gateSessionId } });
    // Cada móvil vuelve a teclear el PIN cada 48 h, aunque el PIN dure meses.
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeLessThanOrEqual(48 * 3_600_000);
    expect(await lookupVoucherBalance(db, QR_SECRET, stand, sale, buildPassQrPayload(QR_SECRET, pass.uuid))).toMatchObject({ status: 'OK', balance: 6, quantity: 6 });
    expect(await spend(stand, sale, pass.uuid, 4)).toMatchObject({ status: 'REDEEMED', spent: 4, balance: 2 });
    expect(await lookupVoucherBalance(db, QR_SECRET, stand, sale, buildPassQrPayload(QR_SECRET, pass.uuid))).toMatchObject({ status: 'OK', balance: 2 });
    // Gastado del todo, la lectura lo dice: no hay nada que teclear.
    expect(await spend(stand, sale, pass.uuid, 2)).toMatchObject({ status: 'REDEEMED', balance: 0 });
    expect(await lookupVoucherBalance(db, QR_SECRET, stand, sale, buildPassQrPayload(QR_SECRET, pass.uuid))).toEqual({ status: 'EXHAUSTED' });
    // «Taquilla y portería» ya la lista como venta de vales, con su validez.
    const card = (await loadGateAdmin(db, director, organization.id)).find((row) => row.id === initiative.id);
    expect(card).toMatchObject({ kind: 'VOUCHER', pinActive: true, voucher: { cancelled: false, canChange: true, canChangeClose: true, validDay: madridIsoDate(voucherValidUntil!) } });
  });

  it('una semana antes de caducar sale el recordatorio, solo a quien tiene vales sin gastar y una sola vez', async () => {
    const { organization, initiative, sale, director } = await voucherSale({ validInDays: 5 });
    const withVouchers = await buy(initiative.id, 2);
    const allSpent = await buy(initiative.id, 1);
    const stand = await standFor(organization.id, initiative.id, director);
    expect(await spend(stand, sale, allSpent.pass.uuid, 1)).toMatchObject({ status: 'REDEEMED', balance: 0 });
    await broadcasts();
    await broadcasts();
    const reminders = await outboxFor('voucher.expiryReminder', initiative.id);
    expect(reminders.map((row) => row.toAddress)).toEqual([withVouchers.email]);
    expect(reminders[0]!.payloadJson).toMatchObject({ initiativeId: initiative.id });
  });

  it('al cerrarse se liquida por lo vendido, con el mantenimiento proporcional, cuando pasan los 14 días de devolución de todas las compras', async () => {
    const { organization, initiative } = await voucherSale({ ticketMax: 100, maintFeeCents: 3_000 });
    const first = await buy(initiative.id, 20);
    await buy(initiative.id, 5);
    const closed = await closeSale(initiative.id);
    // 25 de 100 vales: una cuarta parte del mantenimiento (decisión 66).
    expect(closed).toMatchObject({ status: 'GOAL_REACHED', ticketsSold: 25, raisedCents: 5_000, maintFeeCents: 750 });
    expect(await db.outboxMessage.count({ where: { templateKey: 'voucher.saleClosed', idempotencyKey: { startsWith: `voucher.saleClosed:${initiative.id}:` } } })).toBe(2);

    // Mientras alguna compra pueda pedir su devolución, no se liquida: ni el panel ni la aprobación.
    expect(await readiness(initiative.id, new Date())).toContain('REFUND_WINDOW_OPEN');
    const early = await signedPayout(organization.id, initiative.id);
    await expect(approvePayout(db, early.id, SIGNATURE_SECRET, new Date())).rejects.toMatchObject({ code: 'REFUND_WINDOW_OPEN' });

    // Pasados los 14 días de la última compra, sí.
    const after = new Date(first.pass.issuedAt.getTime() + 15 * DAY);
    expect(await readiness(initiative.id, after)).not.toContain('REFUND_WINDOW_OPEN');
  });

  it('se liquida de verdad y los vales siguen valiendo en el puesto después', async () => {
    const { organization, initiative, sale, director } = await voucherSale({ ticketMax: 100, maintFeeCents: 3_000 });
    const { pass } = await buy(initiative.id, 50);
    await closeSale(initiative.id);
    await settle(organization.id, initiative.id, new Date(pass.issuedAt.getTime() + 15 * DAY));
    const settled = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(settled.status).toBe('CLOSED');
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { organizationId: organization.id, initiativeId: initiative.id })).balanceCents).toBe(0);
    // El PIN se crea también con la venta liquidada: los vales valen hasta su fecha.
    const stand = await standFor(organization.id, initiative.id, director);
    expect(await spend(stand, sale, pass.uuid, 3)).toMatchObject({ status: 'REDEEMED', balance: 47 });
  });

  it('sin nada vendido, se cierra sin dinero y los cupos vuelven a la entidad', async () => {
    const { initiative } = await voucherSale();
    const closed = await closeSale(initiative.id);
    expect(closed.status).toBe('CANCELLED');
    expect(closed.quotaReleasedAt).not.toBeNull();
  });

  it('cancelar antes de liquidar: los vales dejan de valer, la plataforma devuelve lo no gastado de cada compra y lo gastado se liquida a la entidad', async () => {
    const { organization, initiative, sale, director, cosigner } = await voucherSale({ ticketMax: 100, maintFeeCents: 3_000 });
    const partial = await buy(initiative.id, 10);
    const untouched = await buy(initiative.id, 10);
    const exhausted = await buy(initiative.id, 2);
    const stand = await standFor(organization.id, initiative.id, director);
    await spend(stand, sale, partial.pass.uuid, 3);
    await spend(stand, sale, exhausted.pass.uuid, 2);

    const receipt = await cancelVoucherSale(db, cosigner, organization.id, { initiativeId: initiative.id });
    expect(receipt).toMatchObject({ status: 'GOAL_REACHED', settled: false });
    const cancelled = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(cancelled.voucherCancelledAt).not.toBeNull();
    expect(cancelled).toMatchObject({ status: 'GOAL_REACHED', gatePinHash: null });
    expect(cancelled.closesAt.getTime()).toBeLessThanOrEqual(Date.now());
    // El puesto se cierra y los vales no se gastan, ni con quien firma.
    expect(await db.gateSession.count({ where: { initiativeId: initiative.id, revokedAt: null } })).toBe(0);
    expect(await spend(director, sale, untouched.pass.uuid, 1)).toEqual({ status: 'SALE_CANCELLED' });
    await expect(setGatePin(db, PIN_SECRET, director, organization.id, initiative.id)).rejects.toBeInstanceOf(GatePinNotAllowedError);
    // Hasta que la plataforma devuelva lo no gastado no hay nada que liquidar.
    expect(await readiness(initiative.id, new Date(exhausted.pass.issuedAt.getTime() + 15 * DAY))).toContain('REFUND_WINDOW_OPEN');

    await massRefundHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
    // Sin gastar nada: el 100 %. Con 3 de 10 gastados: 7/10 de cada línea (14 € de vales y 60 cts de los 85 de gestión). Con todo gastado: nada.
    expect((await db.contribution.findUniqueOrThrow({ where: { id: untouched.reservation.contributionId } })).status).toBe('REFUNDED');
    const partialRefund = await db.partialRefund.findUniqueOrThrow({ where: { contributionId: partial.reservation.contributionId } });
    expect(partialRefund).toMatchObject({ reason: 'VOUCHER_SALE_CANCELLED', vouchers: 7, escrowCents: 1_400, feeCents: 60, amountCents: 1_460, status: 'REFUNDED' });
    expect(mock.calls.filter((call) => call.operation === 'refund' && call.order === partial.reservation.paycometOrder).map((call) => call.amountCents)).toEqual([1_460]);
    expect((await db.contribution.findUniqueOrThrow({ where: { id: partial.reservation.contributionId } })).status).toBe('COMPLETED');
    expect((await db.contribution.findUniqueOrThrow({ where: { id: exhausted.reservation.contributionId } })).status).toBe('COMPLETED');
    expect(await db.partialRefund.count({ where: { contributionId: exhausted.reservation.contributionId } })).toBe(0);
    // Queda lo gastado: 5 vales (10 €), con el mantenimiento en proporción (5 de 100), y la hucha coincide con lo recaudado.
    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after).toMatchObject({ status: 'GOAL_REACHED', ticketsSold: 5, raisedCents: 1_000, maintFeeCents: 150 });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { organizationId: organization.id, initiativeId: initiative.id })).balanceCents).toBe(1_000);
    for (const journal of await db.ledgerJournal.findMany({ where: { initiativeId: initiative.id }, include: { entries: true } })) {
      const debit = journal.entries.filter((entry) => entry.direction === 'DEBIT').reduce((total, entry) => total + entry.amountCents, 0);
      expect(debit, `asiento ${journal.kind}`).toBe(journal.entries.filter((entry) => entry.direction === 'CREDIT').reduce((total, entry) => total + entry.amountCents, 0));
    }
    // Avisos: a la otra persona firmante, uno por persona a quien se le devuelve algo (no a quien ya lo gastó todo) y «Devolución realizada» por lo devuelto.
    expect(await db.outboxMessage.count({ where: { templateKey: 'voucher.changed', idempotencyKey: { startsWith: `voucher.changed:${initiative.id}:cancel:` } } })).toBe(2);
    const notices = await outboxFor('voucher.cancelledBuyer', initiative.id);
    expect(notices.map((row) => row.toAddress).sort()).toEqual([partial.email, untouched.email].sort());
    expect(notices.every((row) => (row.payloadJson as { settled?: boolean }).settled === false)).toBe(true);
    expect((await db.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `refund.issued:${partial.reservation.contributionId}` } })).payloadJson).toMatchObject({ amountCents: 1_460 });
    // Repetir la tarea o el aviso de Paycomet no devuelve dos veces.
    await massRefundHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
    const { rawBody, contentType } = mock.buildNotification({ kind: 'REFUND', order: partial.reservation.paycometOrder, amountCents: 1_460 });
    expect(await handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET })).toMatchObject({ status: 200 });
    expect(mock.calls.filter((call) => call.operation === 'refund' && call.order === partial.reservation.paycometOrder)).toHaveLength(1);
    await expect(cancelVoucherSale(db, director, organization.id, { initiativeId: initiative.id })).rejects.toMatchObject({ reason: 'ALREADY_CANCELLED' });

    // Lo gastado se liquida a la entidad pasados los 14 días: 10 € menos 1,50 € de mantenimiento.
    expect(await readiness(initiative.id, new Date(exhausted.pass.issuedAt.getTime() + 15 * DAY))).not.toContain('REFUND_WINDOW_OPEN');
    const payout = await settle(organization.id, initiative.id, new Date(exhausted.pass.issuedAt.getTime() + 15 * DAY));
    expect(payout.netPaidCents).toBe(850);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('CLOSED');
  });

  it('cancelar con todo sin gastar: se devuelve todo y la venta se cierra sin nada que liquidar', async () => {
    const { organization, initiative, director } = await voucherSale();
    const first = await buy(initiative.id, 3);
    await buy(initiative.id, 2);
    await cancelVoucherSale(db, director, organization.id, { initiativeId: initiative.id });
    await massRefundHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
    const closed = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(closed).toMatchObject({ status: 'CANCELLED', raisedCents: 0, ticketsSold: 0 });
    expect(closed.quotaReleasedAt).not.toBeNull();
    expect((await db.contribution.findUniqueOrThrow({ where: { id: first.reservation.contributionId } })).status).toBe('REFUNDED');
  });

  it('un pago que se confirma con la venta ya cancelada se devuelve entero', async () => {
    const { organization, initiative, director } = await voucherSale();
    await buy(initiative.id, 1);
    const pending = await reserveVouchers(db, { initiativeId: initiative.id, quantity: 2, mode: 'VOUCHERS', buyer: { guestEmail: 'tarde@pruebas.example' }, paymentMethod: 'CARD' });
    await cancelVoucherSale(db, director, organization.id, { initiativeId: initiative.id });
    expect(await deliver(pending.paycometOrder, pending.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    const late = await db.contribution.findUniqueOrThrow({ where: { id: pending.contributionId }, include: { ticketPass: true } });
    expect(late.status).toBe('REFUND_PENDING');
    expect(late.ticketPass).toBeNull();
  });

  it('cancelar después de liquidar: el dinero ya está en la entidad; los vales dejan de valer, KORUM no mueve dinero y se avisa de que responde la entidad', async () => {
    const { organization, initiative, sale, director } = await voucherSale();
    const { pass, email } = await buy(initiative.id, 4);
    await closeSale(initiative.id);
    await settle(organization.id, initiative.id, new Date(pass.issuedAt.getTime() + 15 * DAY));
    const receipt = await cancelVoucherSale(db, director, organization.id, { initiativeId: initiative.id });
    expect(receipt).toMatchObject({ status: 'CLOSED', settled: true });
    expect(await spend(director, sale, pass.uuid, 1)).toEqual({ status: 'SALE_CANCELLED' });
    await broadcasts();
    const notices = await outboxFor('voucher.cancelledBuyer', initiative.id);
    expect(notices.map((row) => row.toAddress)).toEqual([email]);
    expect(notices[0]!.payloadJson).toMatchObject({ settled: true });
    await massRefundHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
    expect(await db.ledgerJournal.count({ where: { initiativeId: initiative.id, kind: 'ESCROW_REFUND_DONOR' } })).toBe(0);
  });

  it('cancelada después de liquidar, el aviso llega también a quien aportó «sin producto» (condiciones §4.6)', async () => {
    const { organization, initiative, director } = await voucherSale({ ticketMax: 2, noProduct: true, maintFeeCents: 0 });
    const { pass } = await buy(initiative.id, 2);
    const reservation = await reserveVouchers(db, { initiativeId: initiative.id, quantity: 1, mode: 'NO_PRODUCT', buyer: { guestEmail: 'sinproducto@pruebas.example' }, paymentMethod: 'BIZUM' });
    expect(await deliver(reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    await closeSale(initiative.id);
    await settle(organization.id, initiative.id, new Date(pass.issuedAt.getTime() + 15 * DAY));
    await cancelVoucherSale(db, director, organization.id, { initiativeId: initiative.id });
    await broadcasts();
    expect((await outboxFor('voucher.cancelledBuyer', initiative.id)).map((row) => row.toAddress)).toContain('sinproducto@pruebas.example');
  });

  it('una venta sin nada vendido que se cancela se cierra sin dinero y sin avisos a nadie que compró', async () => {
    const { organization, initiative, director } = await voucherSale();
    expect(await cancelVoucherSale(db, director, organization.id, { initiativeId: initiative.id })).toMatchObject({ status: 'CANCELLED' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).quotaReleasedAt).not.toBeNull();
    expect(await db.supporterBroadcast.count({ where: { initiativeId: initiative.id } })).toBe(0);
  });
});

describe('cambiar las fechas de una venta de vales', () => {
  it('alargar la validez avisa a quien tiene vales y el PIN del puesto la sigue; un segundo cambio vuelve a avisar', async () => {
    const { organization, initiative, director } = await voucherSale({ validInDays: 40 });
    const { email } = await buy(initiative.id, 2);
    await setGatePin(db, PIN_SECRET, director, organization.id, initiative.id);
    const later = madridIsoDate(new Date(Date.now() + 60 * DAY));
    const receipt = await changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: later });
    const changed = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(madridIsoDate(changed.voucherValidUntil!)).toBe(later);
    expect(changed.gatePinExpiresAt).toEqual(changed.voucherValidUntil);
    expect(receipt.validUntil).toEqual(changed.voucherValidUntil);
    await broadcasts();
    expect((await outboxFor('voucher.validityChanged', initiative.id)).map((row) => row.toAddress)).toEqual([email]);
    const sooner = madridIsoDate(new Date(Date.now() + 30 * DAY));
    await changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: sooner });
    await broadcasts();
    expect(await outboxFor('voucher.validityChanged', initiative.id)).toHaveLength(2);
    const audit = await db.auditLog.findMany({ where: { action: 'voucher.dates_changed', targetId: String(initiative.id) } });
    expect(audit.map((row) => (row.metadataJson as { validity: string }).validity).sort()).toEqual(['EXTENDED', 'SHORTENED']);
  });

  it('mover el cierre no avisa a quien compró; ya liquidada, la validez solo se alarga', async () => {
    const { organization, initiative, director } = await voucherSale({ validInDays: 40 });
    const { pass } = await buy(initiative.id, 2);
    const close = madridIsoDate(new Date(Date.now() + 20 * DAY));
    await changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, closeDay: close });
    await broadcasts();
    expect(await outboxFor('voucher.validityChanged', initiative.id)).toHaveLength(0);

    await closeSale(initiative.id);
    await settle(organization.id, initiative.id, new Date(pass.issuedAt.getTime() + 15 * DAY));
    const shorter = changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: madridIsoDate(new Date(Date.now() + 10 * DAY)) });
    await expect(shorter).rejects.toMatchObject({ reason: 'VALIDITY_SHORTER_AFTER_PAYOUT' });
    // Cerrada la venta, su último día ya no se mueve.
    await expect(changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, closeDay: close })).rejects.toMatchObject({ reason: 'CLOSE_NOT_CHANGEABLE' });
    await expect(changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: madridIsoDate(new Date(Date.now() + 90 * DAY)) })).resolves.toMatchObject({ status: 'CLOSED' });
  });
});

describe('acortar la validez abre 14 días para recuperar lo no gastado (decisión 69)', () => {
  it('quien compró antes recupera lo no gastado desde sus vales, la liquidación espera y el aviso lleva el enlace a sus vales', async () => {
    const { organization, initiative, sale, director } = await voucherSale({ validInDays: 40 });
    const spentSome = await buy(initiative.id, 4);
    const stand = await standFor(organization.id, initiative.id, director);
    await spend(stand, sale, spentSome.pass.uuid, 1);
    // Pasados sus propios 14 días ya no podría devolverla; el acortamiento le abre otros 14.
    const later = new Date(spentSome.pass.issuedAt.getTime() + 20 * DAY);
    expect(await loadVoucherRefund(db, spentSome.pass.uuid, later)).toMatchObject({ offer: null, block: 'SPENT' });
    // La venta cierra en 10 días: los vales pueden valer desde ese día.
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() + 10 * DAY) } });
    await changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: madridIsoDate(new Date(Date.now() + 20 * DAY)) });
    const shortenedAt = (await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).voucherValidityShortenedAt!;
    expect(shortenedAt).not.toBeNull();
    const view = await loadVoucherRefund(db, spentSome.pass.uuid);
    // 3 de 4 vales sin gastar: 6 € de vales y 3/4 de 61 cts de gestión (46).
    expect(view).toMatchObject({ offer: { kind: 'UNSPENT' }, vouchers: 3, amountCents: 646 });
    // Cerrada la venta, la liquidación espera a que termine el plazo de quien aún puede recuperar algo.
    await closeSale(initiative.id);
    expect(await readiness(initiative.id, new Date())).toContain('REFUND_WINDOW_OPEN');
    await broadcasts();
    const notice = (await outboxFor('voucher.validityChanged', initiative.id))[0]!;
    expect(notice.idempotencyKey).toContain(`:c${spentSome.reservation.contributionId}`);
    expect(notice.payloadJson).toMatchObject({ passUuid: spentSome.pass.uuid, refundUntil: new Date(shortenedAt.getTime() + 14 * DAY).toISOString() });

    const receipt = await claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, await refundPayload(organization.id, spentSome.pass.uuid), { ip: '10.0.0.9' });
    expect(receipt).toMatchObject({ partial: true, refundedCents: 646 });
    expect(await executePartialRefund(db, mock, receipt.contributionId, '10.0.0.1')).toMatchObject({ refunded: true });
    expect(await db.partialRefund.findUniqueOrThrow({ where: { contributionId: receipt.contributionId } })).toMatchObject({ reason: 'VOUCHER_VALIDITY_SHORTENED', status: 'REFUNDED', amountCents: 646 });
    expect(await spend(stand, sale, spentSome.pass.uuid, 1)).toEqual({ status: 'REVOKED' });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ ticketsSold: 1, raisedCents: 200 });
    // Ya no queda nadie a quien devolver: la liquidación deja de esperar.
    expect(await readiness(initiative.id, new Date(spentSome.pass.issuedAt.getTime() + 15 * DAY))).not.toContain('REFUND_WINDOW_OPEN');
  });

  it('un contracargo de un cobro ya devuelto en parte no se asienta a ciegas: se revisa a mano', async () => {
    const { organization, initiative, sale, director } = await voucherSale();
    const { reservation, pass } = await buy(initiative.id, 4);
    const stand = await standFor(organization.id, initiative.id, director);
    await spend(stand, sale, pass.uuid, 1);
    // La venta cierra en 10 días: los vales pueden valer desde ese día.
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() + 10 * DAY) } });
    await changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: madridIsoDate(new Date(Date.now() + 20 * DAY)) });
    const receipt = await claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, await refundPayload(organization.id, pass.uuid), { ip: '10.0.0.9' });
    const before = await db.ledgerJournal.count({ where: { contributionId: reservation.contributionId } });
    const { rawBody, contentType } = mock.buildNotification({ kind: 'CHARGEBACK', order: reservation.paycometOrder, amountCents: reservation.totalChargedCents });
    expect((await handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET })).status).not.toBe(200);
    expect(await db.ledgerJournal.count({ where: { contributionId: reservation.contributionId } })).toBe(before);
    expect((await db.contribution.findUniqueOrThrow({ where: { id: receipt.contributionId } })).status).toBe('COMPLETED');
    // La devolución parcial que aún no se había enviado queda retenida, con su alerta: ni la tarea ni el pase la envían (el banco pudo retirar el cobro entero).
    expect(await db.partialRefund.findUniqueOrThrow({ where: { contributionId: receipt.contributionId } })).toMatchObject({ status: 'ON_HOLD' });
    expect(await db.opsAlert.findFirst({ where: { dedupeKey: `PARTIAL_REFUND_HELD:${receipt.contributionId}`, status: 'OPEN' } })).not.toBeNull();
    await massRefundHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
    expect(await executePartialRefund(db, mock, receipt.contributionId, '10.0.0.1')).toMatchObject({ refunded: false });
    expect(mock.calls.filter((call) => call.operation === 'refund' && call.order === reservation.paycometOrder)).toHaveLength(0);
    // Y la base de datos no deja que vuelva a pendiente por otra vía.
    await expect(db.partialRefund.update({ where: { contributionId: receipt.contributionId }, data: { status: 'PENDING' } })).rejects.toThrow();
  });

  it('una devolución parcial sin respuesta de Paycomet abre su alerta y el Super-Admin la resuelve desde la consola; una rechazada espera antes de reintentarse', async () => {
    const { organization, initiative, sale, director } = await voucherSale();
    const unknown = await buy(initiative.id, 4);
    const rejected = await buy(initiative.id, 4);
    const stand = await standFor(organization.id, initiative.id, director);
    await spend(stand, sale, unknown.pass.uuid, 1);
    await spend(stand, sale, rejected.pass.uuid, 1);
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() + 10 * DAY) } });
    await changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: madridIsoDate(new Date(Date.now() + 20 * DAY)) });
    for (const purchase of [unknown, rejected]) await claimVoucherRefund(db, QR_SECRET, TEST_HMAC_SECRET, await refundPayload(organization.id, purchase.pass.uuid), { ip: '10.0.0.9' });
    const flaky = new MockPaycometProvider({
      secrets,
      failRefund: (order) =>
        order === unknown.reservation.paycometOrder ? new PaymentProviderError('corte de red', 'TIMEOUT', true) : order === rejected.reservation.paycometOrder ? new PaymentProviderError('rechazada', 'REFUND_DENIED') : null
    });
    await executePendingPartialRefunds(db, flaky, '10.0.0.1', { now: new Date(), batchSize: 10, initiativeId: initiative.id });
    expect(await db.opsAlert.findFirst({ where: { dedupeKey: `REFUND_STUCK:partial:${unknown.reservation.contributionId}`, status: 'OPEN' } })).not.toBeNull();
    expect(await db.opsAlert.findFirst({ where: { dedupeKey: `REFUND_REJECTED:partial:${rejected.reservation.contributionId}`, status: 'OPEN' } })).not.toBeNull();
    // La rechazada espera: la tarea siguiente no la vuelve a pedir enseguida (ni bloquea a las demás).
    const flakyDeps = { ...jobDeps, paymentProvider: async () => flaky };
    await massRefundHandler({ db, now: new Date(), batchSize: 50, deps: flakyDeps });
    expect(await db.partialRefund.findUniqueOrThrow({ where: { contributionId: rejected.reservation.contributionId } })).toMatchObject({ status: 'PENDING', sendingAt: null });

    // El Super-Admin comprueba en Paycomet que la sin respuesta sí se hizo y la da por devuelta: asiento de ejecución, email y alerta cerrada.
    const { actor } = await verifiedSuperadmin(db, new Date(), 'payment.resolve_unknown_refund');
    await resolveStuckRefund(db, actor, unknown.reservation.contributionId, true);
    expect(await db.partialRefund.findUniqueOrThrow({ where: { contributionId: unknown.reservation.contributionId } })).toMatchObject({ status: 'REFUNDED' });
    expect(await db.opsAlert.findFirst({ where: { dedupeKey: `REFUND_STUCK:partial:${unknown.reservation.contributionId}`, status: 'OPEN' } })).toBeNull();
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `refund.issued:${unknown.reservation.contributionId}` } })).toBe(1);
  });

  it('el aviso de validez acortada solo ofrece la devolución a quien compró antes del cambio', async () => {
    const { organization, initiative, director } = await voucherSale({ validInDays: 40 });
    const before = await buy(initiative.id, 2);
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() + 10 * DAY) } });
    await changeVoucherDates(db, director, organization.id, { initiativeId: initiative.id, validDay: madridIsoDate(new Date(Date.now() + 20 * DAY)) });
    const after = await buy(initiative.id, 2);
    await broadcasts();
    const notices = await outboxFor('voucher.validityChanged', initiative.id);
    const byPass = new Map(notices.map((row) => [(row.payloadJson as { passUuid?: string }).passUuid, row.payloadJson as { refundUntil?: string }]));
    expect(byPass.get(before.pass.uuid)?.refundUntil).toBeDefined();
    expect(byPass.get(after.pass.uuid)?.refundUntil).toBeUndefined();
  });
});

describe('aislamiento y quién puede cambiar una venta de vales', () => {
  it('ni otra entidad, ni sin segundo factor, ni el Super-Admin, ni un evento con estas reglas', async () => {
    const { organization, initiative, director } = await voucherSale();
    const other = await voucherSale();
    await expect(cancelVoucherSale(db, other.director, other.organization.id, { initiativeId: initiative.id })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    await expect(cancelVoucherSale(db, { ...director, secondFactor: false }, organization.id, { initiativeId: initiative.id })).rejects.toBeInstanceOf(TenantAccessError);
    const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await expect(cancelVoucherSale(db, { kind: 'user', userId: superadmin.id, isSuperadmin: true, memberships: [], secondFactor: true }, organization.id, { initiativeId: initiative.id })).rejects.toBeInstanceOf(TenantAccessError);
    const event = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', category: 'Taquilla', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 10, ticketFeeMode: 'ADD', goalCents: 5_000 });
    await reserveInitiativeQuotas(db, event.id);
    await expect(cancelVoucherSale(db, director, organization.id, { initiativeId: event.id })).rejects.toBeInstanceOf(VoucherSaleChangeError);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).voucherCancelledAt).toBeNull();
    // La cancelación no se deshace: la base de datos lo impide aunque alguien lo intente por otra vía.
    await cancelVoucherSale(db, director, organization.id, { initiativeId: initiative.id });
    await expect(db.initiative.update({ where: { id: initiative.id }, data: { voucherCancelledAt: null } })).rejects.toThrow();
  });
});

describe('los canjes y las sesiones del puesto se borran al año de liquidarse la venta (tabla de plazos §3.6)', () => {
  it('lo de hace más de un año se borra; lo reciente se queda; queda la cifra de cada pase', async () => {
    const old = await voucherSale();
    const recent = await voucherSale();
    for (const { organization, initiative, sale, director } of [old, recent]) {
      const { pass } = await buy(initiative.id, 3);
      const stand = await standFor(organization.id, initiative.id, director);
      await spend(stand, sale, pass.uuid, 2);
      await closeSale(initiative.id);
      await settle(organization.id, initiative.id, new Date(pass.issuedAt.getTime() + 15 * DAY));
    }
    await db.initiative.update({ where: { id: old.initiative.id }, data: { closedAt: new Date(Date.now() - 400 * DAY), voucherValidUntil: new Date(Date.now() - DAY) } });
    // Las sesiones del puesto de la vieja ya caducaron; una sesión que aún vale no se borra nunca.
    await db.gateSession.updateMany({ where: { initiativeId: old.initiative.id }, data: { expiresAt: new Date(Date.now() - DAY) } });
    // Liquidada hace más de un año pero con sus vales aún vigentes (año bisiesto, validez de 12 meses): todavía no se borra nada.
    await db.initiative.update({ where: { id: recent.initiative.id }, data: { closedAt: new Date(Date.now() - 400 * DAY) } });
    for (let round = 0; round < 10 && (await purgeOldGateReadings(db, new Date(), 500)) > 0; round += 1);
    expect(await db.ticketCheckIn.count({ where: { ticketPass: { initiativeId: old.initiative.id } } })).toBe(0);
    expect(await db.gateSession.count({ where: { initiativeId: old.initiative.id } })).toBe(0);
    expect(await db.ticketCheckIn.count({ where: { ticketPass: { initiativeId: recent.initiative.id } } })).toBe(1);
    expect((await db.ticketPass.findFirstOrThrow({ where: { initiativeId: old.initiative.id } })).checkedInCount).toBe(2);
  });
});
