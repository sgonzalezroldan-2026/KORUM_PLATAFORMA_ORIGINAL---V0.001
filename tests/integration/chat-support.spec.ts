import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataHmac } from '@/core/security/crypto';
import { ideaSignerMarker } from '@/core/security/device-quorum.service';
import { markSessionReauthenticated, verifyAccountSession } from '@/core/security/verified-actor';
import { CHAT_FAMILY_MESSAGES_MAX, CHAT_UNANSWERED_MAX } from '@/core/support/support-rules';
import { oneMonthAfter } from '@/core/privacy/privacy-requests';
import { buildPersonalDataExport } from '@/core/privacy/personal-data-export';
import { purgeOldIdeaChats, purgeResolvedSupportTickets } from '@/core/privacy/retention-purge';
import type { KorumPrismaClient } from '@/lib/prisma';
import { IDEA_CHAT_RULE, SUPPORT_TICKET_DAILY_RULE, SUPPORT_TICKET_RULE } from '@/lib/rate-limit-rules';
import { sendFamilyIdeaMessage } from '@/services/ideas/idea-chat.service';
import { loadMyIdeas } from '@/services/ideas/my-ideas-data';
import { eraseOwnAccount } from '@/services/account/account-privacy.service';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { listSupportTicketsOf, submitSupportTicket } from '@/services/support/support-requests.service';
import { createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/**
 * Sprint 3.9 · chat anónimo de las ideas (lado de la familia), «Mis firmas» y soporte (QA-F06), contra PostgreSQL real: solo escribe quien propuso
 * la idea, los mensajes se firman con el alias del servidor, los topes frenan el monólogo y la ráfaga, una consulta de soporte sale con su código,
 * su acuse y (si pide corregir datos) su solicitud RGPD de rectificación, y la supresión, la exportación y la conservación alcanzan al chat.
 */

const NOW = new Date('2026-11-12T10:00:00.000Z');
const DAY = 86_400_000;
const MINUTE = 60_000;
let db: KorumPrismaClient;
const mockSecrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-pruebas' };

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.outboxMessage.updateMany({ where: { templateKey: 'support.received', status: 'PENDING' }, data: { status: 'CANCELLED' } });
  await db.$disconnect();
});

async function verifiedFor(userId: string) {
  const session = await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId, expiresAt: new Date(Date.now() + 60 * MINUTE) } });
  await markSessionReauthenticated(db, session.id, { secondFactor: false }, new Date(Date.now() - MINUTE));
  return verifyAccountSession(db, { userId, sessionId: session.id, operation: 'test' });
}

async function author(overrides: Parameters<typeof createUser>[1] = {}) {
  const person = await createUser(db, overrides);
  const organization = await createOrganization(db, { kybStatus: 'VERIFIED' });
  const idea = await db.idea.create({
    data: { organizationId: organization.id, alias: '#FAM-4821', authorCanonicalEmail: person.canonicalEmail, title: 'Toldo para el patio', category: 'Patios y Deporte', description: 'Hace falta sombra en el recreo', phase: 'PUBLIC_VOTING', verifiedVotes: 3, expiresAt: new Date(NOW.getTime() + 10 * DAY) }
  });
  return { person, organization, idea };
}

const say = (userId: string, ideaId: number, body = 'Hola, ¿se ha podido ver ya?') => sendFamilyIdeaMessage(db, { userId, payload: { ideaId, body } }, NOW);
const centerSays = (ideaId: number, body = 'Gracias, lo estamos mirando.') => db.ideaMessage.create({ data: { ideaId, senderRole: 'ORGANIZATION', senderLabel: 'Dirección del centro', body, createdAt: NOW } });

describe('chat anónimo de una idea (lado de la familia)', () => {
  it('quien propuso escribe, y el mensaje queda firmado con el alias del servidor y no con texto de la familia', async () => {
    const { person, idea } = await author();
    const result = await sendFamilyIdeaMessage(db, { userId: person.id, payload: { ideaId: idea.id, body: '  Soy María   García,\n\n\n\nmamá de Lucas  ', senderLabel: 'María García', senderRole: 'ORGANIZATION' } }, NOW);
    expect(result.status).toBe('SENT');
    const [message] = await db.ideaMessage.findMany({ where: { ideaId: idea.id } });
    expect(message).toMatchObject({ senderRole: 'FAMILY', senderLabel: '#FAM-4821', body: 'Soy María García,\n\nmamá de Lucas' });
  });

  it('una idea ajena responde igual que una inexistente, no escribe nada y deja rastro en la auditoría', async () => {
    const { idea } = await author();
    const stranger = await createUser(db);
    expect(await say(stranger.id, idea.id)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    expect(await say(stranger.id, 2_000_000_000)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    expect(await db.ideaMessage.count({ where: { ideaId: idea.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorUserId: stranger.id, action: 'idea.chat_access_denied', targetId: String(idea.id) } })).toBe(1);
  });

  it('quien firmó la idea pero no la propuso no puede escribir en su chat', async () => {
    const { idea } = await author();
    const signer = await createUser(db);
    await db.ideaSignatureAudit.create({ data: { ideaId: idea.id, userId: signer.id, canonicalEmail: signer.canonicalEmail, reason: 'ideas.audit.firstAccount' } });
    expect(await say(signer.id, idea.id)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
  });

  it('una cuenta sin el email verificado o ya suprimida no escribe', async () => {
    const { person, idea } = await author({ emailVerified: false });
    expect(await say(person.id, idea.id)).toEqual({ status: 'REJECTED', reason: 'ACCOUNT_NOT_ALLOWED' });
    const erased = await author({ gdprAnonymizedAt: new Date() });
    expect(await say(erased.person.id, erased.idea.id)).toEqual({ status: 'REJECTED', reason: 'ACCOUNT_NOT_ALLOWED' });
  });

  it('tres mensajes seguidos sin respuesta del centro frenan el siguiente, y la respuesta del centro lo libera', async () => {
    const { person, idea } = await author();
    for (let index = 0; index < CHAT_UNANSWERED_MAX; index += 1) expect((await say(person.id, idea.id, `Mensaje número ${index + 1}`)).status).toBe('SENT');
    expect(await say(person.id, idea.id)).toEqual({ status: 'REJECTED', reason: 'WAIT_FOR_CENTER' });
    await centerSays(idea.id);
    expect((await say(person.id, idea.id)).status).toBe('SENT');
  });

  it('cinco peticiones a la vez no superan el tope de mensajes sin respuesta', async () => {
    const { person, idea } = await author();
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => say(person.id, idea.id, `En paralelo ${index}`)));
    expect(results.filter((result) => result.status === 'SENT')).toHaveLength(CHAT_UNANSWERED_MAX);
    expect(await db.ideaMessage.count({ where: { ideaId: idea.id, senderRole: 'FAMILY' } })).toBe(CHAT_UNANSWERED_MAX);
  });

  it('el tope total de mensajes de la familia por idea se respeta aunque el centro responda', async () => {
    const { person, idea } = await author();
    await db.ideaMessage.createMany({ data: Array.from({ length: CHAT_FAMILY_MESSAGES_MAX }, () => ({ ideaId: idea.id, senderRole: 'FAMILY' as const, senderLabel: '#FAM-4821', body: 'x'.repeat(5) })) });
    await centerSays(idea.id);
    expect(await say(person.id, idea.id)).toEqual({ status: 'REJECTED', reason: 'LIMIT_REACHED' });
  });

  it('solo se escribe mientras la idea vive: rechazada o convertida, el chat es de solo lectura', async () => {
    const { person, idea } = await author();
    for (const phase of ['REJECTED', 'CONVERTED'] as const) {
      await db.idea.update({ where: { id: idea.id }, data: { phase } });
      expect(await say(person.id, idea.id)).toEqual({ status: 'REJECTED', reason: 'CLOSED' });
    }
    for (const phase of ['PHASE0_MOD', 'DOUBLE_CHECK'] as const) {
      await db.idea.update({ where: { id: idea.id }, data: { phase } });
      await centerSays(idea.id);
      expect((await say(person.id, idea.id)).status).toBe('SENT');
    }
  });

  it('un mensaje inválido no gasta el cupo, y la ráfaga por persona se corta en el tope', async () => {
    const { person, idea } = await author();
    expect(await say(person.id, idea.id, 'x')).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await say(person.id, idea.id, 'y'.repeat(601))).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await db.rateLimit.findUnique({ where: { key: `${IDEA_CHAT_RULE.prefix}${person.id}` } })).toBeNull();
    await db.rateLimit.create({ data: { id: uniqueId('rl'), key: `${IDEA_CHAT_RULE.prefix}${person.id}`, count: IDEA_CHAT_RULE.limit, lastRequest: BigInt(NOW.getTime()) } });
    expect(await say(person.id, idea.id)).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
  });
});

describe('«Mis propuestas» y «Mis firmas»', () => {
  it('solo muestra lo de esta persona: sus propuestas con el chat, y las firmadas (por cuenta o email, no por la marca de una supresión anterior) sin las propias ni las de entidades archivadas', async () => {
    const { person, organization, idea } = await author();
    await centerSays(idea.id);
    const other = await author();
    const archived = await createOrganization(db, { archivedAt: new Date() });
    const mark = async (organizationId: string, signature: { userId?: string; canonicalEmail: string }) => {
      const signed = await db.idea.create({ data: { organizationId, alias: uniqueId('#FAM'), authorCanonicalEmail: `${uniqueId('autor')}@pruebas.example`, title: 'Idea de otra familia', category: 'Cultura', description: 'x', phase: 'PUBLIC_VOTING', verifiedVotes: 2, expiresAt: new Date(NOW.getTime() + DAY) } });
      await db.ideaSignatureAudit.create({ data: { ideaId: signed.id, reason: 'ideas.audit.firstAccount', status: 'SUSPICIOUS', ...signature } });
      return signed;
    };
    const byAccount = await mark(organization.id, { userId: person.id, canonicalEmail: 'otro-correo@pruebas.example' });
    const byMarker = await mark(organization.id, { canonicalEmail: ideaSignerMarker(TEST_HMAC_SECRET, person.canonicalEmail) });
    await mark(archived.id, { userId: person.id, canonicalEmail: person.canonicalEmail });
    await mark(other.organization.id, { canonicalEmail: `${uniqueId('x')}@pruebas.example` });

    const mine = await loadMyIdeas(db, person.id, NOW);
    expect(mine.proposals).toHaveLength(1);
    expect(mine.proposals[0]).toMatchObject({ id: idea.id, alias: '#FAM-4821', block: null, messages: [{ role: 'ORGANIZATION', label: 'Dirección del centro' }] });
    // La marca anónima de una supresión anterior no devuelve a quien vuelve el listado de lo que firmó antes (la cuenta nueva empieza vacía).
    expect(mine.signed.map((row) => row.id)).toEqual([byAccount.id]);
    expect(mine.signed.map((row) => row.id)).not.toContain(byMarker.id);
    // Ni el correo de nadie, ni el estado de la firma (una firma «en revisión» no se le dice a quien la hizo).
    expect(JSON.stringify(mine)).not.toMatch(/@pruebas\.example|SUSPICIOUS|VERIFIED|authorCanonicalEmail/);
    expect((await loadMyIdeas(db, other.person.id, NOW)).proposals.map((row) => row.id)).toEqual([other.idea.id]);
  });

  it('con más de 200 mensajes, el chat enseña los más recientes: nunca se pierde la última respuesta del centro', async () => {
    const { person, idea } = await author();
    await db.ideaMessage.createMany({ data: Array.from({ length: 205 }, (_, index) => ({ ideaId: idea.id, senderRole: 'ORGANIZATION' as const, senderLabel: 'Dirección', body: `Mensaje ${index}`, createdAt: new Date(NOW.getTime() + index * 1_000) })) });
    await db.ideaMessage.create({ data: { ideaId: idea.id, senderRole: 'ORGANIZATION', senderLabel: 'Dirección', body: 'La última respuesta', createdAt: new Date(NOW.getTime() + 999_000) } });
    const [proposal] = (await loadMyIdeas(db, person.id, NOW)).proposals;
    expect(proposal?.messages).toHaveLength(200);
    expect(proposal?.messages.at(-1)?.body).toBe('La última respuesta');
    expect(proposal!.messages[0]!.createdAt < proposal!.messages[1]!.createdAt).toBe(true);
  });

  it('una cuenta sin el email verificado no ve propuestas ni firmas', async () => {
    const { person } = await author({ emailVerified: false });
    expect(await loadMyIdeas(db, person.id, NOW)).toEqual({ proposals: [], signed: [] });
  });
});

describe('consultas de soporte', () => {
  const senderKey = (prefix: string, canonicalEmail: string) => `${prefix}${dataHmac(TEST_HMAC_SECRET, 'support-sender', canonicalEmail)}`;
  const deps = () => ({ db, hmacSecret: TEST_HMAC_SECRET });
  const ticket = (slug: string, overrides: Record<string, unknown> = {}) => ({ orgSlug: slug, topic: 'PAYMENT', subject: 'No me ha llegado la devolución', message: 'Hice una aportación hace dos semanas y aún no he recibido el reembolso.', ...overrides });
  const verified = verifiedFor;

  it('crea la consulta con su código, el email de la cuenta (no el del formulario), su destino según el tema y el acuse en la bandeja', async () => {
    const organization = await createOrganization(db);
    const person = await createUser(db);
    const toKorum = await submitSupportTicket(deps(), { userId: person.id, payload: ticket(organization.slug, { senderEmail: 'otra@pruebas.example', status: 'RESOLVED' }), actor: null, locale: 'ca' }, NOW);
    expect(toKorum).toMatchObject({ status: 'SENT', rectification: false });
    if (toKorum.status !== 'SENT') throw new Error('no enviada');
    expect(toKorum.ticketCode).toMatch(/^TCK-[A-HJKMNP-Z2-9]{6}$/);
    expect(await db.supportTicket.findUniqueOrThrow({ where: { ticketCode: toKorum.ticketCode } })).toMatchObject({ senderEmail: person.email, target: 'SUPERADMIN', topic: 'PAYMENT', status: 'OPEN', organizationId: organization.id, originLabel: organization.name });
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { id: toKorum.outboxId } })).toMatchObject({ templateKey: 'support.received', locale: 'ca', toAddress: person.email, userId: person.id, payloadJson: { ticketCode: toKorum.ticketCode, rectification: false, answeredBy: 'SUPERADMIN' } });

    const toCenter = await submitSupportTicket(deps(), { userId: person.id, payload: ticket(organization.slug, { topic: 'INITIATIVE' }), actor: null, locale: 'es' }, NOW);
    expect(toCenter.status).toBe('SENT');
    expect(await db.supportTicket.count({ where: { senderEmail: person.email, target: 'ORGANIZATION', topic: 'INITIATIVE' } })).toBe(1);
    expect(await db.auditLog.count({ where: { actorUserId: person.id, action: 'support.ticket_created' } })).toBe(2);
  });

  it('corregir datos personales exige haber confirmado la identidad y abre la solicitud de rectificación con plazo de un mes', async () => {
    const organization = await createOrganization(db);
    const person = await createUser(db);
    const rectification = ticket(organization.slug, { topic: 'RECTIFICATION', subject: 'Corregir mi nombre', message: 'Mi apellido está mal escrito en la cuenta y en los justificantes.' });
    expect(await submitSupportTicket(deps(), { userId: person.id, payload: rectification, actor: null, locale: 'es' }, NOW)).toEqual({ status: 'REJECTED', reason: 'REAUTH_REQUIRED' });
    // La confirmación de otra persona no vale.
    const stranger = await createUser(db);
    expect(await submitSupportTicket(deps(), { userId: person.id, payload: rectification, actor: await verified(stranger.id), locale: 'es' }, NOW)).toEqual({ status: 'REJECTED', reason: 'REAUTH_REQUIRED' });
    expect(await db.supportTicket.count({ where: { senderEmail: person.email } })).toBe(0);
    expect(await db.privacyRequest.count({ where: { userId: person.id } })).toBe(0);

    const realNow = new Date();
    const sent = await submitSupportTicket(deps(), { userId: person.id, payload: rectification, actor: await verified(person.id), locale: 'es' }, realNow);
    expect(sent).toMatchObject({ status: 'SENT', rectification: true });
    if (sent.status !== 'SENT') throw new Error('no enviada');
    const request = await db.privacyRequest.findFirstOrThrow({ where: { userId: person.id } });
    expect(request).toMatchObject({ type: 'RECTIFICATION', status: 'RECEIVED', notes: `Soporte ${sent.ticketCode}` });
    expect(request.dueAt.toISOString()).toBe(oneMonthAfter(realNow).toISOString());
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { id: sent.outboxId } })).toMatchObject({ payloadJson: { rectification: true } });
  });

  it('rechaza lo inválido, una cuenta sin email verificado y una entidad inexistente o archivada sin gastar el cupo', async () => {
    const organization = await createOrganization(db);
    const archived = await createOrganization(db, { archivedAt: new Date() });
    const person = await createUser(db);
    const reject = async (userId: string, payload: unknown) => {
      const result = await submitSupportTicket(deps(), { userId, payload, actor: null, locale: 'es' }, NOW);
      return result.status === 'REJECTED' ? result.reason : 'NO_ERROR';
    };
    expect(await reject(person.id, ticket(organization.slug, { subject: 'Hola' }))).toBe('INVALID_INPUT');
    expect(await reject(person.id, ticket(organization.slug, { message: 'muy corto' }))).toBe('INVALID_INPUT');
    expect(await reject(person.id, ticket(organization.slug, { topic: 'HACKER' }))).toBe('INVALID_INPUT');
    expect(await reject(person.id, ticket('no-existe'))).toBe('ORGANIZATION_NOT_FOUND');
    expect(await reject(person.id, ticket(archived.slug))).toBe('ORGANIZATION_NOT_FOUND');
    expect(await reject((await createUser(db, { emailVerified: false })).id, ticket(organization.slug))).toBe('ACCOUNT_NOT_ALLOWED');
    expect(await reject((await createUser(db, { gdprAnonymizedAt: new Date() })).id, ticket(organization.slug))).toBe('ACCOUNT_NOT_ALLOWED');
    for (const rule of [SUPPORT_TICKET_RULE, SUPPORT_TICKET_DAILY_RULE]) expect((await db.rateLimit.findUnique({ where: { key: senderKey(rule.prefix, person.canonicalEmail) } }))?.count ?? 0).toBe(0);
  });

  it('cinco consultas por hora y por persona: la sexta espera, y una que no se crea devuelve el intento', async () => {
    const organization = await createOrganization(db);
    const person = await createUser(db);
    for (let index = 0; index < SUPPORT_TICKET_RULE.limit; index += 1) expect((await submitSupportTicket(deps(), { userId: person.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, NOW)).status).toBe('SENT');
    expect(await submitSupportTicket(deps(), { userId: person.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, NOW)).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
    // Una hora después vuelve a poder, y el tope diario sigue contando.
    const later = new Date(NOW.getTime() + 61 * MINUTE);
    expect((await submitSupportTicket(deps(), { userId: person.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, later)).status).toBe('SENT');
    expect((await db.rateLimit.findUniqueOrThrow({ where: { key: senderKey(SUPPORT_TICKET_DAILY_RULE.prefix, person.canonicalEmail) } })).count).toBe(SUPPORT_TICKET_RULE.limit + 1);
  });

  it('los topes de soporte son por persona: dos cuentas con alias del mismo buzón (laura+1@, laura+2@) comparten el cupo', async () => {
    const organization = await createOrganization(db);
    const stem = uniqueId('alias').toLowerCase();
    const first = await createUser(db, { email: `${stem}+1@pruebas.example`, canonicalEmail: `${stem}+1@pruebas.example` });
    const second = await createUser(db, { email: `${stem}+2@pruebas.example`, canonicalEmail: `${stem}+2@pruebas.example` });
    for (let index = 0; index < SUPPORT_TICKET_RULE.limit; index += 1) expect((await submitSupportTicket(deps(), { userId: index % 2 === 0 ? first.id : second.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, NOW)).status).toBe('SENT');
    expect(await submitSupportTicket(deps(), { userId: first.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, NOW)).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
    expect(await submitSupportTicket(deps(), { userId: second.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, NOW)).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
  });

  it('una segunda consulta de rectificación no abre otra solicitud mientras la primera siga abierta', async () => {
    const organization = await createOrganization(db);
    const person = await createUser(db);
    const rectification = ticket(organization.slug, { topic: 'RECTIFICATION', subject: 'Corregir mi nombre', message: 'Mi nombre está mal escrito en la cuenta y en los justificantes.' });
    const realNow = new Date();
    const first = await submitSupportTicket(deps(), { userId: person.id, payload: rectification, actor: await verified(person.id), locale: 'es' }, realNow);
    const second = await submitSupportTicket(deps(), { userId: person.id, payload: rectification, actor: await verified(person.id), locale: 'es' }, realNow);
    expect([first.status, second.status]).toEqual(['SENT', 'SENT']);
    expect(await db.privacyRequest.count({ where: { userId: person.id, type: 'RECTIFICATION' } })).toBe(1);
    expect(await db.supportTicket.count({ where: { senderEmail: person.email, topic: 'RECTIFICATION' } })).toBe(2);
  });

  it('«Mis consultas» solo trae las de la persona; una cuenta sin verificar o suprimida no ve ninguna', async () => {
    const organization = await createOrganization(db);
    const person = await createUser(db);
    const other = await createUser(db);
    await submitSupportTicket(deps(), { userId: person.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, NOW);
    await submitSupportTicket(deps(), { userId: other.id, payload: ticket(organization.slug), actor: null, locale: 'es' }, NOW);
    expect(await listSupportTicketsOf(db, person)).toHaveLength(1);
    expect(await listSupportTicketsOf(db, { ...person, emailVerified: false })).toEqual([]);
    expect(await listSupportTicketsOf(db, { ...person, gdprAnonymizedAt: new Date() })).toEqual([]);
  });
});

describe('privacidad del chat y de las consultas', () => {
  it('la exportación incluye las propuestas con el chat y las consultas de la persona', async () => {
    const { person, idea } = await author();
    await say(person.id, idea.id, 'Mensaje de la familia');
    await centerSays(idea.id, 'Respuesta del centro');
    const data = await buildPersonalDataExport(db, TEST_KEYRING, { kind: 'self', actor: await verifiedFor(person.id) });
    expect(data.ideaProposals).toHaveLength(1);
    expect(data.ideaProposals[0]).toMatchObject({ alias: '#FAM-4821', title: 'Toldo para el patio' });
    expect(data.ideaProposals[0]?.messages.map((message) => message.body)).toEqual(['Mensaje de la familia', 'Respuesta del centro']);
  });

  it('suprimir la cuenta borra lo que la familia escribió en el chat, conserva las respuestas del centro y quita su email de las consultas', async () => {
    const { person, organization, idea } = await author();
    await say(person.id, idea.id, 'Soy Marta, de 2ºB');
    await centerSays(idea.id);
    await submitSupportTicket({ db, hmacSecret: TEST_HMAC_SECRET }, { userId: person.id, payload: { orgSlug: organization.slug, topic: 'OTHER', subject: 'Una sugerencia', message: 'Estaría bien poder ver las fotos de las obras.' }, actor: null, locale: 'es' }, NOW);

    const deps = { paymentProvider: async () => new MockPaycometProvider({ secrets: mockSecrets }), keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET };
    expect((await eraseOwnAccount(db, deps, { actor: await verifiedFor(person.id) })).status).toBe('ERASED');
    const messages = await db.ideaMessage.findMany({ where: { ideaId: idea.id } });
    expect(messages.map((message) => message.senderRole)).toEqual(['ORGANIZATION']);
    expect(await db.supportTicket.count({ where: { senderEmail: person.email } })).toBe(0);
    // Y el texto de la consulta se va con el email (las de «Corregir mis datos» son las que más datos personales llevan).
    expect(await db.supportTicket.count({ where: { organizationId: organization.id, subject: 'Una sugerencia' } })).toBe(0);
    expect(await db.supportTicket.count({ where: { organizationId: organization.id, message: { contains: 'fotos de las obras' } } })).toBe(0);
  });

  it('la conservación borra el chat de la familia de ideas cerradas hace más de un año y vacía las consultas resueltas hace más de dos', async () => {
    const old = await author();
    await db.idea.update({ where: { id: old.idea.id }, data: { expiresAt: new Date(NOW.getTime() - 400 * DAY) } });
    await db.ideaMessage.createMany({ data: [{ ideaId: old.idea.id, senderRole: 'FAMILY', senderLabel: '#FAM-4821', body: 'viejo' }, { ideaId: old.idea.id, senderRole: 'ORGANIZATION', senderLabel: 'Dirección', body: 'respuesta' }] });
    const recent = await author();
    await db.ideaMessage.create({ data: { ideaId: recent.idea.id, senderRole: 'FAMILY', senderLabel: '#FAM-4821', body: 'reciente' } });
    await purgeOldIdeaChats(db, NOW, 500);
    expect((await db.ideaMessage.findMany({ where: { ideaId: old.idea.id } })).map((message) => message.senderRole)).toEqual(['ORGANIZATION']);
    expect(await db.ideaMessage.count({ where: { ideaId: recent.idea.id } })).toBe(1);

    const resolved = await db.supportTicket.create({ data: { ticketCode: uniqueId('TCK-OLD'), originLabel: 'Centro', senderEmail: 'vieja@pruebas.example', subject: 'Antigua', message: 'Consulta antigua resuelta', replyMessage: 'Hecho', status: 'RESOLVED' } });
    await db.supportTicket.update({ where: { id: resolved.id }, data: { updatedAt: new Date(NOW.getTime() - 800 * DAY) } });
    const open = await db.supportTicket.create({ data: { ticketCode: uniqueId('TCK-OPEN'), originLabel: 'Centro', senderEmail: 'abierta@pruebas.example', subject: 'Abierta', message: 'Consulta abierta sin resolver' } });
    await purgeResolvedSupportTickets(db, NOW, 500);
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: resolved.id } })).toMatchObject({ senderEmail: null, message: '', subject: '', replyMessage: null, status: 'RESOLVED' });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: open.id } })).toMatchObject({ senderEmail: 'abierta@pruebas.example', message: 'Consulta abierta sin resolver' });
    // Una consulta que nunca se resolvió caduca igualmente a los dos años de abrirse.
    const abandoned = await db.supportTicket.create({ data: { ticketCode: uniqueId('TCK-AB'), originLabel: 'Centro', senderEmail: 'olvidada@pruebas.example', subject: 'Olvidada', message: 'Consulta que nadie contestó', createdAt: new Date(NOW.getTime() - 800 * DAY) } });
    await purgeResolvedSupportTickets(db, NOW, 500);
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({ senderEmail: null, message: '', status: 'OPEN' });
  });
});
