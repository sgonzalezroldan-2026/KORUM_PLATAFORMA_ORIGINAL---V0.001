import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdeaProposalRejectedError, proposeIdea } from '@/core/ideas/idea-proposal.service';
import { ideaSignerMarker, signIdea } from '@/core/security/device-quorum.service';
import { dataHmac } from '@/core/security/data-hmac';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { IDEA_PROPOSAL_RULE, IDEA_SIGN_RULE } from '@/lib/rate-limit-rules';
import { listPublicAchievements, getPublicImageFile, listAchievementWorkbench } from '@/repositories/achievements.repository';
import { listIdeaIdsSignedBy, listPublicIdeas } from '@/repositories/ideas-public.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { proposeIdeaForRequest, signIdeaForRequest } from '@/services/ideas/idea-requests.service';
import { AchievementPhotoRejectedError, publishAchievementPhoto, saveThanksMessage, THANKS_MESSAGE_MAX } from '@/services/storage/achievement-photos.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { containsText, jpegWithExif, SECRET_MARKERS } from './image-fixtures';
import { createInitiative, createOrganization, createTestClient, createUser, uniqueId } from './test-database';

/**
 * Sprint 3.6 · buzón de ideas y logros (QA-F09), contra PostgreSQL real: propuesta con alias anónimo y límites, lecturas públicas sin datos
 * internos, firma con la regla padre y madre, alerta de IP de confianza, y fotos Antes / Después sin metadatos y con la confirmación de menores.
 */

const SECRET = 'secreto-de-integracion-del-buzon-0123456789';
const NOW = new Date('2026-11-10T10:00:00.000Z');
const DAY = 86_400_000;
const SYSTEM_MESSAGE = 'Propuesta registrada con {alias}.';
let db: KorumPrismaClient;
let subnet = 0;
/** Cada prueba usa su propia red: los límites por red no se contagian entre pruebas ni entre suites. */
const freshIp = () => {
  subnet += 1;
  return `10.${(Date.now() % 200) + 20}.${subnet % 250}.7`;
};

beforeAll(async () => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

async function newOrganization(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, { kybStatus: 'VERIFIED', ...overrides });
  await db.organizationCategory.createMany({
    data: [
      { organizationId: organization.id, name: 'Patios y Deporte', icon: '⚽' },
      { organizationId: organization.id, name: 'Cultura', icon: '🎭' },
      { organizationId: organization.id, name: 'Taquilla y Rifas', icon: '🎟️', rule: 'EXEMPT' }
    ]
  });
  return organization;
}

const proposal = (slug: string, overrides: Record<string, unknown> = {}) => ({ orgSlug: slug, title: 'Fuentes de agua fresca', category: 'Patios y Deporte', description: 'Los niños rellenarían sus cantimploras en el patio.', ...overrides });
const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }> = [], overrides: Partial<Extract<SessionActor, { kind: 'user' }>> = {}): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true, ...overrides });
const publicIdea = (organizationId: string, overrides: Partial<Parameters<KorumPrismaClient['idea']['create']>[0]['data']> = {}) =>
  db.idea.create({
    data: { organizationId, alias: uniqueId('#FAM'), authorCanonicalEmail: `${uniqueId('autor')}@pruebas.example`, title: 'Toldo para el patio', category: 'Patios y Deporte', description: 'Hace falta sombra en el recreo', phase: 'PUBLIC_VOTING', verifiedVotes: 1, expiresAt: new Date(NOW.getTime() + 10 * DAY), ...overrides } as never
  });

describe('proponer una idea', () => {
  it('nace en revisión del centro con un alias #FAM-NNNN, plazo de la entidad, primera firma del autor y mensaje del sistema; el texto libre del autor nunca es el alias', async () => {
    const organization = await newOrganization({ maxIdeaDays: 30 });
    const author = await createUser(db);
    const result = await proposeIdea(db, { userId: author.id, payload: { ...proposal(organization.slug), alias: 'Mamá de Lucas 3ºB', authorCanonicalEmail: 'otro@pruebas.example', phase: 'PUBLIC_VOTING', verifiedVotes: 99 }, systemMessage: SYSTEM_MESSAGE }, NOW);
    expect(result.alias).toMatch(/^#FAM-[1-9]\d{3}$/);
    const idea = await db.idea.findUniqueOrThrow({ where: { id: result.ideaId }, include: { messages: true } });
    expect(idea).toMatchObject({ alias: result.alias, phase: 'PHASE0_MOD', votes: 1, verifiedVotes: 1, suspiciousVotes: 0, authorCanonicalEmail: author.canonicalEmail, organizationId: organization.id });
    expect(idea.expiresAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(idea.messages).toHaveLength(1);
    expect(idea.messages[0]).toMatchObject({ senderRole: 'SYSTEM', body: `Propuesta registrada con ${result.alias}.` });
  });

  it('no admite email sin verificar, cuenta suprimida, categoría de taquilla o inexistente, entidad ajena o archivada', async () => {
    const organization = await newOrganization();
    const archived = await newOrganization({ archivedAt: new Date() });
    const reject = async (userId: string, payload: unknown) => {
      const error = await proposeIdea(db, { userId, payload, systemMessage: SYSTEM_MESSAGE }, NOW).catch((caught: unknown) => caught);
      return error instanceof IdeaProposalRejectedError ? error.reason : 'NO_ERROR';
    };
    expect(await reject((await createUser(db, { emailVerified: false })).id, proposal(organization.slug))).toBe('ACCOUNT_NOT_ALLOWED');
    expect(await reject((await createUser(db, { gdprAnonymizedAt: new Date() })).id, proposal(organization.slug))).toBe('ACCOUNT_NOT_ALLOWED');
    const person = await createUser(db);
    expect(await reject(person.id, proposal(organization.slug, { category: 'Taquilla y Rifas' }))).toBe('INVALID_CATEGORY');
    expect(await reject(person.id, proposal(organization.slug, { category: 'Inventada' }))).toBe('INVALID_CATEGORY');
    expect(await reject(person.id, proposal('no-existe'))).toBe('ORGANIZATION_NOT_FOUND');
    expect(await reject(person.id, proposal(archived.slug))).toBe('ORGANIZATION_NOT_FOUND');
    expect(await reject(person.id, proposal(organization.slug, { title: 'Corto' }))).toBe('INVALID_INPUT');
    expect(await reject(person.id, 'no-es-un-objeto')).toBe('INVALID_INPUT');
    expect(await db.idea.count({ where: { authorCanonicalEmail: person.canonicalEmail } })).toBe(0);
  });

  it('tres propuestas al día y cinco abiertas: más son rechazadas, y 5 peticiones a la vez no superan el tope', async () => {
    const organization = await newOrganization();
    const author = await createUser(db);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => proposeIdea(db, { userId: author.id, payload: proposal(organization.slug), systemMessage: SYSTEM_MESSAGE }, NOW)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected.every((result) => result.reason instanceof IdeaProposalRejectedError && result.reason.reason === 'TOO_MANY_TODAY')).toBe(true);
    expect(await db.idea.count({ where: { organizationId: organization.id } })).toBe(3);
    // Pasado el día, el tope de abiertas (5) sigue contando las que están en revisión o recogiendo firmas.
    const later = new Date(NOW.getTime() + 2 * DAY);
    await proposeIdea(db, { userId: author.id, payload: proposal(organization.slug), systemMessage: SYSTEM_MESSAGE }, later);
    await proposeIdea(db, { userId: author.id, payload: proposal(organization.slug), systemMessage: SYSTEM_MESSAGE }, later);
    await expect(proposeIdea(db, { userId: author.id, payload: proposal(organization.slug), systemMessage: SYSTEM_MESSAGE }, later)).rejects.toMatchObject({ reason: 'TOO_MANY_OPEN' });
  });

  it('el alias no se repite dentro de la entidad (ni con el formato antiguo «Código #FAM-NNNN»)', async () => {
    const organization = await newOrganization();
    await db.idea.create({ data: { organizationId: organization.id, alias: 'Código #FAM-1000', authorCanonicalEmail: 'vieja@pruebas.example', title: 'Idea antigua', category: 'Cultura', description: 'x', expiresAt: new Date(NOW.getTime() + DAY) } });
    const author = await createUser(db);
    const first = await proposeIdea(db, { userId: author.id, payload: proposal(organization.slug), systemMessage: SYSTEM_MESSAGE, random: () => 0 }, NOW).catch((error: unknown) => error);
    // Con un generador que siempre da la misma cifra, el 1000 ya está usado por el código antiguo: no hay alias posible.
    expect(first).toBeInstanceOf(IdeaProposalRejectedError);
    expect((first as IdeaProposalRejectedError).reason).toBe('ALIAS_EXHAUSTED');
    const second = await proposeIdea(db, { userId: author.id, payload: proposal(organization.slug), systemMessage: SYSTEM_MESSAGE, random: () => 1 }, NOW);
    expect(second.alias).toBe('#FAM-1001');
  });

  it('la propuesta por red está limitada (12 por hora) y sin sesión pide entrar', { timeout: 240_000 }, async () => {
    const organization = await newOrganization();
    const ip = freshIp();
    const deps = { db, hmacSecret: SECRET };
    expect(await proposeIdeaForRequest(deps, proposal(organization.slug), { userId: null, ip, systemMessage: SYSTEM_MESSAGE }, NOW)).toEqual({ status: 'LOGIN_REQUIRED' });
    for (let index = 0; index < IDEA_PROPOSAL_RULE.limit; index += 1) {
      const outcome = await proposeIdeaForRequest(deps, proposal(organization.slug), { userId: (await createUser(db)).id, ip, systemMessage: SYSTEM_MESSAGE }, NOW);
      expect(outcome.status).toBe('PROPOSED');
    }
    const last = await proposeIdeaForRequest(deps, proposal(organization.slug), { userId: (await createUser(db)).id, ip, systemMessage: SYSTEM_MESSAGE }, NOW);
    expect(last).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
  });
});

describe('límite de propuestas por red (auditoría del 3.6)', () => {
  const deps = () => ({ db, hmacSecret: SECRET });

  it('las peticiones inválidas no gastan el cupo de la red; el cupo es por entidad; sin IP válida no hay cupo por red', { timeout: 240_000 }, async () => {
    const organization = await newOrganization();
    const other = await newOrganization();
    const ip = freshIp();
    const person = await createUser(db);
    // 20 propuestas vacías o con un tipo inexistente desde la misma red: ninguna cuenta.
    for (let index = 0; index < 20; index += 1) {
      const invalid = await proposeIdeaForRequest(deps(), proposal(organization.slug, index % 2 ? { title: '' } : { category: 'Inventada' }), { userId: person.id, ip, systemMessage: SYSTEM_MESSAGE }, NOW);
      expect(invalid).toMatchObject({ status: 'REJECTED' });
      expect(invalid).not.toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
    }
    // Otra cuenta de la misma red sigue pudiendo proponer.
    expect((await proposeIdeaForRequest(deps(), proposal(organization.slug), { userId: (await createUser(db)).id, ip, systemMessage: SYSTEM_MESSAGE }, NOW)).status).toBe('PROPOSED');
    // Agotar la red en una entidad no bloquea a esa misma red en otra.
    for (let index = 0; index < IDEA_PROPOSAL_RULE.limit - 1; index += 1) await proposeIdeaForRequest(deps(), proposal(organization.slug), { userId: (await createUser(db)).id, ip, systemMessage: SYSTEM_MESSAGE }, NOW);
    expect(await proposeIdeaForRequest(deps(), proposal(organization.slug), { userId: (await createUser(db)).id, ip, systemMessage: SYSTEM_MESSAGE }, NOW)).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
    expect((await proposeIdeaForRequest(deps(), proposal(other.slug), { userId: (await createUser(db)).id, ip, systemMessage: SYSTEM_MESSAGE }, NOW)).status).toBe('PROPOSED');
    // Sin IP válida del proxy, un fallo de la infraestructura no deja sin buzón a toda la plataforma: no hay cupo por red (y salta la alerta).
    for (let index = 0; index < IDEA_PROPOSAL_RULE.limit + 2; index += 1) {
      expect((await proposeIdeaForRequest(deps(), proposal(organization.slug), { userId: (await createUser(db)).id, ip: null, systemMessage: SYSTEM_MESSAGE }, NOW)).status).toBe('PROPOSED');
    }
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'trusted-ip-missing:idea.propose' } })).type).toBe('TRUSTED_IP_MISSING');
  });

  it('una firma por ráfaga y la de la 3ª cuenta se explican con motivos distintos', async () => {
    const organization = await newOrganization();
    const idea = await publicIdea(organization.id);
    const ip = freshIp();
    // 6 firmas previas de la misma red en 10 minutos (cuentas y dispositivos distintos): la siguiente es una ráfaga.
    for (let index = 0; index < 6; index += 1) await signIdeaForRequest({ db, hmacSecret: SECRET }, { orgSlug: organization.slug, ideaId: idea.id }, { userId: (await createUser(db)).id, ip }, NOW);
    const burst = await signIdeaForRequest({ db, hmacSecret: SECRET }, { orgSlug: organization.slug, ideaId: idea.id }, { userId: (await createUser(db)).id, ip }, NOW);
    expect(burst).toMatchObject({ status: 'SIGNED', verified: false, reasonKey: 'ideas.audit.ipBurst' });
  });
});

describe('tipos de mejora del buzón', () => {
  it('son las categorías globales más las propias de la entidad, sin repetir nombres y sin taquilla y rifas; una idea puede usar cualquiera de las dos', async () => {
    const globalName = uniqueId('Global');
    await db.globalCategory.create({ data: { name: globalName, icon: '🌍', sortOrder: 99 } });
    await db.globalCategory.upsert({ where: { name: 'Taquilla y Rifas' }, create: { name: 'Taquilla y Rifas', icon: '🎟️', rule: 'EXEMPT', sortOrder: 6 }, update: {} });
    const organization = await newOrganization();
    await db.organizationCategory.create({ data: { organizationId: organization.id, name: globalName, icon: '🏠' } });
    const { listIdeaCategoryOptions } = await import('@/repositories/ideas-public.repository');
    const options = await listIdeaCategoryOptions(db, organization.id);
    const names = options.map((option: { name: string }) => option.name);
    expect(names).toContain(globalName);
    expect(names.filter((name: string) => name === globalName)).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(['Patios y Deporte', 'Cultura']));
    expect(names).not.toContain('Taquilla y Rifas');
    const author = await createUser(db);
    const proposed = await proposeIdea(db, { userId: author.id, payload: proposal(organization.slug, { category: globalName }), systemMessage: SYSTEM_MESSAGE }, NOW);
    expect(proposed.alias).toMatch(/^#FAM-/);
  });
});

describe('lectura pública del buzón', () => {
  it('solo salen las ideas que recogen firmas dentro de plazo y las que esperan la doble firma, de esa entidad, sin datos internos', async () => {
    const organization = await newOrganization();
    const other = await newOrganization();
    const open = await publicIdea(organization.id, { title: 'Abierta' });
    const waiting = await publicIdea(organization.id, { title: 'Con quórum', phase: 'DOUBLE_CHECK', verifiedVotes: 30, suspiciousVotes: 4 });
    await publicIdea(organization.id, { title: 'En revisión', phase: 'PHASE0_MOD' });
    await publicIdea(organization.id, { title: 'Rechazada', phase: 'REJECTED' });
    await publicIdea(organization.id, { title: 'Convertida', phase: 'CONVERTED' });
    await publicIdea(organization.id, { title: 'Caducada', expiresAt: new Date(NOW.getTime() - DAY) });
    await publicIdea(other.id, { title: 'De otra entidad' });

    const rows = await listPublicIdeas(db, organization.slug, NOW);
    expect(rows.map((row) => row.title)).toEqual(['Abierta', 'Con quórum']);
    expect(rows.map((row) => row.id)).toEqual([open.id, waiting.id]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['alias', 'category', 'createdAt', 'description', 'expiresAt', 'id', 'phase', 'title', 'verifiedVotes']);
    }
    expect(await listPublicIdeas(db, 'no-existe', NOW)).toEqual([]);
  });

  it('«ya has firmado» reconoce la firma por cuenta, por email canónico y por la marca que deja una supresión; y al autor', async () => {
    const organization = await newOrganization();
    const person = await createUser(db);
    const bySignature = await publicIdea(organization.id);
    const byMarker = await publicIdea(organization.id);
    const authored = await publicIdea(organization.id, { authorCanonicalEmail: person.canonicalEmail });
    const untouched = await publicIdea(organization.id);
    await signIdea(db, SECRET, { ideaId: bySignature.id, userId: person.id }, NOW);
    await db.ideaSignatureAudit.create({ data: { ideaId: byMarker.id, canonicalEmail: ideaSignerMarker(SECRET, person.canonicalEmail), reason: 'ideas.audit.firstAccount' } });

    const signed = await listIdeaIdsSignedBy(db, organization.slug, { userId: person.id, email: person.email, formerMarker: (canonicalEmail) => ideaSignerMarker(SECRET, canonicalEmail) });
    expect([...signed].sort()).toEqual([bySignature.id, byMarker.id, authored.id].sort());
    expect(signed.has(untouched.id)).toBe(false);
    // Otra persona no ve nada firmado, ni en la entidad ajena.
    const stranger = await createUser(db);
    expect((await listIdeaIdsSignedBy(db, organization.slug, { userId: stranger.id, email: stranger.email, formerMarker: (c) => ideaSignerMarker(SECRET, c) })).size).toBe(0);
  });
});

describe('firmar una idea desde la petición', () => {
  const context = (userId: string | null, ip: string | null = freshIp()) => ({ userId, ip });

  it('sin sesión pide entrar; una idea de otra entidad responde NOT_FOUND como si no existiera', async () => {
    const organization = await newOrganization();
    const other = await newOrganization();
    const idea = await publicIdea(other.id);
    const person = await createUser(db);
    const deps = { db, hmacSecret: SECRET };
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, context(null), NOW)).toEqual({ status: 'LOGIN_REQUIRED' });
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, context(person.id), NOW)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: 999_999_999 }, context(person.id), NOW)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: 'uno' }, context(person.id), NOW)).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await db.ideaSignatureAudit.count({ where: { ideaId: idea.id } })).toBe(0);
  });

  it('regla padre y madre: 1ª y 2ª cuenta del dispositivo suman, la 3ª se registra pero no suma al quórum; firmar dos veces no suma', async () => {
    const organization = await newOrganization({ minVotes: 30 });
    const idea = await publicIdea(organization.id);
    const [madre, padre, tercera] = [await createUser(db), await createUser(db), await createUser(db)];
    const deps = { db, hmacSecret: SECRET };
    const ip = freshIp();
    const first = await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, { userId: madre.id, ip }, NOW);
    expect(first).toMatchObject({ status: 'SIGNED', verified: true, accountOrder: 1, quorumReached: false });
    const cookie = first.status === 'SIGNED' ? (first.newDeviceCookie ?? undefined) : undefined;
    expect(cookie).toBeTruthy();
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, { userId: padre.id, ip, deviceCookie: cookie }, NOW)).toMatchObject({ status: 'SIGNED', verified: true, accountOrder: 2 });
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, { userId: tercera.id, ip, deviceCookie: cookie }, NOW)).toMatchObject({ status: 'SIGNED', verified: false, accountOrder: 3, reasonKey: 'ideas.audit.tooManyAccounts' });
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, { userId: madre.id, ip, deviceCookie: cookie }, NOW)).toEqual({ status: 'ALREADY_SIGNED' });
    expect(await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).toMatchObject({ votes: 4, verifiedVotes: 3, suspiciousVotes: 1 });
    // En público solo se ve el recuento verificado.
    expect((await listPublicIdeas(db, organization.slug, NOW))[0]?.verifiedVotes).toBe(3);
  });

  it('al llegar al mínimo de firmas verificadas pasa a la doble firma', async () => {
    const organization = await newOrganization({ minVotes: 2 });
    const idea = await publicIdea(organization.id);
    const person = await createUser(db);
    const outcome = await signIdeaForRequest({ db, hmacSecret: SECRET }, { orgSlug: organization.slug, ideaId: idea.id }, context(person.id), NOW);
    expect(outcome).toMatchObject({ status: 'SIGNED', quorumReached: true });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('DOUBLE_CHECK');
    // Cerrada: ya no admite más firmas.
    const late = await createUser(db);
    expect(await signIdeaForRequest({ db, hmacSecret: SECRET }, { orgSlug: organization.slug, ideaId: idea.id }, context(late.id), NOW)).toEqual({ status: 'REJECTED', reason: 'IDEA_CLOSED' });
  });

  it('email sin verificar o desechable no firma; el tope por persona frena una avalancha', async () => {
    const organization = await newOrganization();
    const idea = await publicIdea(organization.id);
    const deps = { db, hmacSecret: SECRET };
    const unverified = await createUser(db, { emailVerified: false });
    expect(await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, context(unverified.id), NOW)).toEqual({ status: 'REJECTED', reason: 'EMAIL_NOT_VERIFIED' });
    const flooder = await createUser(db);
    let limited = 0;
    for (let index = 0; index < IDEA_SIGN_RULE.limit + 3; index += 1) {
      const outcome = await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: 999_999_999 }, context(flooder.id), NOW);
      if (outcome.status === 'REJECTED' && outcome.reason === 'RATE_LIMITED') limited += 1;
    }
    expect(limited).toBe(3);
  });

  it('sin IP válida del proxy se abre una alerta de operación (una sola, que cuenta las repeticiones y no lleva datos personales)', async () => {
    const organization = await newOrganization();
    const idea = await publicIdea(organization.id);
    const deps = { db, hmacSecret: SECRET };
    const before = (await db.opsAlert.findUnique({ where: { dedupeKey: 'trusted-ip-missing:idea.sign' } }))?.occurrences ?? 0;
    const person = await createUser(db);
    await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, { userId: person.id, ip: null }, NOW);
    await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: 999_999_999 }, { userId: person.id, ip: null }, NOW);
    const alert = await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'trusted-ip-missing:idea.sign' } });
    expect(alert).toMatchObject({ type: 'TRUSTED_IP_MISSING', status: 'OPEN', targetType: 'Route' });
    expect(alert.occurrences).toBe(before === 0 ? 1 : before + 1);
    expect(JSON.stringify(alert.detailJson)).not.toContain(person.email);
  });

  it('la huella solo se guarda con el consentimiento dado al firmar, queda registrado y retirarlo la borra', async () => {
    const organization = await newOrganization();
    const [withConsent, without] = [await createUser(db), await createUser(db)];
    const [ideaA, ideaB] = [await publicIdea(organization.id), await publicIdea(organization.id)];
    const deps = { db, hmacSecret: SECRET };
    const fingerprint = 'a'.repeat(64);

    await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: ideaA.id, fingerprint }, context(without.id), NOW);
    expect(await db.device.count({ where: { accounts: { some: { userId: without.id } }, fingerprintHmac: { not: null } } })).toBe(0);
    expect(await db.consentRecord.count({ where: { userId: without.id } })).toBe(0);

    await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: ideaB.id, fingerprint, fingerprintConsent: true }, context(withConsent.id), NOW);
    const consent = await db.consentRecord.findFirstOrThrow({ where: { userId: withConsent.id, purpose: 'DEVICE_FINGERPRINT' } });
    expect(consent).toMatchObject({ granted: true, source: 'buzon', policyVersion: '2026-11-01' });
    const device = await db.device.findFirstOrThrow({ where: { accounts: { some: { userId: withConsent.id } } } });
    expect(device.fingerprintHmac).toBe(dataHmac(SECRET, 'device-fingerprint', fingerprint));
    expect(device.fingerprintHmac).not.toContain(fingerprint);

    const { recordConsent } = await import('@/core/privacy/consents');
    await recordConsent(db, { userId: withConsent.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: '2026-11-01', source: 'buzon' }, NOW);
    expect((await db.device.findUniqueOrThrow({ where: { id: device.id } })).fingerprintHmac).toBeNull();
  });

  it('quien suprimió su cuenta y vuelve con el mismo email no firma dos veces, pero solo si se usa el mismo secreto (DATA_HMAC_SECRET) en la firma y en la supresión', async () => {
    const organization = await newOrganization();
    const idea = await publicIdea(organization.id);
    const person = await createUser(db);
    await db.ideaSignatureAudit.create({ data: { ideaId: idea.id, canonicalEmail: ideaSignerMarker(SECRET, person.canonicalEmail), reason: 'ideas.audit.firstAccount' } });
    expect(await signIdeaForRequest({ db, hmacSecret: SECRET }, { orgSlug: organization.slug, ideaId: idea.id }, context(person.id), NOW)).toEqual({ status: 'ALREADY_SIGNED' });
    // Con otro secreto la marca no coincide y la protección deja de funcionar sin avisar: por eso la acción usa siempre `DATA_HMAC_SECRET`.
    const other = await signIdeaForRequest({ db, hmacSecret: 'otro-secreto-distinto-0123456789' }, { orgSlug: organization.slug, ideaId: idea.id }, context(person.id), NOW);
    expect(other.status).toBe('SIGNED');
  });
});

describe('fotos Antes / Después y agradecimiento', () => {
  let storage: MemoryStorage;
  let organization: Awaited<ReturnType<typeof newOrganization>>;
  let director: Awaited<ReturnType<typeof createUser>>;
  let reached: Awaited<ReturnType<typeof createInitiative>>;

  beforeAll(async () => {
    storage = new MemoryStorage();
    organization = await newOrganization();
    director = await createUser(db);
    reached = await createInitiative(db, organization.id, { status: 'GOAL_REACHED', raisedCents: 583_300, title: 'Toldos conseguidos' });
  });

  const asDirector = () => actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]);
  const photo = (overrides: Partial<Parameters<typeof publishAchievementPhoto>[3]> = {}) => ({ organizationId: organization.id, initiativeId: reached.id, slot: 'BEFORE' as const, bytes: jpegWithExif(6), declaredMimeType: 'image/jpeg', fileName: 'antes.jpg', noIdentifiableMinors: true, ...overrides });

  it('sin la confirmación de que no hay menores identificables no se sube nada', async () => {
    const stored = storage.size;
    await expect(publishAchievementPhoto(db, storage, asDirector(), photo({ noIdentifiableMinors: false }))).rejects.toMatchObject({ reason: 'CONFIRMATION_REQUIRED' });
    await expect(publishAchievementPhoto(db, storage, asDirector(), photo({ noIdentifiableMinors: undefined as unknown as boolean }))).rejects.toBeInstanceOf(AchievementPhotoRejectedError);
    expect(storage.size).toBe(stored);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: reached.id } })).beforeFileId).toBeNull();
  });

  it('la foto se publica sin ubicación, modelo ni autor (queda solo la orientación), en el cubo público, y la auditoría guarda la confirmación sin los metadatos', async () => {
    const original = jpegWithExif(6);
    for (const marker of SECRET_MARKERS) expect(containsText(original, marker)).toBe(true);
    const result = await publishAchievementPhoto(db, storage, asDirector(), photo());
    expect(result.removedMetadata).toEqual(['APP1', 'COM']);
    const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: result.fileId } });
    expect(asset).toMatchObject({ visibility: 'PUBLIC', purpose: 'INITIATIVE_BEFORE', organizationId: organization.id, uploadedById: director.id, mimeType: 'image/jpeg' });
    const stored = storage.readPublic(asset.bucket, asset.objectKey)!;
    for (const marker of SECRET_MARKERS) expect(containsText(stored.body, marker)).toBe(false);
    expect(containsText(stored.body, 'Maria')).toBe(false);
    expect(asset.sizeBytes).toBe(stored.body.length);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: reached.id } })).beforeFileId).toBe(asset.id);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'achievement.photo_published', targetId: String(reached.id) }, orderBy: { id: 'desc' } });
    expect(audit.organizationId).toBe(organization.id);
    expect(audit.metadataJson).toMatchObject({ slot: 'BEFORE', fileId: asset.id, noIdentifiableMinorsConfirmed: true, removedMetadata: ['APP1', 'COM'] });
    expect(JSON.stringify(audit.metadataJson)).not.toMatch(/GPS|Pixel|Maria/);
  });

  it('subir otra foto sustituye a la anterior, que deja de ser pública y se retira del cubo', async () => {
    const first = await publishAchievementPhoto(db, storage, asDirector(), photo({ slot: 'AFTER' }));
    const firstAsset = await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } });
    const second = await publishAchievementPhoto(db, storage, asDirector(), photo({ slot: 'AFTER' }));
    expect(second.fileId).not.toBe(first.fileId);
    expect((await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } })).deletedAt).not.toBeNull();
    expect(storage.has(firstAsset.bucket, firstAsset.objectKey)).toBe(false);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: reached.id } })).afterFileId).toBe(second.fileId);
    expect(await getPublicImageFile(db, first.fileId)).toBeNull();
    // Sprint 4.4a: con la campaña aún sin liquidar (GOAL_REACHED) la foto no se sirve a nadie; al cerrarse, sí.
    expect(await getPublicImageFile(db, second.fileId)).toBeNull();
    await db.initiative.update({ where: { id: reached.id }, data: { status: 'CLOSED' } });
    expect(await getPublicImageFile(db, second.fileId)).toMatchObject({ id: second.fileId, mimeType: 'image/jpeg' });
    await db.initiative.update({ where: { id: reached.id }, data: { status: 'GOAL_REACHED' } });
  });

  it('rechaza lo que no es una imagen, una imagen corrupta, un tipo que no coincide y una iniciativa que no admite fotos', async () => {
    await expect(publishAchievementPhoto(db, storage, asDirector(), photo({ bytes: Uint8Array.from(Buffer.from('%PDF-1.7 documento')), declaredMimeType: 'application/pdf', fileName: 'x.pdf' }))).rejects.toMatchObject({ reason: 'UNREADABLE_IMAGE' });
    await expect(publishAchievementPhoto(db, storage, asDirector(), photo({ bytes: jpegWithExif(1).slice(0, 25) }))).rejects.toMatchObject({ reason: 'UNREADABLE_IMAGE' });
    await expect(publishAchievementPhoto(db, storage, asDirector(), photo({ declaredMimeType: 'image/png' }))).rejects.toBeInstanceOf(FileRejectedError);
    const draft = await createInitiative(db, organization.id, { status: 'BUDGETING' });
    await expect(publishAchievementPhoto(db, storage, asDirector(), photo({ initiativeId: draft.id }))).rejects.toMatchObject({ reason: 'INITIATIVE_NOT_EDITABLE' });
  });

  it('solo quien firma en la entidad, con segundo factor: otra entidad, familias y Super-Admin sin cargo reciben 403; una iniciativa de otra entidad, 404', async () => {
    const other = await newOrganization();
    const otherDirector = await createUser(db);
    const family = await createUser(db);
    const foreign = await createInitiative(db, other.id, { status: 'GOAL_REACHED' });
    const stored = storage.size;
    const attempt = (actor: SessionActor, overrides = {}) => publishAchievementPhoto(db, storage, actor, photo(overrides));

    await expect(attempt(actorFor(otherDirector.id, [{ organizationId: other.id, role: 'DIRECTOR' }]))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(attempt(actorFor(family.id))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(attempt({ kind: 'anonymous', requestMeta: {} } as SessionActor)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(attempt(actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }], { isSuperadmin: true, memberships: [] }))).rejects.toBeInstanceOf(TenantAccessError);
    // Miembro de la entidad A pidiendo la iniciativa de la B a través de A: igual que si no existiera.
    await expect(attempt(asDirector(), { initiativeId: foreign.id })).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(attempt(asDirector(), { initiativeId: 999_999_999 })).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(storage.size).toBe(stored);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: foreign.id } })).beforeFileId).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'tenant.access_denied', organizationId: organization.id } })).toBeGreaterThan(0);
  });

  it('sin el segundo factor de esta sesión no se publica ni se escribe, aunque haya cargo, y queda auditado', async () => {
    const before = await db.auditLog.count({ where: { action: 'tenant.access_denied', organizationId: organization.id } });
    const stored = storage.size;
    const noSecondFactor = actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }], { secondFactor: false });
    await expect(publishAchievementPhoto(db, storage, noSecondFactor, photo())).rejects.toBeInstanceOf(TenantAccessError);
    await expect(saveThanksMessage(db, noSecondFactor, { organizationId: organization.id, initiativeId: reached.id, message: 'hola' })).rejects.toBeInstanceOf(TenantAccessError);
    expect(storage.size).toBe(stored);
    expect(await db.auditLog.count({ where: { action: 'tenant.access_denied', organizationId: organization.id } })).toBeGreaterThanOrEqual(before + 2);
  });

  it('dos subidas a la vez al mismo hueco dejan una sola foto pública viva (la otra se retira)', async () => {
    const isolated = await newOrganization();
    const owner = await createUser(db);
    const initiative = await createInitiative(db, isolated.id, { status: 'CLOSED' });
    const actor = actorFor(owner.id, [{ organizationId: isolated.id, role: 'DIRECTOR' }]);
    const upload = () => publishAchievementPhoto(db, storage, actor, { organizationId: isolated.id, initiativeId: initiative.id, slot: 'AFTER', bytes: jpegWithExif(1), declaredMimeType: 'image/jpeg', fileName: 'despues.jpg', noIdentifiableMinors: true });
    const results = await Promise.all([upload(), upload(), upload()]);
    const alive = await db.fileAsset.findMany({ where: { organizationId: isolated.id, purpose: 'INITIATIVE_AFTER', deletedAt: null } });
    expect(alive).toHaveLength(1);
    expect(alive[0]!.id).toBe((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).afterFileId);
    expect(results.map((result) => result.fileId)).toContain(alive[0]!.id);
    for (const asset of await db.fileAsset.findMany({ where: { organizationId: isolated.id, purpose: 'INITIATIVE_AFTER', deletedAt: { not: null } } })) expect(storage.has(asset.bucket, asset.objectKey)).toBe(false);
  });

  it('uploadFile limpia por sí mismo toda imagen pública: un logotipo con EXIF sale sin él, venga de donde venga', async () => {
    const { uploadFile } = await import('@/services/storage/file-asset.service');
    const asset = await uploadFile(db, storage, { purpose: 'ORG_LOGO', bytes: jpegWithExif(1), declaredMimeType: 'image/jpeg', fileName: 'logo.jpg', organizationId: organization.id, uploadedById: director.id });
    const stored = storage.readPublic(asset.bucket, asset.objectKey)!;
    for (const marker of SECRET_MARKERS) expect(containsText(stored.body, marker)).toBe(false);
    expect(asset.sizeBytes).toBe(stored.body.length);
    await expect(uploadFile(db, storage, { purpose: 'ORG_LOGO', bytes: jpegWithExif(1).slice(0, 25), declaredMimeType: 'image/jpeg', fileName: 'roto.jpg', organizationId: organization.id, uploadedById: director.id })).rejects.toBeInstanceOf(FileRejectedError);
  });

  it('el agradecimiento se limpia, se recorta y vacío lo quita; solo lo escribe quien firma en la entidad', async () => {
    const saved = await saveThanksMessage(db, asDirector(), { organizationId: organization.id, initiativeId: reached.id, message: '  ¡Gracias‮  a todas\n\nlas familias!  ' });
    expect(saved).toBe('¡Gracias a todas las familias!');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: reached.id } })).thanksMessage).toBe(saved);
    expect((await saveThanksMessage(db, asDirector(), { organizationId: organization.id, initiativeId: reached.id, message: 'x'.repeat(THANKS_MESSAGE_MAX + 50) })).length).toBe(THANKS_MESSAGE_MAX);
    expect(await saveThanksMessage(db, asDirector(), { organizationId: organization.id, initiativeId: reached.id, message: '   ' })).toBe('');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: reached.id } })).thanksMessage).toBeNull();
    await expect(saveThanksMessage(db, actorFor((await createUser(db)).id), { organizationId: organization.id, initiativeId: reached.id, message: 'hola' })).rejects.toBeInstanceOf(TenantAccessError);
  });

  it('los logros públicos son solo los de esa entidad (conseguidos o cerrados), y una foto solo si su fichero es público y no está borrado', async () => {
    const orgA = await newOrganization();
    const orgB = await newOrganization();
    const publicFile = await db.fileAsset.create({ data: { bucket: 'korum-public', objectKey: uniqueId('a/before'), visibility: 'PUBLIC', purpose: 'INITIATIVE_BEFORE', mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64), organizationId: orgA.id } });
    const privateFile = await db.fileAsset.create({ data: { bucket: 'korum-private', objectKey: uniqueId('a/kyb'), visibility: 'PRIVATE', purpose: 'KYB_DOCUMENT', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'b'.repeat(64), organizationId: orgA.id, retainUntil: new Date(NOW.getTime() + 365 * DAY) } });
    const deletedFile = await db.fileAsset.create({ data: { bucket: 'korum-public', objectKey: uniqueId('a/after'), visibility: 'PUBLIC', purpose: 'INITIATIVE_AFTER', mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'c'.repeat(64), organizationId: orgA.id, deletedAt: NOW } });
    const withPhotos = await createInitiative(db, orgA.id, { status: 'CLOSED', title: 'Cerrada con foto', thanksMessage: 'Gracias', beforeFileId: publicFile.id, afterFileId: deletedFile.id, closesAt: new Date(NOW.getTime() - DAY) });
    const withWrongFile = await createInitiative(db, orgA.id, { status: 'GOAL_REACHED', title: 'Conseguida con fichero privado', beforeFileId: privateFile.id });
    await createInitiative(db, orgA.id, { status: 'FUNDRAISING', title: 'Abierta' });
    await createInitiative(db, orgA.id, { status: 'REFUNDED', title: 'Devuelta' });
    await createInitiative(db, orgB.id, { status: 'CLOSED', title: 'De otra entidad' });

    const rows = await listPublicAchievements(db, orgA.slug);
    expect(rows.map((row) => row.title).sort()).toEqual(['Cerrada con foto', 'Conseguida con fichero privado']);
    expect(rows.find((row) => row.id === withPhotos.id)).toMatchObject({ beforeFileId: publicFile.id, afterFileId: null, thanksMessage: 'Gracias' });
    expect(rows.find((row) => row.id === withWrongFile.id)).toMatchObject({ beforeFileId: null, afterFileId: null });
    for (const row of rows) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['organizationId', 'costMatCents', 'walletEscrowId']));
    expect(await getPublicImageFile(db, privateFile.id)).toBeNull();
    expect(await getPublicImageFile(db, deletedFile.id)).toBeNull();
    expect(await listPublicAchievements(db, 'no-existe')).toEqual([]);
  });

  it('el panel de logros lo ven solo DIRECTOR y COSIGNER de esa entidad', async () => {
    const draft = await createInitiative(db, organization.id, { status: 'BUDGETING', title: 'En preparación' });
    const rows = await listAchievementWorkbench(db, asDirector(), organization.id);
    expect(rows.map((row) => row.id)).toContain(reached.id);
    expect(rows.map((row) => row.id)).not.toContain(draft.id);
    const other = await newOrganization();
    await expect(listAchievementWorkbench(db, asDirector(), other.id)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(listAchievementWorkbench(db, actorFor((await createUser(db)).id), organization.id)).rejects.toBeInstanceOf(TenantAccessError);
  });
});
