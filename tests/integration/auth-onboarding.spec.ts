import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistrationError, registerCommunity } from '@/core/onboarding/community-registration';
import { acceptInvitation, acceptInvitationWithSession, createInvitation, InvitationError, inspectInvitation, listPendingCosignerInvitations } from '@/core/onboarding/invitations';
import { bootstrapSuperadmin } from '@/core/onboarding/superadmin-bootstrap';
import { verifySuperadminSession } from '@/core/security/verified-actor';
import { createKorumAuth, type KorumAuth } from '@/lib/auth/auth-config';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import { listSigners } from '@/repositories/organization.repository';
import { secretFromTotpUri, totpCode } from '../support/totp';
import { createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, uniqueId } from './test-database';

/**
 * Autenticación por rol y alta autónoma (Sprint 3.2, QA-M02) contra PostgreSQL real, llamando a Better Auth como lo hace la aplicación.
 * Los enlaces y códigos se leen de la bandeja de salida, que es lo que recibiría la persona.
 */

let db: KorumPrismaClient;
let auth: KorumAuth;
const APP = 'http://localhost:3000';

beforeAll(async () => {
  db = createTestClient();
  auth = createKorumAuth({ db, secret: 'integration-better-auth-secret-0123456789', hmacSecret: TEST_HMAC_SECRET, baseURL: APP, production: false, dispatch: () => undefined });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.$disconnect();
});

let ipSequence = 10;
/** Cada prueba entra desde una red distinta: los límites por IP no se mezclan entre pruebas. */
const requestHeaders = (extra: Record<string, string> = {}) => new Headers({ 'x-forwarded-for': `198.51.100.${(ipSequence += 1) % 250}`, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', ...extra });
const email = (prefix = 'familia') => `${uniqueId(prefix).toLowerCase()}@colegio.example`;

async function lastPayload(to: string, templateKey: string) {
  const message = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: to, templateKey }, orderBy: { id: 'desc' } });
  const payload: Record<string, string | undefined> = { ...(message.payloadJson as Record<string, string>) };
  payload.locale = message.locale;
  return payload;
}

/** `enableTwoFactor` con TOTP devuelve la URI para la app; con el método por email no la trae. */
const totpUriOf = (enabled: { method: string } & Partial<{ totpURI: string }>) => {
  if (!enabled.totpURI) throw new Error('Se esperaba la URI TOTP');
  return enabled.totpURI;
};

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

async function signInWithMagicLink(address: string, callbackURL = '/') {
  const headers = requestHeaders();
  await auth.api.signInMagicLink({ body: { email: address, callbackURL }, headers });
  const { url } = await lastPayload(address, 'auth.magicLink');
  const token = new URL(url!).searchParams.get('token')!;
  const response = await auth.api.magicLinkVerify({ query: { token, callbackURL }, headers, asResponse: true });
  const session = await db.session.findFirstOrThrow({ where: { user: { email: address } }, orderBy: { createdAt: 'desc' } });
  return { response, session, cookie: cookieOf(response) };
}

describe('familias: enlace mágico y código por email', () => {
  it('el enlace crea la cuenta con su email canónico y su idioma, y la sesión guarda la IP solo como HMAC', async () => {
    const address = email();
    const { session } = await signInWithMagicLink(address, '/ca/');
    const user = await db.user.findUniqueOrThrow({ where: { email: address } });
    expect(user).toMatchObject({ canonicalEmail: address, locale: 'ca', emailVerified: true, isSuperadmin: false });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(session.ipAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(session.userAgent).toBe('Chrome/Windows');
    expect(session.reauthenticatedAt).not.toBeNull();
    expect(session.secondFactorVerifiedAt).toBeNull();
    // El enlace se escribió en la bandeja en el idioma de la página desde la que se pidió.
    expect((await lastPayload(address, 'auth.magicLink')).locale).toBe('ca');
  });

  it('el código por email abre sesión y marca la reautenticación; entrar actualiza la última actividad', async () => {
    const address = email();
    const old = new Date('2023-01-01T00:00:00Z');
    await createUser(db, { email: address, canonicalEmail: address, lastActiveAt: old });
    const headers = requestHeaders();
    await auth.api.sendVerificationOTP({ body: { email: address, type: 'sign-in' }, headers });
    const { code } = await lastPayload(address, 'auth.otp');
    await auth.api.signInEmailOTP({ body: { email: address, otp: code! }, headers });
    const user = await db.user.findUniqueOrThrow({ where: { email: address }, include: { sessions: true } });
    expect(user.lastActiveAt.getTime()).toBeGreaterThan(old.getTime());
    expect(user.sessions.at(-1)?.reauthenticatedAt).not.toBeNull();
    // En la base no queda el código en claro.
    const stored = await db.verification.findMany({ where: { identifier: { contains: address } } });
    expect(stored.every((row) => !row.value.includes(code!))).toBe(true);
  });

  it('rechaza una segunda cuenta con la misma bandeja y los dominios desechables', async () => {
    const local = uniqueId('laura').toLowerCase().replace(/[^a-z0-9]/g, '');
    await signInWithMagicLink(`${local}@gmail.com`);
    const headers = requestHeaders();
    await auth.api.signInMagicLink({ body: { email: `${local}+cole@gmail.com`, callbackURL: '/' }, headers });
    const { url } = await lastPayload(`${local}+cole@gmail.com`, 'auth.magicLink');
    const response = await auth.api.magicLinkVerify({ query: { token: new URL(url!).searchParams.get('token')!, callbackURL: '/' }, headers, asResponse: true });
    expect(response.headers.get('location') ?? '').toContain('KORUM_SAME_INBOX');
    expect(await db.user.count({ where: { email: `${local}+cole@gmail.com` } })).toBe(0);

    await auth.api.sendVerificationOTP({ body: { email: `${local}@mailinator.com`, type: 'sign-in' }, headers });
    const { code } = await lastPayload(`${local}@mailinator.com`, 'auth.otp');
    await expect(auth.api.signInEmailOTP({ body: { email: `${local}@mailinator.com`, otp: code! }, headers })).rejects.toMatchObject({ body: { code: 'KORUM_DISPOSABLE_EMAIL' } });
  });

  it('una cuenta suprimida (RGPD) no puede iniciar sesión', async () => {
    const address = email();
    await createUser(db, { email: address, canonicalEmail: address, gdprAnonymizedAt: new Date() });
    const headers = requestHeaders();
    await auth.api.sendVerificationOTP({ body: { email: address, type: 'sign-in' }, headers });
    expect(await db.outboxMessage.count({ where: { toAddress: address } })).toBe(0);
  });

  it('cada bandeja recibe como mucho 5 emails de acceso cada 15 minutos aunque se pidan desde muchas redes', async () => {
    const address = email();
    for (let attempt = 0; attempt < 7; attempt += 1) await auth.api.signInMagicLink({ body: { email: address, callbackURL: '/' }, headers: requestHeaders() });
    expect(await db.outboxMessage.count({ where: { toAddress: address } })).toBe(5);
  });

  it('el límite por red responde 429 y no borra los contadores de la portería ni de otras partes', async () => {
    const gateKey = `gate-pin:ip:999:${uniqueId('ip')}`;
    await db.rateLimit.create({ data: { id: gateKey, key: gateKey, count: 4, lastRequest: BigInt(Date.now() - 10 * 60_000) } });
    const headers = requestHeaders();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await auth.handler(new Request(`${APP}/api/auth/sign-in/magic-link`, { method: 'POST', headers: new Headers({ ...Object.fromEntries(headers), 'content-type': 'application/json', origin: APP }), body: JSON.stringify({ email: email(), callbackURL: '/' }) }));
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(await db.rateLimit.findUnique({ where: { key: gateKey } })).toMatchObject({ count: 4 });
    const authKeys = await db.rateLimit.findMany({ where: { key: { startsWith: 'auth:ip:' } }, select: { key: true } });
    expect(authKeys.every((row) => /^auth:ip:[0-9a-f]{64}$/.test(row.key))).toBe(true);
  });
});

function registration(overrides: Record<string, unknown> = {}) {
  const slug = uniqueId('cole').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  return {
    vertical: 'SCHOOL',
    name: 'CEIP Pruebas',
    provinceCode: '08',
    city: 'Sabadell',
    postalCode: '08201',
    legalName: 'AFA CEIP Pruebas',
    legalForm: 'PARENTS_ASSOCIATION',
    centerOwnership: 'PUBLIC',
    ley49: false,
    contentLocale: 'ca',
    publicIndexing: true,
    slug,
    director: { name: 'Carla Puig', email: email('direccion'), phone: '600 111 222', roleLabel: 'Dirección del centro', password: 'contraseña-larga-1' },
    cosigner: { name: 'Marta Soler', email: email('afa'), phone: '600 333 444', roleLabel: 'Presidencia del AFA' },
    representationDeclared: true,
    ...overrides
  };
}

const context = (sessionUserId: string | null = null) => ({ sessionUserId, locale: 'es' as const, appUrl: APP, hmacSecret: TEST_HMAC_SECRET, dispatch: () => undefined });

describe('alta autónoma de una entidad (QA-M02)', () => {
  it('crea la entidad con los cupos del motor de reglas, su curso, su hucha y su plantilla; la segunda firma queda invitada, sin cargo aún', async () => {
    await db.globalConfig.update({ where: { id: 'GLOBAL' }, data: { exemptLimitCents: 100_000 } });
    const input = registration();
    const result = await registerCommunity(db, input, context());
    const organization = await db.organization.findUniqueOrThrow({ where: { id: result.organizationId }, include: { members: { orderBy: { role: 'asc' } } } });
    expect(organization).toMatchObject({ slug: input.slug, exemptLimitCents: 100_000, exemptRemainingCents: 100_000, kybStatus: 'PENDING', city: 'Sabadell', postalCode: '08201', province: 'Barcelona', provinceCode: '08', contentLocale: 'ca', centerOwnership: 'PUBLIC' });
    expect(organization.quotaPeriod).toMatch(/^\d{4}-\d{4}$/);
    expect(organization.walletId).toMatch(/^WLT-ESC-[A-Z2-9]{6}$/);
    expect((organization.participationGroupsJson as Array<{ items: string[] }>).flatMap((cluster) => cluster.items)).toHaveLength(15);
    expect(organization.members.map((member) => [member.role, member.roleLabel])).toEqual([['DIRECTOR', 'Dirección del centro']]);
    expect(await listPendingCosignerInvitations(db, result.organizationId)).toMatchObject([{ roleLabel: 'Presidencia del AFA', expired: false }]);
    const director = await db.user.findUniqueOrThrow({ where: { id: result.directorUserId }, include: { accounts: true } });
    expect(director.emailVerified).toBe(false);
    expect(director.accounts[0]?.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(result.directorNeedsVerification).toBe(true);
    const invitation = await lastPayload(input.cosigner.email, 'auth.invitation');
    expect(invitation).toMatchObject({ organizationName: 'CEIP Pruebas', roleLabel: 'Presidencia del AFA', hours: 72 });
    expect(invitation.url).toMatch(/\/invitacion#t=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(await db.auditLog.count({ where: { action: 'organization.registered', targetId: result.organizationId } })).toBe(1);
  });

  it('un colegio público solo entra por su AMPA/AFA y un titular de colegio no marca la Ley 49', async () => {
    await expect(registerCommunity(db, registration({ legalForm: 'FOUNDATION' }), context())).rejects.toMatchObject({ failure: { code: 'INVALID', issues: ['PUBLIC_SCHOOL_NEEDS_PARENTS_ASSOCIATION'] } });
    await expect(registerCommunity(db, registration({ legalForm: 'SCHOOL_OWNER', centerOwnership: 'PRIVATE', ley49: true }), context())).rejects.toMatchObject({ failure: { code: 'INVALID', issues: ['SCHOOL_OWNER_NO_LEY49'] } });
    const club = await registerCommunity(db, registration({ vertical: 'SPORTS_CLUB', legalForm: 'SPORTS_ENTITY', centerOwnership: 'PUBLIC' }), context());
    expect(await db.organization.findUniqueOrThrow({ where: { id: club.organizationId } })).toMatchObject({ centerOwnership: 'NOT_APPLICABLE', vertical: 'SPORTS_CLUB' });
  });

  it('rechaza dos firmantes con la misma bandeja, una URL ocupada y una cuenta ajena para quien dirige', async () => {
    const local = uniqueId('pep').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sameInbox = registration({ director: { ...registration().director, email: `${local}@gmail.com` }, cosigner: { ...registration().cosigner, email: `${local}+afa@gmail.com` } });
    await expect(registerCommunity(db, sameInbox, context())).rejects.toMatchObject({ failure: { code: 'SAME_INBOX' } });

    const first = registration();
    await registerCommunity(db, first, context());
    await expect(registerCommunity(db, registration({ slug: first.slug }), context())).rejects.toMatchObject({ failure: { code: 'SLUG_TAKEN' } });

    const existing = await createUser(db);
    const taken = registration({ director: { ...registration().director, email: existing.email } });
    await expect(registerCommunity(db, taken, context())).rejects.toMatchObject({ failure: { code: 'DIRECTOR_EMAIL_IN_USE' } });
    // Con la sesión de esa misma cuenta sí: se le añade la contraseña, sin tocar sus datos.
    const own = await registerCommunity(db, registration({ director: { ...registration().director, email: existing.email } }), context(existing.id));
    expect(own).toMatchObject({ directorUserId: existing.id, directorNeedsVerification: false });
    await expect(registerCommunity(db, registration({ slug: 'admin' }), context())).rejects.toBeInstanceOf(RegistrationError);
    // Ni enlaces ni dominios en los textos que viajan en el email de invitación (anti-suplantación).
    for (const name of ['Entra en korum-ayuda.com', 'Visita https://x.example', 'Escribe a soporte@x.example']) {
      await expect(registerCommunity(db, registration({ name }), context())).rejects.toMatchObject({ failure: { code: 'INVALID', fields: ['name'] } });
    }
    await expect(registerCommunity(db, registration({ cosigner: { ...registration().cosigner, roleLabel: 'Ver www.x.example' } }), context())).rejects.toMatchObject({ failure: { code: 'INVALID', fields: ['cosigner.roleLabel'] } });
    // Un Super-Admin no puede ser quien dirige: la doble firma lo excluye.
    const admin = await createUser(db, { isSuperadmin: true });
    await expect(registerCommunity(db, registration({ director: { ...registration().director, email: admin.email } }), context(admin.id))).rejects.toMatchObject({ failure: { code: 'DIRECTOR_EMAIL_IN_USE' } });
  });

  it('la invitación de la cofirma va a la dirección de la cuenta que ya existe, no a un alias (+…) que busca la misma cuenta (auditoría del 5.4: quien abriera ese enlace se quedaría con una cuenta ajena)', async () => {
    const owner = await createUser(db);
    const [local, domain] = owner.email.split('@');
    const alias = `${local}+afa@${domain}`;
    const result = await registerCommunity(db, registration({ cosigner: { ...registration().cosigner, email: alias } }), context());
    expect(await db.outboxMessage.count({ where: { toAddress: alias } })).toBe(0);
    const message = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: owner.email, templateKey: 'auth.invitation' } });
    expect(message.userId).toBe(owner.id);
    expect(await listPendingCosignerInvitations(db, result.organizationId)).toHaveLength(1);
  });

  it('aceptar a la vez el rol de Super-Admin y ser dirección de una entidad con la misma cuenta no deja a la persona con los dos papeles', async () => {
    for (let round = 0; round < 4; round += 1) {
      const person = await createUser(db);
      const { token } = await createInvitation(db, { userId: person.id, organizationId: null, purpose: 'SUPERADMIN' });
      const registered = registerCommunity(db, registration({ director: { ...registration().director, email: person.email } }), context(person.id));
      const accepted = acceptInvitationWithSession(db, token, person.id);
      await Promise.allSettled([registered, accepted]);
      const [row, signs] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: person.id } }), db.organizationMember.count({ where: { userId: person.id, role: { in: ['DIRECTOR', 'COSIGNER'] } } })]);
      expect(row.isSuperadmin && signs > 0, `ronda ${round}`).toBe(false);
    }
  });
});

describe('firmantes: contraseña + TOTP, e invitación al cofirmante', () => {
  it('quien dirige verifica su email con un código, activa el TOTP y luego entra con contraseña + TOTP', async () => {
    const input = registration();
    await registerCommunity(db, input, context());
    const headers = requestHeaders();
    await auth.api.sendVerificationOTP({ body: { email: input.director.email, type: 'email-verification' }, headers });
    const { code } = await lastPayload(input.director.email, 'auth.otp');
    const verified = await auth.api.verifyEmailOTP({ body: { email: input.director.email, otp: code! }, headers, asResponse: true });
    let cookie = cookieOf(verified);
    expect(cookie).toContain('korum.session_token');

    const enabled = await auth.api.enableTwoFactor({ body: { password: input.director.password }, headers: new Headers({ ...Object.fromEntries(headers), cookie }) });
    const secret = secretFromTotpUri(totpUriOf(enabled));
    const confirmed = await auth.api.verifyTOTP({ body: { code: totpCode(secret) }, headers: new Headers({ ...Object.fromEntries(headers), cookie }), asResponse: true });
    expect(confirmed.status).toBe(200);
    cookie = cookieOf(confirmed);
    const user = await db.user.findUniqueOrThrow({ where: { email: input.director.email }, include: { sessions: true } });
    expect(user.twoFactorEnabled).toBe(true);
    expect(user.sessions.some((session) => session.secondFactorVerifiedAt !== null)).toBe(true);

    // Entrar con contraseña pide el segundo factor: la contraseña sola no abre sesión.
    const passwordOnly = await auth.api.signInEmail({ body: { email: input.director.email, password: input.director.password }, headers, asResponse: true });
    expect(await passwordOnly.json()).toMatchObject({ twoFactorRedirect: true });
    const challenge = cookieOf(passwordOnly);
    const before = await db.session.count({ where: { userId: user.id } });
    const second = await auth.api.verifyTOTP({ body: { code: totpCode(secret, Date.now() + 30_000) }, headers: new Headers({ ...Object.fromEntries(headers), cookie: challenge }), asResponse: true });
    expect(second.status).toBe(200);
    const latest = await db.session.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(before + 1);
    expect(latest.secondFactorVerifiedAt).not.toBeNull();
    const actor = await loadUserActor(db, user.id, undefined, { secondFactor: latest.secondFactorVerifiedAt !== null });
    expect(actor).toMatchObject({ kind: 'user', secondFactor: true, memberships: [expect.objectContaining({ role: 'DIRECTOR' })] });
  });

  it('la invitación fija la contraseña una sola vez, verifica el email y crea el cargo; no cambia la de una cuenta que ya la tiene', async () => {
    const input = registration();
    await registerCommunity(db, input, context());
    const { url } = await lastPayload(input.cosigner.email, 'auth.invitation');
    const token = url!.split('#t=')[1]!;
    expect(await inspectInvitation(db, token)).toMatchObject({ purpose: 'COSIGNER', email: input.cosigner.email, organizationName: 'CEIP Pruebas', roleLabel: 'Presidencia del AFA', hasPassword: false });
    await expect(acceptInvitation(db, token, 'corta')).rejects.toMatchObject({ reason: 'WEAK_PASSWORD' });
    const accepted = await acceptInvitation(db, token, 'otra-contraseña-larga');
    expect(await db.user.findUniqueOrThrow({ where: { email: input.cosigner.email } })).toMatchObject({ emailVerified: true });
    expect(await db.organizationMember.findFirst({ where: { userId: accepted.userId, role: 'COSIGNER' } })).toMatchObject({ roleLabel: 'Presidencia del AFA' });
    await expect(acceptInvitation(db, token, 'otra-contraseña-larga')).rejects.toBeInstanceOf(InvitationError);
    expect(await inspectInvitation(db, `${token.split('.')[0]}.manipulado`)).toBeNull();
    const signedIn = await auth.api.signInEmail({ body: { email: input.cosigner.email, password: 'otra-contraseña-larga' }, headers: requestHeaders() });
    expect(signedIn.user.email).toBe(input.cosigner.email);
  });

  it('una cuenta existente con contraseña no pasa a firmar hasta aceptar con su propia sesión', async () => {
    const existing = await createUser(db, { name: 'Nombre real de la cuenta' });
    await db.account.create({ data: { id: uniqueId('acc'), userId: existing.id, accountId: existing.id, providerId: 'credential', password: 'hash-de-prueba' } });
    const input = registration({ cosigner: { ...registration().cosigner, email: existing.email, name: 'Nombre tecleado' } });
    const result = await registerCommunity(db, input, context());
    expect(await db.organizationMember.count({ where: { userId: existing.id } })).toBe(0);
    // El panel muestra el nombre que se escribió en el alta, nunca el de la cuenta ajena (I4).
    const directorActor = await loadUserActor(db, result.directorUserId, undefined, { secondFactor: true });
    const listed = await listSigners(db, directorActor, result.organizationId);
    expect(listed.find((signer) => signer.status === 'INVITED')).toMatchObject({ name: 'Nombre tecleado', roleLabel: 'Presidencia del AFA' });
    expect(JSON.stringify(listed)).not.toContain('Nombre real de la cuenta');
    const token = (await lastPayload(existing.email, 'auth.invitation')).url!.split('#t=')[1]!;
    expect(await inspectInvitation(db, token)).toMatchObject({ hasPassword: true });
    await expect(acceptInvitation(db, token, 'una-contraseña-nueva')).rejects.toMatchObject({ reason: 'HAS_PASSWORD' });
    const intruder = await createUser(db);
    await expect(acceptInvitationWithSession(db, token, intruder.id)).rejects.toMatchObject({ reason: 'WRONG_ACCOUNT' });
    await acceptInvitationWithSession(db, token, existing.id);
    expect(await db.organizationMember.findFirst({ where: { userId: existing.id, organizationId: result.organizationId } })).toMatchObject({ role: 'COSIGNER' });
    expect(await listPendingCosignerInvitations(db, result.organizationId)).toEqual([]);
  });

  it('quien solo controla el correo no puede cambiar ni saltarse el 2FA de un firmante (auditoría del 3.2, B1 e I1)', async () => {
    const input = registration();
    await registerCommunity(db, input, context());
    const headers = requestHeaders();
    await auth.api.sendVerificationOTP({ body: { email: input.director.email, type: 'email-verification' }, headers });
    const owner = cookieOf(await auth.api.verifyEmailOTP({ body: { email: input.director.email, otp: (await lastPayload(input.director.email, 'auth.otp')).code! }, headers, asResponse: true }));
    const enabled = await auth.api.enableTwoFactor({ body: { password: input.director.password }, headers: new Headers({ ...Object.fromEntries(headers), cookie: owner }) });
    await auth.api.verifyTOTP({ body: { code: totpCode(secretFromTotpUri(totpUriOf(enabled))) }, headers: new Headers({ ...Object.fromEntries(headers), cookie: owner }) });

    // El atacante restablece la contraseña con un código del correo y abre sesión con un enlace mágico.
    const attacker = requestHeaders();
    await auth.api.requestPasswordResetEmailOTP({ body: { email: input.director.email }, headers: attacker });
    await auth.api.resetPasswordEmailOTP({ body: { email: input.director.email, otp: (await lastPayload(input.director.email, 'auth.otp')).code!, password: 'contraseña-del-atacante' }, headers: attacker });
    await auth.api.signInMagicLink({ body: { email: input.director.email, callbackURL: '/' }, headers: attacker });
    const link = new URL((await lastPayload(input.director.email, 'auth.magicLink')).url!);
    const session = cookieOf(await auth.api.magicLinkVerify({ query: { token: link.searchParams.get('token')!, callbackURL: '/' }, headers: attacker, asResponse: true }));
    const as = (path: string, body: unknown) => auth.handler(new Request(`${APP}/api/auth${path}`, { method: 'POST', headers: new Headers({ ...Object.fromEntries(attacker), cookie: session, 'content-type': 'application/json', origin: APP }), body: JSON.stringify(body) }));
    // Las rutas que darían el secreto, códigos nuevos o quitarían el 2FA no existen; volver a activarlo exige el TOTP de esta sesión.
    for (const path of ['/two-factor/get-totp-uri', '/two-factor/generate-backup-codes', '/two-factor/disable']) expect((await as(path, { password: 'contraseña-del-atacante' })).status, path).toBe(404);
    const reEnable = await as('/two-factor/enable', { password: 'contraseña-del-atacante' });
    expect(reEnable.status).toBe(403);
    expect(await reEnable.json()).toMatchObject({ code: 'KORUM_SECOND_FACTOR_REQUIRED' });
    expect((await as('/two-factor/enable', { password: 'contraseña-del-atacante', method: 'otp' })).status).toBe(400);
    // Probar códigos al azar: a los 8 fallos seguidos se bloquea y se cierran las sesiones sin segundo factor.
    const user = await db.user.findUniqueOrThrow({ where: { email: input.director.email } });
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await as('/two-factor/verify-totp', { code: '000000' })).status).not.toBe(200);
    expect(await db.session.count({ where: { userId: user.id, secondFactorVerifiedAt: null } })).toBe(0);
  });

  it('el alta del primer Super-Admin rechaza una cuenta que ya firma por una entidad (la doble firma excluye siempre al Super-Admin) y no le da el rol', async () => {
    const organization = await createOrganization(db);
    const signer = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: signer.id, role: 'DIRECTOR' } });
    const rollback = new Error('rollback de la prueba');
    await expect(
      db.$transaction(async (tx) => {
        // Sin ningún Super-Admin en esta transacción (se deshace al final): la base compartida puede tener otros.
        await tx.user.updateMany({ where: { isSuperadmin: true }, data: { isSuperadmin: false } });
        expect(await bootstrapSuperadmin(tx, { email: signer.email, appUrl: APP, hmacSecret: TEST_HMAC_SECRET, dispatch: () => undefined })).toBe('ACCOUNT_SIGNS');
        expect(await tx.user.count({ where: { id: signer.id, isSuperadmin: true } })).toBe(0);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it('el primer Super-Admin se invita una sola vez y su sesión verificada da el actor de la consola', async () => {
    const existing = await db.user.count({ where: { isSuperadmin: true, gdprAnonymizedAt: null } });
    const address = email('superadmin');
    const outcome = await bootstrapSuperadmin(db, { email: address, appUrl: APP, hmacSecret: TEST_HMAC_SECRET, dispatch: () => undefined });
    if (existing > 0) {
      expect(outcome).toBe('ALREADY_EXISTS');
      return;
    }
    expect(outcome).toBe('INVITED');
    expect(await bootstrapSuperadmin(db, { email: email('otro'), appUrl: APP, hmacSecret: TEST_HMAC_SECRET, dispatch: () => undefined })).toBe('ALREADY_EXISTS');
    const { url } = await lastPayload(address, 'auth.invitation');
    await acceptInvitation(db, url!.split('#t=')[1]!, 'contraseña-de-la-consola');
    const headers = requestHeaders();
    const first = await auth.api.signInEmail({ body: { email: address, password: 'contraseña-de-la-consola' }, headers, asResponse: true });
    const cookie = cookieOf(first);
    const enabled = await auth.api.enableTwoFactor({ body: { password: 'contraseña-de-la-consola' }, headers: new Headers({ ...Object.fromEntries(headers), cookie }) });
    const confirmed = await auth.api.verifyTOTP({ body: { code: totpCode(secretFromTotpUri(totpUriOf(enabled))) }, headers: new Headers({ ...Object.fromEntries(headers), cookie }), asResponse: true });
    expect(confirmed.status).toBe(200);
    // Al activar el TOTP, Better Auth cambia la sesión por una nueva (la de la cookie que devuelve): esa es la que queda verificada.
    const admin = await db.user.findUniqueOrThrow({ where: { email: address } });
    const session = await db.session.findFirstOrThrow({ where: { userId: admin.id }, orderBy: { createdAt: 'desc' } });
    expect(session.secondFactorVerifiedAt).not.toBeNull();
    expect(cookieOf(confirmed)).toContain(session.token);
    await expect(verifySuperadminSession(db, { userId: admin.id, sessionId: session.id, operation: 'settings.update' })).resolves.toMatchObject({ kind: 'verified-superadmin' });
  });
});
