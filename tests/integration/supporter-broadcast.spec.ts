import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KorumPrismaClient } from '@/lib/prisma';
import { queuePhotosBroadcastIfReady, queueSupporterBroadcast, runSupporterBroadcasts } from '@/services/notifications/supporter-broadcast';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, uniqueId } from './test-database';

/**
 * Sprint 4.4a · Avisos a quienes aportaron (heredado del 3.6, EXPERIENCIA §3): «¡Lo hemos conseguido!» al llegar al 100 % y «Mirad cómo ha quedado» con las
 * fotos. Se reparten por lotes fuera de la transacción del cobro, una vez por persona e iniciativa, solo a donaciones completadas, y se pueden repetir sin
 * duplicar nada.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-avisos' };
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
const created: string[] = [];
const run = (batchSize = 2) => runSupporterBroadcasts(db, { now: new Date(), batchSize, hmacSecret: TEST_HMAC_SECRET });

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: created }, status: 'PENDING' } });
  await db.$disconnect();
});

async function paid(organizationId: string, initiativeId: number, amountCents: number, who: { guestEmail?: string; userId?: string; type?: 'DONATION' | 'TICKET'; locale?: 'es' | 'ca' | 'en' }) {
  const contribution = await db.contribution.create({
    data: {
      organizationId,
      initiativeId,
      fiscalYear: 2026,
      type: who.type ?? 'DONATION',
      amountCents,
      totalChargedCents: amountCents,
      paymentMethod: 'CARD',
      paycometOrder: uniqueId('ORD'),
      status: 'PENDING',
      guestEmail: who.guestEmail ?? null,
      canonicalEmail: who.guestEmail ?? null,
      userId: who.userId ?? null,
      locale: who.locale ?? 'es'
    }
  });
  const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: contribution.paycometOrder!, amountCents });
  expect(await handlePaymentWebhook(db, mock, rawBody, contentType)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

describe('Avisos a quienes donaron', () => {
  it('al llegar al 100 %: una vez por persona (aunque aportara dos veces), en su idioma, solo donaciones completadas, por lotes y sin duplicar al repetir', async () => {
    const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    created.push(organization.id);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 5_000 });
    const account = await createUser(db, { locale: 'ca' });
    const twice = `${uniqueId('dos-veces')}@pruebas.example`;
    await paid(organization.id, initiative.id, 1_000, { guestEmail: twice });
    await paid(organization.id, initiative.id, 1_000, { guestEmail: twice, locale: 'en' });
    await paid(organization.id, initiative.id, 1_000, { userId: account.id, locale: 'ca' });
    const refunded = await paid(organization.id, initiative.id, 500, { guestEmail: `${uniqueId('devuelta')}@pruebas.example` });
    await db.contribution.update({ where: { id: refunded.id }, data: { status: 'REFUNDED' } });
    // La entrada no es una donación: no recibe este aviso (aunque sume a la meta).
    await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'TICKET', amountCents: 500, totalChargedCents: 500, paymentMethod: 'CARD', status: 'COMPLETED', guestEmail: `${uniqueId('entrada')}@pruebas.example` } });
    expect(await db.supporterBroadcast.count({ where: { initiativeId: initiative.id } })).toBe(0);
    await paid(organization.id, initiative.id, 1_500, { guestEmail: `${uniqueId('ultima')}@pruebas.example` });

    // El cobro que completa la meta solo deja la difusión pendiente: ni un mensaje a las familias en su transacción.
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('GOAL_REACHED');
    const broadcast = await db.supporterBroadcast.findUniqueOrThrow({ where: { initiativeId_templateKey: { initiativeId: initiative.id, templateKey: 'initiative.goalReachedSupporter' } } });
    expect(broadcast.completedAt).toBeNull();
    const messages = () => db.outboxMessage.findMany({ where: { templateKey: 'initiative.goalReachedSupporter', organizationId: organization.id }, orderBy: { id: 'asc' } });
    expect(await messages()).toHaveLength(0);

    await run(2);
    const sent = await messages();
    expect(sent.map((message) => message.toAddress).sort()).toEqual([account.email, twice, sent.find((message) => message.toAddress.startsWith('ultima'))!.toAddress].sort());
    expect(sent.find((message) => message.toAddress === twice)?.locale).toBe('es');
    expect(sent.find((message) => message.toAddress === account.email)?.locale).toBe('ca');
    // La clave no lleva el email en claro.
    expect(sent.every((message) => !message.idempotencyKey.includes('@'))).toBe(true);
    expect(sent[0]?.payloadJson).toMatchObject({ initiativeId: initiative.id, walletEscrowId: initiative.walletEscrowId });
    expect(await db.supporterBroadcast.findUniqueOrThrow({ where: { id: broadcast.id } })).toMatchObject({ queuedCount: 3 });
    expect((await db.supporterBroadcast.findUniqueOrThrow({ where: { id: broadcast.id } })).completedAt).not.toBeNull();

    // Repetir (la difusión o pedirla otra vez) no escribe nada nuevo.
    await queueSupporterBroadcast(db, initiative.id, 'initiative.goalReachedSupporter', new Date());
    await run(2);
    expect(await messages()).toHaveLength(3);
  });

  it('«¡Lo hemos conseguido!» espera si un contracargo devolvió la campaña a recaudar, y se descarta si acaba sin la meta', async () => {
    const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    created.push(organization.id);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 1_000 });
    await paid(organization.id, initiative.id, 1_000, { guestEmail: `${uniqueId('espera')}@pruebas.example` });
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'FUNDRAISING' } });
    await run(10);
    const pending = await db.supporterBroadcast.findFirstOrThrow({ where: { initiativeId: initiative.id } });
    expect(pending.completedAt).toBeNull();
    expect(await db.outboxMessage.count({ where: { templateKey: 'initiative.goalReachedSupporter', organizationId: organization.id } })).toBe(0);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'EXPIRED' } });
    await run(10);
    expect((await db.supporterBroadcast.findUniqueOrThrow({ where: { id: pending.id } })).completedAt).not.toBeNull();
    expect(await db.outboxMessage.count({ where: { templateKey: 'initiative.goalReachedSupporter', organizationId: organization.id } })).toBe(0);
  });

  it('las fotos Antes / Después solo se anuncian con la campaña cerrada y las dos fotos, una vez', async () => {
    const organization = await createOrganization(db);
    created.push(organization.id);
    const photo = (purpose: 'INITIATIVE_BEFORE' | 'INITIATIVE_AFTER') =>
      db.fileAsset.create({ data: { bucket: 'korum-public', objectKey: `tests/${uniqueId('foto')}.jpg`, visibility: 'PUBLIC', purpose, mimeType: 'image/jpeg', sizeBytes: 100, sha256: 'a'.repeat(64), organizationId: organization.id } });
    const before = await photo('INITIATIVE_BEFORE');
    const initiative = await createInitiative(db, organization.id, { status: 'GOAL_REACHED', beforeFileId: before.id });
    await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'DONATION', amountCents: 500, totalChargedCents: 500, paymentMethod: 'CARD', status: 'COMPLETED', guestEmail: `${uniqueId('foto')}@pruebas.example` } });
    expect(await queuePhotosBroadcastIfReady(db, initiative.id, new Date())).toBe(false);
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'CLOSED' } });
    expect(await queuePhotosBroadcastIfReady(db, initiative.id, new Date())).toBe(false);
    await db.initiative.update({ where: { id: initiative.id }, data: { afterFileId: (await photo('INITIATIVE_AFTER')).id } });
    expect(await queuePhotosBroadcastIfReady(db, initiative.id, new Date())).toBe(true);
    expect(await queuePhotosBroadcastIfReady(db, initiative.id, new Date())).toBe(true);
    await run(10);
    expect(await db.outboxMessage.count({ where: { templateKey: 'initiative.achievementPhotos', organizationId: organization.id } })).toBe(1);
    expect(await db.supporterBroadcast.count({ where: { initiativeId: initiative.id } })).toBe(1);
  });
});
