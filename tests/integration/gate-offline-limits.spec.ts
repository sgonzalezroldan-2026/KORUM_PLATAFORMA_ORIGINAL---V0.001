import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeGateDeviceLabels } from '@/core/privacy/retention-purge';
import { checkInPass } from '@/core/ticketing/check-in.service';
import { GATE_CODE_PATTERN } from '@/core/ticketing/gate-code';
import { allowGateRequest } from '@/core/ticketing/gate-limits';
import { buildGateList, signatureDigest } from '@/core/ticketing/gate-list.service';
import { decideOffline, digestSignature } from '@/core/ticketing/gate-offline';
import { GATE_REQUEST_RULE, GATE_ENTRY_RULE } from '@/lib/rate-limit-rules';
import { MAX_SCAN_AGE_MS } from '@/core/ticketing/gate-rules';
import { MAX_FAILURES_PER_EVENT, openGateSession, revokeGateSession, rotateGateCode, setGatePin } from '@/core/ticketing/gate-session.service';
import { syncGateScans } from '@/core/ticketing/gate-sync.service';
import { buildPassQrPayload, signPass } from '@/core/ticketing/qr-signature';
import type { KorumPrismaClient } from '@/lib/prisma';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadGateAdmin } from '@/repositories/gate-admin.repository';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { reserveTickets } from '@/core/ticketing/ticket-reservation.service';
import { createInitiative, createOrganization, createTestClient, createUser, signerOf, uniqueId } from './test-database';

/**
 * Sprint 4.5 · portería móvil: lecturas sin cobertura (QA-S04), límites de la red (QA-SEC09) y pantalla del panel.
 */

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
  return { organization, initiative, event: { organizationId: organization.id, initiativeId: initiative.id } };
}

async function buy(initiativeId: number, quantity: number) {
  const reservation = await reserveTickets(db, { initiativeId, quantity, buyer: { guestEmail: `${uniqueId('familia')}@pruebas.example` }, paymentMethod: 'BIZUM' });
  const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: reservation.paycometOrder, amountCents: reservation.totalChargedCents, response: 'OK' });
  await handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET });
  const pass = await db.ticketPass.findUniqueOrThrow({ where: { contributionId: reservation.contributionId } });
  return { reservation, pass, payload: buildPassQrPayload(QR_SECRET, pass.uuid) };
}

const director = (organizationId: string): SessionActor => ({ kind: 'user', userId: uniqueId('user'), isSuperadmin: false, memberships: [{ organizationId, role: 'DIRECTOR' }], secondFactor: true });

type GateActor = Extract<SessionActor, { kind: 'gate' }>;

/** Un voluntario más entra con el PIN que ya hay (generar otro cerraría las sesiones abiertas). */
async function joinGate(organizationId: string, initiativeId: number, pin: string): Promise<GateActor> {
  const opened = await openGateSession(db, PIN_SECRET, { initiativeId, pin, deviceLabel: 'Puerta norte', requestMeta: { ipHash: uniqueId('ip') } });
  if (opened.status !== 'OPENED') throw new Error('La sesión de prueba no se abrió');
  return { kind: 'gate', gateSessionId: opened.gateSessionId, organizationId, initiativeId };
}

async function gateSession(organizationId: string, initiativeId: number): Promise<GateActor> {
  const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organizationId), organizationId, initiativeId);
  return joinGate(organizationId, initiativeId, pin);
}

describe('QA-S04 · lista de pases y lecturas con cuatro plazas', () => {
  it('la lista lleva solo pases de entrada pagados y no anulados, con la huella de la firma y sin datos de nadie', async () => {
    const { event, initiative } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const valid = await buy(initiative.id, 4);
    const revoked = await buy(initiative.id, 1);
    await db.ticketPass.update({ where: { id: revoked.pass.id }, data: { revokedAt: new Date() } });
    const list = await buildGateList(db, session, event);
    expect(list.passes).toEqual([{ u: valid.pass.uuid, q: 4, c: 0, h: signatureDigest(valid.pass.qrHmacSignature) }]);
    expect(JSON.stringify(list)).not.toContain('@');
    expect(JSON.stringify(list)).not.toContain(valid.pass.qrHmacSignature);
    // El móvil calcula la misma huella que el servidor.
    expect(await digestSignature(signPass(QR_SECRET, valid.pass.uuid))).toBe(list.passes[0]!.h);

    // Otro evento, otra entidad, o sin sesión: nada.
    const other = await eventSetup();
    await expect(buildGateList(db, session, other.event)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(buildGateList(db, { kind: 'anonymous' }, event)).rejects.toBeInstanceOf(TenantAccessError);
  });

  it('una lectura sin red decide con la lista y coincide con lo que decidiría el servidor', async () => {
    const { event, initiative } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const { payload } = await buy(initiative.id, 4);
    const list = await buildGateList(db, session, event);
    expect(await decideOffline(list, {}, payload, 'ASK')).toMatchObject({ status: 'CHOOSE', remaining: 4, quantity: 4 });
    expect(await decideOffline(list, {}, payload, 2)).toMatchObject({ status: 'ACCEPTED', entered: 2, remaining: 2 });
    expect(await decideOffline(list, { [list.passes[0]!.u]: { count: 3, firstAt: 1_000 } }, payload, 2)).toEqual({ status: 'INSUFFICIENT', remaining: 1, quantity: 4, firstAccessAt: 1_000 });
    const forged = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    expect(await decideOffline(list, {}, forged, 'ASK')).toEqual({ status: 'UNKNOWN' });
    expect(await decideOffline(list, {}, 'cualquier cosa', 'ASK')).toEqual({ status: 'INVALID_FORMAT' });
  });

  it("'ASK' pregunta con varias plazas libres sin anotar nada; con una sola, entra", async () => {
    const { event, initiative } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const group = await buy(initiative.id, 4);
    const single = await buy(initiative.id, 1);
    expect(await checkInPass(db, QR_SECRET, session, event, group.payload, 'ASK')).toMatchObject({ status: 'CHOOSE', remaining: 4, quantity: 4 });
    expect(await db.ticketCheckIn.count({ where: { ticketPassId: group.pass.id } })).toBe(0);
    expect(await checkInPass(db, QR_SECRET, session, event, single.payload, 'ASK')).toMatchObject({ status: 'ACCEPTED', entered: 1, remaining: 0 });
    expect(await checkInPass(db, QR_SECRET, session, event, group.payload, 3)).toMatchObject({ status: 'ACCEPTED', entered: 3, remaining: 1 });
    expect(await checkInPass(db, QR_SECRET, session, event, group.payload, 'ASK')).toMatchObject({ status: 'ACCEPTED', entered: 1, remaining: 0 });
    expect(await checkInPass(db, QR_SECRET, session, event, group.payload, 'ASK')).toMatchObject({ status: 'EXHAUSTED' });
  });

  it('valida en menos de medio segundo', async () => {
    const { event, initiative } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const times: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { payload } = await buy(initiative.id, 1);
      const started = performance.now();
      expect(await checkInPass(db, QR_SECRET, session, event, payload, 'ASK')).toMatchObject({ status: 'ACCEPTED' });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(500);
  });
});

describe('QA-S04 · sincronizar lo leído sin cobertura', () => {
  const scan = (payload: string, quantity: number, scannedAt: number, clientScanId = uniqueId('lectura')) => ({ clientScanId, payload, quantity, scannedAt });

  it('reenviar la cola no deja entrar dos veces, ni con dos envíos a la vez', async () => {
    const { event, initiative } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const { payload, pass } = await buy(initiative.id, 4);
    const batch = { scans: [scan(payload, 2, Date.now() - 60_000, 'lectura-uno-aaaa')] };
    const [first, second] = await Promise.all([syncGateScans(db, QR_SECRET, session, event, batch), syncGateScans(db, QR_SECRET, session, event, batch)]);
    expect([first.results[0]!.outcome.status, second.results[0]!.outcome.status].sort()).toEqual(['ACCEPTED', 'DUPLICATE_SCAN']);
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass.id } })).checkedInCount).toBe(2);
    const again = await syncGateScans(db, QR_SECRET, session, event, batch);
    expect(again.results[0]!.outcome).toEqual({ status: 'DUPLICATE_SCAN', accepted: true });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass.id } })).checkedInCount).toBe(2);
    const rows = await db.ticketCheckIn.findMany({ where: { ticketPassId: pass.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ offline: true, accepted: true, clientScanId: 'lectura-uno-aaaa' });
    // Solo el lote que anotó algo deja fila: reenviar lecturas ya recibidas no escribe otra (la auditoría no se puede purgar).
    expect(await db.auditLog.count({ where: { action: 'gate.sync', organizationId: event.organizationId } })).toBe(1);
  });

  it('si otro móvil ya había dejado entrar el pase, la lectura sin red vuelve como conflicto con la hora del primer acceso', async () => {
    const { event, initiative } = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, event.organizationId), event.organizationId, event.initiativeId);
    const phoneA = await joinGate(event.organizationId, event.initiativeId, pin);
    const phoneB = await joinGate(event.organizationId, event.initiativeId, pin);
    const { payload, pass } = await buy(initiative.id, 4);
    const online = await checkInPass(db, QR_SECRET, phoneA, event, payload, 4);
    expect(online).toMatchObject({ status: 'ACCEPTED', remaining: 0 });
    const {
      results: [result]
    } = await syncGateScans(db, QR_SECRET, phoneB, event, { scans: [scan(payload, 2, Date.now() - 30_000)] });
    expect(result!.outcome).toMatchObject({ status: 'EXHAUSTED', quantity: 4 });
    const first = result!.outcome.status === 'EXHAUSTED' ? result!.outcome.firstAccessAt : null;
    expect(first).not.toBeNull();
    const rows = await db.ticketCheckIn.findMany({ where: { ticketPassId: pass.id }, orderBy: { id: 'asc' } });
    expect(rows.map((row) => [row.accepted, row.offline, row.reason])).toEqual([[true, false, null], [false, true, 'PASE_AGOTADO']]);
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass.id } })).checkedInCount).toBe(4);
  });

  it('la hora de una lectura sin red se acota: ni futura, ni anterior a la sesión, ni de hace días', async () => {
    const { event, initiative } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const opened = (await db.gateSession.findUniqueOrThrow({ where: { id: session.gateSessionId } })).createdAt;
    const future = await buy(initiative.id, 1);
    const past = await buy(initiative.id, 1);
    const ancient = await buy(initiative.id, 1);
    const now = new Date();
    await syncGateScans(db, QR_SECRET, session, event, { scans: [scan(future.payload, 1, now.getTime() + 3_600_000), scan(past.payload, 1, opened.getTime() - 3_600_000), scan(ancient.payload, 1, now.getTime() - MAX_SCAN_AGE_MS * 2)] }, now);
    const at = async (passId: number) => (await db.ticketCheckIn.findFirstOrThrow({ where: { ticketPassId: passId } })).createdAt.getTime();
    expect(await at(future.pass.id)).toBe(now.getTime());
    expect(await at(past.pass.id)).toBe(opened.getTime());
    expect(await at(ancient.pass.id)).toBeGreaterThanOrEqual(opened.getTime());
    expect(await at(ancient.pass.id)).toBeLessThanOrEqual(now.getTime());
  });

  it('una sesión cerrada no puede enviar lecturas: la cola queda en el móvil', async () => {
    const { event, initiative } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const { payload } = await buy(initiative.id, 1);
    await db.gateSession.update({ where: { id: session.gateSessionId }, data: { revokedAt: new Date() } });
    await expect(syncGateScans(db, QR_SECRET, session, event, { scans: [scan(payload, 1, Date.now())] })).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.ticketCheckIn.count({ where: { gateSessionId: session.gateSessionId } })).toBe(0);
  });
});

describe('QA-SEC09 · portería expuesta a Internet', () => {
  it('una red que pasa de 60 intentos de PIN en 15 minutos, en todos los eventos, queda bloqueada y deja una sola fila de auditoría', async () => {
    const { event } = await eventSetup();
    const ipHash = uniqueId('ip');
    await db.rateLimit.create({ data: { id: `${GATE_ENTRY_RULE.prefix}${ipHash}`, key: `${GATE_ENTRY_RULE.prefix}${ipHash}`, count: GATE_ENTRY_RULE.limit, lastRequest: BigInt(Date.now()) } });
    const rowsBefore = await db.rateLimit.count();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId + attempt * 1_000, pin: '123456', requestMeta: { ipHash } })).toEqual({ status: 'LOCKED' });
    }
    // Solo se añadió la marca de «ya anotado»: no una fila de contador por evento recorrido.
    expect(await db.rateLimit.count()).toBe(rowsBefore + 1);
    const blocked = await db.auditLog.findMany({ where: { action: 'gate.pin_blocked', ipHash } });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ targetType: 'Gate', metadataJson: { cause: 'NETWORK_LIMIT' } });
    // Pasada la ventana, vuelve a poder probar.
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: 999_999_997, pin: '123456', requestMeta: { ipHash } }, new Date(Date.now() + 16 * 60_000))).toEqual({ status: 'INVALID' });
  });

  it('las peticiones con sesión también cuentan por red, y el bloqueo se anota una vez por ventana', async () => {
    const ipHash = uniqueId('ip');
    const now = new Date();
    await db.rateLimit.create({ data: { id: `${GATE_REQUEST_RULE.prefix}${ipHash}`, key: `${GATE_REQUEST_RULE.prefix}${ipHash}`, count: GATE_REQUEST_RULE.limit, lastRequest: BigInt(now.getTime()) } });
    expect(await allowGateRequest(db, { ipHash }, now)).toBe(false);
    expect(await allowGateRequest(db, { ipHash }, now)).toBe(false);
    expect(await allowGateRequest(db, { ipHash }, now)).toBe(false);
    expect(await db.auditLog.count({ where: { action: 'gate.request_limited', ipHash } })).toBe(1);
    expect(await allowGateRequest(db, { ipHash }, new Date(now.getTime() + 61_000))).toBe(true);
    // Otra red no se ve afectada.
    expect(await allowGateRequest(db, { ipHash: uniqueId('ip') }, now)).toBe(true);
  });

  it('cambiar la fecha del evento mueve la caducidad del PIN: no la decide quien llama', async () => {
    const firstDay = new Date(Date.now() + 2 * 86_400_000);
    const { event } = await eventSetup({ closesAt: firstDay });
    const first = await setGatePin(db, PIN_SECRET, await signerOf(db, event.organizationId), event.organizationId, event.initiativeId);
    expect(first.expiresAt.getTime()).toBe(firstDay.getTime() + 6 * 3_600_000);
    const later = new Date(Date.now() + 10 * 86_400_000);
    await db.initiative.update({ where: { id: event.initiativeId }, data: { closesAt: later } });
    const second = await setGatePin(db, PIN_SECRET, await signerOf(db, event.organizationId), event.organizationId, event.initiativeId);
    expect(second.expiresAt.getTime()).toBe(later.getTime() + 6 * 3_600_000);
  });
});

describe('Panel de la taquilla', () => {
  it('el panel lista los eventos de la entidad con su PIN y sus móviles, sin el hash del PIN, y solo para quien firma', async () => {
    const mine = await eventSetup();
    const other = await eventSetup();
    await gateSession(mine.event.organizationId, mine.event.initiativeId);
    const events = await loadGateAdmin(db, director(mine.event.organizationId), mine.event.organizationId);
    expect(events.map((item) => item.id)).toEqual([mine.event.initiativeId]);
    expect(events[0]).toMatchObject({ pinActive: true });
    expect(events[0]!.sessions).toEqual([expect.objectContaining({ deviceLabel: 'Puerta norte', scans: 0 })]);
    expect(JSON.stringify(events)).not.toContain('scrypt');
    expect(events.some((item) => item.id === other.event.initiativeId)).toBe(false);
    await expect(loadGateAdmin(db, { kind: 'user', userId: uniqueId('user'), isSuperadmin: false, memberships: [{ organizationId: mine.event.organizationId, role: 'GATEKEEPER' }] }, mine.event.organizationId)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(loadGateAdmin(db, director(other.event.organizationId), mine.event.organizationId)).rejects.toBeInstanceOf(TenantAccessError);
  });
});

describe('Conservación del nombre del móvil (CUMPLIMIENTO §6)', () => {
  it('el nombre que un voluntario da a su móvil se vacía a los 90 días de caducar la sesión, y solo entonces', async () => {
    const { event } = await eventSetup();
    const recent = await gateSession(event.organizationId, event.initiativeId);
    const old = await gateSession(event.organizationId, event.initiativeId);
    const day = 86_400_000;
    await db.gateSession.update({ where: { id: old.gateSessionId }, data: { expiresAt: new Date(Date.now() - 100 * day) } });
    await db.gateSession.update({ where: { id: recent.gateSessionId }, data: { expiresAt: new Date(Date.now() - 80 * day) } });
    await purgeGateDeviceLabels(db, new Date(), 100);
    expect((await db.gateSession.findUniqueOrThrow({ where: { id: old.gateSessionId } })).deviceLabel).toBeNull();
    expect((await db.gateSession.findUniqueOrThrow({ where: { id: recent.gateSessionId } })).deviceLabel).toBe('Puerta norte');
  });
});

describe('Correcciones de la auditoría del Sprint 4.5', () => {
  const scanOf = (payload: string, quantity: number, clientScanId = uniqueId('lectura')) => ({ clientScanId, payload, quantity, scannedAt: Date.now() - 1_000 });

  it('(B1) sondear campañas sin taquilla, o eventos sin PIN, no llena la auditoría: una fila por red y ventana como mucho', async () => {
    const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    const budget = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    for (let index = 0; index < 30; index += 1) {
      expect(await openGateSession(db, PIN_SECRET, { initiativeId: budget.id, pin: '123456', requestMeta: { ipHash: uniqueId('ip') } })).toEqual({ status: 'INVALID' });
    }
    expect(await db.auditLog.count({ where: { targetId: String(budget.id), action: { startsWith: 'gate.' } } })).toBe(0);

    const { event } = await eventSetup();
    const ipHash = uniqueId('ip');
    for (let attempt = 0; attempt < 8; attempt += 1) await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId, pin: '123456', requestMeta: { ipHash } });
    expect(await db.auditLog.count({ where: { targetId: String(event.initiativeId), action: 'gate.pin_failed' } })).toBe(1);
  });

  it('(R1) quien tiene el PIN no abre sesiones sin límite: las entradas correctas también cuentan para el tope de la red', async () => {
    const { event } = await eventSetup();
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, event.organizationId), event.organizationId, event.initiativeId);
    const ipHash = uniqueId('ip');
    const key = `${GATE_ENTRY_RULE.prefix}${ipHash}`;
    await db.rateLimit.create({ data: { id: key, key, count: GATE_ENTRY_RULE.limit - 1, lastRequest: BigInt(Date.now()) } });
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId, pin, requestMeta: { ipHash } })).toMatchObject({ status: 'OPENED' });
    expect(await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId, pin, requestMeta: { ipHash } })).toEqual({ status: 'LOCKED' });
    expect(await db.gateSession.count({ where: { initiativeId: event.initiativeId } })).toBe(1);
  });

  it('(R2) con muchas redes distintas, un evento sin PIN o bloqueado deja una sola fila por ventana, no una por red', async () => {
    const { event } = await eventSetup();
    for (let index = 0; index < 40; index += 1) await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId, pin: '123456', requestMeta: { ipHash: uniqueId('ip') } });
    expect(await db.auditLog.count({ where: { targetId: String(event.initiativeId), action: { startsWith: 'gate.' } } })).toBe(1);
  });

  it('(I1) un lote de 100 QR falsos deja una fila de auditoría por tipo, no 101', async () => {
    const { event } = await eventSetup();
    const session = await gateSession(event.organizationId, event.initiativeId);
    const forgedPayload = () => `korum://v1/pass/${crypto.randomUUID()}?sig=${'A'.repeat(43)}`;
    const batch = { scans: Array.from({ length: 100 }, () => scanOf(forgedPayload(), 1)) };
    const { results } = await syncGateScans(db, QR_SECRET, session, event, batch);
    expect(results).toHaveLength(100);
    expect(results.every((item) => item.outcome.status === 'INVALID_SIGNATURE')).toBe(true);
    expect(await db.auditLog.count({ where: { action: 'gate.qr_invalid', targetId: String(event.initiativeId) } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'gate.sync', targetId: String(event.initiativeId) } })).toBe(1);
  });

  it('(I2) reenviar la cola con otra sesión (tras cambiar el PIN) no cuenta dos veces, ni con otro pase con el mismo identificador', async () => {
    const { event, initiative } = await eventSetup();
    const first = await gateSession(event.organizationId, event.initiativeId);
    const family = await buy(initiative.id, 4);
    const other = await buy(initiative.id, 1);
    const reading = scanOf(family.payload, 2, 'lectura-reenviada-1');
    expect((await syncGateScans(db, QR_SECRET, first, event, { scans: [reading] })).results[0]!.outcome.status).toBe('ACCEPTED');
    // La respuesta se pierde, la entidad cambia el PIN y el voluntario entra de nuevo: la cola se reenvía con otra sesión.
    const second = await gateSession(event.organizationId, event.initiativeId);
    expect(second.gateSessionId).not.toBe(first.gateSessionId);
    expect((await syncGateScans(db, QR_SECRET, second, event, { scans: [reading] })).results[0]!.outcome).toEqual({ status: 'DUPLICATE_SCAN', accepted: true });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: family.pass.id } })).checkedInCount).toBe(2);
    // Un identificador reutilizado para otro pase tampoco entra dos veces.
    expect((await syncGateScans(db, QR_SECRET, second, event, { scans: [scanOf(other.payload, 1, 'lectura-reenviada-1')] })).results[0]!.outcome.status).toBe('DUPLICATE_SCAN');
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: other.pass.id } })).checkedInCount).toBe(0);
  });

  it('(I3) el Super-Admin no crea el PIN ni cierra sesiones de portería', async () => {
    const { event } = await eventSetup();
    const superadmin: SessionActor = { kind: 'user', userId: uniqueId('user'), isSuperadmin: true, memberships: [], secondFactor: true };
    await expect(setGatePin(db, PIN_SECRET, superadmin, event.organizationId, event.initiativeId)).rejects.toBeInstanceOf(TenantAccessError);
    const session = await gateSession(event.organizationId, event.initiativeId);
    await expect(revokeGateSession(db, superadmin, event.organizationId, session.gateSessionId)).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.gateSession.findUniqueOrThrow({ where: { id: session.gateSessionId } })).revokedAt).toBeNull();
  });

  it('(M2) solo se crea el PIN de un evento a la venta o ya conseguido', async () => {
    for (const status of ['BUDGETING', 'CANCELLED', 'REFUNDED', 'CLOSED'] as const) {
      const { event } = await eventSetup({ status });
      await expect(setGatePin(db, PIN_SECRET, await signerOf(db, event.organizationId), event.organizationId, event.initiativeId)).rejects.toThrow('no está a la venta');
    }
    const reached = await eventSetup({ status: 'GOAL_REACHED' });
    await expect(setGatePin(db, PIN_SECRET, await signerOf(db, reached.event.organizationId), reached.event.organizationId, reached.event.initiativeId)).resolves.toHaveProperty('pin');
  });

  it('(M3) la sesión vive como mucho 48 horas, aunque el PIN dure semanas', async () => {
    const closes = new Date(Date.now() + 20 * 86_400_000);
    const { event } = await eventSetup({ closesAt: closes });
    const { pin, expiresAt } = await setGatePin(db, PIN_SECRET, await signerOf(db, event.organizationId), event.organizationId, event.initiativeId);
    expect(expiresAt.getTime()).toBe(closes.getTime() + 6 * 3_600_000);
    const opened = await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId, pin, requestMeta: { ipHash: uniqueId('ip') } });
    if (opened.status !== 'OPENED') throw new Error('Debía abrirse');
    expect(opened.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000 + 5_000);
    expect(opened.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
  });
});

describe('Sprint 4.6 · avisos y panel de la portería', () => {
  it('al anularse el PIN por abuso, el intento devuelve los avisos para enviarlos al momento, solo a quien firma', async () => {
    const { event, organization } = await eventSetup();
    const a = await createUser(db);
    const b = await createUser(db);
    const root = await createUser(db);
    await db.user.update({ where: { id: root.id }, data: { isSuperadmin: true } });
    await db.organizationMember.createMany({ data: [{ userId: a.id, organizationId: organization.id, role: 'DIRECTOR' }, { userId: b.id, organizationId: organization.id, role: 'COSIGNER' }, { userId: root.id, organizationId: organization.id, role: 'COSIGNER' }] });
    const { pin } = await setGatePin(db, PIN_SECRET, await signerOf(db, organization.id), organization.id, event.initiativeId);
    const wrong = pin === '000000' ? '000001' : '000000';
    let last: Awaited<ReturnType<typeof openGateSession>> | null = null;
    for (let attempt = 0; attempt < MAX_FAILURES_PER_EVENT; attempt += 1) last = await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId, pin: wrong, requestMeta: { ipHash: uniqueId('ip') } });
    expect(last).toMatchObject({ status: 'INVALID' });
    const ids = (last as { outboxIds?: number[] }).outboxIds ?? [];
    expect(ids).toHaveLength(2);
    const rows = await db.outboxMessage.findMany({ where: { id: { in: ids } }, select: { userId: true, templateKey: true } });
    expect(rows.map((row) => row.userId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((row) => row.templateKey === 'gate.pinRevoked')).toBe(true);
  }, 240_000);

  it('el panel dice si el PIN se anuló por abuso (y deja de decirlo al crear otro) y deja de enseñar un evento liquidado pasado hace más de una semana', async () => {
    const { event } = await eventSetup();
    const asDirector = await signerOf(db, event.organizationId);
    const find = async () => (await loadGateAdmin(db, asDirector, event.organizationId)).find((item) => item.id === event.initiativeId)!;
    expect(await find()).toMatchObject({ pinActive: false, pinRevoked: false });
    const { pin } = await setGatePin(db, PIN_SECRET, asDirector, event.organizationId, event.initiativeId);
    expect(await find()).toMatchObject({ pinActive: true, pinRevoked: false });
    // Veinticinco fallos desde otras tantas redes revocan el PIN.
    for (let attempt = 0; attempt < MAX_FAILURES_PER_EVENT; attempt += 1) await openGateSession(db, PIN_SECRET, { initiativeId: event.initiativeId, pin: pin === '000000' ? '000001' : '000000', requestMeta: { ipHash: uniqueId('ip') } });
    expect(await find()).toMatchObject({ pinActive: false, pinRevoked: true });
    await setGatePin(db, PIN_SECRET, asDirector, event.organizationId, event.initiativeId);
    expect(await find()).toMatchObject({ pinActive: true, pinRevoked: false });

    const recent = await eventSetup({ status: 'GOAL_REACHED', closesAt: new Date(Date.now() - 3 * 86_400_000) });
    const old = await eventSetup({ status: 'GOAL_REACHED', closesAt: new Date(Date.now() - 30 * 86_400_000) });
    const visible = async (target: { organization: { id: string }; initiative: { id: number } }) => (await loadGateAdmin(db, director(target.organization.id), target.organization.id)).some((item) => item.id === target.initiative.id);
    expect(await visible(recent)).toBe(true);
    // Desde el Sprint 5.13 un evento celebrado y sin liquidar se sigue viendo (aún se puede aplazar o cancelar); liquidado y pasado hace más de una semana, ya no.
    expect(await visible(old)).toBe(true);
    // Liquidado: pasa a cerrado (`CLOSED`), como al terminar el envío de la liquidación.
    await db.initiative.update({ where: { id: old.initiative.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    expect(await visible(old)).toBe(false);
  }, 240_000);

});

describe('Sprint 4.7 · código de la puerta', () => {
  it('se puede cambiar el enlace de la puerta: el código nuevo es distinto, queda auditado y solo lo hace quien firma', async () => {
    const { event, organization } = await eventSetup();
    const asDirector = await signerOf(db, organization.id);
    await expect(rotateGateCode(db, asDirector, organization.id, event.initiativeId)).rejects.toThrow('todavía no hay PIN');
    await setGatePin(db, PIN_SECRET, asDirector, organization.id, event.initiativeId);
    const before = (await db.initiative.findUniqueOrThrow({ where: { id: event.initiativeId } })).gateCode!;
    const { gateCode } = await rotateGateCode(db, asDirector, organization.id, event.initiativeId);
    expect(gateCode).not.toBe(before);
    expect(gateCode).toMatch(GATE_CODE_PATTERN);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: event.initiativeId } })).gateCode).toBe(gateCode);
    expect(await db.auditLog.count({ where: { action: 'gate.code_rotated', targetId: String(event.initiativeId) } })).toBe(1);
    const gatekeeper: SessionActor = { kind: 'user', userId: uniqueId('user'), isSuperadmin: false, memberships: [{ organizationId: organization.id, role: 'GATEKEEPER' }], secondFactor: true };
    const superadmin: SessionActor = { kind: 'user', userId: uniqueId('user'), isSuperadmin: true, memberships: [], secondFactor: true };
    const stranger = director((await eventSetup()).organization.id);
    for (const actor of [gatekeeper, superadmin, stranger]) await expect(rotateGateCode(db, actor, organization.id, event.initiativeId)).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: event.initiativeId } })).gateCode).toBe(gateCode);
  });

  it('el código de la puerta se crea con el primer PIN, no cambia al cambiar el PIN y tiene el formato esperado; dos eventos nunca lo comparten', async () => {
    const a = await eventSetup();
    const b = await eventSetup();
    const find = async (target: typeof a) => (await loadGateAdmin(db, director(target.organization.id), target.organization.id)).find((item) => item.id === target.event.initiativeId)!;
    expect((await find(a)).gateCode).toBeNull();
    await setGatePin(db, PIN_SECRET, await signerOf(db, a.organization.id), a.organization.id, a.event.initiativeId);
    const code = (await find(a)).gateCode!;
    expect(code).toMatch(GATE_CODE_PATTERN);
    await setGatePin(db, PIN_SECRET, await signerOf(db, a.organization.id), a.organization.id, a.event.initiativeId);
    expect((await find(a)).gateCode).toBe(code);
    await setGatePin(db, PIN_SECRET, await signerOf(db, b.organization.id), b.organization.id, b.event.initiativeId);
    expect((await find(b)).gateCode).not.toBe(code);
    await expect(db.initiative.update({ where: { id: b.event.initiativeId }, data: { gateCode: 'MAL-CODIGO' } })).rejects.toThrow();
    await expect(db.initiative.update({ where: { id: b.event.initiativeId }, data: { gateCode: code } })).rejects.toThrow();
  });
});
