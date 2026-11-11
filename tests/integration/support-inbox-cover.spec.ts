import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeResolvedSupportTickets } from '@/core/privacy/retention-purge';
import type { Prisma } from '@/generated/prisma/client';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { SUPPORT_ORG_TICKET_RULE } from '@/lib/rate-limit-rules';
import { getPublicInitiative, getPublicInitiativeCard, listPublicInitiatives } from '@/repositories/public.repository';
import { loadSupportInbox } from '@/repositories/support-inbox.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { listSupportTicketsOf } from '@/services/support/support-requests.service';
import { MAX_INPUT_PIXELS } from '@/services/media/resize-image';
import { getPublicImageFile } from '@/repositories/achievements.repository';
import { publishEntityImage } from '@/services/panel/entity-branding.service';
import { InitiativeCoverError, publishInitiativeCover, removeInitiativeCover } from '@/services/panel/initiative-cover.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { publishAchievementPhoto } from '@/services/storage/achievement-photos.service';
import { answerFamilyTicket, sendMessageToKorum } from '@/services/support/support-inbox.service';
import { containsText } from './image-fixtures';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET } from './test-database';

/**
 * Sprint 4.4c · soporte del centro e imagen de la campaña contra PostgreSQL real.
 *
 * Soporte: las personas firmantes contestan las consultas que las familias dirigen a **su** centro sin ver el email de quien escribe; una consulta de
 * otra entidad o una de una familia a KORUM (que guarda el mismo `organizationId`) responde como una inexistente; una respuesta por consulta, estado que
 * solo avanza, dos firmantes a la vez no se pisan, y la entidad escribe a KORUM por su buzón con tope propio.
 * Imagen: la imagen de la campaña, la portada y las fotos de logros se reducen a 1.600 px y se publican sin metadatos; solo firmantes de la entidad.
 */

let db: KorumPrismaClient;
let storage: MemoryStorage;

beforeAll(() => {
  db = createTestClient();
  storage = new MemoryStorage();
});

afterAll(async () => {
  await db.outboxMessage.updateMany({ where: { templateKey: { in: ['support.received', 'support.replied'] }, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  await db.$disconnect();
});

const actorFor = (userId: string, organizationId: string, role: MemberRole, secondFactor = true): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor });

async function team() {
  const organization = await createOrganization(db, { kybStatus: 'VERIFIED' });
  const [director, cosigner] = await Promise.all([createUser(db, { twoFactorEnabled: true }), createUser(db, { twoFactorEnabled: true })]);
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, directorUser: director, director: actorFor(director.id, organization.id, 'DIRECTOR'), cosigner: actorFor(cosigner.id, organization.id, 'COSIGNER') };
}

const ticket = (organizationId: string | null, overrides: Partial<Prisma.SupportTicketUncheckedCreateInput> = {}) =>
  db.supportTicket.create({ data: { ticketCode: `TCK-${Math.random().toString(36).replace(/[^a-hjkmnp-z2-9]/g, '').padEnd(6, 'k').slice(0, 6).toUpperCase()}`, organizationId, originLabel: 'CEIP de pruebas', subject: 'Toldos del patio', message: 'Quería saber cuándo se instalan los toldos.', target: 'ORGANIZATION', topic: 'INITIATIVE', ...overrides } });

describe('bandeja de soporte del centro', () => {
  it('lista las consultas de las familias a su centro, sin el email de quien escribe, y deja fuera las de KORUM, las de la entidad y las de otras entidades', async () => {
    const { organization, director } = await team();
    const other = await team();
    const family = await createUser(db);
    const mine = await ticket(organization.id, { senderEmail: family.email });
    await ticket(organization.id, { senderEmail: family.email, target: 'SUPERADMIN', topic: 'PAYMENT', subject: 'Un cobro a KORUM' });
    const sentByEntity = await ticket(organization.id, { senderEmail: 'direccion@pruebas.example', target: 'SUPERADMIN', fromOrganization: true, subject: 'Pregunta de la entidad' });
    await ticket(other.organization.id, { senderEmail: family.email, subject: 'De otro centro' });

    const view = await loadSupportInbox(db, director, organization.id);
    expect(view.families.waiting.map((row) => row.ticketCode)).toEqual([mine.ticketCode]);
    expect(view.families.waitingCount).toBe(1);
    expect(view.sent.map((row) => row.ticketCode)).toEqual([sentByEntity.ticketCode]);
    // Nunca sale el email: ni en la lista de las familias ni en nada de lo que se serializa.
    expect(JSON.stringify(view)).not.toContain(family.email);
    expect(JSON.stringify(view)).not.toContain('direccion@pruebas.example');
    expect(Object.keys(view.families.waiting[0]!)).not.toContain('senderEmail');
  });

  it('la lectura es solo de quien firma en esa entidad: otra entidad, sin segundo factor no importa para leer, pero sin cargo o anónimo se deniega y queda rastro', async () => {
    const { organization } = await team();
    const other = await team();
    await expect(loadSupportInbox(db, other.director, organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(loadSupportInbox(db, { kind: 'anonymous' } as SessionActor, organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    const gatekeeper = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: gatekeeper.id, role: 'GATEKEEPER' } });
    await expect(loadSupportInbox(db, actorFor(gatekeeper.id, organization.id, 'GATEKEEPER'), organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'tenant.access_denied' } })).toBeGreaterThanOrEqual(2);
  });

  it('contestar guarda la respuesta una sola vez, pasa la consulta a «en curso», avisa a la familia sin copiar el texto y no deja el texto en la auditoría', async () => {
    const { organization, director, cosigner, directorUser } = await team();
    const family = await createUser(db, { locale: 'ca' });
    const row = await ticket(organization.id, { senderEmail: family.email });
    const now = new Date('2026-11-12T10:00:00.000Z');

    const answered = await answerFamilyTicket({ db }, director, organization.id, { ticketCode: row.ticketCode, reply: 'Los toldos se instalan en las vacaciones de Navidad.' }, now);
    expect(answered).toMatchObject({ status: 'OK', ticketCode: row.ticketCode, resolved: false });
    const stored = await db.supportTicket.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: 'IN_PROGRESS', replyMessage: 'Los toldos se instalan en las vacaciones de Navidad.', repliedAt: now, resolvedAt: null, senderEmail: family.email });
    const mail = await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `support.replied:${row.ticketCode}` } });
    expect(mail).toMatchObject({ templateKey: 'support.replied', toAddress: family.email, userId: family.id, organizationId: organization.id, locale: 'ca' });
    expect(JSON.stringify(mail.payloadJson)).not.toContain('toldos se instalan');
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'support.ticket_answered', targetId: String(row.id) } });
    expect(audit).toMatchObject({ organizationId: organization.id, actorUserId: directorUser.id });
    expect(JSON.stringify(audit.metadataJson)).not.toMatch(/toldos|@/);

    // Una segunda respuesta, aunque venga de la otra persona firmante, no se acepta; el estado se puede resolver.
    expect(await answerFamilyTicket({ db }, cosigner, organization.id, { ticketCode: row.ticketCode, reply: 'Una respuesta distinta.' })).toEqual({ status: 'REJECTED', reason: 'ALREADY_REPLIED' });
    expect(await answerFamilyTicket({ db }, cosigner, organization.id, { ticketCode: row.ticketCode, status: 'IN_PROGRESS' })).toEqual({ status: 'REJECTED', reason: 'NOTHING_TO_CHANGE' });
    const later = new Date(now.getTime() + 3_600_000);
    expect(await answerFamilyTicket({ db }, cosigner, organization.id, { ticketCode: row.ticketCode, status: 'RESOLVED' }, later)).toMatchObject({ status: 'OK', resolved: true, outboxId: null });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'RESOLVED', resolvedAt: later, replyMessage: 'Los toldos se instalan en las vacaciones de Navidad.' });
    // Resuelta: ya no se toca, ni para contestar ni para cambiar el estado.
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: row.ticketCode, status: 'IN_PROGRESS' })).toEqual({ status: 'REJECTED', reason: 'ALREADY_RESOLVED' });
    expect(await db.outboxMessage.count({ where: { templateKey: 'support.replied', organizationId: organization.id } })).toBe(1);
    const view = await loadSupportInbox(db, director, organization.id);
    expect(view.families.waiting).toEqual([]);
    expect(view.families.resolved.map((item) => item.ticketCode)).toEqual([row.ticketCode]);
  });

  it('se puede resolver sin contestar y contestar y resolver a la vez; sin dirección (la consulta ya se purgó) no sale ningún aviso', async () => {
    const { organization, director } = await team();
    const family = await createUser(db);
    const plain = await ticket(organization.id, { senderEmail: family.email });
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: plain.ticketCode, status: 'RESOLVED' })).toMatchObject({ status: 'OK', resolved: true, outboxId: null });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ status: 'RESOLVED', replyMessage: null, repliedAt: null });

    const both = await ticket(organization.id, { senderEmail: family.email });
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: both.ticketCode, reply: 'Hecho, gracias por avisar.', status: 'RESOLVED' })).toMatchObject({ status: 'OK', resolved: true });
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `support.replied:${both.ticketCode}` } })).toBe(1);

    const orphan = await ticket(organization.id, { senderEmail: null });
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: orphan.ticketCode, reply: 'Hecho, gracias por avisar.' })).toMatchObject({ status: 'OK', outboxId: null });
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `support.replied:${orphan.ticketCode}` } })).toBe(0);
  });

  it('una consulta ya vaciada (cuenta suprimida o plazo de conservación) no se contesta, y «Mis consultas» no enseña lo que se escribió en nombre de la entidad', async () => {
    const { organization, director } = await team();
    const person = await createUser(db);
    const purged = await ticket(organization.id, { senderEmail: null, message: '', subject: '' });
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: purged.ticketCode, reply: 'Una respuesta que nadie leerá.' })).toEqual({ status: 'REJECTED', reason: 'PURGED' });
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: purged.ticketCode, status: 'RESOLVED' })).toEqual({ status: 'REJECTED', reason: 'PURGED' });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: purged.id } })).toMatchObject({ status: 'OPEN', replyMessage: null });

    const own = await ticket(organization.id, { senderEmail: person.email, target: 'SUPERADMIN', fromOrganization: true, subject: 'Pregunta de la entidad' });
    const mine = await ticket(null, { senderEmail: person.email, target: 'SUPERADMIN', topic: 'PAYMENT', subject: 'Mi pregunta personal' });
    const listed = await listSupportTicketsOf(db, { email: person.email, emailVerified: true, gdprAnonymizedAt: null });
    expect(listed.map((row) => row.ticketCode)).toEqual([mine.ticketCode]);
    expect(listed.map((row) => row.ticketCode)).not.toContain(own.ticketCode);
  });

  it('una consulta de otra entidad, una de una familia a KORUM o una escrita por la propia entidad responden como una inexistente y no cambian', async () => {
    const { organization, director } = await team();
    const other = await team();
    const foreign = await ticket(other.organization.id, { senderEmail: 'otra@pruebas.example' });
    const toKorum = await ticket(organization.id, { senderEmail: 'familia@pruebas.example', target: 'SUPERADMIN', topic: 'PAYMENT' });
    const own = await ticket(organization.id, { target: 'SUPERADMIN', fromOrganization: true });
    for (const row of [foreign, toKorum, own]) {
      expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: row.ticketCode, reply: 'Intento de contestar lo que no es mío.' })).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
      expect(await db.supportTicket.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'OPEN', replyMessage: null });
    }
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'tenant.access_denied', targetType: 'SupportTicket' } })).toBe(3);
    // El mismo código inexistente responde igual.
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: 'TCK-ZZZZZZ', reply: 'Intento de contestar lo que no existe.' })).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
  });

  it('sin segundo factor, sin cargo, de otra entidad, anónimo o Super-Admin no se contesta; un cuerpo con campos de más se rechaza', async () => {
    const { organization, director } = await team();
    const other = await team();
    const row = await ticket(organization.id, { senderEmail: 'familia@pruebas.example' });
    const payload = { ticketCode: row.ticketCode, reply: 'Intento de contestar sin permiso.' };
    await expect(answerFamilyTicket({ db }, { ...director, secondFactor: false } as SessionActor, organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(answerFamilyTicket({ db }, other.director, organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(answerFamilyTicket({ db }, { kind: 'anonymous' } as SessionActor, organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await expect(answerFamilyTicket({ db }, { kind: 'user', userId: admin.id, isSuperadmin: true, memberships: [], secondFactor: true }, organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await answerFamilyTicket({ db }, director, organization.id, { ...payload, organizationId: other.organization.id })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await answerFamilyTicket({ db }, director, organization.id, { ticketCode: row.ticketCode })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'OPEN', replyMessage: null });
  });

  it('dos personas firmantes contestando a la vez: una respuesta y un solo aviso', async () => {
    const { organization, director, cosigner } = await team();
    const family = await createUser(db);
    const row = await ticket(organization.id, { senderEmail: family.email });
    const results = await Promise.all([
      answerFamilyTicket({ db }, director, organization.id, { ticketCode: row.ticketCode, reply: 'Respuesta de la dirección.' }),
      answerFamilyTicket({ db }, cosigner, organization.id, { ticketCode: row.ticketCode, reply: 'Respuesta de la cofirma.' })
    ]);
    expect(results.filter((result) => result.status === 'OK')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED').map((result) => (result as { reason: string }).reason)[0]).toMatch(/ALREADY_REPLIED|CONFLICT/);
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `support.replied:${row.ticketCode}` } })).toBe(1);
    expect((await db.supportTicket.findUniqueOrThrow({ where: { id: row.id } })).replyMessage).toMatch(/Respuesta de la (dirección|cofirma)\./);
  });

  it('la entidad escribe a KORUM: consulta prioritaria con su código, acuse al correo de quien firma, fuera de la bandeja de las familias y con un tope por entidad', async () => {
    const { organization, director, directorUser } = await team();
    const sent = await sendMessageToKorum({ db, hmacSecret: TEST_HMAC_SECRET }, director, organization.id, { payload: { topic: 'PAYMENT', subject: 'Cuándo llega la liquidación', message: 'Firmamos el lunes y querríamos saber cuándo se envía el dinero.' }, locale: 'en' });
    expect(sent.status).toBe('SENT');
    if (sent.status !== 'SENT') return;
    expect(await db.supportTicket.findUniqueOrThrow({ where: { ticketCode: sent.ticketCode } })).toMatchObject({ organizationId: organization.id, target: 'SUPERADMIN', fromOrganization: true, topic: 'PAYMENT', senderEmail: directorUser.email, originLabel: organization.name, status: 'OPEN' });
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { id: sent.outboxId } })).toMatchObject({ templateKey: 'support.received', locale: 'en', toAddress: directorUser.email, payloadJson: { ticketCode: sent.ticketCode, rectification: false, answeredBy: 'SUPERADMIN' } });
    const view = await loadSupportInbox(db, director, organization.id);
    expect(view.sent.map((row) => row.ticketCode)).toEqual([sent.ticketCode]);
    expect(view.families.waiting).toEqual([]);

    // Un tema que no es de la entidad, un campo de más o textos cortos no crean nada.
    for (const payload of [{ topic: 'RECTIFICATION', subject: 'Una duda importante', message: 'Un mensaje que es suficientemente largo.' }, { topic: 'OTHER', subject: 'Una duda importante', message: 'Un mensaje que es suficientemente largo.', target: 'ORGANIZATION' }, { topic: 'OTHER', subject: 'hola', message: 'corto' }]) {
      expect(await sendMessageToKorum({ db, hmacSecret: TEST_HMAC_SECRET }, director, organization.id, { payload, locale: 'es' })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    }
    expect(await db.supportTicket.count({ where: { organizationId: organization.id, fromOrganization: true } })).toBe(1);

    // El tope por hora es de la entidad: una persona más del equipo no suma cupo.
    const valid = { topic: 'OTHER', subject: 'Una duda importante', message: 'Un mensaje que es suficientemente largo.' };
    for (let index = 1; index < SUPPORT_ORG_TICKET_RULE.limit; index += 1) expect((await sendMessageToKorum({ db, hmacSecret: TEST_HMAC_SECRET }, director, organization.id, { payload: valid, locale: 'es' })).status).toBe('SENT');
    expect(await sendMessageToKorum({ db, hmacSecret: TEST_HMAC_SECRET }, director, organization.id, { payload: valid, locale: 'es' })).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
  });

  it('escribir a KORUM exige cargo con segundo factor en esa entidad', async () => {
    const { organization } = await team();
    const other = await team();
    const payload = { topic: 'OTHER', subject: 'Una duda importante', message: 'Un mensaje que es suficientemente largo.' };
    await expect(sendMessageToKorum({ db, hmacSecret: TEST_HMAC_SECRET }, other.director, organization.id, { payload, locale: 'es' })).rejects.toBeInstanceOf(TenantAccessError);
    await expect(sendMessageToKorum({ db, hmacSecret: TEST_HMAC_SECRET }, { kind: 'anonymous' } as SessionActor, organization.id, { payload, locale: 'es' })).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.supportTicket.count({ where: { organizationId: organization.id } })).toBe(0);
  });

  it('la base protege las reglas: «resuelta» siempre con su fecha de cierre y una consulta de la entidad siempre va a KORUM', async () => {
    const { organization } = await team();
    await expect(ticket(organization.id, { status: 'RESOLVED' })).rejects.toThrow();
    await expect(ticket(organization.id, { status: 'OPEN', resolvedAt: new Date() })).rejects.toThrow();
    await expect(ticket(organization.id, { target: 'ORGANIZATION', fromOrganization: true })).rejects.toThrow();
    await expect(ticket(organization.id, { status: 'RESOLVED', resolvedAt: new Date() })).resolves.toBeTruthy();
  });

  it('la conservación de 2 años de una consulta resuelta cuenta desde su cierre, no desde el último retoque de la fila', async () => {
    const { organization } = await team();
    const now = new Date('2026-11-12T10:00:00.000Z');
    const DAY = 86_400_000;
    const closedLongAgo = await ticket(organization.id, { senderEmail: 'vieja@pruebas.example', replyMessage: 'Hecho', status: 'RESOLVED', resolvedAt: new Date(now.getTime() - 800 * DAY) });
    const closedRecently = await ticket(organization.id, { senderEmail: 'reciente@pruebas.example', replyMessage: 'Hecho', status: 'RESOLVED', resolvedAt: new Date(now.getTime() - 30 * DAY) });
    // Una fila antigua retocada ayer sigue contando desde su cierre.
    await db.supportTicket.update({ where: { id: closedLongAgo.id }, data: { updatedAt: new Date(now.getTime() - DAY) } });
    await purgeResolvedSupportTickets(db, now, 500);
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: closedLongAgo.id } })).toMatchObject({ senderEmail: null, message: '', replyMessage: null, status: 'RESOLVED' });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: closedRecently.id } })).toMatchObject({ senderEmail: 'reciente@pruebas.example', replyMessage: 'Hecho' });
  });
});

async function bigPhoto(width = 4000, height = 3000, orientation = 6) {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 245, g: 158, b: 11 } } })
    .jpeg({ quality: 92 })
    .withMetadata({ orientation, exif: { IFD0: { Copyright: 'Maria Lopez', Make: 'Pixel 9', ImageDescription: 'GPSLatitude=40.4168' } } })
    .toBuffer();
  return new Uint8Array(buffer);
}

const SECRETS = ['Maria Lopez', 'Pixel 9', 'GPSLatitude=40.4168'];

describe('imagen de la campaña y fotos redimensionadas', () => {
  it('se reduce a 1.600 px, se publica sin metadatos, queda en el portal y sustituye a la anterior, que sale del almacén', async () => {
    const { organization, director, cosigner } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const original = await bigPhoto();
    for (const marker of SECRETS) expect(containsText(original, marker)).toBe(true);

    const first = await publishInitiativeCover(db, storage, director, { organizationId: organization.id, initiativeId: initiative.id, bytes: original, declaredMimeType: 'image/jpeg', fileName: 'toldos.jpg', noMinorsConfirmed: true });
    const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } });
    expect(asset).toMatchObject({ purpose: 'INITIATIVE_COVER', visibility: 'PUBLIC', mimeType: 'image/jpeg', organizationId: organization.id });
    const stored = storage.readPublic(asset.bucket, asset.objectKey)!;
    const meta = await sharp(Buffer.from(stored.body)).metadata();
    // 4000×3000 con orientación 6 es una foto vertical: sale derecha, con el lado mayor a 1.600 px.
    expect([meta.width, meta.height]).toEqual([1200, 1600]);
    expect(meta.exif).toBeUndefined();
    for (const marker of SECRETS) expect(containsText(stored.body, marker), marker).toBe(false);
    expect(stored.body.length).toBeLessThan(original.length);
    expect(asset.sizeBytes).toBe(stored.body.length);

    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).coverFileId).toBe(first.fileId);
    expect((await getPublicInitiative(db, organization.slug, initiative.id)).coverFileId).toBe(first.fileId);
    expect((await getPublicInitiativeCard(db, initiative.id)).coverFileId).toBe(first.fileId);
    expect((await listPublicInitiatives(db, organization.slug)).map((row) => [row.id, row.coverFileId])).toEqual([[initiative.id, first.fileId]]);

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'initiative.cover_published', targetId: String(initiative.id) } });
    expect(audit.metadataJson).toMatchObject({ fileId: first.fileId, noMinorsConfirmed: true, width: 1200, height: 1600 });
    expect(JSON.stringify(audit.metadataJson)).not.toMatch(/Maria|Pixel|GPS/);

    // Otra persona firmante la cambia: la anterior deja de ser pública y se retira del almacén.
    const second = await publishInitiativeCover(db, storage, cosigner, { organizationId: organization.id, initiativeId: initiative.id, bytes: await bigPhoto(1000, 500, 1), declaredMimeType: 'image/jpeg', fileName: 'otra.jpg', noMinorsConfirmed: true });
    expect(second.fileId).not.toBe(first.fileId);
    expect((await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } })).deletedAt).not.toBeNull();
    expect(storage.has(asset.bucket, asset.objectKey)).toBe(false);
    expect((await getPublicInitiativeCard(db, initiative.id)).coverFileId).toBe(second.fileId);

    expect(await removeInitiativeCover(db, storage, cosigner, organization.id, initiative.id)).toBe(true);
    expect(await removeInitiativeCover(db, storage, cosigner, organization.id, initiative.id)).toBe(false);
    expect((await getPublicInitiativeCard(db, initiative.id)).coverFileId).toBeNull();
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: { in: ['initiative.cover_published', 'initiative.cover_removed'] } } })).toBe(3);
  });

  it('cambiar la imagen versiona la tarjeta de WhatsApp (updatedAt de la campaña) y un fichero retirado no se enseña', async () => {
    const { organization, director } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const before = (await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cover = await publishInitiativeCover(db, storage, director, { organizationId: organization.id, initiativeId: initiative.id, bytes: await bigPhoto(800, 600, 1), declaredMimeType: 'image/jpeg', fileName: 'a.jpg', noMinorsConfirmed: true });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).updatedAt.getTime()).toBeGreaterThan(before.getTime());
    await db.fileAsset.update({ where: { id: cover.fileId }, data: { deletedAt: new Date() } });
    expect((await getPublicInitiativeCard(db, initiative.id)).coverFileId).toBeNull();
    expect((await getPublicInitiative(db, organization.slug, initiative.id)).coverFileId).toBeNull();
  });

  it('sin la casilla de menores, con algo que no es una imagen, de otra entidad o en una campaña que no admite imagen, no se publica nada', async () => {
    const { organization, director } = await team();
    const other = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const foreignInitiative = await createInitiative(db, other.organization.id, { status: 'FUNDRAISING' });
    const input = { organizationId: organization.id, initiativeId: initiative.id, bytes: await bigPhoto(800, 600, 1), declaredMimeType: 'image/jpeg', fileName: 'a.jpg', noMinorsConfirmed: true };

    await expect(publishInitiativeCover(db, storage, director, { ...input, noMinorsConfirmed: false })).rejects.toMatchObject({ reason: 'MINORS_NOT_CONFIRMED' });
    await expect(publishInitiativeCover(db, storage, director, { ...input, noMinorsConfirmed: undefined as unknown as boolean })).rejects.toBeInstanceOf(InitiativeCoverError);
    await expect(publishInitiativeCover(db, storage, director, { ...input, bytes: new TextEncoder().encode('%PDF-1.4\n%%EOF\n'), declaredMimeType: 'application/pdf', fileName: 'a.pdf' })).rejects.toMatchObject({ reason: 'UNREADABLE_IMAGE' });
    await expect(publishInitiativeCover(db, storage, director, { ...input, bytes: input.bytes.slice(0, 30) })).rejects.toMatchObject({ reason: 'UNREADABLE_IMAGE' });
    await expect(publishInitiativeCover(db, storage, director, { ...input, declaredMimeType: 'image/png' })).rejects.toBeInstanceOf(FileRejectedError);
    // Otra entidad: ni con su cargo en la suya ni con el identificador de una campaña ajena.
    await expect(publishInitiativeCover(db, storage, other.director, input)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(publishInitiativeCover(db, storage, director, { ...input, initiativeId: foreignInitiative.id })).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(publishInitiativeCover(db, storage, director, { ...input, initiativeId: 2_000_000_000 })).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(removeInitiativeCover(db, storage, director, organization.id, foreignInitiative.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    // Sin segundo factor o sin sesión.
    await expect(publishInitiativeCover(db, storage, { ...director, secondFactor: false } as SessionActor, input)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(publishInitiativeCover(db, storage, { kind: 'anonymous' } as SessionActor, input)).rejects.toBeInstanceOf(TenantAccessError);
    // Campañas que ya no se enseñan.
    for (const status of ['CANCELLED', 'EXPIRED', 'REFUNDED'] as const) {
      const closed = await createInitiative(db, organization.id, { status });
      await expect(publishInitiativeCover(db, storage, director, { ...input, initiativeId: closed.id })).rejects.toMatchObject({ reason: 'NOT_EDITABLE' });
    }
    expect(await db.fileAsset.count({ where: { organizationId: organization.id, purpose: 'INITIATIVE_COVER', deletedAt: null } })).toBe(0);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: foreignInitiative.id } })).coverFileId).toBeNull();
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).coverFileId).toBeNull();
  });

  it('la imagen se puede quitar en cualquier estado de la campaña y deja de servirse en cuanto esta ya no es visible', async () => {
    const { organization, director } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const cover = await publishInitiativeCover(db, storage, director, { organizationId: organization.id, initiativeId: initiative.id, bytes: await bigPhoto(800, 600, 1), declaredMimeType: 'image/jpeg', fileName: 'a.jpg', noMinorsConfirmed: true });
    expect(await getPublicImageFile(db, cover.fileId)).toMatchObject({ id: cover.fileId });
    for (const status of ['CANCELLED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED'] as const) {
      await db.initiative.update({ where: { id: initiative.id }, data: { status } });
      // Ya no se sirve a quien guardó la URL ...
      expect(await getPublicImageFile(db, cover.fileId), status).toBeNull();
    }
    // ... y la entidad puede retirarla igualmente (una familia puede pedirlo con la campaña ya devuelta); subir otra, no.
    await expect(publishInitiativeCover(db, storage, director, { organizationId: organization.id, initiativeId: initiative.id, bytes: await bigPhoto(800, 600, 1), declaredMimeType: 'image/jpeg', fileName: 'b.jpg', noMinorsConfirmed: true })).rejects.toMatchObject({ reason: 'NOT_EDITABLE' });
    expect(await removeInitiativeCover(db, storage, director, organization.id, initiative.id)).toBe(true);
    const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: cover.fileId } });
    expect(asset.deletedAt).not.toBeNull();
    expect(storage.has(asset.bucket, asset.objectKey)).toBe(false);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).coverFileId).toBeNull();
  });

  it('un logotipo con más de 40 megapíxeles se rechaza sin decodificarlo (sin reducirlo: solo se limpia)', async () => {
    const { organization, director } = await team();
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 200;
    const bomb = new Uint8Array(await sharp({ create: { width: side, height: side, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png({ compressionLevel: 9 }).toBuffer());
    await expect(publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'logo', bytes: bomb, declaredMimeType: 'image/png', fileName: 'logo.png' })).rejects.toMatchObject({ reason: 'UNREADABLE_IMAGE' });
    expect(await db.fileAsset.count({ where: { organizationId: organization.id, deletedAt: null } })).toBe(0);
  }, 60_000);

  it('una campaña en preparación puede tener imagen, pero el portal no la enseña hasta que se publica', async () => {
    const { organization, director } = await team();
    const draft = await createInitiative(db, organization.id, { status: 'BUDGETING' });
    await publishInitiativeCover(db, storage, director, { organizationId: organization.id, initiativeId: draft.id, bytes: await bigPhoto(800, 600, 1), declaredMimeType: 'image/jpeg', fileName: 'a.jpg', noMinorsConfirmed: true });
    await expect(getPublicInitiative(db, organization.slug, draft.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await listPublicInitiatives(db, organization.slug)).toEqual([]);
  });

  it('la portada y la foto de un logro también se reducen a 1.600 px y salen sin metadatos', async () => {
    const { organization, director } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'GOAL_REACHED' });
    const original = await bigPhoto(4000, 3000, 1);

    const banner = await publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'banner', bytes: original, declaredMimeType: 'image/jpeg', fileName: 'portada.jpg', noMinorsConfirmed: true });
    const bannerAsset = await db.fileAsset.findUniqueOrThrow({ where: { id: banner.fileId } });
    const bannerStored = storage.readPublic(bannerAsset.bucket, bannerAsset.objectKey)!;
    const bannerMeta = await sharp(Buffer.from(bannerStored.body)).metadata();
    expect([bannerMeta.width, bannerMeta.height]).toEqual([1600, 1200]);
    for (const marker of SECRETS) expect(containsText(bannerStored.body, marker), marker).toBe(false);
    expect(bannerStored.body.length).toBeLessThan(original.length);

    const photo = await publishAchievementPhoto(db, storage, director, { organizationId: organization.id, initiativeId: initiative.id, slot: 'BEFORE', bytes: original, declaredMimeType: 'image/jpeg', fileName: 'antes.jpg', noIdentifiableMinors: true });
    const photoAsset = await db.fileAsset.findUniqueOrThrow({ where: { id: photo.fileId } });
    const photoStored = storage.readPublic(photoAsset.bucket, photoAsset.objectKey)!;
    expect((await sharp(Buffer.from(photoStored.body)).metadata()).width).toBe(1600);
    for (const marker of SECRETS) expect(containsText(photoStored.body, marker), marker).toBe(false);
    expect(photo.removedMetadata).toEqual(expect.arrayContaining(['APP1']));
  });

  it('la portada y el logotipo siguen con sus topes: el logotipo no se redimensiona (solo se limpia)', async () => {
    const { organization, director } = await team();
    const wideLogo = new Uint8Array(await sharp({ create: { width: 2400, height: 800, channels: 3, background: { r: 16, g: 31, b: 56 } } }).png().toBuffer());
    const logo = await publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'logo', bytes: wideLogo, declaredMimeType: 'image/png', fileName: 'escudo.png' });
    const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: logo.fileId } });
    expect((await sharp(Buffer.from(storage.readPublic(asset.bucket, asset.objectKey)!.body)).metadata()).width).toBe(2400);
  });
});
