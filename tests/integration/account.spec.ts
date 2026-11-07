import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import es from '../../messages/es.json';
import { model182ReminderHandler } from '@/core/jobs/handlers/model182-reminder';
import type { JobDeps } from '@/core/jobs/job-types';
import { accountReauthIsFresh, markSessionReauthenticated, verifyAccountSession } from '@/core/security/verified-actor';
import { sealDonorTaxId } from '@/core/tax/tax-id-vault';
import type { Prisma } from '@/generated/prisma/client';
import { createKorumAuth, type KorumAuth } from '@/lib/auth/auth-config';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ACCOUNT_ERASURE_RULE, ACCOUNT_EXPORT_RULE } from '@/lib/rate-limit-rules';
import { findOwnDonationDocument, listDonationDocuments, loadAccountOverview } from '@/repositories/account.repository';
import { eraseOwnAccount, exportOwnData } from '@/services/account/account-privacy.service';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, testJobDeps, uniqueId } from './test-database';

/**
 * *Mi cuenta* (Sprint 3.7) contra PostgreSQL real: qué ve cada persona (y nunca lo de otra), la exportación y la supresión con su solicitud RGPD
 * y su límite de intentos (QA-PRIV01, QA-REG03), el aviso de enero a quien tiene certificado fiscal, y la guardia que exige una prueba de
 * identidad reciente para añadir una llave de acceso.
 */

let db: KorumPrismaClient;
let auth: KorumAuth;
const APP = 'http://localhost:3000';
const MINUTE = 60_000;
const mockSecrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-pruebas' };

beforeAll(async () => {
  db = createTestClient();
  auth = createKorumAuth({ db, secret: 'integration-better-auth-secret-0123456789', hmacSecret: TEST_HMAC_SECRET, baseURL: APP, production: false, dispatch: () => undefined });
});

afterAll(async () => {
  await db.outboxMessage.updateMany({ where: { templateKey: { in: ['tax.certificateReady', 'auth.otp', 'auth.magicLink'] }, status: 'PENDING', toAddress: { contains: 'cuenta-' } }, data: { status: 'CANCELLED' } });
  await db.$disconnect();
});

const translate = (path: string, values: Record<string, string> = {}) => {
  const text = path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es.privacy.export);
  return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '') : path;
};

async function verifiedAccount(userId: string, minutesAgo = 1) {
  const session = await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId, expiresAt: new Date(Date.now() + 60 * MINUTE) } });
  await markSessionReauthenticated(db, session.id, { secondFactor: false }, new Date(Date.now() - minutesAgo * MINUTE));
  return { session, actor: minutesAgo <= 10 ? await verifyAccountSession(db, { userId, sessionId: session.id, operation: 'test' }) : null };
}

async function community(overrides: Partial<Prisma.OrganizationUncheckedCreateInput> = {}) {
  const organization = await createOrganization(db, overrides);
  const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
  return { organization, initiative };
}

const contribution = (place: { organization: { id: string }; initiative: { id: number } }, data: Partial<Prisma.ContributionUncheckedCreateInput>) =>
  db.contribution.create({
    data: { organizationId: place.organization.id, initiativeId: place.initiative.id, fiscalYear: 2026, amountCents: 2_500, totalChargedCents: 2_500, paymentMethod: 'CARD', status: 'COMPLETED', paycometOrder: uniqueId('ORD'), ...data }
  });

const address = (prefix: string) => `${uniqueId(`cuenta-${prefix}`).toLowerCase()}@pruebas.example`;

describe('Mi cuenta · lo que ve cada persona', () => {
  it('ve sus aportaciones con la cuenta y, con el email verificado, las de invitada; nunca las de otra persona', async () => {
    const place = await community();
    const email = address('ana');
    const ana = await createUser(db, { email, canonicalEmail: email });
    const other = await createUser(db);
    const own = await contribution(place, { userId: ana.id, canonicalEmail: email });
    const asGuest = await contribution(place, { guestEmail: email, canonicalEmail: email, type: 'TICKET', ticketQuantity: 2 });
    const foreign = await contribution(place, { userId: other.id, canonicalEmail: other.canonicalEmail });
    await contribution(place, { userId: ana.id, canonicalEmail: email, status: 'FAILED' });

    const overview = await loadAccountOverview(db, ana.id);
    const ids = overview.contributions.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([own.id, asGuest.id]));
    expect(ids).not.toContain(foreign.id);
    // Un pago que nunca se completó no es una aportación.
    expect(overview.contributions.every((row) => row.status !== 'FAILED')).toBe(true);

    // Sin el email verificado, lo comprado como invitada con ese email no es suyo: podría ser de quien sí controla la bandeja.
    await db.user.update({ where: { id: ana.id }, data: { emailVerified: false } });
    expect((await loadAccountOverview(db, ana.id)).contributions.map((row) => row.id)).not.toContain(asGuest.id);
  });

  it('las entradas salen con su organización para el enlace firmado, y una anulada se marca', async () => {
    const place = await community();
    const email = address('pase');
    const holder = await createUser(db, { email, canonicalEmail: email });
    const bought = await contribution(place, { userId: holder.id, canonicalEmail: email, type: 'TICKET', ticketQuantity: 1 });
    await db.ticketPass.create({ data: { contributionId: bought.id, initiativeId: place.initiative.id, serialCode: uniqueId('TKT'), holderEmail: email, qrHmacSignature: 'firma', revokedAt: new Date() } });
    const [pass] = (await loadAccountOverview(db, holder.id)).passes;
    expect(pass).toMatchObject({ initiative: { organization: { slug: place.organization.slug } } });
    expect(pass!.revokedAt).not.toBeNull();
  });

  it('documentos: solo donaciones completadas y sin devolución; certificado con Ley 49 verificada y NIF; la de otra persona no existe', async () => {
    const certified = await community({ ley49: true, ley49VerifiedAt: new Date() });
    const plain = await community();
    const email = address('donante');
    const donor = await createUser(db, { email, canonicalEmail: email });
    const fiscal = { donorFullName: 'GARCÍA LÓPEZ, ANA', donorProvinceCode: '08', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) };
    const withCertificate = await contribution(certified, { userId: donor.id, canonicalEmail: email, isTaxDeductible: true, ...fiscal });
    const receipt = await contribution(plain, { userId: donor.id, canonicalEmail: email, fiscalYear: 2025 });
    await contribution(certified, { userId: donor.id, canonicalEmail: email, type: 'TICKET' });
    await contribution(certified, { userId: donor.id, canonicalEmail: email, refundedCents: 2_500, status: 'REFUNDED' });

    const years = await listDonationDocuments(db, donor.id);
    expect(years.map((year) => year.fiscalYear)).toEqual([2026, 2025]);
    expect(years.flatMap((year) => year.items).map((item) => [item.id, item.kind])).toEqual([
      [withCertificate.id, 'TAX_CERTIFICATE'],
      [receipt.id, 'NOMINATIVE_RECEIPT']
    ]);
    expect((await loadAccountOverview(db, donor.id)).documentCount).toBe(2);

    const stranger = await createUser(db);
    expect(await findOwnDonationDocument(db, stranger.id, withCertificate.id)).toBeNull();
    expect(await findOwnDonationDocument(db, donor.id, withCertificate.id)).toMatchObject({ id: withCertificate.id, donorFullName: 'GARCÍA LÓPEZ, ANA' });
  });

  it('una cuenta suprimida no tiene Mi cuenta', async () => {
    const gone = await createUser(db, { gdprAnonymizedAt: new Date() });
    await expect(loadAccountOverview(db, gone.id)).rejects.toThrow('suprimida');
  });
});

describe('QA-PRIV01 · exportar mis datos', () => {
  it('JSON y PDF de la propia persona, cada descarga con su solicitud EXPORT cerrada al momento', async () => {
    const place = await community();
    const email = address('exporta');
    const person = await createUser(db, { email, canonicalEmail: email, name: 'Lucía Exporta' });
    await contribution(place, { userId: person.id, canonicalEmail: email });
    const { actor } = await verifiedAccount(person.id);

    const json = await exportOwnData(db, { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { actor: actor!, format: 'json', locale: 'es', t: translate });
    expect(json.status).toBe('OK');
    if (json.status !== 'OK') return;
    const data = JSON.parse(new TextDecoder().decode(json.file.bytes)) as { account: { email: string }; contributions: unknown[] };
    expect(data.account.email).toBe(email);
    expect(data.contributions).toHaveLength(1);
    expect(json.file.fileName).toMatch(/^korum-mis-datos-\d{4}-\d{2}-\d{2}\.json$/);
    expect(json.file.fileName).not.toContain('exporta');

    const pdf = await exportOwnData(db, { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { actor: actor!, format: 'pdf', locale: 'es', t: translate });
    expect(pdf.status === 'OK' && new TextDecoder().decode(pdf.file.bytes.slice(0, 8))).toBe('%PDF-1.4');

    const requests = await db.privacyRequest.findMany({ where: { userId: person.id }, orderBy: { id: 'asc' } });
    expect(requests.map((request) => [request.type, request.status])).toEqual([
      ['EXPORT', 'COMPLETED'],
      ['EXPORT', 'COMPLETED']
    ]);
  });

  it('tope de descargas por persona al día, sin abrir más solicitudes', async () => {
    const person = await createUser(db);
    const { actor } = await verifiedAccount(person.id);
    await db.rateLimit.create({ data: { id: uniqueId('rl'), key: `${ACCOUNT_EXPORT_RULE.prefix}${person.id}`, count: ACCOUNT_EXPORT_RULE.limit, lastRequest: BigInt(Date.now()) } });
    expect(await exportOwnData(db, { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { actor: actor!, format: 'json', locale: 'es', t: translate })).toEqual({ status: 'RATE_LIMITED' });
    expect(await db.privacyRequest.count({ where: { userId: person.id } })).toBe(0);
  });

  it('la reautenticación caduca a los 10 minutos y preguntarlo no deja rastro en la auditoría', async () => {
    const person = await createUser(db);
    const { session } = await verifiedAccount(person.id, 2);
    expect(await accountReauthIsFresh(db, { userId: person.id, sessionId: session.id })).toBe(true);
    const stale = await verifiedAccount(person.id, 11);
    expect(await accountReauthIsFresh(db, { userId: person.id, sessionId: stale.session.id })).toBe(false);
    // La sesión de otra persona nunca vale.
    expect(await accountReauthIsFresh(db, { userId: (await createUser(db)).id, sessionId: session.id })).toBe(false);
    expect(await db.auditLog.count({ where: { actorUserId: person.id } })).toBe(0);
  });
});

describe('QA-REG03 · suprimir mi cuenta', () => {
  const deps = () => ({ paymentProvider: async () => new MockPaycometProvider({ secrets: mockSecrets }), keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET });

  it('suprime, conserva los datos fiscales declarables y cierra su solicitud ERASURE', async () => {
    const certified = await community({ ley49: true, ley49VerifiedAt: new Date() });
    const email = address('suprime');
    const person = await createUser(db, { email, canonicalEmail: email, name: 'Marta Suprime' });
    await contribution(certified, { userId: person.id, canonicalEmail: email, donorFullName: 'SUPRIME, MARTA', donorProvinceCode: '28', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) });
    const { actor } = await verifiedAccount(person.id);

    expect(await eraseOwnAccount(db, deps(), { actor: actor! })).toEqual({ status: 'ERASED', retainedFiscalRecords: 1 });
    const user = await db.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(user.email).not.toContain('suprime');
    expect(user.gdprAnonymizedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: person.id } })).toBe(0);
    expect(await db.privacyRequest.findFirstOrThrow({ where: { userId: person.id, type: 'ERASURE' } })).toMatchObject({ status: 'COMPLETED' });
  });

  it('quien firma por una entidad queda bloqueado: la solicitud se cierra como rechazada con el motivo, sin datos personales', async () => {
    const { organization } = await community();
    const signer = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: signer.id, role: 'DIRECTOR', roleLabel: 'Dirección del centro' } });
    const { actor } = await verifiedAccount(signer.id);
    expect(await eraseOwnAccount(db, deps(), { actor: actor! })).toEqual({ status: 'BLOCKED', reason: 'ACTIVE_SIGNER' });
    expect(await db.privacyRequest.findFirstOrThrow({ where: { userId: signer.id, type: 'ERASURE' } })).toMatchObject({ status: 'REJECTED', notes: 'bloqueo:ACTIVE_SIGNER' });
    expect((await db.user.findUniqueOrThrow({ where: { id: signer.id } })).gdprAnonymizedAt).toBeNull();
    expect((await loadAccountOverview(db, signer.id)).erasureBlock).toBe('ACTIVE_SIGNER');
  });

  it('tope de intentos por persona', async () => {
    const person = await createUser(db);
    const { actor } = await verifiedAccount(person.id);
    await db.rateLimit.create({ data: { id: uniqueId('rl'), key: `${ACCOUNT_ERASURE_RULE.prefix}${person.id}`, count: ACCOUNT_ERASURE_RULE.limit, lastRequest: BigInt(Date.now()) } });
    expect(await eraseOwnAccount(db, deps(), { actor: actor! })).toEqual({ status: 'RATE_LIMITED' });
    expect((await db.user.findUniqueOrThrow({ where: { id: person.id } })).gdprAnonymizedAt).toBeNull();
  });
});

describe('aviso de enero `tax.certificateReady`', () => {
  it('un email por persona y ejercicio a quien tiene certificado (cuenta o invitada), nunca a justificantes, devueltas ni cuentas suprimidas', async () => {
    const fiscalYear = 2040;
    const certifiedA = await community({ ley49: true, ley49VerifiedAt: new Date() });
    const certifiedB = await community({ ley49: true, ley49VerifiedAt: new Date() });
    const notVerified = await community({ ley49: true });
    const fiscal = () => ({ fiscalYear, donorFullName: 'APELLIDOS, NOMBRE', donorProvinceCode: '46', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) });

    const accountEmail = address('enero-cuenta');
    const withAccount = await createUser(db, { email: accountEmail, canonicalEmail: accountEmail, locale: 'ca' });
    await contribution(certifiedA, { userId: withAccount.id, canonicalEmail: accountEmail, ...fiscal() });
    await contribution(certifiedB, { userId: withAccount.id, canonicalEmail: accountEmail, ...fiscal() });
    const guestEmail = address('enero-invitada');
    await contribution(certifiedA, { guestEmail, canonicalEmail: guestEmail, locale: 'en', ...fiscal() });
    const receiptEmail = address('enero-justificante');
    await contribution(notVerified, { guestEmail: receiptEmail, canonicalEmail: receiptEmail, ...fiscal() });
    const refundedEmail = address('enero-devuelta');
    await contribution(certifiedA, { guestEmail: refundedEmail, canonicalEmail: refundedEmail, status: 'REFUNDED', refundedCents: 2_500, ...fiscal() });
    const erased = await createUser(db, { gdprAnonymizedAt: new Date() });
    await contribution(certifiedA, { userId: erased.id, canonicalEmail: erased.canonicalEmail, ...fiscal() });

    const deps: JobDeps = { ...testJobDeps(), paymentProvider: () => Promise.reject(new Error('no se usa')), invoicingProvider: () => { throw new Error('no se usa'); }, refundOriginalIp: async () => '10.0.0.1' };
    const run = () => model182ReminderHandler({ db, now: new Date(Date.UTC(fiscalYear + 1, 0, 2, 8)), batchSize: 2, deps });
    await run();
    await run();

    const sent = await db.outboxMessage.findMany({ where: { templateKey: 'tax.certificateReady', payloadJson: { equals: { fiscalYear } } }, orderBy: { id: 'asc' } });
    expect(sent.map((message) => [message.toAddress, message.locale, message.userId])).toEqual([
      [accountEmail, 'ca', withAccount.id],
      [guestEmail, 'en', null]
    ]);
    // La clave lleva el email solo como HMAC.
    expect(sent.every((message) => !message.idempotencyKey.includes('@'))).toBe(true);
  });
});

describe('llaves de acceso: añadir una exige una prueba de identidad reciente', () => {
  const registerOptions = (cookie: string) =>
    auth.handler(new Request(`${APP}/api/auth/passkey/generate-register-options`, { method: 'GET', headers: new Headers({ cookie, origin: APP, 'x-forwarded-for': '203.0.113.77' }) }));

  let ipSequence = 0;
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');

  /** Sesión real (enlace mágico, como en la aplicación) cuya última prueba de identidad fue hace `minutesAgo` minutos. */
  async function sessionCookie(email: string, proof: { minutesAgo: number; secondFactor: boolean }) {
    const headers = new Headers({ 'x-forwarded-for': `198.51.100.${200 + (ipSequence += 1)}`, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' });
    await auth.api.signInMagicLink({ body: { email, callbackURL: '/' }, headers });
    const message = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: email, templateKey: 'auth.magicLink' }, orderBy: { id: 'desc' } });
    const token = new URL((message.payloadJson as { url: string }).url).searchParams.get('token')!;
    const response = await auth.api.magicLinkVerify({ query: { token, callbackURL: '/' }, headers, asResponse: true });
    const session = await db.session.findFirstOrThrow({ where: { user: { email } }, orderBy: { createdAt: 'desc' } });
    const at = new Date(Date.now() - proof.minutesAgo * MINUTE);
    await db.session.update({ where: { id: session.id }, data: { reauthenticatedAt: at, secondFactorVerifiedAt: proof.secondFactor ? at : null } });
    return cookieOf(response);
  }

  it('familia con el código por email de hace 2 minutos: sí; de hace 20 minutos: no', async () => {
    const email = address('llave');
    await createUser(db, { email, canonicalEmail: email });
    expect((await registerOptions(await sessionCookie(email, { minutesAgo: 2, secondFactor: false }))).status).toBe(200);
    const stale = await registerOptions(await sessionCookie(email, { minutesAgo: 20, secondFactor: false }));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: 'KORUM_REAUTH_REQUIRED' });
  });

  it('cuenta con doble factor: el código por email no basta, hace falta el TOTP reciente de esta sesión', async () => {
    const email = address('llave-2fa');
    await createUser(db, { email, canonicalEmail: email, twoFactorEnabled: true });
    const emailOnly = await registerOptions(await sessionCookie(email, { minutesAgo: 1, secondFactor: false }));
    expect(emailOnly.status).toBe(403);
    expect(await emailOnly.json()).toMatchObject({ code: 'KORUM_SECOND_FACTOR_REQUIRED' });
    expect((await registerOptions(await sessionCookie(email, { minutesAgo: 1, secondFactor: true }))).status).toBe(200);
  });

  it('quien firma por una entidad sin 2FA activado no puede saltárselo con una llave registrada con el correo', async () => {
    const { organization } = await community();
    const email = address('llave-firmante');
    const signer = await createUser(db, { email, canonicalEmail: email });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: signer.id, role: 'COSIGNER', roleLabel: 'Presidencia del AMPA' } });
    const response = await registerOptions(await sessionCookie(email, { minutesAgo: 1, secondFactor: false }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'KORUM_TWO_FACTOR_SETUP_REQUIRED' });
  });

  it('confirmar con el código estando dentro cierra la sesión anterior de esa persona (no quedan sesiones de 30 días olvidadas)', async () => {
    const email = address('reauth');
    await createUser(db, { email, canonicalEmail: email });
    const cookie = await sessionCookie(email, { minutesAgo: 20, secondFactor: false });
    const [previous] = await db.session.findMany({ where: { user: { email } } });
    const headers = new Headers({ cookie, 'x-forwarded-for': `198.51.100.${200 + (ipSequence += 1)}`, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' });
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' }, headers });
    const message = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: email, templateKey: 'auth.otp' }, orderBy: { id: 'desc' } });
    await auth.api.signInEmailOTP({ body: { email, otp: (message.payloadJson as { code: string }).code }, headers });
    const sessions = await db.session.findMany({ where: { user: { email } } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).not.toBe(previous!.id);
    expect(Date.now() - sessions[0]!.reauthenticatedAt!.getTime()).toBeLessThan(MINUTE);
  });
});
