import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { legalToday } from '@/core/admin/settings-model';
import { acceptInvitationWithSession, createInvitation } from '@/core/onboarding/invitations';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { KorumPrismaClient } from '@/lib/prisma';
import { testConnection } from '@/services/admin/connection-tests';
import { removeSecretValue, saveLegalText, saveSecretValue, saveSettingsSection, SettingsRejectedError } from '@/services/admin/platform-settings.service';
import { loadSettingsView } from '@/services/admin/platform-settings-view';
import type { SettingsRuntime } from '@/services/admin/settings-runtime';
import { cancelSuperadminInvitation, inviteSuperadmin } from '@/services/admin/superadmin-team.service';
import { getSetting, invalidateSettingsCache } from '@/services/settings/settings.service';
import { createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.4 · segunda pasada de la auditoría de seguridad (QA-A05, QA-SEC07): un borrador con fecha futura no bloquea su publicación; los tres idiomas de la política publicados a la
 * vez suben la versión vigente; el monedero con saldo no se activa mientras se quita su clave; los datos imprescindibles de Paycomet no se vacían; anular una invitación se ordena con
 * aceptarla y solo borra cuentas que creó ella y nadie ha usado; la confirmación del monedero se anota solo al activarlo y se ve en el historial; y las variables de respaldo inyectadas
 * son las únicas que se usan.
 */

const MOCK: SettingsRuntime = { paycometMode: 'mock', keyring: TEST_KEYRING, encryptionKeyVersion: 1, previousKeyCount: 0, fallbacks: {} };
const REAL: SettingsRuntime = { ...MOCK, paycometMode: 'sandbox' };
const SECRET_VALUE = 'clave-del-monedero-0123456789-ZZZZ';
const KEYS = ['paycomet.merchantCode', 'paycomet.terminalId', 'paycomet.serverIp', 'paycomet.jetId', 'hucha.mode', 'hucha.walletProvider', 'privacy.policyVersion'];
const SECRETS = ['hucha.walletApiKey', 'paycomet.apiKey', 'paycomet.webhookSecret'];
const DAY_MS = 86_400_000;
const today = () => legalToday(new Date());
const dayOffset = (days: number) => legalToday(new Date(Date.now() + days * DAY_MS));

let db: KorumPrismaClient;
const verified = async (): Promise<VerifiedSuperadminActor> => (await verifiedSuperadmin(db)).actor;
const versionsOf = async (keys: string[]) => Object.fromEntries(await Promise.all(keys.map(async (key) => [key, (await db.platformSetting.findUnique({ where: { key }, select: { version: true } }))?.version ?? 0] as const)));
const save = async (section: string, values: Record<string, unknown>, options: { runtime?: SettingsRuntime; confirmations?: string[] } = {}) =>
  saveSettingsSection(db, await verified(), { section, values, versions: await versionsOf(Object.keys(values)), confirmations: options.confirmations ?? [] }, options.runtime ?? MOCK);
const rejection = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(SettingsRejectedError);
  return error as SettingsRejectedError;
};
const text = (over: Record<string, unknown> = {}) => ({ document: 'cookies', locale: 'es', version: today(), status: 'BORRADOR', markdown: 'Texto.', expectedVersion: 0, ...over });
const currentVersion = async (key: string) => (await db.platformSetting.findUnique({ where: { key }, select: { version: true } }))?.version ?? 0;

async function wipe() {
  await db.platformSetting.deleteMany({ where: { OR: [{ key: { in: KEYS } }, { key: { startsWith: 'legal.' } }] } });
  await db.platformSecret.deleteMany({ where: { key: { in: SECRETS } } });
  await db.rateLimit.deleteMany({ where: { OR: [{ key: { startsWith: 'console:' } }, { key: { startsWith: 'auth:mail:' } }] } });
  invalidateSettingsCache();
}

let originalPolicy: unknown;
beforeAll(async () => {
  db = createTestClient();
  originalPolicy = (await db.platformSetting.findUnique({ where: { key: 'privacy.policyVersion' } }))?.valueJson;
  await wipe();
}, 120_000);
beforeEach(wipe);
afterEach(() => invalidateSettingsCache());
afterAll(async () => {
  await wipe();
  if (originalPolicy !== undefined) await db.platformSetting.create({ data: { key: 'privacy.policyVersion', valueJson: originalPolicy as string } });
  await db.$disconnect();
});

describe('textos legales', () => {
  it('un borrador con una fecha futura (o una errata) no bloquea su publicación: se publica con la de hoy; un texto ya publicado sigue sin poder retroceder', async () => {
    await saveLegalText(db, await verified(), text({ version: '2099-01-01' }));
    const stored = await currentVersion('legal.cookies.es');
    // Publicar con la fecha de hoy funciona aunque el borrador llevara una posterior.
    expect((await saveLegalText(db, await verified(), text({ status: 'PUBLICADO', expectedVersion: stored }))).version).toBe(today());
    // Ya publicado, una versión anterior sí se rechaza.
    expect((await rejection(saveLegalText(db, await verified(), text({ status: 'PUBLICADO', version: dayOffset(-1), markdown: 'Otro', expectedVersion: await currentVersion('legal.cookies.es') })))).reason).toBe('VERSION_OLDER');
  });

  it('publicar la política de privacidad en los tres idiomas a la vez sube la versión vigente (cada publicación ve las otras ya confirmadas)', async () => {
    for (let round = 0; round < 3; round += 1) {
      await db.platformSetting.deleteMany({ where: { OR: [{ key: 'privacy.policyVersion' }, { key: { startsWith: 'legal.privacidad.' } }] } });
      invalidateSettingsCache();
      const actors = [await verified(), await verified(), await verified()];
      const results = await Promise.allSettled(
        (['es', 'ca', 'en'] as const).map((locale, index) => saveLegalText(db, actors[index]!, text({ document: 'privacidad', locale, status: 'PUBLICADO', markdown: `Texto ${locale}` })))
      );
      expect(results.filter((result) => result.status === 'rejected'), `ronda ${round}`).toEqual([]);
      invalidateSettingsCache();
      expect(await getSetting(db, 'privacy.policyVersion'), `ronda ${round}`).toBe(today());
    }
  });
});

describe('Paycomet, monedero y claves', () => {
  it('con cobros de pruebas o reales el código de comercio y el terminal no se vacían salvo que el servidor tenga una variable de respaldo; con el simulador sí', async () => {
    await save('pagos', { 'paycomet.merchantCode': 'KORUM-COMERCIO', 'paycomet.terminalId': '12345' });
    for (const key of ['paycomet.merchantCode', 'paycomet.terminalId']) {
      const error = await rejection(save('pagos', { [key]: '' }, { runtime: REAL }));
      expect(error).toMatchObject({ reason: 'FIELD_REQUIRED', fields: [key] });
      expect(await db.platformSetting.count({ where: { key } })).toBe(1);
    }
    // Con una variable de respaldo a la que volver, sí; y con el simulador también.
    await save('pagos', { 'paycomet.merchantCode': '' }, { runtime: { ...REAL, fallbacks: { PAYCOMET_MERCHANT_CODE: 'RESPALDO' } } });
    expect(await db.platformSetting.count({ where: { key: 'paycomet.merchantCode' } })).toBe(0);
    await save('pagos', { 'paycomet.terminalId': '' });
    expect(await db.platformSetting.count({ where: { key: 'paycomet.terminalId' } })).toBe(0);
  });

  it('activar el monedero con saldo a la vez que se quita su clave nunca lo deja activo sin clave', async () => {
    for (let round = 0; round < 4; round += 1) {
      await wipe();
      const actor = await verified();
      await saveSecretValue(db, actor, { key: 'hucha.walletApiKey', value: SECRET_VALUE }, MOCK);
      await save('hucha', { 'hucha.mode': 'PLEDGE', 'hucha.walletProvider': 'Mangopay' });
      const versions = await versionsOf(['hucha.mode', 'hucha.walletProvider']);
      await Promise.allSettled([
        saveSettingsSection(db, await verified(), { section: 'hucha', values: { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Mangopay' }, versions, confirmations: ['walletLegal'] }, MOCK),
        removeSecretValue(db, await verified(), { key: 'hucha.walletApiKey' }, MOCK)
      ]);
      const mode = (await db.platformSetting.findUnique({ where: { key: 'hucha.mode' } }))?.valueJson;
      const hasKey = (await db.platformSecret.count({ where: { key: 'hucha.walletApiKey' } })) === 1;
      expect(mode === 'REGULATED_WALLET' && !hasKey, `ronda ${round}`).toBe(false);
    }
  });

  it('dos guardados a la vez del bloque Mi Hucha (activar el monedero y salir de él quitando el proveedor) nunca dejan el monedero activo sin proveedor', async () => {
    for (let round = 0; round < 6; round += 1) {
      await wipe();
      await saveSecretValue(db, await verified(), { key: 'hucha.walletApiKey', value: SECRET_VALUE }, MOCK);
      await save('hucha', { 'hucha.mode': 'PLEDGE', 'hucha.walletProvider': 'Mangopay' });
      const versions = await versionsOf(['hucha.mode', 'hucha.walletProvider']);
      await Promise.allSettled([
        saveSettingsSection(db, await verified(), { section: 'hucha', values: { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Mangopay' }, versions, confirmations: ['walletLegal'] }, MOCK),
        saveSettingsSection(db, await verified(), { section: 'hucha', values: { 'hucha.mode': 'PLEDGE', 'hucha.walletProvider': '' }, versions, confirmations: [] }, MOCK)
      ]);
      const mode = (await db.platformSetting.findUnique({ where: { key: 'hucha.mode' } }))?.valueJson;
      const provider = await db.platformSetting.findUnique({ where: { key: 'hucha.walletProvider' } });
      expect(mode === 'REGULATED_WALLET' && provider === null, `ronda ${round}`).toBe(false);
    }
  });

  it('la confirmación del monedero se anota solo al activarlo, y el historial la enseña; cambiar de entidad con saldos abiertos tiene su propio motivo', async () => {
    const actor = await verified();
    await saveSecretValue(db, actor, { key: 'hucha.walletApiKey', value: SECRET_VALUE }, MOCK);
    // Marcar la casilla al pasar a otro modo no deja constancia de nada.
    await save('hucha', { 'hucha.mode': 'DISABLED', 'hucha.walletProvider': 'Mangopay' }, { confirmations: ['walletLegal'] });
    const disabled = await db.auditLog.findFirstOrThrow({ where: { action: 'settings.setting.updated', targetId: 'hucha.mode' }, orderBy: { id: 'desc' } });
    expect(JSON.stringify(disabled.metadataJson)).not.toContain('walletLegalConfirmed');

    await save('hucha', { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Mangopay' }, { confirmations: ['walletLegal'] });
    const view = await loadSettingsView(db, MOCK, { actorUserId: actor.userId, historyLimit: 25 });
    expect(view.history.rows.find((row) => row.target === 'hucha.mode' && row.walletConfirmed)).toBeDefined();
    expect(view.history.rows.filter((row) => row.target === 'hucha.mode' && !row.walletConfirmed)).toHaveLength(1);

    const holder = await createUser(db, { walletBalanceCents: 500 });
    expect(await rejection(save('hucha', { 'hucha.mode': 'REGULATED_WALLET', 'hucha.walletProvider': 'Otra entidad' }))).toMatchObject({ reason: 'WALLET_PROVIDER_LOCKED', fields: ['hucha.walletProvider'] });
    await db.user.update({ where: { id: holder.id }, data: { walletBalanceCents: 0 } });
  });

  it('las variables de respaldo inyectadas son las únicas que se usan: «Probar conexión» no mira las del proceso y la caché no las mezcla', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errorCode: 0, operations: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const actor = await verified();
    await save('pagos', { 'paycomet.serverIp': '203.0.113.7' });
    // Sin nada guardado ni respaldo inyectado, falta todo (aunque el entorno del proceso tuviera algo).
    expect(await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl })).toMatchObject({ status: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const fallbacks = { PAYCOMET_API_KEY: 'respaldo-del-servidor-clave-1234', PAYCOMET_WEBHOOK_SECRET: 'respaldo-del-webhook', PAYCOMET_MERCHANT_CODE: 'RESPALDO', PAYCOMET_TERMINAL_ID: '777' };
    expect(await testConnection(db, actor, 'paycomet', { ...REAL, fallbacks, fetchImpl })).toEqual({ status: 'OK' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Una segunda llamada sin respaldos vuelve a decir que falta (no queda nada en la caché de la anterior).
    expect(await testConnection(db, actor, 'paycomet', { ...REAL, fetchImpl })).toMatchObject({ status: 'NOT_CONFIGURED' });
  });
});

describe('equipo de Super-Admin', () => {
  const deps = () => ({ appUrl: 'https://korum.test', hmacSecret: TEST_HMAC_SECRET, dispatch: () => undefined });
  const address = () => `${uniqueId('hard')}@example.com`;

  it('anular la invitación de una cuenta que se creó para ella borra la cuenta, pero no si alguien la ha usado para algo (una contraseña, un cargo, una sesión)', async () => {
    const actor = await verified();
    for (const use of ['account', 'session'] as const) {
      const to = address();
      await inviteSuperadmin(db, actor, { email: to, locale: 'es' }, deps());
      const user = await db.user.findUniqueOrThrow({ where: { email: to } });
      if (use === 'account') await db.account.create({ data: { id: uniqueId('acc'), accountId: user.id, providerId: 'credential', userId: user.id, password: 'hash' } });
      else await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) } });
      await cancelSuperadminInvitation(db, actor, { userId: user.id });
      expect(await db.user.count({ where: { id: user.id } }), use).toBe(1);
    }
    // Una cuenta que ya existía (no la creó esta invitación) tampoco se borra aunque esté sin usar.
    const bare = await createUser(db, { emailVerified: false });
    await inviteSuperadmin(db, actor, { email: bare.email, locale: 'es' }, deps());
    await cancelSuperadminInvitation(db, actor, { userId: bare.id });
    expect(await db.user.count({ where: { id: bare.id } })).toBe(1);
  });

  it('anular la invitación no borra una cuenta con un relevo pendiente hacia ella, con otra invitación abierta ni con un cargo (aunque sea de portería)', async () => {
    const actor = await verified();
    const organization = await createOrganization(db);
    const outgoing = await createUser(db);
    const member = await db.organizationMember.create({ data: { organizationId: organization.id, userId: outgoing.id, role: 'COSIGNER' } });

    // 1. Un relevo pendiente (todavía sin invitación) apunta a la cuenta.
    const handover = address();
    await inviteSuperadmin(db, actor, { email: handover, locale: 'es' }, deps());
    const handoverUser = await db.user.findUniqueOrThrow({ where: { email: handover } });
    await db.signerHandover.create({
      data: { organizationId: organization.id, role: 'COSIGNER', outgoingMemberId: member.id, outgoingUserId: outgoing.id, incomingUserId: handoverUser.id, roleLabel: 'Presidencia', displayName: 'Persona', proposedByUserId: outgoing.id, status: 'AWAITING_CONSENT', expiresAt: new Date(Date.now() + 3_600_000) }
    });
    await cancelSuperadminInvitation(db, actor, { userId: handoverUser.id });
    expect(await db.user.count({ where: { id: handoverUser.id } })).toBe(1);

    // 2. Otra invitación abierta (de cofirma de una entidad) a la misma cuenta.
    const other = address();
    await inviteSuperadmin(db, actor, { email: other, locale: 'es' }, deps());
    const otherUser = await db.user.findUniqueOrThrow({ where: { email: other } });
    await createInvitation(db, { userId: otherUser.id, organizationId: organization.id, purpose: 'COSIGNER', roleLabel: 'Presidencia', displayName: 'Persona' });
    await cancelSuperadminInvitation(db, actor, { userId: otherUser.id });
    expect(await db.user.count({ where: { id: otherUser.id } })).toBe(1);

    // 3. Un cargo de portería.
    const gate = address();
    await inviteSuperadmin(db, actor, { email: gate, locale: 'es' }, deps());
    const gateUser = await db.user.findUniqueOrThrow({ where: { email: gate } });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: gateUser.id, role: 'GATEKEEPER' } });
    await cancelSuperadminInvitation(db, actor, { userId: gateUser.id });
    expect(await db.user.count({ where: { id: gateUser.id } })).toBe(1);
  });

  it('anular y aceptar la misma invitación a la vez no acaba en error de interbloqueo: una de las dos gana', async () => {
    const actor = await verified();
    for (let round = 0; round < 6; round += 1) {
      await db.rateLimit.deleteMany({ where: { OR: [{ key: { startsWith: 'console:' } }, { key: { startsWith: 'auth:mail:' } }] } });
      const to = address();
      await inviteSuperadmin(db, actor, { email: to, locale: 'es' }, deps());
      const user = await db.user.findUniqueOrThrow({ where: { email: to } });
      const message = await db.outboxMessage.findFirstOrThrow({ where: { toAddress: to, templateKey: 'auth.invitation' } });
      const token = (message.payloadJson as { url: string }).url.split('#t=')[1] ?? '';
      const results = await Promise.allSettled([cancelSuperadminInvitation(db, actor, { userId: user.id }), acceptInvitationWithSession(db, token, user.id)]);
      for (const result of results) {
        if (result.status === 'rejected') expect(String((result.reason as Error).message), `ronda ${round}`).not.toMatch(/deadlock|40P01|interbloqueo/i);
      }
      await db.user.updateMany({ where: { id: user.id }, data: { isSuperadmin: false } });
    }
  });
});
