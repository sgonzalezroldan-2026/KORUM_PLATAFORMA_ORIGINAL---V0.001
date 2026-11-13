import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { legalToday } from '@/core/admin/settings-model';
import { acceptInvitation, acceptInvitationWithSession, createInvitation, InvitationError } from '@/core/onboarding/invitations';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import { getConsoleSettings } from '@/repositories/console.repository';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { testConnection } from '@/services/admin/connection-tests';
import { loadPublicPlatformConfig, resetPublicConfigMemo } from '@/services/marketing/public-config';
import { removeSecretValue, saveLegalText, saveSecretValue, saveSettingsSection, SettingsRejectedError } from '@/services/admin/platform-settings.service';
import { loadSettingsView } from '@/services/admin/platform-settings-view';
import type { SettingsRuntime } from '@/services/admin/settings-runtime';
import { cancelSuperadminInvitation, inviteSuperadmin, revokeSuperadmin, type SuperadminTeamError } from '@/services/admin/superadmin-team.service';
import { describeSecrets, getSecret, getSetting, invalidateSettingsCache } from '@/services/settings/settings.service';
import { createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.4 · Ajustes de la plataforma (`/admin/ajustes`) contra PostgreSQL real (QA-A05, QA-SEC07). Lo que se prueba: cada bloque guarda todo o nada con la versión de cada ajuste y
 * lo no modificado no deja rastro; lo imposible se rechaza (rastreadores que colarían líneas en `robots.txt`, un monedero sin proveedor ni saldo a cero, el NIF sin la razón social);
 * los secretos van cifrados y nunca aparecen en la auditoría ni en la vista; los textos legales no retroceden ni se editan publicados; el equipo de Super-Admin no deja la consola vacía;
 * «Probar conexión» no llama a nadie con cobros simulados y no filtra la respuesta del proveedor; y todo exige el Super-Admin verificado.
 */

const TOUCHED = ['paycomet.merchantCode', 'paycomet.terminalId', 'paycomet.jetId', 'paycomet.serverIp', 'email.provider', 'email.fromAddress', 'email.fromName', 'email.replyTo', 'invoicing.provider', 'invoicing.issuerNif', 'invoicing.issuerName', 'invoicing.series', 'hucha.mode', 'hucha.walletProvider', 'autoBoost.publicDisclosureDefault', 'seo.aiCrawlers', 'seo.verification.google', 'seo.verification.bing', 'platform.company', 'raffle.extraRoundMinHours', 'privacy.policyVersion'];
const TOUCHED_SECRETS = ['paycomet.apiKey', 'paycomet.webhookSecret', 'email.apiKey', 'hucha.walletApiKey', 'invoicing.apiKey', 'seo.indexNowKey'];
const MOCK: SettingsRuntime = { paycometMode: 'mock', keyring: TEST_KEYRING, encryptionKeyVersion: 1, previousKeyCount: 0 };
const REAL: SettingsRuntime = { ...MOCK, paycometMode: 'sandbox' };
const SECRET_VALUE = 'sk-super-secreta-0123456789-ZZZZ';
/** Las versiones de los textos son fechas de publicación y no pueden ser futuras: se calculan a partir de hoy. */
const DAY_MS = 86_400_000;
const dayOffset = (days: number, sequence?: number) => `${legalToday(new Date(Date.now() + days * DAY_MS))}${sequence ? `.${sequence}` : ''}`;

let db: KorumPrismaClient;
let originalPolicy: unknown;

const verified = async (now: Date = new Date()): Promise<VerifiedSuperadminActor> => (await verifiedSuperadmin(db, now)).actor;
const versionsOf = async (keys: string[]) => Object.fromEntries(await Promise.all(keys.map(async (key) => [key, (await db.platformSetting.findUnique({ where: { key }, select: { version: true } }))?.version ?? 0] as const)));

/** Guarda un bloque con las versiones que tiene la base ahora (como haría la pantalla recién cargada). */
async function save(section: string, values: Record<string, unknown>, options: { runtime?: SettingsRuntime; confirmations?: string[]; actor?: VerifiedSuperadminActor; now?: Date } = {}) {
  return saveSettingsSection(db, options.actor ?? (await verified(options.now)), { section, values, versions: await versionsOf(Object.keys(values)), confirmations: options.confirmations ?? [] }, options.runtime ?? MOCK, undefined, options.now);
}

const rejection = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(SettingsRejectedError);
  return error as SettingsRejectedError;
};

async function wipe() {
  await db.platformSetting.deleteMany({ where: { key: { in: TOUCHED } } });
  await db.platformSecret.deleteMany({ where: { key: { in: TOUCHED_SECRETS } } });
  await db.platformSetting.deleteMany({ where: { key: { startsWith: 'legal.' } } });
  await db.rateLimit.deleteMany({ where: { key: { startsWith: 'console:' } } });
  invalidateSettingsCache();
}

beforeAll(async () => {
  db = createTestClient();
  originalPolicy = (await db.platformSetting.findUnique({ where: { key: 'privacy.policyVersion' } }))?.valueJson;
  await wipe();
}, 120_000);

afterEach(() => invalidateSettingsCache());

afterAll(async () => {
  await wipe();
  if (originalPolicy !== undefined) await db.platformSetting.create({ data: { key: 'privacy.policyVersion', valueJson: originalPolicy as string } });
  await db.$disconnect();
});

describe('QA-A05 · guardar un bloque de ajustes', () => {
  it('guarda todo el bloque con la versión de cada ajuste, deja un rastro por ajuste y lo no modificado no escribe ni audita', async () => {
    const result = await save('pagos', { 'paycomet.merchantCode': 'KORUM-COMERCIO', 'paycomet.terminalId': '12345', 'paycomet.jetId': 'jet-abc', 'paycomet.serverIp': '203.0.113.7' });
    expect(result.changed).toBe(4);
    expect(result.versions['paycomet.merchantCode']).toBe(1);
    expect(await getSetting(db, 'paycomet.terminalId')).toBe('12345');

    const audits = await db.auditLog.findMany({ where: { action: 'settings.setting.updated', targetId: { in: ['paycomet.merchantCode', 'paycomet.serverIp'] } }, orderBy: { id: 'desc' }, take: 2 });
    expect(audits).toHaveLength(2);
    expect(audits.every((audit) => audit.actorUserId !== null)).toBe(true);

    // Volver a guardar lo mismo no sube versiones ni escribe nada.
    const before = await db.auditLog.count({ where: { action: { startsWith: 'settings.setting.' } } });
    const again = await save('pagos', { 'paycomet.merchantCode': 'KORUM-COMERCIO', 'paycomet.terminalId': '12345' });
    expect(again.changed).toBe(0);
    expect(await db.auditLog.count({ where: { action: { startsWith: 'settings.setting.' } } })).toBe(before);
    expect((await versionsOf(['paycomet.merchantCode']))['paycomet.merchantCode']).toBe(1);
  });

  it('un valor vacío borra el ajuste (vuelve el de respaldo) y la auditoría lo anota como borrado', async () => {
    await save('email', { 'email.fromName': 'Colegio Demo', 'email.replyTo': 'ayuda@korum.test' });
    const cleared = await save('email', { 'email.replyTo': '' });
    expect(cleared.changed).toBe(1);
    expect(await db.platformSetting.findUnique({ where: { key: 'email.replyTo' } })).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'settings.setting.cleared', targetId: 'email.replyTo' } })).toBeGreaterThanOrEqual(1);
  });

  it('el valor por defecto no crea una fila: guardar el bloque sin tocar nada no ensucia la base', async () => {
    await save('autoimpulso', { 'autoBoost.publicDisclosureDefault': 'SHOW' });
    expect(await db.platformSetting.findUnique({ where: { key: 'autoBoost.publicDisclosureDefault' } })).toBeNull();
    await save('autoimpulso', { 'autoBoost.publicDisclosureDefault': 'HIDE' });
    expect(await getSetting(db, 'autoBoost.publicDisclosureDefault')).toBe('HIDE');
  });

  it('si otra persona guardó antes (versión distinta) no se pisa y no se guarda nada del bloque', async () => {
    await save('facturacion', { 'invoicing.series': 'KR' });
    const actor = await verified();
    const stale = { section: 'facturacion', values: { 'invoicing.series': 'XX', 'invoicing.provider': 'Proveedor' }, versions: { 'invoicing.series': 0, 'invoicing.provider': 0 } };
    expect((await rejection(saveSettingsSection(db, actor, stale, MOCK))).reason).toBe('STALE');
    expect(await getSetting(db, 'invoicing.series')).toBe('KR');
    expect(await db.platformSetting.findUnique({ where: { key: 'invoicing.provider' } })).toBeNull();
  });

  it('dos guardados a la vez sobre el mismo ajuste: uno gana y el otro recibe STALE', async () => {
    const [first, second] = [await verified(), await verified()];
    const versions = await versionsOf(['paycomet.jetId']);
    const run = (actor: VerifiedSuperadminActor, jetId: string) => saveSettingsSection(db, actor, { section: 'pagos', values: { 'paycomet.jetId': jetId }, versions }, MOCK);
    const results = await Promise.allSettled([run(first, 'jet-uno'), run(second, 'jet-dos')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect((failed as PromiseRejectedResult).reason).toMatchObject({ reason: 'STALE' });
  });

  it('rechaza campos de otro bloque o inventados, valores imposibles y selectores fuera de su lista, sin tocar nada', async () => {
    expect((await rejection(save('pagos', { 'hucha.mode': 'DISABLED' }))).reason).toBe('UNKNOWN');
    expect((await rejection(save('pagos', { 'limits.inventado': '5' }))).reason).toBe('UNKNOWN');
    expect((await rejection(save('pagos', { 'paycomet.terminalId': 'abc', 'paycomet.serverIp': 'no-es-una-ip' }))).fields.sort()).toEqual(['paycomet.serverIp', 'paycomet.terminalId']);
    expect((await rejection(save('email', { 'email.provider': 'smtp' }))).fields).toEqual(['email.provider']);
    expect((await rejection(save('email', { 'email.fromAddress': 'esto no es un email' }))).fields).toEqual(['email.fromAddress']);
    expect((await rejection(save('limites', { 'raffle.extraRoundMinHours': '721' }))).fields).toEqual(['raffle.extraRoundMinHours']);
    expect((await rejection(save('limites', { 'raffle.extraRoundMinHours': '1.5' }))).fields).toEqual(['raffle.extraRoundMinHours']);
    expect((await rejection(save('limites', { 'raffle.extraRoundMinHours': '-3' }))).fields).toEqual(['raffle.extraRoundMinHours']);
    expect((await rejection(saveSettingsSection(db, await verified(), { section: 'inexistente', values: {}, versions: {} }, MOCK))).reason).toBe('INVALID');
    expect((await rejection(saveSettingsSection(db, await verified(), { section: 'pagos', values: { 'paycomet.jetId': 'x' }, versions: {} }, MOCK))).fields).toEqual(['paycomet.jetId']);
  });

  it('las horas de la ronda extra del sorteo se guardan como número y las lee el motor del sorteo', async () => {
    await save('limites', { 'raffle.extraRoundMinHours': '24' });
    expect(await getSetting(db, 'raffle.extraRoundMinHours')).toBe(24);
  });
});

describe('QA-SEC07 · reglas entre ajustes', () => {
  it('con cobros reales o de pruebas, ni la IP del servidor ni el remitente se pueden dejar vacíos una vez puestos; con el simulador sí', async () => {
    await save('pagos', { 'paycomet.serverIp': '203.0.113.9' });
    await save('email', { 'email.fromAddress': 'hola@korum.test' });
    expect((await rejection(save('pagos', { 'paycomet.serverIp': '' }, { runtime: REAL }))).reason).toBe('SERVER_IP_REQUIRED');
    expect((await rejection(save('email', { 'email.fromAddress': '' }, { runtime: REAL }))).reason).toBe('SENDER_REQUIRED');
    expect(await getSetting(db, 'paycomet.serverIp')).toBe('203.0.113.9');
    await save('pagos', { 'paycomet.serverIp': '' });
    expect(await db.platformSetting.findUnique({ where: { key: 'paycomet.serverIp' } })).toBeNull();
  });

  it('guardar un bloque no congela en la consola los valores de respaldo del servidor: solo se escribe lo que se toca', async () => {
    await db.platformSetting.deleteMany({ where: { key: { in: ['paycomet.merchantCode', 'paycomet.terminalId', 'paycomet.serverIp'] } } });
    invalidateSettingsCache();
    const runtime = { ...MOCK, fallbacks: { PAYCOMET_MERCHANT_CODE: 'ENV-COMERCIO', PAYCOMET_TERMINAL_ID: '999' } };
    const before = await db.auditLog.count({ where: { action: 'settings.setting.updated', targetId: { in: ['paycomet.merchantCode', 'paycomet.terminalId'] } } });
    const result = await save('pagos', { 'paycomet.merchantCode': 'ENV-COMERCIO', 'paycomet.terminalId': '999', 'paycomet.serverIp': '203.0.113.9' }, { runtime });
    expect(result.changed).toBe(1);
    expect(await db.platformSetting.count({ where: { key: { in: ['paycomet.merchantCode', 'paycomet.terminalId'] } } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'settings.setting.updated', targetId: { in: ['paycomet.merchantCode', 'paycomet.terminalId'] } } })).toBe(before);
    // Cambiarlo a otro valor sí lo escribe.
    expect((await save('pagos', { 'paycomet.merchantCode': 'OTRO' }, { runtime })).changed).toBe(1);
  });

  it('las versiones no se reutilizan tras borrar un ajuste: quien vio la versión vieja recibe STALE aunque otro lo haya vaciado y vuelto a crear', async () => {
    await db.platformSetting.deleteMany({ where: { key: 'email.replyTo' } });
    invalidateSettingsCache();
    await save('email', { 'email.replyTo': 'a@korum.test' });
    const seen = (await versionsOf(['email.replyTo']))['email.replyTo']!;
    await save('email', { 'email.replyTo': '' });
    await save('email', { 'email.replyTo': 'c@korum.test' });
    const now = (await versionsOf(['email.replyTo']))['email.replyTo']!;
    expect(now).toBeGreaterThan(seen);
    const error = await rejection(saveSettingsSection(db, await verified(), { section: 'email', values: { 'email.replyTo': 'a-pisa@korum.test' }, versions: { 'email.replyTo': seen } }, MOCK));
    expect(error.reason).toBe('STALE');
    expect(await getSetting(db, 'email.replyTo')).toBe('c@korum.test');
  });

  it('dos altas a la vez de un ajuste sin fila: una gana y la otra recibe STALE (no un error genérico)', async () => {
    await db.platformSetting.deleteMany({ where: { key: 'paycomet.jetId' } });
    invalidateSettingsCache();
    const [first, second] = [await verified(), await verified()];
    const run = (actor: VerifiedSuperadminActor, jetId: string) => saveSettingsSection(db, actor, { section: 'pagos', values: { 'paycomet.jetId': jetId }, versions: { 'paycomet.jetId': 0 } }, MOCK);
    const results = await Promise.allSettled([run(first, 'jet-alta-uno'), run(second, 'jet-alta-dos')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ reason: 'STALE' });
  });

  it('el remitente y «responder a» no se copian a la auditoría (pueden ser el buzón de una persona y se conserva 6 años)', async () => {
    await save('email', { 'email.fromAddress': 'persona.concreta@korum.test', 'email.replyTo': 'otra.persona@korum.test' });
    const rows = await db.auditLog.findMany({ where: { action: 'settings.setting.updated', targetId: { in: ['email.fromAddress', 'email.replyTo'] } }, orderBy: { id: 'desc' }, take: 2 });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('persona');
    expect(JSON.stringify(rows)).not.toContain('korum.test');
  });

  it('un valor guardado que ya no se ofrece (SMTP) no impide guardar el bloque: se corrige eligiendo Brevo', async () => {
    await db.platformSetting.upsert({ where: { key: 'email.provider' }, create: { key: 'email.provider', valueJson: 'smtp', version: 1 }, update: { valueJson: 'smtp', version: 1 } });
    invalidateSettingsCache();
    expect((await save('email', { 'email.provider': 'brevo' })).changed).toBeGreaterThanOrEqual(1);
    expect(await getSetting(db, 'email.provider')).toBe('brevo');
  });

  it('el NIF y la razón social del emisor van juntos: con uno solo no se guarda (sin los dos no se emite ninguna factura)', async () => {
    const error = await rejection(save('facturacion', { 'invoicing.issuerNif': 'B12345674' }));
    expect(error.reason).toBe('INVOICING_PAIR');
    expect(error.fields).toEqual(['invoicing.issuerNif', 'invoicing.issuerName']);
    expect((await rejection(save('facturacion', { 'invoicing.issuerNif': 'B12345679', 'invoicing.issuerName': 'KORUM Tecnología S.L.' }))).reason).toBe('INVALID');
    const saved = await save('facturacion', { 'invoicing.issuerNif': 'B12345674', 'invoicing.issuerName': 'KORUM Tecnología S.L.', 'invoicing.series': 'KR' });
    expect(saved.changed).toBe(2);
    // Quitar solo uno vuelve a rechazarse.
    expect((await rejection(save('facturacion', { 'invoicing.issuerName': '' }))).reason).toBe('INVOICING_PAIR');
  });

  it('el monedero con saldo exige proveedor, su clave, la confirmación expresa y, para salir, que no haya saldos de familias', async () => {
    expect((await rejection(save('hucha', { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': '' }))).reason).toBe('WALLET_PROVIDER_REQUIRED');
    expect((await rejection(save('hucha', { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Mangopay' }))).reason).toBe('WALLET_KEY_REQUIRED');
    await saveSecretValue(db, await verified(), { key: 'hucha.walletApiKey', value: SECRET_VALUE }, MOCK);
    expect((await rejection(save('hucha', { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Mangopay' }))).reason).toBe('WALLET_CONFIRMATION_REQUIRED');
    expect(await getSetting(db, 'hucha.mode')).not.toBe('REGULATED_WALLET');

    await save('hucha', { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Mangopay' }, { confirmations: ['walletLegal'] });
    expect(await getSetting(db, 'hucha.mode')).toBe('REGULATED_WALLET');
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'settings.setting.updated', targetId: 'hucha.mode' }, orderBy: { id: 'desc' } });
    // La confirmación del proveedor y de la revisión legal queda anotada junto al cambio de modo.
    expect(audit.metadataJson).toMatchObject({ newSetting: 'REGULATED_WALLET', walletLegalConfirmed: true });

    // Con saldos de familias abiertos tampoco se cambia la entidad que los custodia.
    const holder = await createUser(db, { walletBalanceCents: 300 });
    expect((await rejection(save('hucha', { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Otra entidad' }))).fields).toEqual(['hucha.walletProvider']);
    await db.user.update({ where: { id: holder.id }, data: { walletBalanceCents: 0 } });

    // Con el monedero activo no se quita la clave de la entidad que lo custodia.
    expect((await rejection(removeSecretValue(db, await verified(), { key: 'hucha.walletApiKey' }, MOCK))).reason).toBe('WALLET_KEY_REQUIRED');
    expect(await db.platformSecret.count({ where: { key: 'hucha.walletApiKey' } })).toBe(1);

    // Con un saldo de una familia no se puede salir del monedero.
    const family = await createUser(db, { walletBalanceCents: 1_250 });
    expect((await rejection(save('hucha', { 'hucha.mode': 'PLEDGE', 'hucha.walletProvider': 'Mangopay' }))).reason).toBe('WALLET_BALANCES_OPEN');
    await db.user.update({ where: { id: family.id }, data: { walletBalanceCents: 0 } });
    await save('hucha', { 'hucha.mode': 'PLEDGE', 'hucha.walletProvider': 'Mangopay' });
    expect(await getSetting(db, 'hucha.mode')).toBe('PLEDGE');
  });

  it('un rastreador con un salto de línea (que colaría directivas en robots.txt), con asterisco, repetido o sin nombre válido se rechaza', async () => {
    const policy = (search: Array<{ userAgent: string; allow: boolean }>, training: Array<{ userAgent: string; allow: boolean }> = []) => ({ search, training });
    for (const userAgent of ['Bot\nAllow: /panel/', 'Bot\r\nDisallow: /', '*', 'Mi Bot', '', 'a', 'Bot;x', 'Bot/1.0']) {
      expect((await rejection(save('seo', { 'seo.aiCrawlers': policy([{ userAgent, allow: true }]) }))).fields).toEqual(['seo.aiCrawlers']);
    }
    expect((await rejection(save('seo', { 'seo.aiCrawlers': policy([{ userAgent: 'GPTBot', allow: true }], [{ userAgent: 'gptbot', allow: false }]) }))).fields).toEqual(['seo.aiCrawlers']);
    await save('seo', { 'seo.aiCrawlers': policy([{ userAgent: 'PerplexityBot', allow: false }], [{ userAgent: 'GPTBot', allow: true }]) });
    expect(await getSetting(db, 'seo.aiCrawlers')).toEqual(policy([{ userAgent: 'PerplexityBot', allow: false }], [{ userAgent: 'GPTBot', allow: true }]));
  });

  it('el código de verificación de buscadores solo admite letras, cifras, guion y guion bajo (va dentro de una etiqueta meta)', async () => {
    for (const token of ['"><script>alert(1)</script>', 'corto', 'con espacios 12345678', 'a'.repeat(201)]) {
      expect((await rejection(save('seo', { 'seo.verification.google': token }))).fields).toEqual(['seo.verification.google']);
    }
    await save('seo', { 'seo.verification.google': 'abcDEF123_-xyz', 'seo.verification.bing': '0123456789ABCDEF' });
    expect(await getSetting(db, 'seo.verification.bing')).toBe('0123456789ABCDEF');
  });

  it('los datos de la empresa se validan (NIF y emails) y se pueden borrar', async () => {
    const company = { legalName: 'KORUM Tecnología S.L.', taxId: 'B12345674', address: 'Calle Mayor 1, 28001 Madrid', supportEmail: 'soporte@korum.test', privacyEmail: 'privacidad@korum.test' };
    expect((await rejection(save('empresa', { 'platform.company': { ...company, taxId: 'B12345679' } }))).fields).toEqual(['platform.company.taxId']);
    expect((await rejection(save('empresa', { 'platform.company': { ...company, supportEmail: 'no-es-email' } }))).fields).toEqual(['platform.company.supportEmail']);
    // Si fallan varios campos se dicen todos, cada uno por su nombre.
    expect((await rejection(save('empresa', { 'platform.company': { ...company, legalName: '', privacyEmail: 'no' } }))).fields.sort()).toEqual(['platform.company.legalName', 'platform.company.privacyEmail']);
    // Un campo que no existe no se guarda: se descarta.
    await save('empresa', { 'platform.company': { ...company, extra: 'no permitido' } });
    expect(await getSetting(db, 'platform.company')).toEqual(company);
    // La auditoría no copia nada de la empresa (domicilio, NIF, emails).
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'settings.setting.updated', targetId: 'platform.company' }, orderBy: { id: 'desc' } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('Calle Mayor');
    expect(JSON.stringify(audit.metadataJson)).not.toContain('B12345674');
    await save('empresa', { 'platform.company': null });
    expect(await db.platformSetting.findUnique({ where: { key: 'platform.company' } })).toBeNull();
  });
});

describe('QA-SEC07 · secretos', () => {
  it('se guardan cifrados, no se devuelven nunca y no aparecen en la auditoría, la vista ni los errores', async () => {
    const actor = await verified();
    const saved = await saveSecretValue(db, actor, { key: 'paycomet.apiKey', value: SECRET_VALUE }, MOCK);
    expect(saved.hint).toBe('ZZZZ');
    const row = await db.platformSecret.findUniqueOrThrow({ where: { key: 'paycomet.apiKey' } });
    expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
    expect(await getSecret(db, TEST_KEYRING, 'paycomet.apiKey')).toBe(SECRET_VALUE);

    const view = await loadSettingsView(db, MOCK, { actorUserId: actor.userId });
    expect(JSON.stringify(view)).not.toContain(SECRET_VALUE);
    expect(view.secrets['paycomet.apiKey']).toMatchObject({ configured: true, hint: 'ZZZZ' });

    const audits = await db.auditLog.findMany({ where: { action: { startsWith: 'settings.secret' } } });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(audits)).not.toContain('ZZZZ');

    // Un secreto demasiado corto o una clave que no existe se rechazan sin repetir el valor.
    const short = await rejection(saveSecretValue(db, actor, { key: 'paycomet.apiKey', value: 'corto' }, MOCK));
    expect(short.message).not.toContain('corto');
    expect((await rejection(saveSecretValue(db, actor, { key: 'platform.company', value: SECRET_VALUE }, MOCK))).reason).toBe('INVALID');
    expect((await describeSecrets(db, ['paycomet.apiKey']))[0]?.configured).toBe(true);

    // La auditoría de la clave guarda quién y desde dónde (HMAC de la red y familia de navegador), no el valor.
    await saveSecretValue(db, actor, { key: 'seo.indexNowKey', value: 'clave-indexnow-12345-larga' }, MOCK, { ipHash: 'hmac-de-la-red', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' });
    const withWho = await db.auditLog.findFirstOrThrow({ where: { action: 'settings.secret.updated', targetId: 'seo.indexNowKey' }, orderBy: { id: 'desc' } });
    expect(withWho).toMatchObject({ ipHash: 'hmac-de-la-red', userAgent: 'Chrome/Windows' });

    await removeSecretValue(db, actor, { key: 'paycomet.apiKey' }, MOCK);
    expect(await db.platformSecret.findUnique({ where: { key: 'paycomet.apiKey' } })).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'settings.secret.deleted', targetId: 'paycomet.apiKey' } })).toBeGreaterThanOrEqual(1);
  });
});

describe('QA-SEC07 · quitar claves con las mismas reglas que vaciar un campo', () => {
  it('con cobros de pruebas o reales no se quitan las claves de Paycomet ni de Brevo salvo que el servidor tenga una de respaldo; con el simulador sí', async () => {
    const actor = await verified();
    await saveSecretValue(db, actor, { key: 'paycomet.apiKey', value: SECRET_VALUE }, MOCK);
    await saveSecretValue(db, actor, { key: 'email.apiKey', value: SECRET_VALUE }, MOCK);
    for (const key of ['paycomet.apiKey', 'email.apiKey']) {
      expect((await rejection(removeSecretValue(db, actor, { key }, REAL))).reason).toBe('SECRET_REQUIRED');
      expect(await db.platformSecret.count({ where: { key } })).toBe(1);
    }
    // Con una variable de respaldo a la que volver, sí.
    await removeSecretValue(db, actor, { key: 'paycomet.apiKey' }, { ...REAL, fallbacks: { PAYCOMET_API_KEY: 'respaldo-del-servidor-1234' } });
    expect(await db.platformSecret.count({ where: { key: 'paycomet.apiKey' } })).toBe(0);
    // Con el simulador no hace falta.
    await removeSecretValue(db, actor, { key: 'email.apiKey' }, MOCK);
    expect(await db.platformSecret.count({ where: { key: 'email.apiKey' } })).toBe(0);
    // Una clave opcional (IndexNow) se quita siempre.
    await saveSecretValue(db, actor, { key: 'seo.indexNowKey', value: 'clave-indexnow-12345-larga' }, MOCK);
    await removeSecretValue(db, actor, { key: 'seo.indexNowKey' }, REAL);
  });
});

describe('QA-A05 · textos legales versionados', () => {
  const text = (over: Partial<{ document: string; locale: string; version: string; status: string; markdown: string; expectedVersion: number }> = {}) => ({ document: 'terminos', locale: 'es', version: dayOffset(0), status: 'BORRADOR', markdown: '# Términos\n\nTexto.', expectedVersion: 0, ...over });
  const current = async (key: string) => (await db.platformSetting.findUnique({ where: { key }, select: { version: true } }))?.version ?? 0;

  it('un texto nuevo se guarda como borrador, se publica y desde ese momento no se edita bajo la misma versión ni vuelve a borrador ni retrocede', async () => {
    const draft = await saveLegalText(db, await verified(), text());
    expect(draft).toMatchObject({ version: dayOffset(0), settingVersion: 1 });
    // Mientras es borrador se puede seguir editando con la misma versión.
    await saveLegalText(db, await verified(), text({ markdown: '# Términos\n\nTexto corregido.', expectedVersion: 1 }));
    await saveLegalText(db, await verified(), text({ status: 'PUBLICADO', markdown: '# Términos\n\nTexto corregido.', expectedVersion: 2 }));

    const key = 'legal.terminos.es';
    expect((await rejection(saveLegalText(db, await verified(), text({ status: 'PUBLICADO', markdown: 'Otro texto', expectedVersion: await current(key) })))).reason).toBe('VERSION_IN_USE');
    // Ni escribiendo la misma versión de otra forma (con «.0»): no entra, y la guardada no cambia.
    expect((await rejection(saveLegalText(db, await verified(), text({ status: 'PUBLICADO', version: `${dayOffset(0)}.0`, markdown: 'Otro texto', expectedVersion: await current(key) })))).fields).toEqual(['version']);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key } })).valueJson).toMatchObject({ markdown: '# Términos\n\nTexto corregido.' });
    expect((await rejection(saveLegalText(db, await verified(), text({ status: 'BORRADOR', version: dayOffset(0, 1), expectedVersion: await current(key) })))).reason).toBe('PUBLISHED_TO_DRAFT');
    expect((await rejection(saveLegalText(db, await verified(), text({ status: 'PUBLICADO', version: dayOffset(-1), expectedVersion: await current(key) })))).reason).toBe('VERSION_OLDER');
    // Una versión nueva del mismo día se publica con «.n».
    const next = await saveLegalText(db, await verified(), text({ status: 'PUBLICADO', version: dayOffset(0, 1), markdown: 'Texto de la versión 2', expectedVersion: await current(key) }));
    expect(next.version).toBe(dayOffset(0, 1));
    const stored = await getSetting(db, 'legal.terminos.es');
    expect(stored).toMatchObject({ version: dayOffset(0, 1), status: 'PUBLICADO' });
    // La auditoría guarda la versión y el estado, no el texto.
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'settings.setting.updated', targetId: key }, orderBy: { id: 'desc' } });
    expect(audit.metadataJson).toMatchObject({ legalVersion: dayOffset(0, 1), legalStatus: 'PUBLICADO' });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('versión 2');
  });

  it('una versión con formato imposible, una fecha futura publicada o una edición con la versión caducada se rechazan', async () => {
    expect((await rejection(saveLegalText(db, await verified(), text({ document: 'cookies', version: '2026-13-45' })))).fields).toEqual(['version']);
    expect((await rejection(saveLegalText(db, await verified(), text({ document: 'cookies', version: 'ayer' })))).fields).toEqual(['version']);
    expect((await rejection(saveLegalText(db, await verified(), text({ document: 'cookies', version: '2099-01-01', status: 'PUBLICADO' })))).reason).toBe('VERSION_NOT_TODAY');
    // Tampoco atrasada: la fecha de publicación es la de hoy y sirve de prueba.
    expect((await rejection(saveLegalText(db, await verified(), text({ document: 'aviso-legal', version: dayOffset(-5), status: 'PUBLICADO' })))).reason).toBe('VERSION_NOT_TODAY');
    // Solo la forma canónica: «.0» y los ceros a la izquierda serían la misma versión escrita de otra forma.
    for (const version of [`${dayOffset(0)}.0`, `${dayOffset(0)}.01`, `${dayOffset(0)}.1000`, `${dayOffset(0)}.`]) {
      expect((await rejection(saveLegalText(db, await verified(), text({ document: 'aviso-legal', version })))).fields).toEqual(['version']);
    }
    expect((await rejection(saveLegalText(db, await verified(), text({ document: 'cookies', expectedVersion: 7 })))).reason).toBe('STALE');
    expect((await rejection(saveLegalText(db, await verified(), { ...text({ document: 'cookies' }), locale: 'fr' }))).reason).toBe('INVALID');
    expect((await rejection(saveLegalText(db, await verified(), text({ document: 'cookies', markdown: '' })))).reason).toBe('INVALID');
    // Un borrador sí puede llevar una fecha futura (la de publicación prevista).
    await saveLegalText(db, await verified(), text({ document: 'cookies', version: '2099-01-01' }));
  });

  it('la versión de la política que guardan los consentimientos solo sube cuando los tres idiomas están publicados, pasa a la más antigua de las tres y nunca retrocede', async () => {
    await db.platformSetting.deleteMany({ where: { key: 'privacy.policyVersion' } });
    invalidateSettingsCache();
    const viewBefore = await loadSettingsView(db, MOCK, { actorUserId: (await verified()).userId });
    expect(viewBefore.legal.policyVersion).toBe('2026-11-01');

    // Publicar en un solo idioma no la mueve: una familia que acepta en castellano quedaría registrada con un texto catalán que no vio.
    await saveLegalText(db, await verified(), text({ document: 'privacidad', version: dayOffset(0), status: 'PUBLICADO' }));
    expect(await getSetting(db, 'privacy.policyVersion')).toBe('2026-11-01');
    await saveLegalText(db, await verified(), text({ document: 'privacidad', locale: 'ca', version: dayOffset(0), status: 'PUBLICADO' }));
    expect(await getSetting(db, 'privacy.policyVersion')).toBe('2026-11-01');
    // Un borrador del tercero tampoco.
    await saveLegalText(db, await verified(), text({ document: 'privacidad', locale: 'en', version: dayOffset(0), status: 'BORRADOR' }));
    expect(await getSetting(db, 'privacy.policyVersion')).toBe('2026-11-01');
    // Con los tres publicados pasa a la más antigua de las tres.
    await saveLegalText(db, await verified(), text({ document: 'privacidad', locale: 'en', version: dayOffset(0), status: 'PUBLICADO', expectedVersion: await current('legal.privacidad.en') }));
    expect(await getSetting(db, 'privacy.policyVersion')).toBe(dayOffset(0));

    // Una nueva versión en un idioma no la sube mientras los otros dos sigan en la anterior (la más antigua manda); cuando los tres la alcanzan, sube.
    await saveLegalText(db, await verified(), text({ document: 'privacidad', version: dayOffset(0, 1), status: 'PUBLICADO', markdown: 'Nueva', expectedVersion: await current('legal.privacidad.es') }));
    expect(await getSetting(db, 'privacy.policyVersion')).toBe(dayOffset(0));
    await saveLegalText(db, await verified(), text({ document: 'privacidad', locale: 'ca', version: dayOffset(0, 1), status: 'PUBLICADO', markdown: 'Nova', expectedVersion: await current('legal.privacidad.ca') }));
    await saveLegalText(db, await verified(), text({ document: 'privacidad', locale: 'en', version: dayOffset(0, 1), status: 'PUBLICADO', markdown: 'New', expectedVersion: await current('legal.privacidad.en') }));
    expect(await getSetting(db, 'privacy.policyVersion')).toBe(dayOffset(0, 1));
    // Nunca retrocede, aunque el estado guardado diga otra cosa.
    await db.platformSetting.update({ where: { key: 'legal.privacidad.ca' }, data: { valueJson: { version: '2026-01-01', status: 'PUBLICADO', markdown: 'Vieja' } } });
    invalidateSettingsCache();
    await saveLegalText(db, await verified(), text({ document: 'privacidad', locale: 'es', version: dayOffset(0, 2), status: 'PUBLICADO', markdown: 'Otra', expectedVersion: await current('legal.privacidad.es') }));
    expect(await getSetting(db, 'privacy.policyVersion')).toBe(dayOffset(0, 1));
  });

  it('la vista lista las doce combinaciones con su versión y estado, y manda el texto solo del documento elegido', async () => {
    const actor = await verified();
    const view = await loadSettingsView(db, MOCK, { actorUserId: actor.userId, text: { document: 'terminos', locale: 'es' } });
    expect(view.legal.overview).toHaveLength(12);
    expect(view.legal.overview.find((row) => row.document === 'terminos' && row.locale === 'es')).toMatchObject({ status: 'PUBLICADO', version: dayOffset(0, 1) });
    expect(view.legal.selected.text?.markdown).toBe('Texto de la versión 2');
    expect(JSON.stringify(view.legal.overview)).not.toContain('Texto de la versión 2');
  });
});

describe('QA-SEC07 · equipo de Super-Admin', () => {
  // Los topes de invitaciones y de emails por destinatario se acumulan entre pruebas: cada una parte de cero.
  beforeEach(async () => {
    await db.rateLimit.deleteMany({ where: { OR: [{ key: { startsWith: 'console:' } }, { key: { startsWith: 'auth:mail:' } }] } });
  });
  const deps = (sent: number[][] = []) => ({ appUrl: 'https://korum.test', hmacSecret: TEST_HMAC_SECRET, dispatch: (ids: readonly number[]) => void sent.push([...ids]) });
  const address = () => `${uniqueId('equipo')}@example.com`;
  const tokenOf = async (to: string) => {
    const message = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: to, templateKey: 'auth.invitation' }, orderBy: { id: 'desc' } });
    return ((message.payloadJson as { url: string }).url.split('#t=')[1] ?? '');
  };

  it('invita sin dar el rol todavía: el rol llega al aceptar y con contraseña de 12 o más caracteres; el email sale al momento', async () => {
    const actor = await verified();
    const sent: number[][] = [];
    const to = address();
    await inviteSuperadmin(db, actor, { email: to, locale: 'es' }, deps(sent));
    const user = await db.user.findUniqueOrThrow({ where: { email: to } });
    expect(user.isSuperadmin).toBe(false);
    expect(sent.flat()).toHaveLength(1);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: 'superadmin.invited', targetId: user.id } })).metadataJson).toEqual({ newAccount: true });
    // Ni el email de la persona ni el enlace quedan en la auditoría.
    expect(JSON.stringify(await db.auditLog.findMany({ where: { action: 'superadmin.invited', targetId: user.id } }))).not.toContain(to);

    const token = await tokenOf(to);
    await expect(acceptInvitation(db, token, 'corta')).rejects.toBeInstanceOf(InvitationError);
    await acceptInvitation(db, token, 'una-contraseña-larga-y-segura');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).isSuperadmin).toBe(true);
    // El enlace sirve una sola vez.
    await expect(acceptInvitation(db, token, 'una-contraseña-larga-y-segura')).rejects.toBeInstanceOf(InvitationError);
  });

  it('rechaza a quien ya es Super-Admin, a quien firma por una entidad, un email imposible o desechable, y si firma por una entidad mientras espera el enlace ya no vale', async () => {
    const actor = await verified();
    const existing = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const reason = async (email: string) => ((await inviteSuperadmin(db, actor, { email, locale: 'es' }, deps()).catch((error: unknown) => error)) as SuperadminTeamError).reason;
    expect(await reason(existing.email)).toBe('ALREADY_SUPERADMIN');

    const organization = await createOrganization(db);
    const signer = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: signer.id, role: 'DIRECTOR' } });
    expect(await reason(signer.email)).toBe('ENTITY_MEMBER');
    expect(await reason('esto-no-es-un-email')).toBe('INVALID_EMAIL');
    expect(await reason('alguien@mailinator.com')).toBe('INVALID_EMAIL');
    expect(((await inviteSuperadmin(db, actor, { email: '', locale: 'es' }, deps()).catch((error: unknown) => error)) as SuperadminTeamError).reason).toBe('INVALID_INPUT');
    expect(await db.user.count({ where: { id: signer.id, isSuperadmin: true } })).toBe(0);

    const late = address();
    await inviteSuperadmin(db, actor, { email: late, locale: 'ca' }, deps());
    const lateUser = await db.user.findUniqueOrThrow({ where: { email: late } });
    expect(lateUser.locale).toBe('ca');
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: lateUser.id, role: 'COSIGNER' } });
    await expect(acceptInvitation(db, await tokenOf(late), 'una-contraseña-larga-y-segura')).rejects.toBeInstanceOf(InvitationError);
    expect((await db.user.findUniqueOrThrow({ where: { id: lateUser.id } })).isSuperadmin).toBe(false);
  });

  it('el enlace va siempre a la dirección de la cuenta, no a la que se teclea con un alias (+…) que busca la misma cuenta: quien abriera ese enlace se quedaría con una cuenta ajena', async () => {
    const actor = await verified();
    const sent: number[][] = [];
    const owner = await createUser(db);
    const [local, domain] = owner.email.split('@');
    const alias = `${local}+korum@${domain}`;
    await inviteSuperadmin(db, actor, { email: alias, locale: 'es' }, deps(sent));
    expect(await db.outboxMessage.count({ where: { toAddress: alias } })).toBe(0);
    const message = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: owner.email, templateKey: 'auth.invitation' } });
    expect(message.userId).toBe(owner.id);
    await db.verification.deleteMany({ where: { identifier: { startsWith: `korum-invite:${owner.id}:` } } });
  });

  it('el idioma de la cuenta nueva es el que se elige al invitar', async () => {
    const actor = await verified();
    const to = address();
    await inviteSuperadmin(db, actor, { email: to, locale: 'en' }, deps());
    expect((await db.user.findUniqueOrThrow({ where: { email: to } })).locale).toBe('en');
    expect((await db.outboxMessage.findFirstOrThrow({ where: { toAddress: to } })).locale).toBe('en');
  });

  it('solo los cargos que firman impiden la invitación (dirección y cofirma): un cargo de familia o de portería no', async () => {
    const actor = await verified();
    const organization = await createOrganization(db);
    const gatekeeper = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: gatekeeper.id, role: 'GATEKEEPER' } });
    await inviteSuperadmin(db, actor, { email: gatekeeper.email, locale: 'es' }, deps());
    const link = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: gatekeeper.email, templateKey: 'auth.invitation' } });
    const token = (link.payloadJson as { url: string }).url.split('#t=')[1] ?? '';
    await acceptInvitationWithSession(db, token, gatekeeper.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: gatekeeper.id } })).isSuperadmin).toBe(true);
    await db.user.update({ where: { id: gatekeeper.id }, data: { isSuperadmin: false } });
  });

  it('aceptar a la vez el rol de Super-Admin y un cargo de firma no deja a la misma persona con los dos', async () => {
    for (let round = 0; round < 4; round += 1) {
      const organization = await createOrganization(db);
      const person = await createUser(db);
      const admin = await createInvitation(db, { userId: person.id, organizationId: null, purpose: 'SUPERADMIN' });
      const cosigner = await createInvitation(db, { userId: person.id, organizationId: organization.id, purpose: 'COSIGNER', roleLabel: 'Presidencia', displayName: 'Persona' });
      const results = await Promise.allSettled([acceptInvitationWithSession(db, admin.token, person.id), acceptInvitationWithSession(db, cosigner.token, person.id)]);
      const [row, members] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: person.id } }), db.organizationMember.count({ where: { userId: person.id, role: { in: ['DIRECTOR', 'COSIGNER'] } } })]);
      expect(row.isSuperadmin && members > 0, `ronda ${round}`).toBe(false);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      await db.user.update({ where: { id: person.id }, data: { isSuperadmin: false } });
    }
  });

  it('anular la invitación de una cuenta creada solo para ella no deja la cuenta huérfana, pero una cuenta con vida propia se conserva', async () => {
    const actor = await verified();
    const fresh = address();
    await inviteSuperadmin(db, actor, { email: fresh, locale: 'es' }, deps());
    const user = await db.user.findUniqueOrThrow({ where: { email: fresh } });
    await cancelSuperadminInvitation(db, actor, { userId: user.id });
    expect(await db.user.count({ where: { id: user.id } })).toBe(0);

    const family = await createUser(db, { emailVerified: true });
    await inviteSuperadmin(db, actor, { email: family.email, locale: 'es' }, deps());
    await cancelSuperadminInvitation(db, actor, { userId: family.id });
    expect(await db.user.count({ where: { id: family.id } })).toBe(1);
  });

  it('retirar el acceso anula también su invitación pendiente: con su contraseña no puede recuperar el rol aceptando el enlace antiguo', async () => {
    const actor = await verified();
    const other = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const { token } = await createInvitation(db, { userId: other.id, organizationId: null, purpose: 'SUPERADMIN' });
    await revokeSuperadmin(db, actor, { userId: other.id });
    await expect(acceptInvitationWithSession(db, token, other.id)).rejects.toBeInstanceOf(InvitationError);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).isSuperadmin).toBe(false);
  });

  it('pedir otra invitación anula la anterior, y se puede anular una pendiente; solo cinco invitaciones al día', async () => {
    const actor = await verified();
    const to = address();
    await inviteSuperadmin(db, actor, { email: to, locale: 'es' }, deps());
    const first = await tokenOf(to);
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'auth:mail:' } } });
    await inviteSuperadmin(db, actor, { email: to, locale: 'es' }, deps());
    await expect(acceptInvitation(db, first, 'una-contraseña-larga-y-segura')).rejects.toBeInstanceOf(InvitationError);

    const user = await db.user.findUniqueOrThrow({ where: { email: to } });
    await cancelSuperadminInvitation(db, actor, { userId: user.id });
    await expect(acceptInvitation(db, await tokenOf(to), 'una-contraseña-larga-y-segura')).rejects.toBeInstanceOf(InvitationError);
    await expect(cancelSuperadminInvitation(db, actor, { userId: user.id })).rejects.toMatchObject({ reason: 'NOT_FOUND' });

    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'console:superadmin-invite:' } } });
    const outcomes: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      outcomes.push(await inviteSuperadmin(db, actor, { email: address(), locale: 'es' }, deps()).then(() => 'OK', (error: SuperadminTeamError) => error.reason));
    }
    expect(outcomes).toEqual(['OK', 'OK', 'OK', 'OK', 'OK', 'RATE_LIMITED']);
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'console:superadmin-invite:' } } });
  });

  it('retirar el acceso quita el rol y cierra sus sesiones al momento; no a uno mismo ni a la última persona con segundo factor; dos a la vez no vacían la consola', async () => {
    const actor = await verified();
    const other = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId: other.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId: other.id, expiresAt: new Date(Date.now() + 3_600_000) } });

    await expect(revokeSuperadmin(db, actor, { userId: actor.userId })).rejects.toMatchObject({ reason: 'SELF' });
    await expect(revokeSuperadmin(db, actor, { userId: 'no-existe' })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    await revokeSuperadmin(db, actor, { userId: other.id });
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).isSuperadmin).toBe(false);
    expect(await db.session.count({ where: { userId: other.id } })).toBe(0);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: 'superadmin.revoked', targetId: other.id } })).metadataJson).toEqual({ sessionsClosed: 2 });
    await expect(revokeSuperadmin(db, actor, { userId: other.id })).rejects.toMatchObject({ reason: 'NOT_FOUND' });

    // Dos Super-Admin que se retiran el acceso a la vez: como mucho uno lo consigue y siempre queda alguien con segundo factor.
    const [first, second] = [await verified(), await verified()];
    const everyone = await db.user.findMany({ where: { isSuperadmin: true, gdprAnonymizedAt: null }, select: { id: true } });
    const settled = await Promise.allSettled([revokeSuperadmin(db, first, { userId: second.userId }), revokeSuperadmin(db, second, { userId: first.userId })]);
    expect(settled.filter((result) => result.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    // El que llegó segundo se encuentra sin acceso (ya no es Super-Admin cuando le toca el turno).
    for (const result of settled) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(SuperadminRequiredError);
    expect(await db.user.count({ where: { isSuperadmin: true, twoFactorEnabled: true, gdprAnonymizedAt: null } })).toBeGreaterThanOrEqual(1);
    // Quien queda sin el rol vuelve a tenerlo para no dejar la base de pruebas cambiada para otros archivos.
    await db.user.updateMany({ where: { id: { in: everyone.map((row) => row.id) } }, data: { isSuperadmin: true } });
  });
});

describe('QA-A05 · probar la conexión', () => {
  const respond = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  afterEach(async () => {
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'console:connection-test:' } } });
  });

  it('con cobros simulados no llama a nadie; Veri*factu solo comprueba que el emisor está completo', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = { ...MOCK, fetchImpl };
    const actor = await verified();
    expect(await testConnection(db, actor, 'paycomet', runtime)).toEqual({ status: 'SIMULATED' });
    expect(await testConnection(db, actor, 'email', runtime)).toEqual({ status: 'SIMULATED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await db.platformSetting.deleteMany({ where: { key: { in: ['invoicing.issuerNif', 'invoicing.issuerName'] } } });
    invalidateSettingsCache();
    expect(await testConnection(db, actor, 'invoicing', runtime)).toEqual({ status: 'NOT_CONFIGURED', missing: ['invoicing.issuerNif', 'invoicing.issuerName'] });
    await save('facturacion', { 'invoicing.issuerNif': 'B12345674', 'invoicing.issuerName': 'KORUM Tecnología S.L.' });
    expect(await testConnection(db, actor, 'invoicing', runtime)).toEqual({ status: 'SIMULATED' });
    await expect(testConnection(db, actor, 'otro', runtime)).rejects.toBeInstanceOf(SettingsRejectedError);
  });

  it('con cobros de pruebas dice qué falta sin llamar a Paycomet, y con todo puesto distingue OK, rechazo con su código y corte de red; la respuesta del proveedor no se copia', async () => {
    const actor = await verified();
    const calls = vi.fn();
    expect(await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl: calls as unknown as typeof fetch })).toMatchObject({ status: 'NOT_CONFIGURED' });
    expect(calls).not.toHaveBeenCalled();

    await save('pagos', { 'paycomet.merchantCode': 'KORUM-COMERCIO', 'paycomet.terminalId': '12345', 'paycomet.serverIp': '203.0.113.7' });
    await saveSecretValue(db, actor, { key: 'paycomet.apiKey', value: SECRET_VALUE }, MOCK);
    await saveSecretValue(db, actor, { key: 'paycomet.webhookSecret', value: 'contraseña-del-webhook' }, MOCK);

    const ok = respond(200, { errorCode: 0, operations: [] });
    expect(await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl: ok })).toEqual({ status: 'OK' });
    const [url, init] = (ok as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('https://rest.paycomet.com/v1/payments/search');
    expect((init.headers as Record<string, string>)['PAYCOMET-API-TOKEN']).toBe(SECRET_VALUE);

    const rejected = await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl: respond(401, { errorCode: 1004, secreto: SECRET_VALUE }) });
    expect(rejected).toEqual({ status: 'FAILED', code: '1004' });
    const down = await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl: vi.fn(async () => { throw new Error(`fallo con ${SECRET_VALUE}`); }) as unknown as typeof fetch });
    expect(down).toEqual({ status: 'FAILED', code: 'NETWORK' });

    const audits = await db.auditLog.findMany({ where: { action: 'settings.connection_tested', targetId: 'paycomet' } });
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audits)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(rejected)).not.toContain(SECRET_VALUE);
  });

  it('un ajuste guardado que no es válido o una clave que no se descifra se dice en lenguaje llano y deja rastro; el código del proveedor solo se acepta si tiene forma de código', async () => {
    const actor = await verified();
    await db.platformSetting.upsert({ where: { key: 'paycomet.serverIp' }, create: { key: 'paycomet.serverIp', valueJson: 'no-es-una-ip', version: 1 }, update: { valueJson: 'no-es-una-ip', version: 1 } });
    invalidateSettingsCache();
    expect(await testConnection(db, actor, 'paycomet', REAL)).toEqual({ status: 'FAILED', code: 'CONFIG' });
    await db.platformSetting.update({ where: { key: 'paycomet.serverIp' }, data: { valueJson: '203.0.113.7' } });
    invalidateSettingsCache();

    await save('pagos', { 'paycomet.merchantCode': 'KORUM-COMERCIO', 'paycomet.terminalId': '12345' });
    await saveSecretValue(db, actor, { key: 'paycomet.apiKey', value: SECRET_VALUE }, MOCK);
    await saveSecretValue(db, actor, { key: 'paycomet.webhookSecret', value: 'contraseña-del-webhook' }, MOCK);
    // El código sale del cuerpo de la respuesta del proveedor: texto libre o con marcas no se enseña.
    const hostile = await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl: respond(400, { errorCode: '<img src=x onerror=alert(1)> lo que sea' }) });
    expect(hostile).toEqual({ status: 'FAILED', code: 'UNKNOWN' });
    // Una consulta de prueba con demasiados resultados es que el proveedor aceptó las credenciales.
    const operations = Array.from({ length: 10_000 }, (_, index) => ({ order: `KD${index}`, amount: 100, authCode: 'a', timestamp: '20261113120000', state: 1, operationType: 1 }));
    expect(await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl: respond(200, { errorCode: 0, operations }) })).toEqual({ status: 'OK' });
    // Una clave que no se descifra con el llavero (otra versión de clave) también se dice con su causa.
    await db.platformSecret.update({ where: { key: 'paycomet.apiKey' }, data: { ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } });
    invalidateSettingsCache();
    const neverCalled = vi.fn() as unknown as typeof fetch;
    expect(await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl: neverCalled })).toEqual({ status: 'FAILED', code: 'CONFIG' });
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it('el email pregunta a Brevo con la clave guardada, sin enviar nada, y distingue clave rechazada de corte de red', async () => {
    const actor = await verified();
    await db.platformSetting.deleteMany({ where: { key: { in: ['email.fromAddress', 'email.provider'] } } });
    await db.platformSecret.deleteMany({ where: { key: 'email.apiKey' } });
    invalidateSettingsCache();
    expect(await testConnection(db, actor, 'email', REAL)).toMatchObject({ status: 'NOT_CONFIGURED', missing: expect.arrayContaining(['email.apiKey', 'email.fromAddress']) });
    await save('email', { 'email.provider': 'brevo', 'email.fromAddress': 'hola@korum.test' }, { runtime: REAL });
    await saveSecretValue(db, actor, { key: 'email.apiKey', value: SECRET_VALUE }, MOCK);

    const ok = respond(200, { email: 'cuenta@brevo.test' });
    expect(await testConnection(db, actor, 'email', { ...REAL, fetchImpl: ok })).toEqual({ status: 'OK' });
    const [url, init] = (ok as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('https://api.brevo.com/v3/account');
    expect(init.method).toBe('GET');
    expect(await testConnection(db, actor, 'email', { ...REAL, fetchImpl: respond(401) })).toEqual({ status: 'FAILED', code: 'REJECTED' });
    expect(await testConnection(db, actor, 'email', { ...REAL, fetchImpl: respond(503) })).toEqual({ status: 'FAILED', code: 'NETWORK' });
  });

  it('solo diez pruebas cada diez minutos por persona', async () => {
    const actor = await verified();
    const results: string[] = [];
    for (let index = 0; index < 11; index += 1) results.push((await testConnection(db, actor, 'invoicing', MOCK)).status);
    expect(results.filter((status) => status === 'RATE_LIMITED')).toHaveLength(1);
    expect(results[10]).toBe('RATE_LIMITED');
  });
});

describe('QA-A05 · un ajuste de buscadores que ya no valida no tumba la web pública', () => {
  it('solo se ignora ese valor: las tarifas públicas y los demás ajustes se siguen leyendo de la consola', async () => {
    await db.platformSetting.upsert({ where: { key: 'seo.verification.google' }, create: { key: 'seo.verification.google', valueJson: 'valor con \n salto', version: 1 }, update: { valueJson: 'valor con \n salto', version: 1 } });
    await db.platformSetting.upsert({ where: { key: 'seo.verification.bing' }, create: { key: 'seo.verification.bing', valueJson: 'bingtoken12345', version: 1 }, update: { valueJson: 'bingtoken12345', version: 1 } });
    invalidateSettingsCache();
    resetPublicConfigMemo();
    await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
    const config = await loadPublicPlatformConfig(db);
    expect(config.source).toBe('console');
    expect(config.verification).toEqual({ bing: 'bingtoken12345' });
    expect(config.pricing).toBeDefined();
    await db.platformSetting.deleteMany({ where: { key: { in: ['seo.verification.google', 'seo.verification.bing'] } } });
    invalidateSettingsCache();
    resetPublicConfigMemo();
  });
});

describe('QA-SEC07 · solo el Super-Admin verificado', () => {
  it('sin segundo factor reciente (11 minutos) nada se guarda ni se prueba, y cada operación dice que hay que volver a verificar', async () => {
    await db.platformSecret.deleteMany({ where: { key: 'paycomet.apiKey' } });
    invalidateSettingsCache();
    const old = new Date(Date.now() - 11 * 60_000);
    const stale = await verified(old);
    const attempts: Array<Promise<unknown>> = [
      saveSettingsSection(db, stale, { section: 'pagos', values: { 'paycomet.jetId': 'x-vieja-1234' }, versions: { 'paycomet.jetId': 0 } }, MOCK),
      saveSecretValue(db, stale, { key: 'paycomet.apiKey', value: SECRET_VALUE }, MOCK),
      removeSecretValue(db, stale, { key: 'paycomet.apiKey' }, MOCK),
      saveLegalText(db, stale, { document: 'terminos', locale: 'es', version: dayOffset(0), status: 'BORRADOR', markdown: 'x', expectedVersion: 0 }),
      inviteSuperadmin(db, stale, { email: `${uniqueId('x')}@example.com`, locale: 'es' }, { appUrl: 'https://korum.test', hmacSecret: TEST_HMAC_SECRET, dispatch: () => undefined }),
      revokeSuperadmin(db, stale, { userId: 'cualquiera' }),
      testConnection(db, stale, 'invoicing', MOCK)
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(await db.platformSecret.findUnique({ where: { key: 'paycomet.apiKey' } })).toBeNull();
  });

  it('un Super-Admin dado de baja o con la sesión cerrada tampoco puede, aunque conserve el actor verificado de hace un minuto', async () => {
    const { admin, session, actor } = await verifiedSuperadmin(db);
    await db.session.delete({ where: { id: session.id } });
    await expect(saveSettingsSection(db, actor, { section: 'pagos', values: { 'paycomet.jetId': 'sin-sesion-123' }, versions: { 'paycomet.jetId': 0 } }, MOCK)).rejects.toBeInstanceOf(SuperadminRequiredError);
    const second = await verifiedSuperadmin(db);
    await db.user.update({ where: { id: second.admin.id }, data: { isSuperadmin: false } });
    await expect(saveSecretValue(db, second.actor, { key: 'paycomet.apiKey', value: SECRET_VALUE }, MOCK)).rejects.toBeInstanceOf(SuperadminRequiredError);
    void admin;
  });

  it('la pantalla solo se lee con el Super-Admin y su segundo factor: una familia, una persona firmante o un Super-Admin sin segundo factor reciben 403 y queda anotado', async () => {
    const organization = await createOrganization(db);
    const family = await createUser(db);
    const director = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const run = (userId: string, secondFactor: boolean) => loadUserActor(db, userId, { ipHash: 'hash-de-ip' }, { secondFactor }).then((actor) => getConsoleSettings(db, actor, MOCK, {}));

    await expect(run(family.id, true)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(run(director.id, true)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(run(admin.id, false)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.auditLog.count({ where: { action: 'tenant.access_denied', actorUserId: director.id, targetType: 'PlatformSetting' } })).toBe(1);
    const view = await run(admin.id, true);
    expect(view.team.members.some((member) => member.id === admin.id && member.isYou)).toBe(true);
    expect(await db.auditLog.count({ where: { action: 'superadmin.access', actorUserId: admin.id, targetType: 'PlatformSetting' } })).toBe(1);
  });
});

describe('QA-A05 · vista, claves de cifrado e historial', () => {
  it('la vista enseña el valor efectivo de cada campo con su origen (consola, variable de respaldo o por defecto) y su versión', async () => {
    const actor = await verified();
    await save('email', { 'email.fromName': 'Colegio Demo' });
    vi.stubEnv('VERIFACTU_ISSUER_NAME', 'Respaldo S.L.');
    try {
      await db.platformSetting.deleteMany({ where: { key: 'invoicing.issuerName' } });
      const view = await loadSettingsView(db, MOCK, { actorUserId: actor.userId });
      expect(view.fields['email.fromName']).toMatchObject({ value: 'Colegio Demo', source: 'console' });
      expect(view.fields['email.fromName']!.version).toBeGreaterThanOrEqual(1);
      expect(view.fields['invoicing.issuerName']).toMatchObject({ value: 'Respaldo S.L.', version: 0, source: 'env' });
      expect(view.fields['hucha.mode']).toMatchObject({ source: expect.stringMatching(/default|console/) });
      expect(view.fields['paycomet.jetId']).toBeDefined();
      expect(view.paycometMode).toBe('mock');
      expect(view.fixedLimits.length).toBeGreaterThan(4);
      // La tabla de límites fijos lee la constante: el tope de pagos por red enseña el valor vigente (600 cada 15 minutos).
      expect(view.fixedLimits.find((row) => row.id === 'checkout')).toMatchObject({ limit: 600, windowMs: 15 * 60_000 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('cuenta lo pendiente de volver a cifrar con la clave actual y las alertas abiertas de claves y privacidad', async () => {
    const actor = await verified();
    const view = await loadSettingsView(db, { ...MOCK, encryptionKeyVersion: 2, previousKeyCount: 1 }, { actorUserId: actor.userId });
    expect(view.security).toMatchObject({ keyVersion: 2, previousKeys: 1 });
    expect(view.security.pending).toHaveProperty('PlatformSecret');
    expect(view.security.pendingTotal).toBe(Object.values(view.security.pending).reduce((sum, count) => sum + count, 0));
    expect(view.security.alerts).toEqual({ CARD_DELETE_FAILED: expect.any(Number), PRIVACY_REQUEST_OVERDUE: expect.any(Number), ENCRYPTION_KEY_MISSING: expect.any(Number) });
  });

  it('el historial lista los cambios de más recientes a más antiguos con quién y cuándo, la versión, el valor solo si es corto y no personal, y sin ningún secreto', async () => {
    const actor = await verified();
    await save('limites', { 'raffle.extraRoundMinHours': '48' });
    await saveSecretValue(db, actor, { key: 'seo.indexNowKey', value: 'clave-indexnow-12345' }, MOCK);
    const view = await loadSettingsView(db, MOCK, { actorUserId: actor.userId, historyLimit: 25 });
    expect(view.history.rows.length).toBeGreaterThan(5);
    const times = view.history.rows.map((row) => row.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const change = view.history.rows.find((row) => row.target === 'raffle.extraRoundMinHours' && row.action === 'settings.setting.updated');
    expect(change).toMatchObject({ value: '48', version: expect.any(Number) });
    expect(change?.actorEmail).toBeTruthy();
    expect(JSON.stringify(view.history)).not.toContain('clave-indexnow-12345');
    expect(view.history.rows.find((row) => row.action === 'settings.secret.updated')?.value).toBeNull();
    // Pedir más páginas respeta el máximo.
    const many = await loadSettingsView(db, MOCK, { actorUserId: actor.userId, historyLimit: 100_000 });
    expect(many.history.limit).toBe(200);
  });
});
