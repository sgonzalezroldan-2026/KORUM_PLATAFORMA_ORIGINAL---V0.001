import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dataRetentionPurgeHandler } from '@/core/jobs/handlers/data-retention-purge';
import type { JobDeps } from '@/core/jobs/job-types';
import { currentConsents, ConsentInputError, recordConsent } from '@/core/privacy/consents';
import { anonymizedEmailOf, erasePersonalData, ErasureBlockedError } from '@/core/privacy/erasure.service';
import { renderPersonalDataPdf } from '@/core/privacy/export-pdf';
import { buildPersonalDataExport, type ExportRequester } from '@/core/privacy/personal-data-export';
import { closePrivacyRequest, openPrivacyRequest, PrivacyRequestError } from '@/core/privacy/privacy-requests';
import { retryCardDeletions } from '@/core/privacy/retention-accounts';
import { createKeyring, CRYPTO_CONTEXT, openValue, sealParts, sealValue } from '@/core/security/crypto';
import { countPendingRotation, reencryptPlatformSecret, rotateEncryptedData } from '@/core/security/key-rotation';
import { signIdea } from '@/core/security/device-quorum.service';
import { markSessionReauthenticated, verifyAccountSession, verifySuperadminSession } from '@/core/security/verified-actor';
import { openDonorTaxId, openInvoiceRecipientTaxId, openSponsorTaxId, sealDonorTaxId, sealInvoiceRecipientTaxId, sealSponsorTaxId } from '@/core/tax/tax-id-vault';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadCardToken, tokenizeAndStoreCard } from '@/services/payments/card-tokens';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { PaymentProviderError } from '@/services/payments/payment-provider';
import { describeSecrets, getSecret, getSetting, invalidateSettingsCache, InvalidSettingError, SettingConflictError, updateSecret, updateSetting } from '@/services/settings/settings.service';
import { UnknownSettingError } from '@/services/settings/setting-definitions';
import { MemoryStorage } from '@/services/storage/memory-storage';
import es from '../../messages/es.json';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/** Sprint 2.5 · QA-SEC07 (ajustes cifrados), QA-PRIV01 (exportación), QA-PRIV02 (consentimientos y conservación) y QA-REG03 (supresión). */

let db: KorumPrismaClient;
const MINUTE = 60_000;
const DAY = 86_400_000;
const TOUCHED_SETTINGS = ['paycomet.serverIp', 'hucha.mode', 'hucha.walletProvider', 'platform.company', 'email.fromAddress'];
const TOUCHED_SECRETS = ['paycomet.apiKey', 'email.apiKey'];
const mockSecrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-pruebas' };

beforeAll(() => {
  db = createTestClient();
});

afterEach(() => invalidateSettingsCache());

afterAll(async () => {
  await db.platformSetting.deleteMany({ where: { key: { in: TOUCHED_SETTINGS } } });
  await db.platformSecret.deleteMany({ where: { key: { in: TOUCHED_SECRETS } } });
  await db.$disconnect();
});

/** Los ayudantes de `test-database` piden el cliente; dentro de una transacción tienen la misma forma. */
const asClient = (tx: Db) => tx as unknown as KorumPrismaClient;

const ROLLBACK = new Error('rollback de la prueba');
/** Ejecuta en una transacción que se deshace al final: la purga y la rotación recorren toda la base y no deben afectar a otras pruebas. */
async function inRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  await expect(db.$transaction(async (tx) => {
    await fn(tx);
    throw ROLLBACK;
  }, { timeout: 180_000, maxWait: 30_000 })).rejects.toBe(ROLLBACK);
}

const newSession = (userId: string) => db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId, expiresAt: new Date(Date.now() + 60 * MINUTE) } });

async function adminSession(overrides: { twoFactorEnabled?: boolean; isSuperadmin?: boolean; secondFactorMinutesAgo?: number } = {}) {
  const admin = await createUser(db, { isSuperadmin: overrides.isSuperadmin ?? true, twoFactorEnabled: overrides.twoFactorEnabled ?? true });
  const session = await newSession(admin.id);
  // Lo que hará la capa de sesión (Sprint 3.2) al comprobar el código TOTP.
  await markSessionReauthenticated(db, session.id, { secondFactor: true }, new Date(Date.now() - (overrides.secondFactorMinutesAgo ?? 1) * MINUTE));
  return { admin, session };
}

async function verifiedAdmin() {
  const { admin, session } = await adminSession();
  const actor = await verifySuperadminSession(db, { userId: admin.id, sessionId: session.id, operation: 'settings.update' });
  return { admin, actor, session };
}

/** Titular de la cuenta reautenticado con un código por email (sin segundo factor). */
async function verifiedAccount(userId: string) {
  const session = await newSession(userId);
  await markSessionReauthenticated(db, session.id, { secondFactor: false });
  return verifyAccountSession(db, { userId, sessionId: session.id, operation: 'privacy.export' });
}

describe('QA-SEC07 · secretos cifrados y ajustes auditados', () => {
  it('guardar un secreto: solo cifrado en la base, pista de 4 caracteres, auditoría sin el valor y uso inmediato sin reiniciar', async () => {
    const { admin, actor } = await verifiedAdmin();
    const fallbacks = { PAYCOMET_API_KEY: 'respaldo-del-entorno-0000', EMAIL_API_KEY: 'respaldo-email-0123456789' };
    expect(await getSecret(db, TEST_KEYRING, 'paycomet.apiKey', fallbacks)).toBe('respaldo-del-entorno-0000');

    expect(await updateSecret(db, actor, TEST_KEYRING, 'paycomet.apiKey', 'sk_test_primera_clave_0001')).toEqual({ hint: '0001' });
    const row = await db.platformSecret.findUniqueOrThrow({ where: { key: 'paycomet.apiKey' } });
    expect(row.ciphertext).not.toContain('primera');
    expect(row).toMatchObject({ keyVersion: 1, hint: '0001', updatedById: admin.id });
    // La consola gana al respaldo, y el valor nuevo se usa al momento aunque el anterior estuviera en caché.
    expect(await getSecret(db, TEST_KEYRING, 'paycomet.apiKey', fallbacks)).toBe('sk_test_primera_clave_0001');
    await updateSecret(db, actor, TEST_KEYRING, 'paycomet.apiKey', 'sk_test_segunda_clave_0002');
    expect(await getSecret(db, TEST_KEYRING, 'paycomet.apiKey', fallbacks)).toBe('sk_test_segunda_clave_0002');

    const audits = await db.auditLog.findMany({ where: { actorUserId: admin.id, action: 'settings.secret.updated' } });
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toMatch(/sk_test|primera|segunda|0001|0002/);

    const summary = await describeSecrets(db, ['paycomet.apiKey', 'email.apiKey', 'no.existe'], fallbacks);
    expect(summary).toEqual([
      expect.objectContaining({ key: 'paycomet.apiKey', configured: true, hint: '0002', usesEnvFallback: false }),
      expect.objectContaining({ key: 'email.apiKey', configured: true, hint: null, usesEnvFallback: true })
    ]);
    expect(JSON.stringify(summary)).not.toContain('sk_test');
  });

  it('la prueba del segundo factor se lee de la sesión: sin verificación reciente, con otra sesión o sin ser Super-Admin con 2FA, se rechaza', async () => {
    const attempt = (userId: string, sessionId: string) => verifySuperadminSession(db, { userId, sessionId, operation: 'settings.update' });
    const stale = await adminSession({ secondFactorMinutesAgo: 11 });
    await expect(attempt(stale.admin.id, stale.session.id)).rejects.toMatchObject({ reason: 'REAUTH_REQUIRED' });
    const future = await adminSession({ secondFactorMinutesAgo: -5 });
    await expect(attempt(future.admin.id, future.session.id)).rejects.toMatchObject({ reason: 'REAUTH_REQUIRED' });
    // Una sesión que solo se reautenticó con un código por email no vale para la consola.
    const emailOnly = await adminSession({ secondFactorMinutesAgo: 60 });
    await markSessionReauthenticated(db, emailOnly.session.id, { secondFactor: false });
    await expect(attempt(emailOnly.admin.id, emailOnly.session.id)).rejects.toMatchObject({ reason: 'REAUTH_REQUIRED' });
    await expect(attempt(stale.admin.id, future.session.id)).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
    await expect(attempt(stale.admin.id, 'no-existe')).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
    const noTwoFactor = await adminSession({ twoFactorEnabled: false });
    await expect(attempt(noTwoFactor.admin.id, noTwoFactor.session.id)).rejects.toMatchObject({ reason: 'TWO_FACTOR_REQUIRED' });
    const family = await adminSession({ isSuperadmin: false });
    await expect(attempt(family.admin.id, family.session.id)).rejects.toMatchObject({ reason: 'NOT_SUPERADMIN' });
    expect(await db.auditLog.count({ where: { actorUserId: stale.admin.id, action: 'tenant.access_denied', targetType: 'SuperadminSession' } })).toBe(3);

    // Un actor verificado caduca a los 10 minutos, y deja de valer en cuanto se cierra su sesión o la persona deja de ser Super-Admin.
    const expiring = await verifiedAdmin();
    await expect(updateSetting(db, expiring.actor, 'paycomet.serverIp', '203.0.113.7', { now: new Date(Date.now() + 11 * MINUTE) })).rejects.toMatchObject({ reason: 'REAUTH_REQUIRED' });
    const loggedOut = await verifiedAdmin();
    await db.session.delete({ where: { id: loggedOut.session.id } });
    await expect(updateSetting(db, loggedOut.actor, 'paycomet.serverIp', '203.0.113.7')).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
    const demoted = await verifiedAdmin();
    await db.user.update({ where: { id: demoted.admin.id }, data: { isSuperadmin: false } });
    await expect(updateSecret(db, demoted.actor, TEST_KEYRING, 'paycomet.apiKey', 'sk_test_no_deberia_entrar')).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
    expect(await db.platformSetting.findUnique({ where: { key: 'paycomet.serverIp' } })).toBeNull();
  });

  it('cada ajuste se valida, dos personas no se pisan y el valor se audita solo si no es personal', async () => {
    const { admin, actor } = await verifiedAdmin();
    await expect(updateSetting(db, actor, 'paycomet.serverIp', '300.0.0.1')).rejects.toBeInstanceOf(InvalidSettingError);
    expect(await updateSetting(db, actor, 'paycomet.serverIp', '203.0.113.7')).toEqual({ version: 1 });
    expect(await getSetting(db, 'paycomet.serverIp')).toBe('203.0.113.7');
    await expect(updateSetting(db, actor, 'paycomet.serverIp', '203.0.113.8', { expectedVersion: 0 })).rejects.toBeInstanceOf(SettingConflictError);
    expect(await updateSetting(db, actor, 'paycomet.serverIp', '203.0.113.8', { expectedVersion: 1 })).toEqual({ version: 2 });
    expect(await getSetting(db, 'paycomet.serverIp')).toBe('203.0.113.8');
    await expect(updateSetting(db, actor, 'nada.de.nada' as 'paycomet.serverIp', '1.1.1.1')).rejects.toBeInstanceOf(UnknownSettingError);

    // El monedero regulado solo con proveedor configurado (CUMPLIMIENTO §3).
    await expect(updateSetting(db, actor, 'hucha.mode', 'REGULATED_WALLET')).rejects.toThrow(/walletProvider/);
    await updateSetting(db, actor, 'hucha.walletProvider', 'proveedor-de-pruebas');
    await updateSetting(db, actor, 'hucha.mode', 'REGULATED_WALLET');
    expect(await getSetting(db, 'hucha.mode')).toBe('REGULATED_WALLET');

    await updateSetting(db, actor, 'platform.company', { legalName: 'KORUM Plataforma SL', taxId: 'B12345674', address: 'Calle Mayor 1, Madrid', supportEmail: 'hola@korum.example', privacyEmail: 'privacidad@korum.example' });
    const companyAudit = await db.auditLog.findFirstOrThrow({ where: { actorUserId: admin.id, targetId: 'platform.company' } });
    expect(JSON.stringify(companyAudit.metadataJson)).not.toMatch(/B12345674|korum\.example|Mayor/);
    const modeAudit = await db.auditLog.findFirstOrThrow({ where: { actorUserId: admin.id, targetId: 'hucha.mode' } });
    expect(modeAudit.metadataJson).toMatchObject({ version: 1, newSetting: 'REGULATED_WALLET' });

    // Un valor guardado que ya no pasa la validación no se usa en silencio.
    await db.platformSetting.upsert({ where: { key: 'email.fromAddress' }, create: { key: 'email.fromAddress', valueJson: 'no-es-un-email' }, update: { valueJson: 'no-es-un-email' } });
    invalidateSettingsCache();
    await expect(getSetting(db, 'email.fromAddress')).rejects.toBeInstanceOf(InvalidSettingError);
    expect(await getSetting(db, 'hucha.walletProvider')).toBe('proveedor-de-pruebas');
  });

  it('con la clave rotada, o solo con la versión cambiada, los secretos se siguen leyendo: los webhooks no se caen', async () => {
    await inRollback(async (tx) => {
      const sealed = sealParts(TEST_KEYRING, 'contraseña-de-notificaciones', CRYPTO_CONTEXT.platformSecret('paycomet.webhookSecret'));
      await tx.platformSecret.upsert({ where: { key: 'paycomet.webhookSecret' }, create: { key: 'paycomet.webhookSecret', ...sealed }, update: sealed });
      const newKey = randomBytes(32).toString('base64');
      invalidateSettingsCache();
      expect(await getSecret(tx, createKeyring({ version: 2, key: newKey }, [{ version: 1, key: TEST_KEYRING.keys.get(1)! }]), 'paycomet.webhookSecret', {})).toBe('contraseña-de-notificaciones');
      invalidateSettingsCache();
      expect(await getSecret(tx, createKeyring({ version: 7, key: TEST_KEYRING.keys.get(1)! }), 'paycomet.webhookSecret', {})).toBe('contraseña-de-notificaciones');
    });
  });
});

describe('QA-PRIV02 · consentimientos', () => {
  it('retirar la huella la borra al momento de todos los dispositivos de esa persona, y queda registrado', async () => {
    const person = await createUser(db);
    const neighbour = await createUser(db);
    const devices = await Promise.all([0, 1].map((index) => db.device.create({ data: { cookieIdHash: uniqueId(`cookie-${index}`), fingerprintHmac: uniqueId('huella') } })));
    for (const device of devices) await db.deviceAccount.create({ data: { deviceId: device.id, userId: person.id, canonicalEmail: person.canonicalEmail, accountOrder: 1 } });
    const neighbourDevice = await db.device.create({ data: { cookieIdHash: uniqueId('cookie-n'), fingerprintHmac: 'huella-ajena' } });
    await db.deviceAccount.create({ data: { deviceId: neighbourDevice.id, userId: neighbour.id, canonicalEmail: neighbour.canonicalEmail, accountOrder: 1 } });

    expect(await recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: '2026-11-05', source: 'buzon' })).toEqual({ changed: true });
    expect(await recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: '2026-11-05', source: 'cuenta' })).toEqual({ changed: true });
    expect(await db.device.count({ where: { id: { in: devices.map((device) => device.id) }, fingerprintHmac: { not: null } } })).toBe(0);
    expect((await db.device.findUniqueOrThrow({ where: { id: neighbourDevice.id } })).fingerprintHmac).toBe('huella-ajena');

    // Repetir el mismo estado no añade filas; el estado actual se lee del último registro.
    expect(await recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: '2026-11-05', source: 'cuenta' })).toEqual({ changed: false });
    expect(await db.consentRecord.count({ where: { userId: person.id } })).toBe(2);
    const state = await currentConsents(db, person.id);
    expect(state.find((entry) => entry.purpose === 'DEVICE_FINGERPRINT')).toMatchObject({ granted: false, policyVersion: '2026-11-05' });
    expect(state.find((entry) => entry.purpose === 'MARKETING_EMAILS')).toMatchObject({ granted: false, updatedAt: null });
    await expect(recordConsent(db, { userId: person.id, purpose: 'MARKETING_EMAILS', granted: true, policyVersion: 'v1', source: 'cuenta' })).rejects.toBeInstanceOf(ConsentInputError);
  });
});

async function contribution(organizationId: string, initiativeId: number, data: Record<string, unknown> = {}) {
  return db.contribution.create({ data: { organizationId, initiativeId, fiscalYear: 2026, amountCents: 2_500, totalChargedCents: 2_700, guaranteeContributionCents: 200, paymentMethod: 'CARD', status: 'COMPLETED', paycometOrder: uniqueId('ORD'), ...data } });
}

const translate = (path: string, values: Record<string, string> = {}) => {
  const text = path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es.privacy.export);
  return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '') : path;
};

describe('QA-PRIV01 · exportación de datos personales', () => {
  it('incluye cuenta, aportaciones (también como invitada), entradas y consentimientos, con el NIF descifrado; la solicitud queda registrada', async () => {
    const person = await createUser(db, { name: 'Marta Puig' });
    const nif = sealValue(TEST_KEYRING, '12345678Z', CRYPTO_CONTEXT.userTaxId(person.id));
    await db.user.update({ where: { id: person.id }, data: { nifEnc: nif.sealed, nifKeyVersion: nif.keyVersion } });
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id);
    await contribution(organization.id, initiative.id, { userId: person.id, donorFullName: 'Marta Puig', donorProvinceCode: '08', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) });
    const asGuest = await contribution(organization.id, initiative.id, { type: 'TICKET', guestEmail: person.email, canonicalEmail: person.canonicalEmail });
    await db.ticketPass.create({ data: { contributionId: asGuest.id, initiativeId: initiative.id, serialCode: uniqueId('PASE'), holderEmail: person.email, qrHmacSignature: 'firma' } });
    await contribution(organization.id, initiative.id, { guestEmail: 'otra@pruebas.example', canonicalEmail: 'otra@pruebas.example' });
    await recordConsent(db, { userId: person.id, purpose: 'MARKETING_EMAILS', granted: true, policyVersion: '2026-11-05', source: 'cuenta' });
    await tokenizeAndStoreCard(db, new MockPaycometProvider({ secrets: mockSecrets }), { jetToken: uniqueId('jet'), userId: person.id, brand: 'VISA', last4: '4242' }, TEST_KEYRING);

    const actor = await verifiedAccount(person.id);
    const requestedAt = new Date();
    const request = await openPrivacyRequest(db, TEST_HMAC_SECRET, { actor, type: 'EXPORT' }, requestedAt);
    expect(request.dueAt.getTime()).toBeGreaterThan(requestedAt.getTime() + 27 * DAY);
    expect(request.requesterEmailHmac).not.toContain('@');

    const data = await buildPersonalDataExport(db, TEST_KEYRING, { kind: 'self', actor });
    // Con la sesión de una familia no se exportan los datos de otra cuenta, aunque una ruta reenvíe un identificador ajeno.
    const victim = await createUser(db);
    const forged = { kind: 'superadmin', actor, userId: victim.id } as unknown as ExportRequester;
    await expect(buildPersonalDataExport(db, TEST_KEYRING, forged)).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
    const smuggled = { kind: 'self', actor, userId: victim.id } as unknown as ExportRequester;
    expect((await buildPersonalDataExport(db, TEST_KEYRING, smuggled)).account.id).toBe(person.id);
    // Cada exportación queda en la auditoría, sin datos de la exportación.
    const exportAudits = await db.auditLog.findMany({ where: { action: 'privacy.export', targetId: person.id } });
    expect(exportAudits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(exportAudits)).not.toMatch(/12345678Z|Marta/);
    expect(data.account).toMatchObject({ name: 'Marta Puig', email: person.email, taxId: '12345678Z' });
    expect(data.contributions).toHaveLength(2);
    expect(data.contributions.find((row) => row.asGuest)).toMatchObject({ type: 'TICKET' });
    expect(data.contributions.find((row) => !row.asGuest)).toMatchObject({ donorTaxId: '12345678Z', donorFullName: 'Marta Puig' });
    expect(data.tickets).toHaveLength(1);
    expect(data.consents).toEqual([expect.objectContaining({ purpose: 'MARKETING_EMAILS', granted: true })]);
    expect(data.savedCards).toEqual([expect.objectContaining({ brand: 'VISA', last4: '4242' })]);
    expect(data.privacyRequests).toEqual([expect.objectContaining({ type: 'EXPORT', status: 'RECEIVED' })]);
    // Nunca secretos ni datos de otras personas.
    expect(JSON.stringify(data)).not.toMatch(/otra@pruebas|tokenUser|idUserEnc|Enc"/);
    expect(data.unreadableTaxIds).toBe(0);

    const pdf = Buffer.from(renderPersonalDataPdf(data, translate, 'es')).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('Marta Puig');

    // Nadie cierra la solicitud de otra persona (responde como si no existiera); la propia sí, una vez.
    const stranger = await verifiedAccount((await createUser(db)).id);
    await expect(closePrivacyRequest(db, request.id, { status: 'COMPLETED' }, { kind: 'self', actor: stranger })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await closePrivacyRequest(db, request.id, { status: 'COMPLETED' }, { kind: 'self', actor });
    await expect(closePrivacyRequest(db, request.id, { status: 'COMPLETED' }, { kind: 'system' })).rejects.toBeInstanceOf(PrivacyRequestError);
    const audits = await db.auditLog.findMany({ where: { targetType: 'PrivacyRequest', targetId: String(request.id) } });
    expect(audits.map((row) => row.action).sort()).toEqual(['privacy.request_closed', 'privacy.request_opened']);
    expect(JSON.stringify(audits)).not.toContain(person.email);
  });

  it('una cuenta con el email sin verificar no recibe las compras de invitado hechas con ese email, ni puede pedir sus datos por sí misma', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id);
    const impostor = await createUser(db, { emailVerified: false });
    await contribution(organization.id, initiative.id, { guestEmail: impostor.email, canonicalEmail: impostor.canonicalEmail, donorFullName: 'La verdadera titular', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) });
    const session = await newSession(impostor.id);
    await markSessionReauthenticated(db, session.id, { secondFactor: false });
    await expect(verifyAccountSession(db, { userId: impostor.id, sessionId: session.id, operation: 'privacy.export' })).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
    const { actor: admin } = await verifiedAdmin();
    const data = await buildPersonalDataExport(db, TEST_KEYRING, { kind: 'superadmin', actor: admin, userId: impostor.id });
    expect(data.contributions).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('La verdadera titular');
  });
});

describe('QA-REG03 · derecho de supresión', () => {
  it('anonimiza nombre, email, NIF, tokens e identificadores de dispositivo y conserva lo contable y lo fiscal obligatorio', async () => {
    const provider = new MockPaycometProvider({ secrets: mockSecrets });
    const person = await createUser(db, { name: 'Jordi Vila', provinceCode: '08', postalCode: '08001' });
    const nif = sealValue(TEST_KEYRING, '12345678Z', CRYPTO_CONTEXT.userTaxId(person.id));
    await db.user.update({ where: { id: person.id }, data: { nifEnc: nif.sealed, nifKeyVersion: nif.keyVersion } });
    const organization = await createOrganization(db, { ley49: true, ley49VerifiedAt: new Date() });
    const initiative = await createInitiative(db, organization.id);
    const plainOrganization = await createOrganization(db);
    const plainInitiative = await createInitiative(db, plainOrganization.id);
    // Sin Ley 49/2002 verificada no hay Modelo 182: su NIF no se conserva.
    const notDeclarable = await contribution(plainOrganization.id, plainInitiative.id, { userId: person.id, donorFullName: 'Jordi Vila', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) });
    const fiscal = await contribution(organization.id, initiative.id, { userId: person.id, canonicalEmail: person.canonicalEmail, donorFullName: 'Jordi Vila', donorProvinceCode: '08', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) });
    const plain = await contribution(organization.id, initiative.id, { userId: person.id, donorFullName: 'Jordi Vila' });
    const guest = await contribution(organization.id, initiative.id, { type: 'TICKET', guestEmail: person.email, canonicalEmail: person.canonicalEmail });
    const pass = await db.ticketPass.create({ data: { contributionId: guest.id, initiativeId: initiative.id, serialCode: uniqueId('PASE'), holderEmail: person.email, qrHmacSignature: 'firma' } });
    const { paymentMethodTokenId } = await tokenizeAndStoreCard(db, provider, { jetToken: uniqueId('jet'), userId: person.id, last4: '4242' }, TEST_KEYRING);

    // Dispositivo compartido con otra cuenta que llegó después: su orden (2ª) no debe cambiar.
    const device = await db.device.create({ data: { cookieIdHash: uniqueId('cookie'), fingerprintHmac: uniqueId('huella') } });
    const sibling = await createUser(db);
    await db.deviceAccount.create({ data: { deviceId: device.id, userId: person.id, canonicalEmail: person.canonicalEmail, accountOrder: 1, firstSeenAt: new Date(Date.now() - DAY) } });
    await db.deviceAccount.create({ data: { deviceId: device.id, userId: sibling.id, canonicalEmail: sibling.canonicalEmail, accountOrder: 2 } });
    const idea = await db.idea.create({ data: { organizationId: organization.id, alias: 'FAM-1', authorCanonicalEmail: person.canonicalEmail, title: 'Fuente', category: 'Patio', description: 'x', expiresAt: new Date(Date.now() + 30 * DAY) } });
    const otherIdea = await db.idea.create({ data: { organizationId: organization.id, alias: 'FAM-2', authorCanonicalEmail: sibling.canonicalEmail, title: 'Toldo', category: 'Patio', description: 'x', phase: 'PUBLIC_VOTING', expiresAt: new Date(Date.now() + 30 * DAY) } });
    const poll = await db.resizePoll.create({ data: { initiativeId: plainInitiative.id, optionsJson: [], closesAt: new Date(Date.now() + DAY) } });
    const vote = await db.resizeVote.create({ data: { pollId: poll.id, canonicalEmail: person.canonicalEmail, optionIndex: 0 } });
    await db.ideaSignatureAudit.create({ data: { ideaId: otherIdea.id, userId: person.id, canonicalEmail: person.canonicalEmail, deviceId: device.id, ipSubnetHash: 'red', reason: 'ideas.audit.firstAccount' } });
    await db.outboxMessage.create({ data: { idempotencyKey: uniqueId('msg'), templateKey: 'ticket.pass', toAddress: person.email, userId: person.id, payloadJson: { name: 'Jordi' } } });
    await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId: person.id, expiresAt: new Date(Date.now() + DAY) } });
    await db.organizationMember.create({ data: { userId: person.id, organizationId: organization.id, role: 'FAMILY' } });
    const actor = await verifiedAccount(person.id);
    const request = await openPrivacyRequest(db, TEST_HMAC_SECRET, { actor, type: 'ERASURE' });
    const deps = { paymentProvider: async () => provider, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET };

    // Nadie suprime la cuenta de otra persona con su propia sesión.
    await expect(erasePersonalData(db, deps, { userId: sibling.id, requestedBy: { kind: 'self', actor } })).rejects.toMatchObject({ reason: 'NOT_ACCOUNT_OWNER' });
    const result = await erasePersonalData(db, deps, { userId: person.id, requestedBy: { kind: 'self', actor }, requestId: request.id });
    expect(result).toEqual({ status: 'ERASED', cardsPendingDeletion: 0, retainedFiscalRecords: 1 });

    const user = await db.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(user).toMatchObject({ name: '', email: anonymizedEmailOf(person.id), nifEnc: null, provinceCode: null, postalCode: null, emailVerified: false });
    expect(user.gdprAnonymizedAt).not.toBeNull();
    expect(await db.contribution.findUniqueOrThrow({ where: { id: fiscal.id } })).toMatchObject({ amountCents: 2_500, donorFullName: 'Jordi Vila', donorProvinceCode: '08', canonicalEmail: null, guestEmail: null });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ amountCents: 2_500, donorFullName: null });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: notDeclarable.id } })).toMatchObject({ amountCents: 2_500, donorFullName: null, donorTaxIdEnc: null, donorTaxIdHmac: null });
    expect((await db.resizeVote.findUniqueOrThrow({ where: { id: vote.id } })).canonicalEmail).not.toContain('@');
    expect(await db.contribution.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({ guestEmail: null, canonicalEmail: null });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass.id } })).holderEmail).not.toContain('@');
    const card = await db.paymentMethodToken.findUniqueOrThrow({ where: { id: paymentMethodTokenId } });
    expect(card).toMatchObject({ idUserEnc: '', tokenUserEnc: '', last4: null });
    expect(card.revokedAt).not.toBeNull();
    expect(provider.deletedCards).toHaveLength(1);
    const accounts = await db.deviceAccount.findMany({ where: { deviceId: device.id }, orderBy: { accountOrder: 'asc' } });
    expect(accounts.map((row) => [row.userId, row.accountOrder])).toEqual([[person.id, 1], [sibling.id, 2]]);
    expect(accounts[0]!.canonicalEmail).not.toContain('@');
    expect((await db.device.findUniqueOrThrow({ where: { id: device.id } })).fingerprintHmac).toBeNull();
    expect((await db.ideaSignatureAudit.findFirstOrThrow({ where: { ideaId: otherIdea.id, userId: person.id } })).canonicalEmail).not.toContain('@');
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).authorCanonicalEmail).not.toContain('@');
    expect(await db.outboxMessage.findFirstOrThrow({ where: { userId: person.id } })).toMatchObject({ status: 'CANCELLED', payloadJson: {} });
    expect(await db.session.count({ where: { userId: person.id } })).toBe(0);
    expect(await db.organizationMember.count({ where: { userId: person.id } })).toBe(0);
    expect((await db.privacyRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('COMPLETED');
    // El NIF del donante sigue siendo legible para la entidad (Modelo 182) con la clave de la plataforma.
    const fiscalRow = await db.contribution.findUniqueOrThrow({ where: { id: fiscal.id } });
    expect(openDonorTaxId(TEST_KEYRING, fiscalRow.donorTaxIdEnc!, fiscalRow.donorTaxIdKeyVersion)).toBe('12345678Z');

    const { actor: admin } = await verifiedAdmin();
    expect(await erasePersonalData(db, deps, { userId: person.id, requestedBy: { kind: 'superadmin', actor: admin } })).toMatchObject({ status: 'ALREADY_ERASED' });

    // Volver a darse de alta con el mismo email no da otra firma en la misma idea, ni permite firmar la propia.
    const returning = await createUser(db, { email: person.email, canonicalEmail: person.canonicalEmail });
    expect(await signIdea(db, TEST_HMAC_SECRET, { ideaId: otherIdea.id, userId: returning.id })).toEqual({ status: 'ALREADY_SIGNED' });
    await db.idea.update({ where: { id: idea.id }, data: { phase: 'PUBLIC_VOTING' } });
    expect(await signIdea(db, TEST_HMAC_SECRET, { ideaId: idea.id, userId: returning.id })).toEqual({ status: 'ALREADY_SIGNED' });
    // Una cuenta suprimida ya no da consentimientos.
    await expect(recordConsent(db, { userId: person.id, purpose: 'MARKETING_EMAILS', granted: true, policyVersion: '2026-11-05', source: 'cuenta' })).rejects.toBeInstanceOf(ConsentInputError);
  });

  it('no se suprime a quien firma en una entidad ni al Super-Admin, y queda constancia', async () => {
    const organization = await createOrganization(db);
    const signer = await createUser(db);
    await db.organizationMember.create({ data: { userId: signer.id, organizationId: organization.id, role: 'COSIGNER' } });
    const deps = { paymentProvider: async () => new MockPaycometProvider({ secrets: mockSecrets }), keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET };
    await expect(erasePersonalData(db, deps, { userId: signer.id, requestedBy: { kind: 'self', actor: await verifiedAccount(signer.id) } })).rejects.toMatchObject({ reason: 'ACTIVE_SIGNER' });
    const admin = await createUser(db, { isSuperadmin: true });
    await expect(erasePersonalData(db, deps, { userId: admin.id, requestedBy: { kind: 'system', reason: 'INACTIVITY' } })).rejects.toBeInstanceOf(ErasureBlockedError);
    expect((await db.user.findUniqueOrThrow({ where: { id: signer.id } })).gdprAnonymizedAt).toBeNull();
    expect(await db.auditLog.count({ where: { targetId: { in: [signer.id, admin.id] }, action: 'privacy.erasure_blocked' } })).toBe(2);
  });

  it('si Paycomet no confirma el borrado de la tarjeta, queda revocada, se avisa y la purga lo reintenta', async () => {
    let failing = true;
    const provider = new MockPaycometProvider({ secrets: mockSecrets, failDeleteCard: () => (failing ? new PaymentProviderError('caído', 'NETWORK', true) : null) });
    const person = await createUser(db);
    const { paymentMethodTokenId } = await tokenizeAndStoreCard(db, provider, { jetToken: uniqueId('jet'), userId: person.id }, TEST_KEYRING);
    const deps = { paymentProvider: async () => provider, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET };
    expect(await erasePersonalData(db, deps, { userId: person.id, requestedBy: { kind: 'self', actor: await verifiedAccount(person.id) } })).toMatchObject({ status: 'ERASED', cardsPendingDeletion: 1 });
    const pending = await db.paymentMethodToken.findUniqueOrThrow({ where: { id: paymentMethodTokenId } });
    expect(pending.revokedAt).not.toBeNull();
    expect(pending.providerDeletedAt).toBeNull();
    await expect(loadCardToken(db, paymentMethodTokenId, { userId: person.id }, TEST_KEYRING)).rejects.toThrow(/revocada/);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `card-delete:${paymentMethodTokenId}` } })).toMatchObject({ type: 'CARD_DELETE_FAILED', status: 'OPEN' });

    failing = false;
    expect((await retryCardDeletions(db, deps, new Date(), 1000)).deleted).toBeGreaterThanOrEqual(1);
    expect((await db.paymentMethodToken.findUniqueOrThrow({ where: { id: paymentMethodTokenId } })).providerDeletedAt).not.toBeNull();
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `card-delete:${paymentMethodTokenId}` } })).status).toBe('RESOLVED');
  });

  it('con Paycomet sin configurar la supresión se completa igual: la tarjeta queda revocada y pendiente de borrar', async () => {
    const person = await createUser(db);
    const { paymentMethodTokenId } = await tokenizeAndStoreCard(db, new MockPaycometProvider({ secrets: mockSecrets }), { jetToken: uniqueId('jet'), userId: person.id }, TEST_KEYRING);
    const deps = { paymentProvider: () => Promise.reject(new Error('Faltan credenciales de Paycomet')), keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET };
    expect(await erasePersonalData(db, deps, { userId: person.id, requestedBy: { kind: 'system', reason: 'INACTIVITY' } })).toMatchObject({ status: 'ERASED', cardsPendingDeletion: 1 });
    const card = await db.paymentMethodToken.findUniqueOrThrow({ where: { id: paymentMethodTokenId } });
    expect(card.revokedAt).not.toBeNull();
    expect(card.providerDeletedAt).toBeNull();
    expect(await retryCardDeletions(db, deps, new Date(), 1000)).toMatchObject({ deleted: 0 });
  });
});

describe('QA-PRIV02 · DATA_RETENTION_PURGE solo toca lo vencido', () => {
  it('aplica la tabla de plazos y respeta lo que sigue en plazo', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const ago = (days: number) => new Date(now.getTime() - days * DAY);
      const storage = new MemoryStorage();
      const provider = new MockPaycometProvider({ secrets: mockSecrets });
      const deps: JobDeps = { paymentProvider: async () => provider, invoicingProvider: () => { throw new Error('no se usa'); }, refundOriginalIp: async () => '10.0.0.1', storageProvider: () => storage, keyring: () => TEST_KEYRING, hmacSecret: () => TEST_HMAC_SECRET };

      const organization = await createOrganization(asClient(tx));
      const initiative = await createInitiative(asClient(tx), organization.id);
      const donor = (fiscalYear: number) => tx.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear, amountCents: 1_000, totalChargedCents: 1_000, paymentMethod: 'CARD', status: 'COMPLETED', guestEmail: 'antigua@pruebas.example', canonicalEmail: 'antigua@pruebas.example', donorFullName: 'Persona Antigua', donorProvinceCode: '08', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) } });
      const expired = await donor(lastYearExpired(now));
      const current = await donor(now.getUTCFullYear() - 1);

      const oldIdea = await tx.idea.create({ data: { organizationId: organization.id, alias: 'A', authorCanonicalEmail: 'autora@pruebas.example', title: 'Vieja', category: 'Patio', description: 'x', expiresAt: ago(400) } });
      const liveIdea = await tx.idea.create({ data: { organizationId: organization.id, alias: 'B', authorCanonicalEmail: 'autor@pruebas.example', title: 'Nueva', category: 'Patio', description: 'x', expiresAt: ago(30) } });
      const voter = await tx.user.create({ data: { id: uniqueId('user'), email: `${uniqueId('v')}@pruebas.example`, canonicalEmail: `${uniqueId('vc')}@pruebas.example` } });
      const oldSignature = await tx.ideaSignatureAudit.create({ data: { ideaId: oldIdea.id, userId: voter.id, canonicalEmail: voter.canonicalEmail, ipSubnetHash: 'red', reason: 'ideas.audit.firstAccount', createdAt: ago(420) } });
      const liveSignature = await tx.ideaSignatureAudit.create({ data: { ideaId: liveIdea.id, userId: voter.id, canonicalEmail: voter.canonicalEmail, ipSubnetHash: 'red', reason: 'ideas.audit.firstAccount', createdAt: ago(40) } });

      const staleDevice = await tx.device.create({ data: { cookieIdHash: uniqueId('c1'), lastSeenAt: ago(400) } });
      const agedDevice = await tx.device.create({ data: { cookieIdHash: uniqueId('c2'), fingerprintHmac: 'huella', lastSeenAt: ago(370) } });
      const freshDevice = await tx.device.create({ data: { cookieIdHash: uniqueId('c3'), fingerprintHmac: 'huella', lastSeenAt: ago(5) } });
      const oldAudit = await tx.auditLog.create({ data: { actorType: 'USER', action: 'prueba.retencion', targetType: 'X', targetId: '1', ipHash: 'hash-ip', userAgent: 'Navegador', occurredAt: ago(400) } });
      const newAudit = await tx.auditLog.create({ data: { actorType: 'USER', action: 'prueba.retencion', targetType: 'X', targetId: '2', ipHash: 'hash-ip', occurredAt: ago(10) } });
      const oldMessage = await tx.outboxMessage.create({ data: { idempotencyKey: uniqueId('m1'), templateKey: 'x', toAddress: 'a@pruebas.example', payloadJson: { a: 1 }, status: 'SENT', createdAt: ago(400) } });
      const newMessage = await tx.outboxMessage.create({ data: { idempotencyKey: uniqueId('m2'), templateKey: 'x', toAddress: 'b@pruebas.example', payloadJson: { a: 1 }, status: 'SENT', createdAt: ago(10) } });
      const consentOwner = await tx.user.create({ data: { id: uniqueId('user'), email: `${uniqueId('co')}@pruebas.example`, canonicalEmail: `${uniqueId('coc')}@pruebas.example` } });
      const consent = (days: number, granted: boolean) => tx.consentRecord.create({ data: { userId: consentOwner.id, purpose: 'MARKETING_EMAILS', granted, policyVersion: '2020-01-01', source: 'cuenta', createdAt: ago(days) } });
      const consent5y = await consent(5 * 365, true);
      const consent4y = await consent(4 * 365, false);
      const consent1y = await consent(365, true);
      const webhook = await tx.webhookEvent.create({ data: { provider: 'paycomet', externalEventId: uniqueId('antiguo'), signatureValid: true, payloadJson: {}, status: 'PROCESSED', receivedAt: new Date(Date.UTC(now.getUTCFullYear() - 8, 5, 1)) } });

      const inactive = await tx.user.create({ data: { id: uniqueId('user'), email: `${uniqueId('in')}@pruebas.example`, canonicalEmail: `${uniqueId('inc')}@pruebas.example`, lastActiveAt: ago(4 * 365) } });
      const unresponsive = await tx.user.create({ data: { id: uniqueId('user'), name: 'Sin respuesta', email: `${uniqueId('un')}@pruebas.example`, canonicalEmail: `${uniqueId('unc')}@pruebas.example`, lastActiveAt: ago(4 * 365), inactivityNoticeAt: ago(31) } });
      const guestBuyer = await tx.user.create({ data: { id: uniqueId('user'), email: `${uniqueId('gb')}@pruebas.example`, canonicalEmail: `${uniqueId('gbc')}@pruebas.example`, emailVerified: true, lastActiveAt: ago(4 * 365) } });
      await tx.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: now.getUTCFullYear(), amountCents: 500, totalChargedCents: 500, paymentMethod: 'BIZUM', guestEmail: guestBuyer.email, canonicalEmail: guestBuyer.canonicalEmail } });
      const returned = await tx.user.create({ data: { id: uniqueId('user'), email: `${uniqueId('re')}@pruebas.example`, canonicalEmail: `${uniqueId('rec')}@pruebas.example`, lastActiveAt: ago(2), inactivityNoticeAt: ago(31) } });

      await storage.put({ bucket: 'korum-private', objectKey: 'kyb/antiguo.pdf', body: new Uint8Array([1]), contentType: 'application/pdf' });
      const expiredFile = await tx.fileAsset.create({ data: { bucket: 'korum-private', objectKey: `kyb/${uniqueId('f')}.pdf`, visibility: 'PRIVATE', purpose: 'KYB_DOCUMENT', mimeType: 'application/pdf', sizeBytes: 1, sha256: 'x', retainUntil: ago(1) } });
      const keptFile = await tx.fileAsset.create({ data: { bucket: 'korum-private', objectKey: `kyb/${uniqueId('g')}.pdf`, visibility: 'PRIVATE', purpose: 'KYB_DOCUMENT', mimeType: 'application/pdf', sizeBytes: 1, sha256: 'x', retainUntil: new Date(now.getTime() + DAY) } });
      const overdue = await tx.privacyRequest.create({ data: { userId: voter.id, requesterEmailHmac: 'hmac', type: 'ACCESS', dueAt: ago(1) } });

      const result = await dataRetentionPurgeHandler({ db: tx, now, batchSize: 1000, deps });
      expect(result.detail).toMatchObject({ inactiveErased: 1, inactiveReturned: 1 });

      expect(await tx.contribution.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ amountCents: 1_000, donorTaxIdEnc: null, donorFullName: null, guestEmail: null, donorProvinceCode: null });
      expect(await tx.contribution.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({ donorFullName: 'Persona Antigua', guestEmail: 'antigua@pruebas.example' });
      expect(await tx.ideaSignatureAudit.findUniqueOrThrow({ where: { id: oldSignature.id } })).toMatchObject({ userId: null, ipSubnetHash: null });
      expect((await tx.idea.findUniqueOrThrow({ where: { id: oldIdea.id } })).authorCanonicalEmail).not.toContain('@');
      expect(await tx.ideaSignatureAudit.findUniqueOrThrow({ where: { id: liveSignature.id } })).toMatchObject({ userId: voter.id, ipSubnetHash: 'red' });
      expect((await tx.idea.findUniqueOrThrow({ where: { id: liveIdea.id } })).authorCanonicalEmail).toBe('autor@pruebas.example');
      expect(await tx.device.findUnique({ where: { id: staleDevice.id } })).toBeNull();
      expect(await tx.device.findUniqueOrThrow({ where: { id: agedDevice.id } })).toMatchObject({ fingerprintHmac: null });
      expect(await tx.device.findUniqueOrThrow({ where: { id: freshDevice.id } })).toMatchObject({ fingerprintHmac: 'huella' });
      expect(await tx.auditLog.findUniqueOrThrow({ where: { id: oldAudit.id } })).toMatchObject({ ipHash: null, userAgent: null, action: 'prueba.retencion' });
      expect(await tx.auditLog.findUniqueOrThrow({ where: { id: newAudit.id } })).toMatchObject({ ipHash: 'hash-ip' });
      expect(await tx.outboxMessage.findUniqueOrThrow({ where: { id: oldMessage.id } })).toMatchObject({ toAddress: '', payloadJson: {}, status: 'SENT' });
      expect(await tx.outboxMessage.findUniqueOrThrow({ where: { id: newMessage.id } })).toMatchObject({ toAddress: 'b@pruebas.example' });
      const consents = (await tx.consentRecord.findMany({ where: { userId: consentOwner.id } })).map((row) => row.id).sort();
      expect(consents).toEqual([consent4y.id, consent1y.id].sort());
      expect(consent5y.id).toBeGreaterThan(0);
      expect(await tx.webhookEvent.findUnique({ where: { id: webhook.id } })).toBeNull();

      expect((await tx.user.findUniqueOrThrow({ where: { id: inactive.id } })).inactivityNoticeAt).not.toBeNull();
      // Quien compró hace poco como invitada con su email no está inactiva.
      expect((await tx.user.findUniqueOrThrow({ where: { id: guestBuyer.id } })).inactivityNoticeAt).toBeNull();
      expect(await tx.outboxMessage.count({ where: { userId: inactive.id, templateKey: 'privacy.inactivityNotice' } })).toBe(1);
      expect(await tx.user.findUniqueOrThrow({ where: { id: unresponsive.id } })).toMatchObject({ name: '', email: anonymizedEmailOf(unresponsive.id) });
      expect(await tx.user.findUniqueOrThrow({ where: { id: returned.id } })).toMatchObject({ inactivityNoticeAt: null, gdprAnonymizedAt: null });

      expect((await tx.fileAsset.findUniqueOrThrow({ where: { id: expiredFile.id } })).deletedAt).not.toBeNull();
      expect((await tx.fileAsset.findUniqueOrThrow({ where: { id: keptFile.id } })).deletedAt).toBeNull();
      expect(await tx.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `privacy-request:${overdue.id}` } })).toMatchObject({ type: 'PRIVACY_REQUEST_OVERDUE', severity: 'CRITICAL' });
    });
  });
});

function lastYearExpired(now: Date): number {
  return now.getUTCFullYear() - 7;
}

describe('rotación de la clave de cifrado', () => {
  it('vuelve a cifrar con la clave nueva todo lo cifrado con la anterior, con el mismo contexto, y avisa de lo que no puede leer', async () => {
    await inRollback(async (tx) => {
      const newKeyring = createKeyring({ version: 2, key: randomBytes(32).toString('base64') }, [{ version: 1, key: TEST_KEYRING.keys.get(1)! }]);
      const onlyNew = createKeyring({ version: 2, key: newKeyring.keys.get(2)! });
      const organization = await createOrganization(asClient(tx));
      const initiative = await createInitiative(asClient(tx), organization.id);
      const person = await tx.user.create({ data: { id: uniqueId('user'), email: `${uniqueId('r')}@pruebas.example`, canonicalEmail: `${uniqueId('rc')}@pruebas.example` } });
      const nif = sealValue(TEST_KEYRING, '12345678Z', CRYPTO_CONTEXT.userTaxId(person.id));
      await tx.user.update({ where: { id: person.id }, data: { nifEnc: nif.sealed, nifKeyVersion: nif.keyVersion } });
      const secret = sealParts(TEST_KEYRING, 'clave-de-indexnow', CRYPTO_CONTEXT.platformSecret('seo.indexNowKey'));
      await tx.platformSecret.upsert({ where: { key: 'seo.indexNowKey' }, create: { key: 'seo.indexNowKey', ...secret }, update: secret });
      const { paymentMethodTokenId } = await tokenizeAndStoreCard(tx, new MockPaycometProvider({ secrets: mockSecrets }), { jetToken: 'jet-rotacion', userId: person.id }, TEST_KEYRING);
      const donation = await tx.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, amountCents: 1_000, totalChargedCents: 1_000, paymentMethod: 'CARD', ...sealDonorTaxId('12345678Z', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }) } });
      const lost = await tx.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, amountCents: 1_000, totalChargedCents: 1_000, paymentMethod: 'CARD', ...sealDonorTaxId('12345678Z', { keyring: createKeyring({ version: 1, key: randomBytes(32).toString('base64') }), hmacSecret: TEST_HMAC_SECRET }) } });
      const sponsor = await tx.sponsor.create({ data: { organizationId: organization.id, name: 'Comercio', contactPerson: 'x', phone: '1', email: 'c@pruebas.example', sector: 's', tierLabel: 't', amountCents: 10_000, feeGeneratedCents: 1_500, promo: 'p', code: uniqueId('C'), expiresAt: new Date('2027-01-01'), ...sealSponsorTaxId(TEST_KEYRING, organization.id, 'B12345674') } });
      const invoiceNumber = uniqueId('FAC-ROT');
      const invoice = await tx.invoice.create({ data: { invoiceNumber, organizationId: organization.id, recipientName: 'Comercio', concept: 'Fee', baseAmountCents: 100, totalAmountCents: 121, taxAmountCents: 21, verifactuHash: uniqueId('hash'), verifactuQrUrl: 'https://example.test', ...sealInvoiceRecipientTaxId(TEST_KEYRING, invoiceNumber, 'B12345674') } });

      const result = await rotateEncryptedData(tx, newKeyring, 500);
      expect(result.rotated).toBeGreaterThanOrEqual(6);
      expect(result.undecryptable).toBeGreaterThanOrEqual(1);

      // Ya se leen sin la clave anterior.
      const user = await tx.user.findUniqueOrThrow({ where: { id: person.id } });
      expect(user.nifKeyVersion).toBe(2);
      expect(openValue(onlyNew, user.nifEnc!, user.nifKeyVersion, CRYPTO_CONTEXT.userTaxId(person.id))).toBe('12345678Z');
      invalidateSettingsCache();
      expect(await getSecret(tx, onlyNew, 'seo.indexNowKey', {})).toBe('clave-de-indexnow');
      expect(await loadCardToken(tx, paymentMethodTokenId, { userId: person.id }, onlyNew)).toEqual(await new MockPaycometProvider({ secrets: mockSecrets }).tokenizeCard({ jetToken: 'jet-rotacion' }));
      const donationRow = await tx.contribution.findUniqueOrThrow({ where: { id: donation.id } });
      expect(openDonorTaxId(onlyNew, donationRow.donorTaxIdEnc!, donationRow.donorTaxIdKeyVersion)).toBe('12345678Z');
      const sponsorRow = await tx.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } });
      expect(openSponsorTaxId(onlyNew, { organizationId: organization.id, cifEnc: sponsorRow.cifEnc!, cifKeyVersion: sponsorRow.cifKeyVersion })).toBe('B12345674');
      const invoiceRow = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(openInvoiceRecipientTaxId(onlyNew, { invoiceNumber, recipientTaxIdEnc: invoiceRow.recipientTaxIdEnc!, recipientTaxIdKeyVersion: invoiceRow.recipientTaxIdKeyVersion })).toBe('B12345674');

      // Lo que ninguna clave lee se queda como estaba, con una alerta crítica.
      expect((await tx.contribution.findUniqueOrThrow({ where: { id: lost.id } })).donorTaxIdKeyVersion).toBe(1);
      expect(await tx.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'key-missing:Contribution' } })).toMatchObject({ type: 'ENCRYPTION_KEY_MISSING', severity: 'CRITICAL' });
      expect((await countPendingRotation(tx, newKeyring)).Contribution).toBeGreaterThanOrEqual(1);
      // Una segunda pasada no vuelve a tocar lo ya rotado.
      expect((await rotateEncryptedData(tx, newKeyring, 50)).rotated).toBe(0);

      // Carrera: la rotación leyó un secreto y, antes de reescribirlo, el Super-Admin guarda otro valor. Gana el del Super-Admin.
      const old = sealParts(TEST_KEYRING, 'valor-antiguo-de-la-clave', CRYPTO_CONTEXT.platformSecret('email.apiKey'));
      await tx.platformSecret.upsert({ where: { key: 'email.apiKey' }, create: { key: 'email.apiKey', ...old }, update: old });
      const readByRotation = await tx.platformSecret.findUniqueOrThrow({ where: { key: 'email.apiKey' } });
      const saved = sealParts(onlyNew, 'valor-nuevo-del-super-admin', CRYPTO_CONTEXT.platformSecret('email.apiKey'));
      await tx.platformSecret.update({ where: { key: 'email.apiKey' }, data: saved });
      expect(await reencryptPlatformSecret(tx, newKeyring, readByRotation)).toBe(false);
      invalidateSettingsCache();
      expect(await getSecret(tx, onlyNew, 'email.apiKey', {})).toBe('valor-nuevo-del-super-admin');
    });
  });
});
