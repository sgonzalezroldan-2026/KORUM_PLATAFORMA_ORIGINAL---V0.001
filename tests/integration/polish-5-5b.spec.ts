import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { remindExpiredDecisions, splitWindowGuardHandler } from '@/core/jobs/handlers/split-window-guard';
import type { JobDeps } from '@/core/jobs/job-types';
import { GatePinRateLimitedError, setGatePin } from '@/core/ticketing/gate-session.service';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import type { SessionActor } from '@/repositories/tenant-guard';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { decideRefund, launchResizeVote } from '@/services/resize/expired-decision.service';
import { queueResendLinks, reserveResendAttempt } from '@/services/resize/resize-link-resend.service';
import { loadResizeBallot } from '@/services/resize/resize-vote.service';
import { INDEXNOW_ENDPOINT, notifyIndexNow } from '@/services/seo/indexnow.service';
import { deleteSecret, invalidateSettingsCache, updateSecret } from '@/services/settings/settings.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, testJobDeps, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.5b contra PostgreSQL real: el aviso a IndexNow solo de lo que cambió (y nunca si el buscador lo rechaza), el reenvío del enlace de voto (mismo resultado
 * para cualquiera, enviado al email de la donación), el tope de PIN de portería por persona y el recordatorio escalado de una campaña vencida sin decidir.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-5-5b' };
const DAY = 86_400_000;
const APP = 'https://korum.es';
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

const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true });

async function team(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', ...overrides });
  created.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, director: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]) };
}

async function donate(organizationId: string, initiativeId: number, amountCents: number, email: string) {
  const contribution = await db.contribution.create({
    data: { organizationId, initiativeId, fiscalYear: 2026, type: 'DONATION', amountCents, totalChargedCents: amountCents, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING', guestEmail: email, canonicalEmail: email, locale: 'ca' }
  });
  const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: contribution.paycometOrder!, amountCents });
  expect(await handlePaymentWebhook(db, mock, rawBody, contentType)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

async function expiredCampaign(organizationId: string, donors: string[]) {
  const initiative = await createInitiative(db, organizationId, { status: 'FUNDRAISING', goalCents: 20_000, costMatCents: 12_000, costInstCents: 4_000, contingencyBps: 1_000, bracketFeeCents: 1_000, maintFeeCents: 500, gatewayFeeCents: 900 });
  await reserveInitiativeQuotas(db, initiative.id);
  for (const email of donors) await donate(organizationId, initiative.id, 2_000, email);
  await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() - 60_000) } });
  await campaignExpiryHandler({ db, now: new Date(), batchSize: 50, deps: jobDeps });
  expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('EXPIRED');
  return initiative;
}

describe('QA-SEO02 · IndexNow avisa solo de lo que cambió', () => {
  const KEY = 'clave-indexnow-5-5b-0123';
  let admin: Awaited<ReturnType<typeof verifiedSuperadmin>>;

  beforeAll(async () => {
    admin = await verifiedSuperadmin(db, new Date(), 'settings.secret_update');
    await updateSecret(db, admin.actor, TEST_KEYRING, 'seo.indexNowKey', KEY);
  });
  afterAll(async () => {
    const fresh = await verifiedSuperadmin(db, new Date(), 'settings.secret_delete');
    await deleteSecret(db, fresh.actor, 'seo.indexNowKey');
    invalidateSettingsCache('seo.indexNowKey');
  });

  const fetchOk = () => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 202 }));
  const bodyOf = (fetchMock: ReturnType<typeof fetchOk>) => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { host: string; key: string; keyLocation: string; urlList: string[] };

  it('al publicar avisa de la ficha y de la portada en los tres idiomas; repetirlo ya no envía nada', async () => {
    const { organization } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const fetchMock = fetchOk();
    const outcome = await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: fetchMock as unknown as typeof fetch }, { initiativeIds: [initiative.id] });
    expect(outcome).toEqual({ status: 'SENT', initiatives: 1, urls: 6 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(INDEXNOW_ENDPOINT);
    const body = bodyOf(fetchMock);
    expect(body).toMatchObject({ host: 'korum.es', key: KEY, keyLocation: 'https://korum.es/indexnow-key.txt' });
    expect(body.urlList).toContain(`https://korum.es/${organization.slug}/iniciativas/${initiative.id}`);
    expect(body.urlList).toContain(`https://korum.es/en/${organization.slug}`);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).indexNowStatus).toBe('FUNDRAISING');

    const again = fetchOk();
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: again as unknown as typeof fetch }, { initiativeIds: [initiative.id] })).toEqual({ status: 'SKIPPED', reason: 'NOTHING_CHANGED' });
    expect(again).not.toHaveBeenCalled();

    // Deja de ser pública (vence): se avisa para que el buscador la retire; seguir cambiando entre estados no públicos ya no avisa.
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'EXPIRED' } });
    const removal = fetchOk();
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: removal as unknown as typeof fetch }, { initiativeIds: [initiative.id] })).toMatchObject({ status: 'SENT', initiatives: 1 });
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: fetchOk() as unknown as typeof fetch }, { initiativeIds: [initiative.id] })).toEqual({ status: 'SKIPPED', reason: 'NOTHING_CHANGED' });
  });

  it('nunca avisa de entidades que no se indexan, de borradores ni desde una web local', async () => {
    const hidden = await team({ publicIndexing: false });
    const unverified = await team({ kybStatus: 'PENDING' });
    const visible = await team();
    const ids = [
      (await createInitiative(db, hidden.organization.id, { status: 'FUNDRAISING' })).id,
      (await createInitiative(db, unverified.organization.id, { status: 'FUNDRAISING' })).id,
      (await createInitiative(db, visible.organization.id, { status: 'BUDGETING' })).id
    ];
    const fetchMock = fetchOk();
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: fetchMock as unknown as typeof fetch }, { initiativeIds: ids })).toEqual({ status: 'SKIPPED', reason: 'NOTHING_CHANGED' });
    const local = await createInitiative(db, visible.organization.id, { status: 'FUNDRAISING' });
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: 'http://localhost:3000', fetch: fetchMock as unknown as typeof fetch }, { initiativeIds: [local.id] })).toEqual({ status: 'SKIPPED', reason: 'NOT_PUBLIC_HOST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si el buscador rechaza el aviso o no responde, no se anota y el siguiente barrido lo repite; nunca lanza', async () => {
    const { organization } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'GOAL_REACHED' });
    const rejected = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: rejected as unknown as typeof fetch }, { initiativeIds: [initiative.id] })).toEqual({ status: 'FAILED', reason: 'REJECTED', httpStatus: 403 });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: down as unknown as typeof fetch }, { initiativeIds: [initiative.id] })).toEqual({ status: 'FAILED', reason: 'UNREACHABLE' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).indexNowStatus).toBeNull();
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: fetchOk() as unknown as typeof fetch }, { initiativeIds: [initiative.id] })).toMatchObject({ status: 'SENT' });
  });

  it('sin clave en la consola no envía nada', async () => {
    const fresh = await verifiedSuperadmin(db, new Date(), 'settings.secret_delete');
    await deleteSecret(db, fresh.actor, 'seo.indexNowKey');
    const { organization } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    expect(await notifyIndexNow({ db, keyring: () => TEST_KEYRING, appUrl: APP, fetch: fetchOk() as unknown as typeof fetch }, { initiativeIds: [initiative.id] })).toEqual({ status: 'SKIPPED', reason: 'NO_KEY' });
    const again = await verifiedSuperadmin(db, new Date(), 'settings.secret_update');
    await updateSecret(db, again.actor, TEST_KEYRING, 'seo.indexNowKey', KEY);
  });

  it('la consola rechaza una clave que el protocolo no admite (se publicaría tal cual)', async () => {
    await expect(updateSecret(db, admin.actor, TEST_KEYRING, 'seo.indexNowKey', 'clave con espacios')).rejects.toThrow(/IndexNow/);
  });
});

describe('«Reenviarme mi enlace de voto» (heredado del 4.4b)', () => {
  /** Lo que hace la acción: reserva en la petición y, si se acepta, deja los enlaces en la bandeja después de responder. */
  async function resend(orgSlug: string, email: string, ip = '10.9.0.1') {
    const attempt = await reserveResendAttempt(db, TEST_HMAC_SECRET, { orgSlug, email }, { ip });
    if (attempt.status !== 'ACCEPTED') return { attempt, ids: [] as number[] };
    return { attempt, ids: await queueResendLinks(db, TEST_HMAC_SECRET, attempt.request) };
  }

  it('envía el enlace al email de la donación aunque se escriba con otra forma; a quien no donó no le envía nada; la respuesta es la misma', async () => {
    const { organization, director } = await team();
    const donor = `${uniqueId('ana')}@gmail.com`;
    const initiative = await expiredCampaign(organization.id, [donor, `${uniqueId('luis')}@pruebas.example`]);
    await launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: ['Comprar 14 tablets con lo recaudado', 'Comprar 10 tablets y un armario cargador'] });
    const variant = donor.replace('@gmail.com', '+otra@gmail.com').toUpperCase();

    const sent = await resend(organization.slug, variant);
    expect(sent.attempt.status).toBe('ACCEPTED');
    expect(sent.ids).toHaveLength(1);
    const message = await db.outboxMessage.findFirstOrThrow({ where: { organizationId: organization.id, idempotencyKey: { startsWith: 'initiative.resizePoll:resend:' } } });
    expect(message.toAddress).toBe(donor);
    expect(message.locale).toBe('ca');
    const token = (message.payloadJson as { voteToken: string }).voteToken;
    expect(await loadResizeBallot(db, TEST_HMAC_SECRET, organization.slug, token)).toMatchObject({ status: 'OPEN', refundableCents: 2_000 });

    // Quien no donó recibe la misma respuesta en la petición (la diferencia solo existe después de responder).
    const stranger = await resend(organization.slug, 'nadie@pruebas.example');
    expect(stranger.attempt.status).toBe('ACCEPTED');
    expect(stranger.ids).toEqual([]);
    expect((await reserveResendAttempt(db, TEST_HMAC_SECRET, { orgSlug: organization.slug, email: 'no-es-un-email' }, { ip: '10.9.0.1' })).status).toBe('INVALID_EMAIL');
    // Pulsar dos veces seguidas no manda dos emails.
    // (devuelve el mismo mensaje aún pendiente para enviarlo, sin crear otro; el envío reclama cada mensaje una sola vez).
    expect((await resend(organization.slug, donor)).ids).toEqual(sent.ids);
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, idempotencyKey: { startsWith: 'initiative.resizePoll:resend:' } } })).toBe(1);
    // Tres por email y día (el de la variante, el repetido y este): el cuarto ya no.
    expect((await resend(organization.slug, donor, '10.9.0.2')).attempt.status).toBe('ACCEPTED');
    expect((await resend(organization.slug, donor, '10.9.0.2')).attempt.status).toBe('RATE_LIMITED');
    const audit = await db.auditLog.findMany({ where: { action: 'resize.link_resent', organizationId: organization.id } });
    expect(JSON.stringify(audit)).not.toContain(donor.split('@')[0]!);
  });

  it('desde la página de otra entidad no se envía nada, y una donación ya devuelta no recibe enlace (aislamiento, auditoría de seguridad del 5.5b, H2)', async () => {
    const { organization, director } = await team();
    const other = await team();
    const donor = `${uniqueId('rosa')}@pruebas.example`;
    const refunded = `${uniqueId('pau')}@pruebas.example`;
    const initiative = await expiredCampaign(organization.id, [donor, refunded]);
    await db.contribution.updateMany({ where: { initiativeId: initiative.id, canonicalEmail: refunded }, data: { status: 'REFUNDED' } });
    await launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: ['Comprar 14 tablets con lo recaudado', 'Comprar 10 tablets y un armario cargador'] });

    const crossTenant = await resend(other.organization.slug, donor, '10.9.1.1');
    expect(crossTenant.attempt.status).toBe('ACCEPTED');
    expect(crossTenant.ids).toEqual([]);
    expect((await resend(organization.slug, refunded, '10.9.1.1')).ids).toEqual([]);
    expect(await db.outboxMessage.count({ where: { idempotencyKey: { startsWith: 'initiative.resizePoll:resend:' }, organizationId: { in: [organization.id, other.organization.id] } } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'resize.link_resent', organizationId: { in: [organization.id, other.organization.id] } } })).toBe(0);
  });
});

describe('tope de PIN de portería por persona firmante (M5 del 4.5)', () => {
  it('diez PIN a la hora; el undécimo se rechaza sin tocar las sesiones y deja una sola fila de auditoría', async () => {
    const { organization, director } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 200, ticketFeeMode: 'ADD', goalCents: 100_000, closesAt: new Date(Date.now() + 5 * DAY) });
    for (let index = 0; index < 10; index += 1) await setGatePin(db, TEST_HMAC_SECRET, director, organization.id, initiative.id);
    const before = (await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).gatePinHash;
    await expect(setGatePin(db, TEST_HMAC_SECRET, director, organization.id, initiative.id)).rejects.toBeInstanceOf(GatePinRateLimitedError);
    await expect(setGatePin(db, TEST_HMAC_SECRET, director, organization.id, initiative.id)).rejects.toBeInstanceOf(GatePinRateLimitedError);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).gatePinHash).toBe(before);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'tenant.access_denied', metadataJson: { path: ['attempted'], equals: 'gate.pin_set' } } })).toBe(1);
  });
});

describe('recordatorio escalado de una campaña vencida sin decidir (heredado del 4.4b)', () => {
  it('avisa a quienes firman una vez por etapa, alerta al Super-Admin a 14 días (crítica a 7) y no les manda «liquidad ya»; al decidir, la alerta se cierra', async () => {
    const { organization, director } = await team();
    const initiative = await expiredCampaign(organization.id, [`${uniqueId('eva')}@pruebas.example`]);
    const base = Date.now();
    // A 80 días (y una hora de margen) del primer cobro: quedan 10 días de ventana.
    await db.initiative.update({ where: { id: initiative.id }, data: { firstPayinAt: new Date(base - 80 * DAY + 3_600_000) } });
    const reminders = () => db.outboxMessage.findMany({ where: { organizationId: organization.id, templateKey: 'expired.decisionReminder' }, orderBy: { id: 'asc' } });
    const alert = () => db.opsAlert.findUnique({ where: { dedupeKey: `EXPIRED_DECISION_PENDING:${initiative.id}` } });

    // El mismo día del vencimiento: nada (ya salió «initiative.expired»), pero la alerta sí (quedan 10 días).
    await remindExpiredDecisions(db, new Date(base));
    expect(await reminders()).toHaveLength(0);
    expect(await alert()).toMatchObject({ status: 'OPEN', severity: 'WARNING' });

    const later = new Date(base + 2 * DAY);
    await splitWindowGuardHandler({ db, now: later, batchSize: 50, deps: jobDeps });
    await remindExpiredDecisions(db, later);
    const first = await reminders();
    expect(first).toHaveLength(2);
    expect(first[0]?.payloadJson).toMatchObject({ initiativeId: initiative.id, daysLeft: 8, canVote: false, urgent: false });
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: { in: ['split.windowExpiring', 'split.windowExpired'] } } })).toBe(0);

    await remindExpiredDecisions(db, new Date(base + 4 * DAY));
    expect(await reminders()).toHaveLength(4);
    expect(await alert()).toMatchObject({ status: 'OPEN', severity: 'CRITICAL' });

    await decideRefund(db, director, organization.id, { initiativeId: initiative.id });
    await remindExpiredDecisions(db, new Date(base + 4 * DAY));
    expect(await alert()).toMatchObject({ status: 'RESOLVED' });
    expect(await reminders()).toHaveLength(4);
  });
});
