import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance } from '@/core/finance/ledger.service';
import { reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { massRefundHandler } from '@/core/jobs/handlers/mass-refund';
import type { JobDeps } from '@/core/jobs/job-types';
import { payoutFigures } from '@/core/payouts/campaign-payout-rules';
import { purgeOldGateReadings } from '@/core/privacy/retention-purge';
import { computeSignatureHash, payoutDigestFor } from '@/core/security/signature-hash';
import { endOfDayInMadrid, madridIsoDate } from '@/core/studio/studio-draft';
import { EventScheduleError, signEventRefundToken } from '@/core/ticketing/event-schedule-rules';
import { reserveTickets } from '@/core/ticketing/ticket-reservation.service';
import { checkInPass } from '@/core/ticketing/check-in.service';
import { openGateSession, setGatePin } from '@/core/ticketing/gate-session.service';
import { buildPassQrPayload } from '@/core/ticketing/qr-signature';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadGateAdmin } from '@/repositories/gate-admin.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { runRescheduleNotices } from '@/services/notifications/event-reschedule-notices';
import { runSupporterBroadcasts } from '@/services/notifications/supporter-broadcast';
import { formatBankDateTime, MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { approvePayout, PayoutNotAllowedError } from '@/services/payments/split-transfer.service';
import { payoutBlockers } from '@/services/payouts/payout-readiness';
import { claimEventRefund, loadEventRefund } from '@/services/ticketing/event-refund-link.service';
import { cancelEvent, rescheduleEvent } from '@/services/ticketing/event-schedule.service';
import { openRescheduleRefundUntil } from '@/services/ticketing/reschedule-window';
import { createInitiative, createOrganization, createTestClient, createUser, table, TEST_HMAC_SECRET, testJobDeps, uniqueId } from './test-database';

/**
 * Sprint 5.13 · Reglas de las entradas contra PostgreSQL real (QA-TKT10, decisión 30 del promotor y decisiones de apertura del 2026-11-19):
 *
 * - Un evento con 40 de 100 entradas vendidas que llega a su fecha pasa a liquidable por lo vendido (no a «vencido»), con el mantenimiento proporcional,
 *   y se liquida con la doble firma; sin ventas, se cierra sin mover dinero y devuelve sus cupos.
 * - Cancelar devuelve el 100 % (entradas y gastos de gestión) y avisa a cada persona; la portería se cierra.
 * - Cambiar la fecha avisa a cada persona con un enlace que devuelve el 100 % durante 14 días y deja de valer después; mientras, no se liquida.
 * - Todos los asientos cuadran y la hucha queda a cero tras devolver.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-eventos' };
const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-eventos-0123';
const PIN_SECRET = 'secreto-de-integracion-de-la-porteria-eventos-0123';
const SIGNATURE_SECRET ='secreto-de-integracion-de-las-firmas-eventos-0123';
const SECRET = TEST_HMAC_SECRET;
const DAY = 86_400_000;
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let jobDeps: JobDeps;
const created: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  jobDeps = { paymentProvider: async () => mock, invoicingProvider: () => { throw new Error('sin facturación'); }, refundOriginalIp: async () => '10.0.0.1', ...testJobDeps() };
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: created }, status: 'PENDING' } });
  await db.$disconnect();
});

const ctx = (now: Date) => ({ db, now, batchSize: 50, deps: jobDeps });
const actorFor = (userId: string, organizationId: string, role: 'DIRECTOR' | 'COSIGNER' | 'FAMILY', secondFactor = true): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor });

/** `MASS_REFUND` recorre lo pendiente de toda la base compartida: se ejecuta mientras quede trabajo, como `job-drain.ts` (ver `resize-vote.spec.ts`). */
async function runMassRefund(now: Date): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    let result: Awaited<ReturnType<typeof massRefundHandler>>;
    try {
      result = await massRefundHandler(ctx(now));
    } catch (error) {
      if (round === 0) throw error;
      return;
    }
    if (!result.hasMore || result.processed === 0) return;
  }
  throw new Error('MASS_REFUND sigue con trabajo tras 20 lotes');
}

/** Entidad verificada con sus dos personas firmantes y un evento de 100 entradas a 5 € (meta 500 €) con 49 € de mantenimiento y sus cupos reservados. */
async function eventWithTeam(overrides: Parameters<typeof createInitiative>[2] = {}) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', maintAnnualCapCents: 100_000 });
  created.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  const initiative = await createInitiative(db, organization.id, {
    status: 'FUNDRAISING',
    format: 'TICKETING',
    category: 'Taquilla',
    ticketSubtype: 'EVENT',
    ticketPriceCents: 500,
    ticketMax: 100,
    ticketFeeMode: 'ADD',
    goalCents: 50_000,
    maintFeeCents: 4_900,
    ...overrides
  });
  await reserveInitiativeQuotas(db, initiative.id);
  return { organization, initiative, director: actorFor(director.id, organization.id, 'DIRECTOR'), cosigner: actorFor(cosigner.id, organization.id, 'COSIGNER') };
}

/** Aviso de Paycomet; `bankAt` es la hora del cobro que da el banco, que puede ser anterior a cuando llega el aviso. */
const deliver = (kind: 'PAYMENT' | 'CHARGEBACK', order: string, amountCents: number, bankAt?: Date) => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents, ...(bankAt ? { bankDateTime: formatBankDateTime(bankAt) } : {}) });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET });
};

async function buy(initiativeId: number, quantity: number, email = `${uniqueId('familia')}@pruebas.example`) {
  const reservation = await reserveTickets(db, { initiativeId, quantity, buyer: { guestEmail: email }, paymentMethod: 'BIZUM' });
  expect(await deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return reservation;
}

/** Lleva el evento a su fecha (un minuto antes de ahora) y ejecuta la tarea diaria. */
async function reachDate(initiativeId: number) {
  await db.initiative.update({ where: { id: initiativeId }, data: { closesAt: new Date(Date.now() - 60_000) } });
  await campaignExpiryHandler(ctx(new Date()));
  return db.initiative.findUniqueOrThrow({ where: { id: initiativeId } });
}

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

/** Cada asiento del evento cuadra (Σ DEBE = Σ HABER) y, mientras no se ha liquidado, la hucha coincide con lo recaudado. */
async function expectBalanced(organizationId: string, initiativeId: number, settled = false) {
  const journals = await db.ledgerJournal.findMany({ where: { initiativeId }, include: { entries: true } });
  for (const journal of journals) {
    const debit = journal.entries.filter((entry) => entry.direction === 'DEBIT').reduce((sum, entry) => sum + entry.amountCents, 0);
    const credit = journal.entries.filter((entry) => entry.direction === 'CREDIT').reduce((sum, entry) => sum + entry.amountCents, 0);
    expect(debit, `asiento ${journal.id} (${journal.kind})`).toBe(credit);
  }
  const { raisedCents } = await db.initiative.findUniqueOrThrow({ where: { id: initiativeId }, select: { raisedCents: true } });
  expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { organizationId, initiativeId })).balanceCents).toBe(settled ? 0 : raisedCents);
}

const readiness = async (initiativeId: number, now = new Date()) => {
  const initiative = await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } });
  const organization = await db.organization.findUniqueOrThrow({ where: { id: initiative.organizationId } });
  return payoutBlockers(db, initiative, organization, { destination: 'ORGANIZATION', payoutId: null, now });
};

const dayIn = (days: number) => madridIsoDate(new Date(Date.now() + days * DAY));

describe('QA-TKT10 · un evento que llega a su fecha se liquida por lo vendido', () => {
  it('40 de 100 entradas vendidas: liquidable (no vencido), mantenimiento proporcional y liquidación con doble firma; los asientos cuadran', async () => {
    const { organization, initiative } = await eventWithTeam();
    for (let index = 0; index < 4; index += 1) await buy(initiative.id, 10);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).quotaReservedMaintCents).toBe(4_900);

    const held = await reachDate(initiative.id);
    expect(held).toMatchObject({ status: 'GOAL_REACHED', stepIndex: 5, ticketsSold: 40, raisedCents: 20_000 });
    // 49 € × 200 / 500 = 19,60 € (decisión del 2026-11-19): la entidad recibe 180,40 €.
    expect(held.maintFeeCents).toBe(1_960);
    expect(payoutFigures(held)).toMatchObject({ netPaidCents: 18_040, korumFeeSettledCents: 1_960 });
    expect(await db.auditLog.count({ where: { action: 'event.date_reached', targetId: String(initiative.id) } })).toBe(1);
    const notices = await db.outboxMessage.findMany({ where: { templateKey: 'event.dateReached', organizationId: organization.id } });
    expect(notices).toHaveLength(2);
    expect(notices[0]?.payloadJson).toMatchObject({ outcome: 'SETTLE', ticketsSold: 40, raisedCents: 20_000 });
    expect(await db.auditLog.count({ where: { action: 'initiative.status_changed', targetId: String(initiative.id), metadataJson: { path: ['reason'], equals: 'EVENT_DATE_REACHED' } } })).toBe(1);

    expect(await readiness(initiative.id)).toEqual([]);
    await expectBalanced(organization.id, initiative.id);
    const payout = await signedPayout(organization.id, initiative.id);
    expect(await approvePayout(db, payout.id, SIGNATURE_SECRET)).toMatchObject({ approved: true });
    // Aprobada: la hucha sale entera, el neto a la entidad y el mantenimiento a KORUM.
    await expectBalanced(organization.id, initiative.id, true);
    const approval = await db.ledgerJournal.findFirstOrThrow({ where: { initiativeId: initiative.id, kind: 'PAYOUT_APPROVAL' }, include: { entries: true } });
    const credited = (account: string) => approval.entries.filter((entry) => entry.account === account && entry.direction === 'CREDIT').reduce((sum, entry) => sum + entry.amountCents, 0);
    expect({ entity: credited('ORG_PAYABLE'), maintenance: credited('KORUM_REVENUE_MAINTENANCE') }).toEqual({ entity: 18_040, maintenance: 1_960 });
  });

  it('un contracargo después de la fecha no reabre la venta y el mantenimiento sigue siendo proporcional a lo que queda', async () => {
    const { initiative } = await eventWithTeam();
    const first = await buy(initiative.id, 10);
    await buy(initiative.id, 20);
    await reachDate(initiative.id);
    expect(await deliver('CHARGEBACK', first.paycometOrder, first.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after).toMatchObject({ status: 'GOAL_REACHED', raisedCents: 10_000, ticketsSold: 20 });
    expect(after.maintFeeCents).toBe(980);
  });

  it('sin ninguna entrada vendida se cierra sin mover dinero y devuelve sus cupos', async () => {
    const { organization, initiative } = await eventWithTeam();
    const before = await db.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { maintPaidCents: true } });
    expect(before.maintPaidCents).toBe(4_900);
    const closed = await reachDate(initiative.id);
    expect(closed.status).toBe('CANCELLED');
    expect(closed.quotaReleasedAt).not.toBeNull();
    expect(await db.ledgerJournal.count({ where: { initiativeId: initiative.id } })).toBe(0);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { maintPaidCents: true } })).maintPaidCents).toBe(0);
    const [notice] = await db.outboxMessage.findMany({ where: { templateKey: 'event.dateReached', organizationId: organization.id } });
    expect(notice?.payloadJson).toMatchObject({ outcome: 'CLOSE_EMPTY' });
  });

  it('una campaña de presupuesto que vence sin meta sigue pasando a «vencida» (no cambia)', async () => {
    const { organization } = await eventWithTeam();
    const budget = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 20_000, closesAt: new Date(Date.now() - 60_000) });
    await campaignExpiryHandler(ctx(new Date()));
    expect((await db.initiative.findUniqueOrThrow({ where: { id: budget.id } })).status).toBe('EXPIRED');
  });
});

describe('QA-TKT10 · cancelar el evento devuelve el 100 %', () => {
  it('solo una persona firmante de esa entidad con su segundo factor', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    const other = await eventWithTeam();
    const family = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: family.id, role: 'FAMILY' } });
    const payload = { initiativeId: initiative.id };
    await expect(cancelEvent(db, { ...director, secondFactor: false }, organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(cancelEvent(db, actorFor(family.id, organization.id, 'FAMILY'), organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    // El evento de otra entidad se responde como inexistente y queda registrado.
    await expect(cancelEvent(db, other.director, other.organization.id, payload)).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(await db.auditLog.count({ where: { action: 'tenant.resource_outside_tenant', organizationId: other.organization.id, targetId: String(initiative.id) } })).toBeGreaterThan(0);
    await expect(cancelEvent(db, director, organization.id, { initiativeId: initiative.id, organizationId: other.organization.id })).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('FUNDRAISING');
  });

  it('con ventas: devuelve entradas y gastos de gestión a cada persona, la avisa, cierra la portería y la hucha queda a cero', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    const ana = await buy(initiative.id, 3, 'ana@pruebas.example');
    const luis = await buy(initiative.id, 2, 'luis@pruebas.example');
    await buy(initiative.id, 1, 'ana@pruebas.example');
    await db.initiative.update({ where: { id: initiative.id }, data: { gatePinHash: 'hash-de-prueba', gatePinExpiresAt: new Date(Date.now() + 40 * DAY) } });
    const session = await db.gateSession.create({ data: { initiativeId: initiative.id, tokenHash: uniqueId('token'), expiresAt: new Date(Date.now() + DAY) } });

    expect(await cancelEvent(db, director, organization.id, { initiativeId: initiative.id })).toEqual({ initiativeId: initiative.id, status: 'REFUNDING' });
    const cancelled = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(cancelled).toMatchObject({ status: 'REFUNDING', gatePinHash: null, gatePinExpiresAt: null });
    expect((await db.gateSession.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();
    // Repetirlo no hace nada distinto.
    await expect(cancelEvent(db, director, organization.id, { initiativeId: initiative.id })).rejects.toMatchObject({ reason: 'WRONG_STATUS' });

    await runMassRefund(new Date());
    const purchases = await db.contribution.findMany({ where: { initiativeId: initiative.id, type: 'TICKET' } });
    expect(purchases.every((row) => row.status === 'REFUNDED' && row.refundedCents === row.totalChargedCents)).toBe(true);
    expect(purchases.find((row) => row.paycometOrder === ana.paycometOrder)?.refundedCents).toBe(ana.totalChargedCents);
    expect(purchases.find((row) => row.paycometOrder === luis.paycometOrder)?.refundedCents).toBe(luis.totalChargedCents);
    expect(await db.ticketPass.count({ where: { initiativeId: initiative.id, revokedAt: null } })).toBe(0);
    const done = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(done).toMatchObject({ status: 'REFUNDED', raisedCents: 0, ticketsSold: 0 });
    expect(done.quotaReleasedAt).not.toBeNull();
    await expectBalanced(organization.id, initiative.id);
    expect((await getAccountBalance(db, 'KORUM_REVENUE_TICKET_FEE', { organizationId: organization.id, initiativeId: initiative.id })).balanceCents).toBe(0);

    // Un aviso por persona (Ana compró dos veces) y uno a cada persona firmante.
    await runSupporterBroadcasts(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
    const buyers = await db.outboxMessage.findMany({ where: { templateKey: 'event.cancelledBuyer', organizationId: organization.id } });
    expect(buyers.map((message) => message.toAddress).sort()).toEqual(['ana@pruebas.example', 'luis@pruebas.example']);
    expect(await db.outboxMessage.count({ where: { templateKey: 'event.changed', organizationId: organization.id } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: 'event.cancelled', targetId: String(initiative.id) } })).toBe(1);
  });

  it('sin ventas: se cierra sin dinero y devuelve sus cupos; un evento ya liquidado no se puede cancelar', async () => {
    const empty = await eventWithTeam();
    expect(await cancelEvent(db, empty.director, empty.organization.id, { initiativeId: empty.initiative.id })).toMatchObject({ status: 'CANCELLED' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: empty.initiative.id } })).quotaReleasedAt).not.toBeNull();

    const sold = await eventWithTeam({ ticketMax: 2, goalCents: 1_000, maintFeeCents: 0 });
    await buy(sold.initiative.id, 2);
    const payout = await signedPayout(sold.organization.id, sold.initiative.id);
    await approvePayout(db, payout.id, SIGNATURE_SECRET);
    await expect(cancelEvent(db, sold.director, sold.organization.id, { initiativeId: sold.initiative.id })).rejects.toMatchObject({ reason: 'ALREADY_SETTLED' });
    await expect(rescheduleEvent(db, sold.director, sold.organization.id, { initiativeId: sold.initiative.id, newDay: dayIn(10) })).rejects.toMatchObject({ reason: 'ALREADY_SETTLED' });
  });
});

describe('QA-TKT10 · cambiar la fecha: enlace de devolución durante 14 días', () => {
  it('avisa a cada persona con su enlace; devuelve el 100 % de sus compras sin usar y deja de valer pasados los 14 días', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    const ana1 = await buy(initiative.id, 2, 'ana@pruebas.example');
    const ana2 = await buy(initiative.id, 1, 'ana@pruebas.example');
    await buy(initiative.id, 4, 'luis@pruebas.example');
    const marta = await buy(initiative.id, 1, 'marta@pruebas.example');
    // Marta ya entró con su entrada (portería): esa compra no se devuelve.
    const martaPass = await db.ticketPass.findUniqueOrThrow({ where: { contributionId: marta.contributionId } });
    await db.ticketPass.update({ where: { id: martaPass.id }, data: { checkedInCount: 1, lastCheckedInAt: new Date() } });
    const before = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });

    const receipt = await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(12) });
    expect(receipt.status).toBe('FUNDRAISING');
    const moved = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(moved.closesAt).toEqual(receipt.newDate);
    const reschedule = await db.eventReschedule.findFirstOrThrow({ where: { initiativeId: initiative.id } });
    expect(reschedule).toMatchObject({ previousDate: before.closesAt, newDate: receipt.newDate, createdById: director.userId });
    expect(reschedule.refundUntil.getTime() - reschedule.createdAt.getTime()).toBe(14 * DAY);

    // Quien compra después del cambio ya conoce la fecha: su compra no entra en el enlace.
    const late = await buy(initiative.id, 1, 'ana@pruebas.example');

    await runRescheduleNotices(db, { now: new Date(), batchSize: 2, hmacSecret: SECRET });
    const messages = await db.outboxMessage.findMany({ where: { templateKey: 'event.rescheduledBuyer', organizationId: organization.id } });
    expect(messages.map((message) => message.toAddress).sort()).toEqual(['ana@pruebas.example', 'luis@pruebas.example', 'marta@pruebas.example']);
    // El reparto sigue abierto hasta el final del plazo, por si alguien que estaba pagando termina después.
    expect((await db.eventReschedule.findUniqueOrThrow({ where: { id: reschedule.id } })).noticesCompletedAt).toBeNull();
    const tokenOf = (email: string) => (messages.find((message) => message.toAddress === email)?.payloadJson as { refundToken: string; expiresAt: string }).refundToken;
    expect((messages[0]?.payloadJson as { expiresAt: string }).expiresAt).toBe(reschedule.refundUntil.toISOString());

    const anaView = await loadEventRefund(db, SECRET, organization.slug, tokenOf('ana@pruebas.example'));
    expect(anaView).toMatchObject({ status: 'OPEN', refundableCents: ana1.totalChargedCents + ana2.totalChargedCents, usedPurchases: 0 });
    expect(await claimEventRefund(db, SECRET, { orgSlug: organization.slug, token: tokenOf('ana@pruebas.example') }, { ip: '10.9.8.7' })).toEqual({ purchases: 2, refundedCents: ana1.totalChargedCents + ana2.totalChargedCents });
    const statuses = await db.contribution.findMany({ where: { paycometOrder: { in: [ana1.paycometOrder, ana2.paycometOrder, late.paycometOrder] } }, select: { paycometOrder: true, status: true } });
    expect(statuses.find((row) => row.paycometOrder === late.paycometOrder)?.status).toBe('COMPLETED');
    expect(statuses.filter((row) => row.status === 'REFUND_PENDING')).toHaveLength(2);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).ticketsSold).toBe(before.ticketsSold + 1 - 3);
    // Pedirlo otra vez no devuelve nada más.
    await expect(claimEventRefund(db, SECRET, { orgSlug: organization.slug, token: tokenOf('ana@pruebas.example') }, { ip: '10.9.8.7' })).rejects.toMatchObject({ reason: 'NOTHING_TO_REFUND' });
    expect((await loadEventRefund(db, SECRET, organization.slug, tokenOf('ana@pruebas.example'))).status).toBe('REQUESTED');

    // Marta: su compra ya se usó en la puerta.
    expect(await loadEventRefund(db, SECRET, organization.slug, tokenOf('marta@pruebas.example'))).toMatchObject({ status: 'CLOSED', usedPurchases: 1 });
    await expect(claimEventRefund(db, SECRET, { orgSlug: organization.slug, token: tokenOf('marta@pruebas.example') }, { ip: '10.9.8.7' })).rejects.toMatchObject({ reason: 'NOTHING_TO_REFUND' });

    // Pasados los 14 días el enlace de Luis deja de valer, y su entrada vale para la fecha nueva.
    const afterWindow = new Date(reschedule.refundUntil.getTime() + 60_000);
    expect((await loadEventRefund(db, SECRET, organization.slug, tokenOf('luis@pruebas.example'), afterWindow)).status).toBe('CLOSED');
    await expect(claimEventRefund(db, SECRET, { orgSlug: organization.slug, token: tokenOf('luis@pruebas.example') }, { ip: '10.9.8.7' }, afterWindow)).rejects.toMatchObject({ reason: 'CLOSED' });

    // Enlaces falsos o de otra entidad no sirven.
    expect((await loadEventRefund(db, SECRET, 'otra-entidad', tokenOf('luis@pruebas.example'))).status).toBe('INVALID');
    expect((await loadEventRefund(db, SECRET, organization.slug, signEventRefundToken('otro-secreto-de-integracion-de-eventos-0123456789', reschedule.id, ana1.contributionId))).status).toBe('INVALID');
    await expect(claimEventRefund(db, SECRET, { orgSlug: organization.slug, token: 'basura' }, { ip: '10.9.8.7' })).rejects.toMatchObject({ reason: 'INVALID_LINK' });

    await runMassRefund(new Date());
    expect(await db.contribution.count({ where: { paycometOrder: { in: [ana1.paycometOrder, ana2.paycometOrder] }, status: 'REFUNDED' } })).toBe(2);
    await expectBalanced(organization.id, initiative.id);
    expect(await db.auditLog.count({ where: { action: 'event.reschedule_refund', targetId: String(initiative.id) } })).toBe(1);
  });

  it('un evento agotado sigue liquidable, pero no se liquida hasta que se cierra el plazo de devolución', async () => {
    const { organization, initiative, director } = await eventWithTeam({ ticketMax: 4, goalCents: 2_000, maintFeeCents: 0 });
    await buy(initiative.id, 4);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('GOAL_REACHED');
    const receipt = await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(20) });
    expect(receipt.status).toBe('GOAL_REACHED');
    expect(await readiness(initiative.id)).toEqual(['REFUND_WINDOW_OPEN']);
    const payout = await signedPayout(organization.id, initiative.id);
    const error = await approvePayout(db, payout.id, SIGNATURE_SECRET).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PayoutNotAllowedError);
    expect(error).toMatchObject({ code: 'REFUND_WINDOW_OPEN' });
    const afterWindow = new Date((receipt.refundUntil as Date).getTime() + 60_000);
    expect(await readiness(initiative.id, afterWindow)).toEqual([]);
    const view = (await loadGateAdmin(db, director, organization.id)).find((event) => event.id === initiative.id);
    expect(view?.schedule).toMatchObject({ canChange: true, refundOpenUntil: (receipt.refundUntil as Date).toISOString(), held: false });
  });

  it('aplazar un evento ya celebrado y sin liquidar reabre la venta hasta la fecha nueva con el mantenimiento publicado', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    await buy(initiative.id, 10);
    const held = await reachDate(initiative.id);
    expect(held).toMatchObject({ status: 'GOAL_REACHED', maintFeeCents: 490 });
    const receipt = await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(7) });
    expect(receipt.status).toBe('FUNDRAISING');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'FUNDRAISING', stepIndex: 4, maintFeeCents: 4_900 });
    expect(await db.auditLog.count({ where: { action: 'initiative.status_changed', targetId: String(initiative.id), metadataJson: { path: ['reason'], equals: 'EVENT_RESCHEDULED' } } })).toBe(1);
    // Se puede volver a comprar hasta la fecha nueva.
    await buy(initiative.id, 1);
  });

  it('la fecha nueva no pasa del máximo de la campaña desde su publicación; ni pasada, ni la misma; el PIN de la portería caduca con ella', async () => {
    // Como en el Estudio, el evento acaba al final de su día en España.
    const { organization, initiative, director } = await eventWithTeam({ closesAt: endOfDayInMadrid(dayIn(30)) as Date });
    await db.initiative.update({ where: { id: initiative.id }, data: { gatePinHash: 'hash-de-prueba', gatePinExpiresAt: new Date(Date.now() + 40 * DAY) } });
    const session = await db.gateSession.create({ data: { initiativeId: initiative.id, tokenHash: uniqueId('token'), expiresAt: new Date(Date.now() + 40 * DAY) } });
    const attempt = (newDay: string) => rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay });
    await expect(attempt(dayIn(70))).rejects.toMatchObject({ reason: 'DATE_TOO_LATE' });
    await expect(attempt(dayIn(-1))).rejects.toMatchObject({ reason: 'DATE_IN_PAST' });
    await expect(attempt(madridIsoDate(initiative.closesAt))).rejects.toMatchObject({ reason: 'SAME_DATE' });
    await expect(attempt('2026-02-30')).rejects.toMatchObject({ reason: 'DATE_INVALID' });
    await expect(attempt(dayIn(3))).resolves.toMatchObject({ status: 'FUNDRAISING' });
    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after.gatePinExpiresAt?.getTime()).toBe(after.closesAt.getTime() + 6 * 3_600_000);
    expect((await db.gateSession.findUniqueOrThrow({ where: { id: session.id } })).expiresAt.getTime()).toBe(after.gatePinExpiresAt?.getTime());
  });

  it('un cambio de fecha es historia: ni se reescribe ni se borra; un aviso de un cambio superado por otro no sale', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    await buy(initiative.id, 1, 'pepa@pruebas.example');
    const first = await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(10) });
    await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(11) });
    await runRescheduleNotices(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
    const messages = await db.outboxMessage.findMany({ where: { templateKey: 'event.rescheduledBuyer', organizationId: organization.id } });
    expect(messages).toHaveLength(1);
    expect((messages[0]?.payloadJson as { rescheduleId: number }).rescheduleId).not.toBe(first.rescheduleId);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('EventReschedule')} SET "refundUntil" = now() + interval '90 days' WHERE "id" = ${first.rescheduleId}`)).rejects.toThrow(/no se reescriben/);
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('EventReschedule')} WHERE "id" = ${first.rescheduleId}`)).rejects.toThrow(/no se borra/);
    await expect(db.$executeRawUnsafe(`TRUNCATE ${table('EventReschedule')}`)).rejects.toThrow(/no se vacían/);
  });

  it('el evento de otra entidad no se puede cambiar (aislamiento) y un evento que no es de entradas, tampoco', async () => {
    const { organization, initiative } = await eventWithTeam();
    const other = await eventWithTeam();
    await expect(rescheduleEvent(db, other.director, other.organization.id, { initiativeId: initiative.id, newDay: dayIn(5) })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const budget = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 20_000 });
    const { director } = await eventWithTeam();
    await expect(rescheduleEvent(db, director, organization.id, { initiativeId: budget.id, newDay: dayIn(5) })).rejects.toBeInstanceOf(TenantAccessError);
    const owner = await db.organizationMember.findFirstOrThrow({ where: { organizationId: organization.id, role: 'DIRECTOR' } });
    await expect(rescheduleEvent(db, actorFor(owner.userId, organization.id, 'DIRECTOR'), organization.id, { initiativeId: budget.id, newDay: dayIn(5) })).rejects.toMatchObject({ reason: 'NOT_AN_EVENT' });
    expect(EventScheduleError).toBeDefined();
  });
});

describe('L-124 · lecturas de la portería: un año desde que se liquida el evento', () => {
  it('borra las lecturas y las sesiones de los eventos cerrados hace más de un año y conserva las recientes', async () => {
    const { initiative: old } = await eventWithTeam();
    const { initiative: recent } = await eventWithTeam();
    const oldBuy = await buy(old.id, 1);
    const recentBuy = await buy(recent.id, 1);
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * DAY);
    await db.initiative.update({ where: { id: old.id }, data: { status: 'CLOSED', closedAt: twoYearsAgo } });
    await db.initiative.update({ where: { id: recent.id }, data: { status: 'CLOSED', closedAt: new Date(Date.now() - 30 * DAY) } });
    for (const [initiativeId, contributionId] of [[old.id, oldBuy.contributionId], [recent.id, recentBuy.contributionId]] as const) {
      const session = await db.gateSession.create({ data: { initiativeId, tokenHash: uniqueId('token'), expiresAt: new Date(Date.now() - DAY) } });
      const pass = await db.ticketPass.findUniqueOrThrow({ where: { contributionId } });
      await db.ticketCheckIn.create({ data: { ticketPassId: pass.id, gateSessionId: session.id, quantity: 1, accepted: true } });
      await db.ticketPass.update({ where: { id: pass.id }, data: { checkedInCount: 1 } });
    }
    for (let round = 0; round < 10 && (await purgeOldGateReadings(db, new Date(), 500)) > 0; round += 1);
    expect(await db.ticketCheckIn.count({ where: { ticketPass: { initiativeId: old.id } } })).toBe(0);
    expect(await db.gateSession.count({ where: { initiativeId: old.id } })).toBe(0);
    expect(await db.ticketCheckIn.count({ where: { ticketPass: { initiativeId: recent.id } } })).toBe(1);
    expect(await db.gateSession.count({ where: { initiativeId: recent.id } })).toBe(1);
    // Queda la cifra de cada pase.
    expect((await db.ticketPass.findUniqueOrThrow({ where: { contributionId: oldBuy.contributionId } })).checkedInCount).toBe(1);
  });
});

describe('Auditorías del 5.13 · casos límite de dinero y de portería', () => {
  it('al liquidar por lo vendido, el mantenimiento no cobrado vuelve al tope anual de la entidad', async () => {
    const { organization, initiative } = await eventWithTeam();
    for (let index = 0; index < 4; index += 1) await buy(initiative.id, 10);
    await reachDate(initiative.id);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).maintPaidCents).toBe(4_900);
    const payout = await signedPayout(organization.id, initiative.id);
    await approvePayout(db, payout.id, SIGNATURE_SECRET);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).maintPaidCents).toBe(1_960);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).quotaReservedMaintCents).toBe(1_960);
  });

  it('un cobro tardío con el evento ya celebrado sube lo vendido y pone al día el mantenimiento', async () => {
    const { initiative } = await eventWithTeam({ ticketMax: 50, goalCents: 25_000 });
    for (let index = 0; index < 2; index += 1) await buy(initiative.id, 5);
    const late = await reserveTickets(db, { initiativeId: initiative.id, quantity: 20, buyer: { guestEmail: 'tarde@pruebas.example' }, paymentMethod: 'BIZUM' });
    expect((await reachDate(initiative.id)).maintFeeCents).toBe(Math.floor((4_900 * 5_000) / 25_000));
    // El banco fecha el cobro antes de la fecha del evento, pero el aviso llega después: cuenta la hora de proceso.
    expect(await deliver('PAYMENT', late.paycometOrder, late.totalChargedCents, new Date(Date.now() - 5 * 60_000))).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'GOAL_REACHED', raisedCents: 15_000, maintFeeCents: Math.floor((4_900 * 15_000) / 25_000) });
    // Ya no se vende (la fecha pasó): solo un pago empezado antes de la fecha podía entrar.
    await expect(reserveTickets(db, { initiativeId: initiative.id, quantity: 1, buyer: { guestEmail: 'ultima@pruebas.example' }, paymentMethod: 'BIZUM' })).rejects.toMatchObject({ reason: 'NOT_ON_SALE' });
  });

  it('sin ventas pero con un pago en curso, el evento espera; pagado, se liquida por lo vendido', async () => {
    const { initiative } = await eventWithTeam();
    const paying = await reserveTickets(db, { initiativeId: initiative.id, quantity: 2, buyer: { guestEmail: 'pagando@pruebas.example' }, paymentMethod: 'BIZUM' });
    // La fecha llega con el pago ya empezado (antes de la fecha): el evento espera a que termine.
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date() } });
    await campaignExpiryHandler(ctx(new Date(Date.now() + 1_000)));
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('FUNDRAISING');
    expect(await deliver('PAYMENT', paying.paycometOrder, paying.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    await campaignExpiryHandler(ctx(new Date()));
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'GOAL_REACHED', ticketsSold: 2 });
  });

  it('un evento celebrado que se queda sin dinero (contracargo) se cierra y devuelve sus cupos', async () => {
    const { organization, initiative } = await eventWithTeam();
    const only = await buy(initiative.id, 3);
    await reachDate(initiative.id);
    expect(await deliver('CHARGEBACK', only.paycometOrder, only.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after).toMatchObject({ status: 'CANCELLED', raisedCents: 0 });
    expect(after.quotaReleasedAt).not.toBeNull();
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).maintPaidCents).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'initiative.status_changed', targetId: String(initiative.id), metadataJson: { path: ['reason'], equals: 'EVENT_EMPTIED' } } })).toBe(1);
  });

  it('un pago en curso no impide cambiar la fecha: quien termina de pagar después recibe su enlace y puede recuperar el 100 %', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    await buy(initiative.id, 1, 'antes@pruebas.example');
    const paying = await reserveTickets(db, { initiativeId: initiative.id, quantity: 1, buyer: { guestEmail: 'pagando@pruebas.example' }, paymentMethod: 'BIZUM' });
    const receipt = await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(9) });
    await runRescheduleNotices(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
    expect(await db.outboxMessage.count({ where: { templateKey: 'event.rescheduledBuyer', organizationId: organization.id } })).toBe(1);
    // El banco fecha el pago antes del cambio; KORUM lo procesa después.
    expect(await deliver('PAYMENT', paying.paycometOrder, paying.totalChargedCents, new Date(Date.now() - 60_000))).toEqual({ status: 200, outcome: 'PROCESSED' });
    await runRescheduleNotices(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
    const late = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'event.rescheduledBuyer', organizationId: organization.id, toAddress: 'pagando@pruebas.example' } });
    expect(await claimEventRefund(db, SECRET, { orgSlug: organization.slug, token: (late.payloadJson as { refundToken: string }).refundToken }, { ip: '10.6.6.6' })).toEqual({ purchases: 1, refundedCents: paying.totalChargedCents });
    // Volver a repartir no avisa dos veces; al acabar el plazo, el reparto se cierra.
    await runRescheduleNotices(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
    expect(await db.outboxMessage.count({ where: { templateKey: 'event.rescheduledBuyer', organizationId: organization.id } })).toBe(2);
    await runRescheduleNotices(db, { now: new Date((receipt.refundUntil as Date).getTime() + 60_000), batchSize: 50, hmacSecret: SECRET });
    expect((await db.eventReschedule.findUniqueOrThrow({ where: { id: receipt.rescheduleId as number } })).noticesCompletedAt).not.toBeNull();
  });

  it('con lotes pequeños, todas las personas que terminan de pagar tras el cambio reciben su enlace', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    // A y B empiezan a pagar; C compra después (su número es mayor) y ya ha pagado cuando cambia la fecha.
    const first = await reserveTickets(db, { initiativeId: initiative.id, quantity: 1, buyer: { guestEmail: 'uno@pruebas.example' }, paymentMethod: 'BIZUM' });
    const second = await reserveTickets(db, { initiativeId: initiative.id, quantity: 1, buyer: { guestEmail: 'dos@pruebas.example' }, paymentMethod: 'BIZUM' });
    await buy(initiative.id, 1, 'tres@pruebas.example');
    await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(10) });
    // La primera vuelta avisa a C y deja el cursor por encima de A y B.
    await runRescheduleNotices(db, { now: new Date(), batchSize: 1, hmacSecret: SECRET });
    for (const reservation of [first, second]) expect(await deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    // Con lotes de 1, B solo llega si la búsqueda de quien pagó tras el cambio pasa de página.
    await runRescheduleNotices(db, { now: new Date(), batchSize: 1, hmacSecret: SECRET });
    const notified = await db.outboxMessage.findMany({ where: { templateKey: 'event.rescheduledBuyer', organizationId: organization.id } });
    expect(notified.map((message) => message.toAddress).sort()).toEqual(['dos@pruebas.example', 'tres@pruebas.example', 'uno@pruebas.example']);
  });

  it('un cambio de fecha sin nadie a quien devolver no deja abierto el plazo que bloquea la liquidación', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(8) });
    expect(await openRescheduleRefundUntil(db, initiative.id, new Date())).toBeNull();
    // Quien compra después del cambio ya conoce la fecha nueva: tampoco abre el plazo.
    await buy(initiative.id, 1, 'despues@pruebas.example');
    expect(await openRescheduleRefundUntil(db, initiative.id, new Date())).toBeNull();
    expect((await loadGateAdmin(db, director, organization.id)).find((event) => event.id === initiative.id)?.schedule.refundOpenUntil).toBeNull();
  });

  it('un intento de cancelar sin segundo factor queda en la auditoría', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    await expect(cancelEvent(db, { ...director, secondFactor: false }, organization.id, { initiativeId: initiative.id })).rejects.toBeInstanceOf(TenantAccessError);
    const denied = await db.auditLog.findMany({ where: { action: 'tenant.access_denied', organizationId: organization.id, actorUserId: director.userId } });
    expect(denied.some((row) => { const meta = row.metadataJson as { reason?: string; attempted?: string }; return meta.reason === 'SECOND_FACTOR_REQUIRED' && meta.attempted === 'event.cancel'; })).toBe(true);
  });

  it('una entrada leída sin cobertura antes de que se pidiera su devolución se anota y se avisa a quienes firman', async () => {
    const { organization, initiative, director } = await eventWithTeam();
    const purchase = await buy(initiative.id, 1, 'despistada@pruebas.example');
    const { pin } = await setGatePin(db, PIN_SECRET, director, organization.id, initiative.id);
    const opened = await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } });
    if (opened.status !== 'OPENED') throw new Error('La sesión de prueba no se abrió');
    const gate: SessionActor = { kind: 'gate', gateSessionId: opened.gateSessionId, organizationId: organization.id, initiativeId: initiative.id };
    const scannedAt = new Date(Date.now() + 1_000);
    const later = new Date(Date.now() + 60_000);
    await rescheduleEvent(db, director, organization.id, { initiativeId: initiative.id, newDay: dayIn(20) });
    await runRescheduleNotices(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
    const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'event.rescheduledBuyer', toAddress: 'despistada@pruebas.example', organizationId: organization.id } });
    await claimEventRefund(db, SECRET, { orgSlug: organization.slug, token: (message.payloadJson as { refundToken: string }).refundToken }, { ip: '10.4.4.4' }, later);
    const pass = await db.ticketPass.findUniqueOrThrow({ where: { contributionId: purchase.contributionId } });
    const result = await checkInPass(db, QR_SECRET, gate, { organizationId: organization.id, initiativeId: initiative.id }, buildPassQrPayload(QR_SECRET, pass.uuid), 1, new Date(later.getTime() + 60_000), { offline: true, scannedAt, clientScanId: 'lectura-sin-red-0001' });
    expect(result).toEqual({ status: 'REVOKED' });
    expect((await db.ticketCheckIn.findFirstOrThrow({ where: { ticketPassId: pass.id } })).reason).toBe('REVOKED_AFTER_SCAN');
    expect(await db.auditLog.count({ where: { action: 'gate.refunded_pass_used', organizationId: organization.id } })).toBe(1);
    expect(await db.outboxMessage.count({ where: { templateKey: 'gate.refundedPassUsed', organizationId: organization.id } })).toBe(2);
  });
});
