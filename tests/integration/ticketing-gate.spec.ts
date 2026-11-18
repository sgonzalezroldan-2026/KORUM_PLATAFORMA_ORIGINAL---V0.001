import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRaisedFromLedger } from '@/core/finance/ledger.service';
import { computeSignatureHash, payoutDigestFor } from '@/core/security/signature-hash';
import { checkInPass, getGateSummary } from '@/core/ticketing/check-in.service';
import { MAX_FAILURES_PER_EVENT, openGateSession, resolveGateSession, revokeGateSession, setGatePin } from '@/core/ticketing/gate-session.service';
import { buildPassQrPayload } from '@/core/ticketing/qr-signature';
import { releaseExpiredTicketHolds, reserveTickets, TICKET_HOLD_MS, TicketReservationError } from '@/core/ticketing/ticket-reservation.service';
import type { KorumPrismaClient } from '@/lib/prisma';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { refundContribution } from '@/services/payments/payment-reversals';
import { approvePayout } from '@/services/payments/split-transfer.service';
import { createInitiative, createOrganization, createTestClient, createUser, signerOf, uniqueId } from './test-database';

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const PIN_SECRET = 'secreto-de-integracion-de-la-porteria-0123456789';
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración' };
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

async function eventSetup(overrides: Parameters<typeof createInitiative>[2] = {}) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
  const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 200, ticketFeeMode: 'ADD', goalCents: 100_000, ...overrides });
  return { organization, initiative };
}

const deliver = (kind: 'PAYMENT' | 'REFUND' | 'CHARGEBACK', order: string, amountCents: number, response: 'OK' | 'KO' = 'OK') => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents, response });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET });
};

const reserve = (initiativeId: number, quantity: number, now?: Date) => reserveTickets(db, { initiativeId, quantity, buyer: { guestEmail: `${uniqueId('familia')}@pruebas.example` }, paymentMethod: 'BIZUM' }, now);

async function buy(initiativeId: number, quantity: number) {
  const reservation = await reserve(initiativeId, quantity);
  expect(await deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  const pass = await db.ticketPass.findUniqueOrThrow({ where: { contributionId: reservation.contributionId } });
  return { reservation, pass };
}

const counters = (id: number) => db.initiative.findUniqueOrThrow({ where: { id }, select: { ticketsSold: true, ticketsHeld: true, status: true, raisedCents: true } });
const member = (organizationId: string, role: 'DIRECTOR' | 'GATEKEEPER' = 'DIRECTOR'): SessionActor => ({ kind: 'user', userId: uniqueId('user'), isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor: true });

describe('QA-P03 · aforo atómico bajo concurrencia', () => {
  it('196/200: de dos compras de 3 a la vez solo una sigue, y nunca 202/200', async () => {
    const { initiative } = await eventSetup({ ticketsSold: 196, raisedCents: 98_000 });
    const results = await Promise.allSettled([reserve(initiative.id, 3), reserve(initiative.id, 3)]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as TicketReservationError;
    expect(error).toBeInstanceOf(TicketReservationError);
    expect(error).toMatchObject({ reason: 'SOLD_OUT', availableTickets: 1 });
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 196, ticketsHeld: 3 });

    const reservation = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>>).value;
    expect(reservation).toMatchObject({ amountCents: 1_500, serviceFeeCents: 165, totalChargedCents: 1_665 });
    await deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents);
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 199, ticketsHeld: 0, status: 'FUNDRAISING' });
  });

  it('muchas compras a la vez nunca pasan del aforo', async () => {
    const { initiative } = await eventSetup({ ticketMax: 5, goalCents: 2_500 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserve(initiative.id, 1)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(await counters(initiative.id)).toMatchObject({ ticketsHeld: 5 });
  });

  it('al llegar a 200/200 pasa a GOAL_REACHED y no admite más reservas', async () => {
    const { initiative } = await eventSetup({ ticketsSold: 198, raisedCents: 99_000 });
    await buy(initiative.id, 2);
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 200, ticketsHeld: 0, status: 'GOAL_REACHED', raisedCents: 100_000 });
    await expect(reserve(initiative.id, 1)).rejects.toMatchObject({ reason: 'NOT_ON_SALE' });
  });

  it('con gastos incluidos (INC) el aforo completo también cierra, aunque el importe no llegue a la meta', async () => {
    const { initiative } = await eventSetup({ ticketMax: 2, goalCents: 1_000, ticketFeeMode: 'INC' });
    const { reservation } = await buy(initiative.id, 2);
    expect(reservation).toMatchObject({ amountCents: 890, serviceFeeCents: 110, totalChargedCents: 1_000 });
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 2, status: 'GOAL_REACHED', raisedCents: 890 });
  });

  it('un evento INC agotado sigue cerrado aunque un pago tardío se devuelva', async () => {
    const { initiative } = await eventSetup({ ticketMax: 2, goalCents: 1_000, ticketFeeMode: 'INC' });
    const start = new Date();
    const late = await reserve(initiative.id, 1, start);
    await releaseExpiredTicketHolds(db, new Date(start.getTime() + TICKET_HOLD_MS + 1));
    await buy(initiative.id, 2);
    await deliver('PAYMENT', late.paycometOrder, late.totalChargedCents);
    expect(await db.contribution.findUniqueOrThrow({ where: { id: late.contributionId } })).toMatchObject({ status: 'REFUND_PENDING' });
    expect(await counters(initiative.id)).toMatchObject({ status: 'GOAL_REACHED', ticketsSold: 2 });

    // Una devolución que sí libera plaza reabre la venta.
    const sold = await db.ticketPass.findFirstOrThrow({ where: { initiativeId: initiative.id, revokedAt: null }, include: { contribution: true } });
    await deliver('CHARGEBACK', sold.contribution.paycometOrder!, sold.contribution.totalChargedCents);
    expect(await counters(initiative.id)).toMatchObject({ status: 'FUNDRAISING', ticketsSold: 0 });
  });

  it('una entrada sin importe para la hucha no se vende: se cobraría y no podría asentarse', async () => {
    const free = await eventSetup({ ticketPriceCents: 0 });
    await expect(reserve(free.initiative.id, 1)).rejects.toMatchObject({ reason: 'NOT_ON_SALE' });
    const cheap = await eventSetup({ ticketPriceCents: 40, ticketFeeMode: 'INC' });
    await expect(reserve(cheap.initiative.id, 1)).rejects.toMatchObject({ reason: 'NOT_ON_SALE' });
  });

  it('la base de datos rechaza pasarse del aforo aunque falle el código', async () => {
    const { initiative } = await eventSetup({ ticketMax: 5 });
    await expect(db.initiative.update({ where: { id: initiative.id }, data: { ticketsSold: 6 } })).rejects.toThrow();
    await expect(db.initiative.update({ where: { id: initiative.id }, data: { ticketsSold: 3, ticketsHeld: 3 } })).rejects.toThrow();
  });

  it('rechaza cantidades imposibles y eventos que no están a la venta', async () => {
    const { initiative } = await eventSetup();
    for (const quantity of [0, -1, 1.5, 21]) await expect(reserve(initiative.id, quantity)).rejects.toMatchObject({ reason: 'INVALID_QUANTITY' });
    await expect(reserve(999_999_999, 1)).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const donation = await createInitiative(db, initiative.organizationId, { status: 'FUNDRAISING' });
    await expect(reserve(donation.id, 1)).rejects.toMatchObject({ reason: 'NOT_ON_SALE' });
    const closed = await eventSetup({ closesAt: new Date(Date.now() - 1_000) });
    await expect(reserve(closed.initiative.id, 1)).rejects.toMatchObject({ reason: 'NOT_ON_SALE' });
  });
});

describe('Reservas que no se pagan y pagos tardíos', () => {
  it('una reserva caducada deja sitio a la siguiente compra', async () => {
    const { initiative } = await eventSetup({ ticketMax: 2 });
    const start = new Date();
    await reserve(initiative.id, 2, start);
    await expect(reserve(initiative.id, 1, start)).rejects.toMatchObject({ reason: 'SOLD_OUT' });
    await reserve(initiative.id, 1, new Date(start.getTime() + TICKET_HOLD_MS + 1));
    expect(await counters(initiative.id)).toMatchObject({ ticketsHeld: 1 });
  });

  it('la tarea programada libera las caducadas de cualquier evento', async () => {
    const { initiative } = await eventSetup();
    const start = new Date('2030-01-01T10:00:00Z');
    const { contributionId } = await reserveTickets(db, { initiativeId: initiative.id, quantity: 3, buyer: { guestEmail: 'a@pruebas.example' }, paymentMethod: 'CARD' }, new Date());
    await db.contribution.update({ where: { id: contributionId }, data: { ticketHoldUntil: start } });
    expect(await releaseExpiredTicketHolds(db, new Date(start.getTime() + 1))).toBeGreaterThanOrEqual(1);
    expect(await counters(initiative.id)).toMatchObject({ ticketsHeld: 0 });
  });

  it('un pago fallido libera la plaza, una sola vez', async () => {
    const { initiative } = await eventSetup();
    const reservation = await reserve(initiative.id, 2);
    await deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents, 'KO');
    expect(await counters(initiative.id)).toMatchObject({ ticketsHeld: 0, ticketsSold: 0 });
    expect(await db.ticketPass.count({ where: { contributionId: reservation.contributionId } })).toBe(0);
  });

  it('pago tardío con plaza libre: entra y recibe su pase', async () => {
    const { initiative } = await eventSetup({ ticketMax: 3 });
    const start = new Date();
    const late = await reserve(initiative.id, 2, start);
    await releaseExpiredTicketHolds(db, new Date(start.getTime() + TICKET_HOLD_MS + 1));
    await deliver('PAYMENT', late.paycometOrder, late.totalChargedCents);
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 2, ticketsHeld: 0 });
    expect(await db.ticketPass.count({ where: { contributionId: late.contributionId } })).toBe(1);
  });

  it('pago tardío sin plaza: se devuelve entero y no cuenta en el aforo', async () => {
    const { initiative } = await eventSetup({ ticketMax: 2 });
    const start = new Date();
    const late = await reserve(initiative.id, 2, start);
    await releaseExpiredTicketHolds(db, new Date(start.getTime() + TICKET_HOLD_MS + 1));
    await buy(initiative.id, 2);
    expect(await deliver('PAYMENT', late.paycometOrder, late.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: late.contributionId } })).toMatchObject({ status: 'REFUND_PENDING' });
    expect(await db.ticketPass.count({ where: { contributionId: late.contributionId } })).toBe(0);
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 2 });
    expect(await getRaisedFromLedger(db, initiative.id)).toBe((await counters(initiative.id)).raisedCents);
  });
});

describe('Webhook de una entrada (deuda del Sprint 2.1)', () => {
  it('emite el pase, suma las plazas y deja el aviso en la bandeja de salida, sin QR', async () => {
    const { initiative } = await eventSetup();
    const { reservation, pass } = await buy(initiative.id, 3);
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 3, ticketsHeld: 0, raisedCents: 1_500 });
    expect(pass).toMatchObject({ quantity: 3, subtype: 'EVENT', checkedInCount: 0 });
    expect(pass.serialCode).toMatch(/^PASE-\d{4}-\d{6}$/);
    const outbox = await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `ticket.pass:${reservation.contributionId}` } });
    expect(outbox).toMatchObject({ templateKey: 'ticket.pass', toAddress: pass.holderEmail });
    expect(JSON.stringify(outbox.payloadJson)).not.toContain(pass.qrHmacSignature);
  });

  it('una entrega repetida o simultánea no emite dos pases ni suma dos veces', async () => {
    const { initiative } = await eventSetup();
    const reservation = await reserve(initiative.id, 2);
    await Promise.all([deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents), deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents)]);
    await deliver('PAYMENT', reservation.paycometOrder, reservation.totalChargedCents);
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 2, ticketsHeld: 0 });
    expect(await db.ticketPass.count({ where: { contributionId: reservation.contributionId } })).toBe(1);
  });

  it('sin el secreto del QR falla y se puede reintentar: nada queda a medias', async () => {
    const { initiative } = await eventSetup();
    const reservation = await reserve(initiative.id, 2);
    const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: reservation.paycometOrder, amountCents: reservation.totalChargedCents });
    expect(await handlePaymentWebhook(db, mock, rawBody, contentType)).toEqual({ status: 500, outcome: 'FAILED' });
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 0, ticketsHeld: 2, raisedCents: 0 });
    expect(await handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET })).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 2, ticketsHeld: 0, raisedCents: 1_000 });
  });

  it('un reembolso anula el pase y devuelve la plaza', async () => {
    const { initiative } = await eventSetup();
    const { reservation, pass } = await buy(initiative.id, 2);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    await refundContribution(db, mock, reservation.contributionId, '10.0.0.1');
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 0 });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass.id } })).revokedAt).not.toBeNull();
  });

  it('un contracargo anula el pase, también si KORUM asume la pérdida tras liquidar', async () => {
    const { organization, initiative } = await eventSetup();
    const inEscrow = await buy(initiative.id, 1);
    await deliver('CHARGEBACK', inEscrow.reservation.paycometOrder, inEscrow.reservation.totalChargedCents);
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 0 });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: inEscrow.pass.id } })).revokedAt).not.toBeNull();

    const settled = await buy(initiative.id, 2);
    await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId: initiative.id, status: 'EXECUTED', beneficiaryName: 'Entidad', netPaidCents: 1_000, korumFeeSettledCents: 0 } });
    await deliver('CHARGEBACK', settled.reservation.paycometOrder, settled.reservation.totalChargedCents);
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: settled.pass.id } })).revokedAt).not.toBeNull();
    expect(await counters(initiative.id)).toMatchObject({ ticketsSold: 2 });
  });
});

describe('QA-REG01 · QR anti-fotocopia', () => {
  it('alterado: FIRMA INVÁLIDA; parcial: 2 de 4; agotado: alerta con la hora del primer acceso', async () => {
    const { organization, initiative } = await eventSetup();
    const event = { organizationId: organization.id, initiativeId: initiative.id };
    const session = await gateActorWithSession(organization.id, initiative.id);
    const { pass } = await buy(initiative.id, 4);
    const payload = buildPassQrPayload(QR_SECRET, pass.uuid);
    const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    const firstAccess = new Date(Date.now() + 60_000);

    expect(await checkInPass(db, QR_SECRET, session, event, tampered, 1)).toEqual({ status: 'INVALID_SIGNATURE' });
    expect(await checkInPass(db, QR_SECRET, session, event, 'cualquier cosa', 1)).toEqual({ status: 'INVALID_SIGNATURE' });
    expect(await checkInPass(db, QR_SECRET, session, event, payload, 2, firstAccess)).toMatchObject({ status: 'ACCEPTED', entered: 2, remaining: 2 });
    expect(await getGateSummary(db, session, event)).toEqual({ checkedIn: 2, capacity: 4 });
    expect(await checkInPass(db, QR_SECRET, session, event, payload, 3)).toEqual({ status: 'INSUFFICIENT', remaining: 2, quantity: 4, firstAccessAt: firstAccess });
    expect(await checkInPass(db, QR_SECRET, session, event, payload, 2, new Date(firstAccess.getTime() + 300_000))).toMatchObject({ status: 'ACCEPTED', remaining: 0 });
    expect(await checkInPass(db, QR_SECRET, session, event, payload, 1)).toEqual({ status: 'EXHAUSTED', quantity: 4, firstAccessAt: firstAccess });

    const log = await db.ticketCheckIn.findMany({ where: { ticketPassId: pass.id }, orderBy: { id: 'asc' } });
    expect(log.map((entry) => [entry.accepted, entry.reason])).toEqual([[true, null], [false, 'CANTIDAD_SUPERIOR'], [true, null], [false, 'PASE_AGOTADO']]);
    // Una fila por tipo y sesión (QA-SEC09): dos QR inválidos seguidos de la misma sesión no escriben dos.
    expect(await db.auditLog.count({ where: { action: 'gate.qr_invalid', targetId: String(initiative.id) } })).toBe(1);
  });

  it('dos lecturas simultáneas de una fotocopia: solo entra una', async () => {
    const { organization, initiative } = await eventSetup();
    const { pass } = await buy(initiative.id, 1);
    const session = await gateActorWithSession(organization.id, initiative.id);
    const event = { organizationId: organization.id, initiativeId: initiative.id };
    const payload = buildPassQrPayload(QR_SECRET, pass.uuid);
    const results = await Promise.all([checkInPass(db, QR_SECRET, session, event, payload, 1), checkInPass(db, QR_SECRET, session, event, payload, 1)]);
    expect(results.map((result) => result.status).sort()).toEqual(['ACCEPTED', 'EXHAUSTED']);
  });

  it('un pase de otro evento o de otra entidad no sirve, y no revela de quién es', async () => {
    const own = await eventSetup();
    const other = await eventSetup();
    const { pass } = await buy(other.initiative.id, 1);
    const session = await gateActorWithSession(own.organization.id, own.initiative.id);
    const payload = buildPassQrPayload(QR_SECRET, pass.uuid);
    expect(await checkInPass(db, QR_SECRET, session, { organizationId: own.organization.id, initiativeId: own.initiative.id }, payload, 1)).toEqual({ status: 'OTHER_EVENT' });

    // Quien tiene cargo en una entidad tampoco puede indicar el evento de otra.
    const director = member(own.organization.id);
    expect(await checkInPass(db, QR_SECRET, director, { organizationId: own.organization.id, initiativeId: other.initiative.id }, payload, 1)).toEqual({ status: 'OTHER_EVENT' });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass.id } })).checkedInCount).toBe(0);
  });

  it('una sesión de portería no puede operar sobre otro evento ni sin sesión', async () => {
    const own = await eventSetup();
    const other = await eventSetup({ organizationId: own.organization.id });
    const { pass } = await buy(own.initiative.id, 1);
    const session = await gateActorWithSession(own.organization.id, own.initiative.id);
    const payload = buildPassQrPayload(QR_SECRET, pass.uuid);
    await expect(checkInPass(db, QR_SECRET, session, { organizationId: own.organization.id, initiativeId: other.initiative.id }, payload, 1)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(checkInPass(db, QR_SECRET, { kind: 'anonymous' }, { organizationId: own.organization.id, initiativeId: own.initiative.id }, payload, 1)).rejects.toBeInstanceOf(TenantAccessError);
  });

  it('un pase anulado y un evento cancelado no entran', async () => {
    const { organization, initiative } = await eventSetup();
    const event = { organizationId: organization.id, initiativeId: initiative.id };
    const session = await gateActorWithSession(organization.id, initiative.id);
    const revoked = await buy(initiative.id, 1);
    await deliver('CHARGEBACK', revoked.reservation.paycometOrder, revoked.reservation.totalChargedCents);
    expect(await checkInPass(db, QR_SECRET, session, event, buildPassQrPayload(QR_SECRET, revoked.pass.uuid), 1)).toEqual({ status: 'REVOKED' });

    const valid = await buy(initiative.id, 1);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CANCELLED' } });
    expect(await checkInPass(db, QR_SECRET, session, event, buildPassQrPayload(QR_SECRET, valid.pass.uuid), 1)).toEqual({ status: 'EVENT_CLOSED' });
  });

  it('rechaza un número de personas imposible', async () => {
    const { organization, initiative } = await eventSetup();
    const session = await gateActorWithSession(organization.id, initiative.id);
    await expect(checkInPass(db, QR_SECRET, session, { organizationId: organization.id, initiativeId: initiative.id }, 'x', 0)).rejects.toBeInstanceOf(RangeError);
  });
});

/** Abre una sesión de portería de verdad, con su PIN. */
async function gateActorWithSession(organizationId: string, initiativeId: number): Promise<SessionActor> {
  const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organizationId), organizationId, initiativeId);
  const opened = await openGateSession(db, PIN_SECRET, { initiativeId, pin, requestMeta: { ipHash: uniqueId('ip') } });
  if (opened.status !== 'OPENED') throw new Error('La sesión de prueba no se abrió');
  return { kind: 'gate', gateSessionId: opened.gateSessionId, organizationId, initiativeId };
}

describe('QA-SEC06 · PIN de portería contra fuerza bruta', () => {
  const wrong = (pin: string) => (pin === '000000' ? '000001' : '000000');
  const fiveMinutes = 5 * 60_000;

  it('quien deja de firmar justo mientras se calcula su PIN no deja un PIN vivo: se vuelve a comprobar el cargo con la entidad bloqueada (auditoría de seguridad del 5.2, H1)', async () => {
    const { organization, initiative } = await eventSetup({ closesAt: new Date(Date.now() + 3_600_000) });
    const leaving = await signerOf(db, organization.id, 'COSIGNER');
    if (leaving.kind !== 'user') throw new Error('actor de prueba');
    // Le dan de baja (firma única o relevo), pero la petición que ya estaba en vuelo todavía lleva su cargo en la sesión.
    await db.organizationMember.deleteMany({ where: { organizationId: organization.id, userId: leaving.userId, role: 'COSIGNER' } });
    await expect(setGatePin(db, PIN_SECRET, leaving, organization.id, initiative.id)).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id }, select: { gatePinHash: true } })).gatePinHash).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'gate.pin_set', targetId: String(initiative.id) } })).toBe(0);
    // El intento denegado sí queda anotado (fuera de la transacción deshecha).
    expect(await db.auditLog.count({ where: { action: 'tenant.access_denied', targetId: String(initiative.id), actorUserId: leaving.userId } })).toBe(1);
  });

  it('solo los firmantes generan el PIN, se guarda con hash y caduca 6 h tras la fecha del evento guardada en la iniciativa', async () => {
    const end = new Date(Date.now() + 3_600_000);
    const { organization, initiative } = await eventSetup({ closesAt: end });
    await expect(setGatePin(db, PIN_SECRET, member(organization.id, 'GATEKEEPER'), organization.id, initiative.id)).rejects.toBeInstanceOf(TenantAccessError);
    const { pin, expiresAt } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    expect(expiresAt.getTime()).toBe(end.getTime() + 6 * 3_600_000);
    const stored = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(stored.gatePinHash).not.toContain(pin);
    expect(stored.gatePinExpiresAt?.getTime()).toBe(end.getTime() + 6 * 3_600_000);
    // Un evento que terminó hace más de 6 horas ya no admite PIN.
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() - 7 * 3_600_000) } });
    await expect(setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id)).rejects.toThrow('ya ha terminado');
    const other = await eventSetup();
    await expect(setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, other.initiative.id)).rejects.toThrow('no encontrado');
  });

  it('un PIN de otro evento no sirve', async () => {
    const a = await eventSetup();
    const b = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, a.organization.id), a.organization.id, a.initiative.id);
    let other = await setGatePin(db, PIN_SECRET, await signerOf(db, b.organization.id), b.organization.id, b.initiative.id);
    // Una entre un millón coincidirían por azar, y la prueba no diría nada.
    while (other.pin === pin) other = await setGatePin(db, PIN_SECRET, await signerOf(db, b.organization.id), b.organization.id, b.initiative.id);
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: b.initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } })).toEqual({ status: 'INVALID' });
  });

  it('sondear otra entidad o un evento inexistente queda registrado o no escribe nada', async () => {
    const own = await eventSetup();
    const other = await eventSetup();
    const director = member(own.organization.id);
    await expect(setGatePin(db, PIN_SECRET, director, own.organization.id, other.initiative.id)).rejects.toThrow('no encontrado');
    await expect(getGateSummary(db, director, { organizationId: own.organization.id, initiativeId: other.initiative.id })).rejects.toThrow('no encontrado');
    expect(await db.auditLog.count({ where: { action: 'tenant.resource_outside_tenant', targetId: String(other.initiative.id) } })).toBe(2);
    await db.initiative.update({ where: { id: own.initiative.id }, data: { closesAt: new Date(Date.now() + 2 * 365 * 86_400_000) } });
    await expect(setGatePin(db, PIN_SECRET, director, own.organization.id, own.initiative.id)).rejects.toThrow('demasiado lejana');

    // Recorrer identificadores que no existen solo escribe el contador global de su red (que se purga): ni auditoría ni un contador por evento.
    const ipHash = uniqueId('ip');
    const rows = await db.rateLimit.count();
    const audits = await db.auditLog.count();
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: 999_999_998, pin: '123456', requestMeta: { ipHash } })).toEqual({ status: 'INVALID' });
    expect(await db.rateLimit.count()).toBe(rows + 1);
    expect(await db.rateLimit.count({ where: { key: { startsWith: 'gate:entry:ip:' }, id: { endsWith: ipHash } } })).toBe(1);
    expect(await db.auditLog.count()).toBe(audits);
  });

  it('no caben más de 5 fallos en 6 minutos, tampoco repartidos alrededor del final de la ventana', async () => {
    const { organization, initiative } = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    const requestMeta = { ipHash: uniqueId('ip') };
    const start = Date.now();
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: wrong(pin), requestMeta }, new Date(start))).toEqual({ status: 'INVALID' });
    for (let attempt = 0; attempt < 4; attempt += 1) expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: wrong(pin), requestMeta }, new Date(start + 5 * 60_000))).toEqual({ status: 'INVALID' });
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: wrong(pin), requestMeta }, new Date(start + 7 * 60_000))).toEqual({ status: 'LOCKED' });
  }, 30_000);

  it('un PIN nuevo quita los bloqueos de la wifi de los voluntarios', async () => {
    const { organization, initiative } = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    const requestMeta = { ipHash: uniqueId('ip') };
    for (let attempt = 0; attempt < 5; attempt += 1) await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: wrong(pin), requestMeta });
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta })).toEqual({ status: 'LOCKED' });
    const renewed = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: renewed.pin, requestMeta })).toMatchObject({ status: 'OPENED' });
  }, 30_000);

  it('si falló la revocación, el siguiente intento la completa y avisa', async () => {
    const { organization, initiative } = await eventSetup();
    await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    await db.rateLimit.create({ data: { id: `gate-pin:event:${initiative.id}`, key: `gate-pin:event:${initiative.id}`, count: MAX_FAILURES_PER_EVENT, lastRequest: BigInt(Date.now() - 120_000) } });
    const locked = await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: '123456', requestMeta: { ipHash: uniqueId('ip') } });
    // Ahora hay una persona firmante real a quien avisar: el aviso sale en esta misma respuesta.
    expect(locked).toEqual({ status: 'LOCKED', outboxIds: [expect.any(Number)] });
    const notice = await db.outboxMessage.findUniqueOrThrow({ where: { id: (locked as { outboxIds: number[] }).outboxIds[0]! }, select: { templateKey: true } });
    expect(notice.templateKey).toBe('gate.pinRevoked');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).gatePinHash).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'gate.pin_revoked', targetId: String(initiative.id) } })).toBe(1);
  });

  it('5 fallos desde la misma IP bloquean esa red 6 minutos, y pasados 6 minutos se puede volver a probar; otra red no se ve afectada', async () => {
    const { organization, initiative } = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    const requestMeta = { ipHash: uniqueId('ip') };
    const start = new Date();
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: wrong(pin), requestMeta }, start)).toEqual({ status: 'INVALID' });
    // Bloqueada: ni el PIN correcto entra desde esa IP.
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta }, start)).toEqual({ status: 'LOCKED' });
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta }, new Date(start.getTime() + fiveMinutes))).toEqual({ status: 'LOCKED' });
    expect(await db.auditLog.count({ where: { action: 'gate.pin_failed', targetId: String(initiative.id) } })).toBe(5);
    // Solo el primer bloqueo de la ventana deja fila de auditoría (QA-SEC09): el segundo, cinco minutos después, no escribe otra.
    expect(await db.auditLog.count({ where: { action: 'gate.pin_blocked', targetId: String(initiative.id) } })).toBe(1);
    // Otra IP no está bloqueada.
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } }, start)).toMatchObject({ status: 'OPENED' });
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta }, new Date(start.getTime() + 6 * 60_000))).toMatchObject({ status: 'OPENED' });
  }, 30_000);

  it('muchos intentos simultáneos no pasan del límite', async () => {
    const { organization, initiative } = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    const requestMeta = { ipHash: uniqueId('ip') };
    const results = await Promise.all(Array.from({ length: 8 }, () => openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: wrong(pin), requestMeta })));
    expect(results.filter((result) => result.status === 'INVALID')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'LOCKED')).toHaveLength(3);
  }, 30_000);

  it('con 25 fallos en el evento el PIN se revoca y se avisa a los firmantes; las sesiones abiertas siguen', async () => {
    const { organization, initiative } = await eventSetup();
    const director = await createUser(db);
    const cosigner = await createUser(db);
    await db.organizationMember.createMany({ data: [{ userId: director.id, organizationId: organization.id, role: 'DIRECTOR' }, { userId: cosigner.id, organizationId: organization.id, role: 'COSIGNER' }] });
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    const open = await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } });
    if (open.status !== 'OPENED') throw new Error('Debía abrirse');

    for (let attempt = 0; attempt < MAX_FAILURES_PER_EVENT; attempt += 1) {
      // El intento que anula el PIN devuelve además los avisos creados (se envían al momento).
      expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: wrong(pin), requestMeta: { ipHash: uniqueId('ip') } })).toMatchObject({ status: 'INVALID' });
    }
    const stored = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(stored.gatePinHash).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'gate.pin_revoked', targetId: String(initiative.id) } })).toBe(1);
    const notices = await db.outboxMessage.findMany({ where: { templateKey: 'gate.pinRevoked', organizationId: organization.id } });
    expect(notices.map((notice) => notice.toAddress).sort()).toEqual([director.email, cosigner.email].sort());
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } })).toEqual({ status: 'INVALID' });
    expect(await resolveGateSession(db, PIN_SECRET, open.token)).not.toBeNull();

    // Un PIN nuevo vuelve a funcionar, con el contador a cero.
    const renewed = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin: renewed.pin, requestMeta: { ipHash: uniqueId('ip') } })).toMatchObject({ status: 'OPENED' });
    expect(await resolveGateSession(db, PIN_SECRET, open.token)).toBeNull();
  }, 240_000);

  it('QA-SEC05 · un PIN caducado no abre sesión, y el token solo se guarda como hash', async () => {
    const { organization, initiative } = await eventSetup();
    const { pin, expiresAt } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } }, new Date(expiresAt.getTime() + 1))).toEqual({ status: 'INVALID' });
    const opened = await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } });
    if (opened.status !== 'OPENED') throw new Error('Debía abrirse');
    const session = await db.gateSession.findUniqueOrThrow({ where: { id: opened.gateSessionId } });
    expect(session.tokenHash).not.toContain(opened.token);
    expect(await resolveGateSession(db, PIN_SECRET, opened.token, undefined, new Date(expiresAt.getTime() + 1))).toBeNull();
    expect(await resolveGateSession(db, PIN_SECRET, 'token-inventado')).toBeNull();
  }, 30_000);

  it('la entidad cierra una sesión y deja de valer al instante; otra entidad no puede cerrarla', async () => {
    const { organization, initiative } = await eventSetup();
    const other = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, initiative.id);
    const opened = await openGateSession(db, PIN_SECRET, { initiativeId: initiative.id, pin, requestMeta: { ipHash: uniqueId('ip') } });
    if (opened.status !== 'OPENED') throw new Error('Debía abrirse');
    const actor = (await resolveGateSession(db, PIN_SECRET, opened.token))!;
    await expect(revokeGateSession(db, member(other.organization.id), other.organization.id, opened.gateSessionId)).rejects.toThrow('no encontrado');
    expect(await db.auditLog.count({ where: { action: 'tenant.resource_outside_tenant', targetId: opened.gateSessionId } })).toBe(1);
    await revokeGateSession(db, member(organization.id), organization.id, opened.gateSessionId);
    expect(await resolveGateSession(db, PIN_SECRET, opened.token)).toBeNull();
    await expect(getGateSummary(db, actor, { organizationId: organization.id, initiativeId: initiative.id })).rejects.toBeInstanceOf(TenantAccessError);
    expect(await resolveGateSession(db, PIN_SECRET, opened.token, { ipHash: 'hash-de-ip' })).toBeNull();
    // Una sola fila por sesión cerrada y ventana de 6 horas, aunque insista varias veces (QA-SEC09).
    expect(await db.auditLog.count({ where: { action: 'gate.session_rejected', targetId: opened.gateSessionId } })).toBe(1);
    expect(await resolveGateSession(db, PIN_SECRET, opened.token, undefined, new Date(Date.now() + 6 * 3_600_000 + 60_000))).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'gate.session_rejected', targetId: opened.gateSessionId } })).toBe(2);
    const auditRows = await db.auditLog.count({ where: { action: 'gate.session_rejected' } });
    expect(await resolveGateSession(db, PIN_SECRET, 'token-que-no-existe')).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'gate.session_rejected' } })).toBe(auditRows);
  }, 30_000);
});

describe('Liquidar lo vendido', () => {
  const SIGNATURE_SECRET = 'secreto-de-integracion-de-las-firmas-0123456789';

  /** Prepara una liquidación firmada por dos personas de lo que haya recaudado la iniciativa. */
  async function signedPayout(organizationId: string, initiativeId: number) {
    const { raisedCents } = await counters(initiativeId);
    const payout = await db.escrowPayout.create({ data: { organizationId, initiativeId, destinationType: 'ORGANIZATION', beneficiaryName: 'Entidad', netPaidCents: raisedCents, korumFeeSettledCents: 0 } });
    const { paycometSplitId } = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { paycometSplitId: true } });
    const digest = payoutDigestFor(SIGNATURE_SECRET, { ...payout, providerInvoiceFile: null }, paycometSplitId);
    for (const role of ['DIRECTOR', 'COSIGNER'] as const) {
      const signer = await createUser(db, { twoFactorEnabled: true });
      const membership = await db.organizationMember.create({ data: { userId: signer.id, organizationId, role } });
      const signedAt = new Date();
      const otpVerifiedAt = new Date();
      const signatureHash = computeSignatureHash(SIGNATURE_SECRET, { organizationId, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: digest, signerUserId: signer.id, signerRole: role, membershipId: membership.id, signedAt, otpVerifiedAt });
      await db.doubleCheckSignature.create({ data: { organizationId, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: signer.id, signerRole: role, signatureHash, targetDigest: digest, membershipId: membership.id, signedAt, otpVerifiedAt } });
    }
    return payout;
  }

  it('un evento INC agotado se liquida aunque la hucha quede por debajo de la meta', async () => {
    const { organization, initiative } = await eventSetup({ ticketMax: 2, goalCents: 1_000, ticketFeeMode: 'INC' });
    await buy(initiative.id, 2);
    const payout = await signedPayout(organization.id, initiative.id);
    expect(await approvePayout(db, payout.id, SIGNATURE_SECRET)).toMatchObject({ approved: true });
  });

});
