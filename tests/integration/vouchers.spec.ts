import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance, getRaisedFromLedger } from '@/core/finance/ledger-balances';
import { reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { massRefundHandler } from '@/core/jobs/handlers/mass-refund';
import type { JobDeps } from '@/core/jobs/job-types';
import { checkInPass } from '@/core/ticketing/check-in.service';
import { EventScheduleError } from '@/core/ticketing/event-schedule-rules';
import { openGateSession, revokeGateSession, setGatePin } from '@/core/ticketing/gate-session.service';
import { buildPassQrPayload } from '@/core/ticketing/qr-signature';
import { reserveTickets, TicketReservationError } from '@/core/ticketing/ticket-reservation.service';
import { lookupVoucherBalance, redeemVouchers, VoucherRedeemInputError } from '@/core/ticketing/voucher-redemption.service';
import { reserveVouchers, VoucherReservationError } from '@/core/ticketing/voucher-reservation.service';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadGateAdmin } from '@/repositories/gate-admin.repository';
import { loadInitiativePopup } from '@/services/admin/initiative-popup';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { cancelEvent } from '@/services/ticketing/event-schedule.service';
import { createInitiative, createOrganization, createTestClient, createUser, testJobDeps, uniqueId } from './test-database';

/**
 * Sprint 5.14a · El motor de los vales contra PostgreSQL real (QA-VAL01 y QA-VAL02; decisión 32 del promotor y las dos del 2026-11-19):
 *
 * - Una persona compra 5 vales: un solo pase firmado con saldo 5 y su asiento cuadrado (la hucha recibe el precio; KORUM, los gastos por compra).
 * - Dos personas compran a la vez los últimos vales de una venta con tope: el tope nunca se supera.
 * - Con la venta agotada se aporta «sin producto»: no hay vale ni QR, el cobro suma a la hucha y no se ofrece a un colegio con ánimo de lucro.
 * - Dos lectores gastan a la vez vales del mismo QR: nunca se gasta más que el saldo y ningún vale dos veces; reenviar un canje no gasta otra vez; cada canje
 *   queda con su puesto y su hora.
 * - Una venta de vales no vence, no se cancela ni se cambia de fecha como un evento, su pase no abre la puerta de un evento y no se compra como una entrada.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-vales' };
const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-vales-0123456';
const PIN_SECRET = 'secreto-de-integracion-de-la-porteria-vales-01234567';
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

/** `MASS_REFUND` recorre lo pendiente de toda la base compartida: se ejecuta mientras quede trabajo, como `job-drain.ts` (ver `resize-vote.spec.ts`). */
async function runMassRefund(now: Date): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    let result: Awaited<ReturnType<typeof massRefundHandler>>;
    try {
      result = await massRefundHandler({ db, now, batchSize: 50, deps: jobDeps });
    } catch (error) {
      if (round === 0) throw error;
      return;
    }
    if (!result.hasMore || result.processed === 0) return;
  }
  throw new Error('MASS_REFUND sigue con trabajo tras 20 lotes');
}

const actorFor = (userId: string, organizationId: string, role: 'DIRECTOR' | 'COSIGNER' | 'FAMILY'): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor: true });

/** Entidad con su persona firmante y una venta de vales de 2 € (gastos de gestión 45 cts por compra + 2 %), con tope o sin él, a la venta. */
async function voucherSale(options: { ticketMax?: number | null; noProduct?: boolean; legalForm?: 'PARENTS_ASSOCIATION' | 'SCHOOL_OWNER'; feeMode?: 'ADD' | 'INC' } = {}) {
  // Con tarifa propia: así un cambio de las reglas globales en otro archivo de pruebas no la toca, ni esta venta abierta bloquea ese cambio.
  const organization = await createOrganization(db, { customRules: true, legalForm: options.legalForm ?? 'PARENTS_ASSOCIATION', centerOwnership: options.legalForm === 'SCHOOL_OWNER' ? 'PRIVATE' : 'PUBLIC', voucherFeeFixedCents: 45, voucherFeeBps: 200, ticketFeeFixedCents: 30, ticketFeeBps: 0 });
  created.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
  const ticketMax = options.ticketMax === undefined ? 100 : options.ticketMax;
  const initiative = await createInitiative(db, organization.id, {
    status: 'FUNDRAISING',
    format: 'TICKETING',
    category: 'Taquilla',
    title: 'Paradita de bisutería para el pozo de agua',
    ticketSubtype: 'VOUCHER',
    ticketPriceCents: 200,
    ticketMax,
    ticketFeeMode: options.feeMode ?? 'ADD',
    goalCents: ticketMax === null ? 0 : 200 * ticketMax,
    voucherValidUntil: new Date(Date.now() + 40 * DAY),
    voucherNoProductEnabled: options.noProduct ?? false
  });
  await reserveInitiativeQuotas(db, initiative.id);
  return { organization, initiative, director: actorFor(director.id, organization.id, 'DIRECTOR'), sale: { organizationId: organization.id, initiativeId: initiative.id } };
}

const deliver = (order: string, amountCents: number, kind: 'PAYMENT' | 'CHARGEBACK' = 'PAYMENT') => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET });
};

async function buyVouchers(initiativeId: number, quantity: number, mode: 'VOUCHERS' | 'NO_PRODUCT' = 'VOUCHERS') {
  const reservation = await reserveVouchers(db, { initiativeId, quantity, mode, buyer: { guestEmail: `${uniqueId('familia')}@pruebas.example` }, paymentMethod: 'BIZUM' });
  expect(await deliver(reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  const contribution = await db.contribution.findUniqueOrThrow({ where: { id: reservation.contributionId }, include: { ticketPass: true } });
  return { reservation, contribution, pass: contribution.ticketPass };
}

async function gateActor(organizationId: string, initiativeId: number, signer: SessionActor): Promise<SessionActor> {
  const { pin } = await setGatePin(db, PIN_SECRET, signer, organizationId, initiativeId);
  const opened = await openGateSession(db, PIN_SECRET, { initiativeId, pin, requestMeta: { ipHash: uniqueId('ip') } });
  if (opened.status !== 'OPENED') throw new Error(`No se abrió el puesto: ${opened.status}`);
  return { kind: 'gate', gateSessionId: opened.gateSessionId, organizationId, initiativeId };
}

const journalsOf = (contributionId: number) => db.ledgerJournal.findMany({ where: { contributionId }, include: { entries: true }, orderBy: { id: 'asc' } });
const sum = (entries: Array<{ direction: string; amountCents: number }>, direction: 'DEBIT' | 'CREDIT') => entries.filter((entry) => entry.direction === direction).reduce((total, entry) => total + entry.amountCents, 0);

describe('QA-VAL01 · compra de vales en un QR con saldo', () => {
  it('5 vales de 2 €: un solo pase firmado con saldo 5 y su asiento cuadrado (10 € a la hucha y 65 cts de gestión, un solo fijo por compra)', async () => {
    const { initiative } = await voucherSale();
    const { reservation, contribution, pass } = await buyVouchers(initiative.id, 5);
    expect(reservation).toMatchObject({ amountCents: 1_000, serviceFeeCents: 65, totalChargedCents: 1_065 });
    expect(reservation.paycometOrder).toMatch(/^KV[0-9A-F]{16}$/);
    expect(contribution).toMatchObject({ type: 'TICKET', status: 'COMPLETED', ticketQuantity: 5, ticketHoldUntil: null, voucherNoProduct: false, isTaxDeductible: false, donorTaxIdHmac: null });
    expect(pass).toMatchObject({ subtype: 'VOUCHER', quantity: 5, checkedInCount: 0, revokedAt: null });
    expect(pass!.serialCode).toMatch(/^VALE-\d{4}-\d{6}$/);
    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after).toMatchObject({ status: 'FUNDRAISING', ticketsSold: 5, ticketsHeld: 0, raisedCents: 1_000, totalContributions: 1 });

    const [payin, gateway] = await journalsOf(contribution.id);
    expect(payin!.kind).toBe('PAYIN_TICKET');
    expect(sum(payin!.entries, 'DEBIT')).toBe(sum(payin!.entries, 'CREDIT'));
    expect(payin!.entries.map(({ account, direction, amountCents }) => ({ account, direction, amountCents })).sort((a, b) => a.account.localeCompare(b.account))).toEqual([
      { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 1_000 },
      { account: 'KORUM_REVENUE_TICKET_FEE', direction: 'CREDIT', amountCents: 65 },
      { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 1_065 }
    ]);
    expect(gateway!.kind).toBe('GATEWAY_FEE');
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(1_000);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: initiative.id })).balanceCents).toBe(1_000);
    // No sale por la bandeja el email del pase de una entrada: el de los vales, con su saldo, llega en el Sprint 5.14b.
    expect(await db.outboxMessage.count({ where: { templateKey: 'ticket.pass', idempotencyKey: `ticket.pass:${contribution.id}` } })).toBe(0);
  });

  it('en INC los gastos van dentro: la hucha recibe 9,35 € de una compra de 10 €', async () => {
    const { initiative } = await voucherSale({ feeMode: 'INC' });
    const { reservation, contribution } = await buyVouchers(initiative.id, 5);
    expect(reservation).toMatchObject({ amountCents: 935, serviceFeeCents: 65, totalChargedCents: 1_000 });
    const [payin] = await journalsOf(contribution.id);
    expect(sum(payin!.entries, 'DEBIT')).toBe(1_000);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).raisedCents).toBe(935);
  });

  it('sin tope: se vende sin límite, nunca se «agota» y la venta sigue abierta sin pasar a lograda', async () => {
    const { initiative } = await voucherSale({ ticketMax: null, noProduct: true });
    for (const quantity of [50, 50, 50]) await buyVouchers(initiative.id, quantity);
    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after).toMatchObject({ status: 'FUNDRAISING', ticketsSold: 150, ticketMax: null, raisedCents: 30_000 });
    await expect(reserveVouchers(db, { initiativeId: initiative.id, quantity: 1, mode: 'NO_PRODUCT', buyer: { guestEmail: 'abuela@pruebas.example' }, paymentMethod: 'CARD' })).rejects.toMatchObject({ reason: 'NO_PRODUCT_NOT_OFFERED' });
  });

  it('dos personas compran a la vez los últimos 3 vales: una se los lleva, la otra recibe «agotado» con los que quedan, y el tope nunca se supera', async () => {
    const { initiative } = await voucherSale({ ticketMax: 10 });
    await buyVouchers(initiative.id, 7);
    const attempt = () => reserveVouchers(db, { initiativeId: initiative.id, quantity: 3, mode: 'VOUCHERS', buyer: { guestEmail: `${uniqueId('a')}@pruebas.example` }, paymentMethod: 'BIZUM' });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const failure of rejected) expect(failure.reason).toMatchObject({ reason: 'SOLD_OUT', availableVouchers: 0 });
    const held = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(held.ticketsSold + held.ticketsHeld).toBe(10);
    // La base de datos tampoco deja pasarse, aunque el código se saltara el bloqueo.
    await expect(db.initiative.update({ where: { id: initiative.id }, data: { ticketsHeld: { increment: 1 } } })).rejects.toThrow();
  });

  it('agotada y con la opción activada se aporta «sin producto»: sin vale ni QR, suma a la hucha con sus gastos y no retiene nada', async () => {
    const { initiative } = await voucherSale({ ticketMax: 4, noProduct: true });
    await expect(reserveVouchers(db, { initiativeId: initiative.id, quantity: 2, mode: 'NO_PRODUCT', buyer: { guestEmail: 'pronto@pruebas.example' }, paymentMethod: 'CARD' })).rejects.toMatchObject({ reason: 'NO_PRODUCT_NOT_OFFERED', availableVouchers: 4 });
    await buyVouchers(initiative.id, 4);
    await expect(reserveVouchers(db, { initiativeId: initiative.id, quantity: 1, mode: 'VOUCHERS', buyer: { guestEmail: 'tarde@pruebas.example' }, paymentMethod: 'CARD' })).rejects.toMatchObject({ reason: 'SOLD_OUT', availableVouchers: 0 });

    const { reservation, contribution, pass } = await buyVouchers(initiative.id, 10, 'NO_PRODUCT');
    expect(reservation).toMatchObject({ amountCents: 2_000, serviceFeeCents: 85, totalChargedCents: 2_085, holdUntil: null });
    expect(contribution).toMatchObject({ type: 'TICKET', status: 'COMPLETED', voucherNoProduct: true, ticketQuantity: null, ticketHoldUntil: null, isTaxDeductible: false });
    expect(pass).toBeNull();
    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after).toMatchObject({ status: 'FUNDRAISING', ticketsSold: 4, ticketsHeld: 0, raisedCents: 2_800, totalContributions: 2 });
    const [payin] = await journalsOf(contribution.id);
    expect(payin!.kind).toBe('PAYIN_TICKET');
    expect(sum(payin!.entries, 'DEBIT')).toBe(sum(payin!.entries, 'CREDIT'));
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(2_800);
    // La base de datos impide que una aportación «sin producto» lleve vales o retenga plazas.
    await expect(db.contribution.update({ where: { id: contribution.id }, data: { ticketQuantity: 1 } })).rejects.toThrow();
  });

  it('un colegio con ánimo de lucro vende vales, pero no se le ofrece «sin producto» aunque lo active', async () => {
    const { initiative } = await voucherSale({ ticketMax: 2, noProduct: true, legalForm: 'SCHOOL_OWNER' });
    await buyVouchers(initiative.id, 2);
    await expect(reserveVouchers(db, { initiativeId: initiative.id, quantity: 1, mode: 'NO_PRODUCT', buyer: { guestEmail: 'abuela@pruebas.example' }, paymentMethod: 'CARD' })).rejects.toMatchObject({ reason: 'NO_PRODUCT_NOT_OFFERED' });
  });

  it('no se compra fuera de venta, pasada la validez, con cantidades imposibles, ni una venta de vales como si fuera una entrada (ni al revés)', async () => {
    const { initiative } = await voucherSale();
    const buyer = { guestEmail: 'familia@pruebas.example' };
    for (const quantity of [0, 51, 2.5]) await expect(reserveVouchers(db, { initiativeId: initiative.id, quantity, mode: 'VOUCHERS', buyer, paymentMethod: 'CARD' })).rejects.toMatchObject({ reason: 'INVALID_QUANTITY' });
    await expect(reserveTickets(db, { initiativeId: initiative.id, quantity: 1, buyer, paymentMethod: 'CARD' })).rejects.toBeInstanceOf(TicketReservationError);
    await db.initiative.update({ where: { id: initiative.id }, data: { voucherValidUntil: new Date(Date.now() - 1_000) } });
    await expect(reserveVouchers(db, { initiativeId: initiative.id, quantity: 1, mode: 'VOUCHERS', buyer, paymentMethod: 'CARD' })).rejects.toMatchObject({ reason: 'VALIDITY_ENDED' });

    const organization = await createOrganization(db);
    created.push(organization.id);
    const event = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', category: 'Taquilla', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 10, ticketFeeMode: 'ADD', goalCents: 5_000 });
    await expect(reserveVouchers(db, { initiativeId: event.id, quantity: 1, mode: 'VOUCHERS', buyer, paymentMethod: 'CARD' })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    // Sin validez no se publica una venta de vales (la guarda de la base de datos).
    await expect(createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'VOUCHER', ticketPriceCents: 200, ticketFeeMode: 'ADD', goalCents: 0 })).rejects.toThrow();
    await expect(createInitiative(db, organization.id, { format: 'BUDGET', voucherNoProductEnabled: true })).rejects.toThrow();
  });

  it('un cobro que llega con la venta ya cerrada no cuenta: se devuelve entero', async () => {
    const { initiative } = await voucherSale();
    const reservation = await reserveVouchers(db, { initiativeId: initiative.id, quantity: 2, mode: 'VOUCHERS', buyer: { guestEmail: 'lenta@pruebas.example' }, paymentMethod: 'CARD' });
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CANCELLED' } });
    expect(await deliver(reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    const contribution = await db.contribution.findUniqueOrThrow({ where: { id: reservation.contributionId }, include: { ticketPass: true } });
    expect(contribution.status).toBe('REFUND_PENDING');
    expect(contribution.ticketPass).toBeNull();
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).ticketsHeld).toBe(0);
    // Se devuelve el 100 % (vales y gastos de gestión) y la hucha queda a cero: no se deja trabajo pendiente en la base compartida.
    await runMassRefund(new Date());
    expect((await db.contribution.findUniqueOrThrow({ where: { id: reservation.contributionId } })).status).toBe('REFUNDED');
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(0);
  });
});

describe('QA-VAL02 · canje parcial atómico', () => {
  it('se lee el saldo, se gastan 2 y quedan 3 en el mismo QR; cada canje queda con su puesto y su hora', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 5);
    const qr = buildPassQrPayload(QR_SECRET, pass!.uuid);
    const stand = await gateActor(organization.id, initiative.id, director);

    expect(await lookupVoucherBalance(db, QR_SECRET, stand, sale, qr)).toMatchObject({ status: 'OK', balance: 5, quantity: 5, serialCode: pass!.serialCode });
    expect(await redeemVouchers(db, QR_SECRET, stand, sale, qr, 2, uniqueId('scan'))).toMatchObject({ status: 'REDEEMED', spent: 2, balance: 3, quantity: 5 });
    expect(await lookupVoucherBalance(db, QR_SECRET, stand, sale, qr)).toMatchObject({ status: 'OK', balance: 3 });
    expect(await redeemVouchers(db, QR_SECRET, stand, sale, qr, 4, uniqueId('scan'))).toEqual({ status: 'INSUFFICIENT', balance: 3 });
    // Quien firma también puede canjear (por ejemplo, desde su móvil en el puesto).
    expect(await redeemVouchers(db, QR_SECRET, director, sale, qr, 3, uniqueId('scan'))).toMatchObject({ status: 'REDEEMED', balance: 0 });
    expect(await redeemVouchers(db, QR_SECRET, stand, sale, qr, 1, uniqueId('scan'))).toEqual({ status: 'EXHAUSTED' });

    const readings = await db.ticketCheckIn.findMany({ where: { ticketPassId: pass!.id }, orderBy: { id: 'asc' } });
    expect(readings.map(({ accepted, quantity, reason }) => ({ accepted, quantity, reason }))).toEqual([
      { accepted: true, quantity: 2, reason: null },
      { accepted: false, quantity: 4, reason: 'CANTIDAD_SUPERIOR' },
      { accepted: true, quantity: 3, reason: null },
      { accepted: false, quantity: 1, reason: 'PASE_AGOTADO' }
    ]);
    expect(readings[0]!.gateSessionId).toBe((stand as Extract<SessionActor, { kind: 'gate' }>).gateSessionId);
    expect(readings[2]!.gateSessionId).toBeNull();
    for (const reading of readings) expect(reading.createdAt).toBeInstanceOf(Date);
    // El canje no toca el dinero: la hucha sigue igual.
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(1_000);
  });

  it('dos lectores gastan a la vez vales del mismo QR: nunca más que el saldo y ningún vale dos veces', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 5);
    const qr = buildPassQrPayload(QR_SECRET, pass!.uuid);
    // Dos lectores: el móvil del puesto (con el PIN) y el de quien firma. Crear otro PIN cerraría el primer puesto, así que no hay dos sesiones de PIN a la vez.
    const first = await gateActor(organization.id, initiative.id, director);
    const second = director;
    // 8 canjes de 2 vales a la vez desde los dos lectores sobre un saldo de 5: solo caben 2 (4 vales) y queda 1.
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => redeemVouchers(db, QR_SECRET, index % 2 === 0 ? first : second, sale, qr, 2, uniqueId('scan'))));
    expect(results.filter((result) => result.status === 'REDEEMED')).toHaveLength(2);
    expect(results.filter((result) => result.status === 'INSUFFICIENT')).toHaveLength(6);
    const after = await db.ticketPass.findUniqueOrThrow({ where: { id: pass!.id } });
    expect(after.checkedInCount).toBe(4);
    const accepted = await db.ticketCheckIn.aggregate({ where: { ticketPassId: pass!.id, accepted: true }, _sum: { quantity: true } });
    expect(accepted._sum.quantity).toBe(4);
    // La base de datos no deja gastar más de lo comprado aunque el código se saltara el bloqueo.
    await expect(db.ticketPass.update({ where: { id: pass!.id }, data: { checkedInCount: { increment: 2 } } })).rejects.toThrow();
  });

  it('reenviar el mismo canje (tras un corte o desde dos pestañas a la vez) no gasta otra vez', async () => {
    const { initiative, director, sale } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 5);
    const qr = buildPassQrPayload(QR_SECRET, pass!.uuid);
    const scanId = uniqueId('scan');
    const results = await Promise.all([1, 2, 3].map(() => redeemVouchers(db, QR_SECRET, director, sale, qr, 2, scanId)));
    expect(results.filter((result) => result.status === 'REDEEMED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'DUPLICATE')).toEqual([
      { status: 'DUPLICATE', accepted: true, balance: 3 },
      { status: 'DUPLICATE', accepted: true, balance: 3 }
    ]);
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass!.id } })).checkedInCount).toBe(2);
    await expect(redeemVouchers(db, QR_SECRET, director, sale, qr, 1, 'corto')).rejects.toBeInstanceOf(VoucherRedeemInputError);
    await expect(redeemVouchers(db, QR_SECRET, director, sale, qr, 0, uniqueId('scan'))).rejects.toBeInstanceOf(VoucherRedeemInputError);
  });

  it('no se gasta un vale caducado, anulado, de otra venta o con un QR inventado', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 3);
    const qr = buildPassQrPayload(QR_SECRET, pass!.uuid);
    expect(await redeemVouchers(db, QR_SECRET, director, sale, qr.replace(/sig=.{4}/, 'sig=AAAA'), 1, uniqueId('scan'))).toEqual({ status: 'INVALID_SIGNATURE' });
    expect(await lookupVoucherBalance(db, QR_SECRET, director, sale, 'korum://v1/pass/no-es-un-qr')).toEqual({ status: 'INVALID_SIGNATURE' });

    // Otra venta de la misma entidad: su QR no se gasta aquí.
    const other = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', category: 'Taquilla', ticketSubtype: 'VOUCHER', ticketPriceCents: 200, ticketMax: 50, ticketFeeMode: 'ADD', goalCents: 10_000, voucherValidUntil: new Date(Date.now() + 10 * DAY) });
    const { pass: otherPass } = await buyVouchers(other.id, 1);
    expect(await redeemVouchers(db, QR_SECRET, director, sale, buildPassQrPayload(QR_SECRET, otherPass!.uuid), 1, uniqueId('scan'))).toEqual({ status: 'OTHER_SALE' });

    await db.initiative.update({ where: { id: initiative.id }, data: { voucherValidUntil: new Date(Date.now() - 1_000) } });
    expect(await lookupVoucherBalance(db, QR_SECRET, director, sale, qr)).toEqual({ status: 'EXPIRED' });
    expect(await redeemVouchers(db, QR_SECRET, director, sale, qr, 1, uniqueId('scan'))).toEqual({ status: 'EXPIRED' });
    await db.initiative.update({ where: { id: initiative.id }, data: { voucherValidUntil: new Date(Date.now() + DAY) } });
    await db.ticketPass.update({ where: { id: pass!.id }, data: { revokedAt: new Date() } });
    expect(await redeemVouchers(db, QR_SECRET, director, sale, qr, 1, uniqueId('scan'))).toEqual({ status: 'REVOKED' });
    expect((await db.ticketCheckIn.findMany({ where: { ticketPassId: pass!.id }, select: { reason: true }, orderBy: { id: 'asc' } })).map((row) => row.reason)).toEqual(['VALE_CADUCADO', 'REVOKED']);
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass!.id } })).checkedInCount).toBe(0);
  });

  it('aislamiento: ni otra entidad, ni un puesto de otra venta, ni una familia, ni el Super-Admin canjean', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 3);
    const qr = buildPassQrPayload(QR_SECRET, pass!.uuid);
    const stranger = await voucherSale();
    const family = await createUser(db);
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const intruders: SessionActor[] = [
      stranger.director,
      actorFor(family.id, organization.id, 'FAMILY'),
      { kind: 'user', userId: admin.id, isSuperadmin: true, memberships: [], secondFactor: true },
      await gateActor(stranger.organization.id, stranger.initiative.id, stranger.director)
    ];
    // Un puesto de otra venta de la misma entidad.
    const sibling = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', category: 'Taquilla', ticketSubtype: 'VOUCHER', ticketPriceCents: 200, ticketMax: 50, ticketFeeMode: 'ADD', goalCents: 10_000, voucherValidUntil: new Date(Date.now() + 10 * DAY) });
    intruders.push(await gateActor(organization.id, sibling.id, director));
    for (const intruder of intruders) {
      await expect(redeemVouchers(db, QR_SECRET, intruder, sale, qr, 1, uniqueId('scan'))).rejects.toBeInstanceOf(TenantAccessError);
      await expect(lookupVoucherBalance(db, QR_SECRET, intruder, sale, qr)).rejects.toBeInstanceOf(TenantAccessError);
    }
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass!.id } })).checkedInCount).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'tenant.access_denied' } })).toBeGreaterThan(0);
  });
});

describe('lo que pidieron las auditorías del 5.14a', () => {
  it('quien firma canjea y queda en la auditoría quién fue (su lectura no tiene puesto), sin datos de quien compró', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 4);
    expect(await redeemVouchers(db, QR_SECRET, director, sale, buildPassQrPayload(QR_SECRET, pass!.uuid), 3, uniqueId('scan'))).toMatchObject({ status: 'REDEEMED', balance: 1 });
    const rows = await db.auditLog.findMany({ where: { organizationId: organization.id, action: 'voucher.redeemed' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'USER', actorUserId: director.userId, targetId: String(initiative.id), metadataJson: { serialCode: pass!.serialCode, quantity: 3 } });
    expect(JSON.stringify(rows[0]!.metadataJson)).not.toContain('@');
    // El canje del puesto no deja fila: lo identifica su sesión.
    const stand = await gateActor(organization.id, initiative.id, director);
    await redeemVouchers(db, QR_SECRET, stand, sale, buildPassQrPayload(QR_SECRET, pass!.uuid), 1, uniqueId('scan'));
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'voucher.redeemed' } })).toBe(1);
  });

  it('un cobro que se confirma pasada la validez de los vales no emite vales caducados: se devuelve entero', async () => {
    const { initiative } = await voucherSale();
    const reservation = await reserveVouchers(db, { initiativeId: initiative.id, quantity: 3, mode: 'VOUCHERS', buyer: { guestEmail: 'justo@pruebas.example' }, paymentMethod: 'BIZUM' });
    await db.initiative.update({ where: { id: initiative.id }, data: { voucherValidUntil: new Date(Date.now() - 1_000) } });
    expect(await deliver(reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    const contribution = await db.contribution.findUniqueOrThrow({ where: { id: reservation.contributionId }, include: { ticketPass: true } });
    expect(contribution).toMatchObject({ status: 'REFUND_PENDING', ticketHoldUntil: null });
    expect(contribution.ticketPass).toBeNull();
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ ticketsSold: 0, ticketsHeld: 0, raisedCents: 0 });
    await runMassRefund(new Date());
    expect((await db.contribution.findUniqueOrThrow({ where: { id: reservation.contributionId } })).status).toBe('REFUNDED');
  });

  it('un identificador de canje ya usado con otro vale se rechaza (nunca responde con otro saldo), también con dos peticiones a la vez', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const { pass: first } = await buyVouchers(initiative.id, 3);
    const { pass: second } = await buyVouchers(initiative.id, 3);
    const scanId = uniqueId('scan');
    await redeemVouchers(db, QR_SECRET, director, sale, buildPassQrPayload(QR_SECRET, first!.uuid), 1, scanId);
    await expect(redeemVouchers(db, QR_SECRET, director, sale, buildPassQrPayload(QR_SECRET, second!.uuid), 1, scanId)).rejects.toBeInstanceOf(VoucherRedeemInputError);
    // Desde el mismo puesto, a la vez y sobre pases distintos: la base de datos ordena el identificador y la segunda nunca acaba en un error del servidor.
    const stand = await gateActor(organization.id, initiative.id, director);
    const shared = uniqueId('scan');
    const results = await Promise.allSettled([first, second].map((pass) => redeemVouchers(db, QR_SECRET, stand, sale, buildPassQrPayload(QR_SECRET, pass!.uuid), 1, shared)));
    expect(results.filter((result) => result.status === 'fulfilled' && result.value.status === 'REDEEMED')).toHaveLength(1);
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(VoucherRedeemInputError);
    const spent = await db.ticketPass.findMany({ where: { id: { in: [first!.id, second!.id] } }, select: { checkedInCount: true } });
    expect(spent.reduce((total, pass) => total + pass.checkedInCount, 0)).toBe(2);
  });

  it('un QR inventado o de una entrada deja una sola fila de auditoría por puesto o persona y ventana; el de una entrada se rechaza como de otra venta', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const stand = await gateActor(organization.id, initiative.id, director);
    for (let index = 0; index < 4; index += 1) {
      expect(await redeemVouchers(db, QR_SECRET, director, sale, `korum://v1/pass/inventado-${index}`, 1, uniqueId('scan'))).toEqual({ status: 'INVALID_SIGNATURE' });
      expect(await lookupVoucherBalance(db, QR_SECRET, stand, sale, `korum://v1/pass/inventado-${index}`)).toEqual({ status: 'INVALID_SIGNATURE' });
    }
    const invalid = await db.auditLog.findMany({ where: { organizationId: organization.id, action: 'voucher.qr_invalid' }, select: { actorType: true, metadataJson: true } });
    expect(invalid.map((row) => row.actorType).sort()).toEqual(['GATE_SESSION', 'USER']);
    for (const row of invalid) expect(row.metadataJson).toEqual({});

    const event = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', category: 'Taquilla', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 10, ticketFeeMode: 'ADD', goalCents: 5_000 });
    const ticket = await reserveTickets(db, { initiativeId: event.id, quantity: 1, buyer: { guestEmail: 'entrada@pruebas.example' }, paymentMethod: 'CARD' });
    await deliver(ticket.paycometOrder, ticket.totalChargedCents);
    const ticketPass = await db.ticketPass.findUniqueOrThrow({ where: { contributionId: ticket.contributionId } });
    for (let index = 0; index < 2; index += 1) expect(await redeemVouchers(db, QR_SECRET, stand, sale, buildPassQrPayload(QR_SECRET, ticketPass.uuid), 1, uniqueId('scan'))).toEqual({ status: 'OTHER_SALE' });
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'voucher.qr_other_sale' } })).toBe(1);
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: ticketPass.id } })).checkedInCount).toBe(0);
  });

  it('ni una cuenta de voluntario, ni un puesto cerrado de la misma venta, ni quien firma en otra entidad pasando el identificador de esta venta canjean', async () => {
    const { organization, initiative, director, sale } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 2);
    const qr = buildPassQrPayload(QR_SECRET, pass!.uuid);
    const volunteer = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: volunteer.id, role: 'GATEKEEPER' } });
    const volunteerActor: SessionActor = { kind: 'user', userId: volunteer.id, isSuperadmin: false, memberships: [{ organizationId: organization.id, role: 'GATEKEEPER' }], secondFactor: false };
    await expect(redeemVouchers(db, QR_SECRET, volunteerActor, sale, qr, 1, uniqueId('scan'))).rejects.toBeInstanceOf(TenantAccessError);

    const stand = await gateActor(organization.id, initiative.id, director) as Extract<SessionActor, { kind: 'gate' }>;
    await revokeGateSession(db, director, organization.id, stand.gateSessionId);
    await expect(redeemVouchers(db, QR_SECRET, stand, sale, qr, 1, uniqueId('scan'))).rejects.toBeInstanceOf(TenantAccessError);

    // Quien firma en B pide canjear en «su» entidad con el identificador de la venta de A: se responde como si no existiera.
    const other = await voucherSale();
    await expect(redeemVouchers(db, QR_SECRET, other.director, { organizationId: other.organization.id, initiativeId: initiative.id }, qr, 1, uniqueId('scan'))).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await db.auditLog.count({ where: { organizationId: other.organization.id, action: 'tenant.resource_outside_tenant' } })).toBe(1);
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass!.id } })).checkedInCount).toBe(0);
  });

  it('un contracargo de un pase con vales gastados lo anula y descuenta todos sus vales; el de una aportación «sin producto» no toca los vales; el libro mayor sigue cuadrando', async () => {
    const { initiative, director, sale } = await voucherSale({ ticketMax: 6, noProduct: true });
    const { reservation, pass } = await buyVouchers(initiative.id, 5);
    const qr = buildPassQrPayload(QR_SECRET, pass!.uuid);
    await redeemVouchers(db, QR_SECRET, director, sale, qr, 2, uniqueId('scan'));
    await buyVouchers(initiative.id, 1);
    const gift = await buyVouchers(initiative.id, 2, 'NO_PRODUCT');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ ticketsSold: 6, raisedCents: 1_600, totalContributions: 3 });

    expect(await deliver(reservation.paycometOrder, reservation.totalChargedCents, 'CHARGEBACK')).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await db.ticketPass.findUniqueOrThrow({ where: { id: pass!.id } })).toMatchObject({ checkedInCount: 2 });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass!.id } })).revokedAt).not.toBeNull();
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'FUNDRAISING', ticketsSold: 1, raisedCents: 600, totalContributions: 2 });
    expect(await redeemVouchers(db, QR_SECRET, director, sale, qr, 1, uniqueId('scan'))).toEqual({ status: 'REVOKED' });

    expect(await deliver(gift.reservation.paycometOrder, gift.reservation.totalChargedCents, 'CHARGEBACK')).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ ticketsSold: 1, raisedCents: 200, totalContributions: 1 });
    expect(await getRaisedFromLedger(db, initiative.id)).toBe(200);
  });

  it('la consola no ofrece el Auto-Impulso ni el 💎 en una venta de vales, aunque le falte para su «meta»', async () => {
    const { initiative } = await voucherSale({ ticketMax: 100 });
    await buyVouchers(initiative.id, 10);
    // Con mantenimiento publicado: el BI no lo proyecta en una venta de vales abierta (solo cuenta el ya asentado, que aquí es 0).
    await db.initiative.update({ where: { id: initiative.id }, data: { maintFeeCents: 4_900 } });
    const popup = await loadInitiativePopup(db, initiative.id);
    expect(popup?.boost.availableCents).toBe(0);
    expect(popup?.row).toMatchObject({ isProfitableSelfBoost: false });
    expect(popup?.row.sourcesCents.maintFeeCents).toBe(0);
  });
});

describe('una venta de vales no es un evento', () => {
  it('su pase no abre la puerta, no vence en su fecha, no se cancela como un evento y no aparece en «Taquilla y portería»', async () => {
    const { organization, initiative, director } = await voucherSale();
    const { pass } = await buyVouchers(initiative.id, 2);
    const stand = await gateActor(organization.id, initiative.id, director);
    expect(await checkInPass(db, QR_SECRET, stand, { organizationId: organization.id, initiativeId: initiative.id }, buildPassQrPayload(QR_SECRET, pass!.uuid), 1)).toEqual({ status: 'OTHER_EVENT' });
    const cancelling = cancelEvent(db, director, organization.id, { initiativeId: initiative.id }, new Date());
    await expect(cancelling).rejects.toBeInstanceOf(EventScheduleError);
    await expect(cancelling).rejects.toMatchObject({ reason: 'NOT_AN_EVENT' });
    expect((await loadGateAdmin(db, director, organization.id)).map((row) => row.id)).not.toContain(initiative.id);

    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() - 60_000) } });
    await campaignExpiryHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('FUNDRAISING');
    await expect(reserveVouchers(db, { initiativeId: initiative.id, quantity: 1, mode: 'VOUCHERS', buyer: { guestEmail: 'tarde@pruebas.example' }, paymentMethod: 'CARD' })).rejects.toBeInstanceOf(VoucherReservationError);
  });
});
