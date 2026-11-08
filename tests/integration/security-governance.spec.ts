import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdeaSignatureRejectedError, signIdea } from '@/core/security/device-quorum.service';
import { completeSignature, DoubleCheckNotAllowedError, MAX_OTP_ATTEMPTS, requestSignature as requestSignatureReceipt, type SignatureTarget } from '@/core/security/double-check.service';
import { evaluateDoubleCheck } from '@/core/security/double-check-evaluation';
import { computeSignatureHash, ideaTargetDigest, verifySignatureHash } from '@/core/security/signature-hash';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { approvePayout, executeApprovedPayout, PayoutNotAllowedError } from '@/services/payments/split-transfer.service';
import { createInitiative, createOrganization, createTestClient, createUser, uniqueId } from './test-database';

const SECRET = 'secreto-de-integracion-de-las-firmas-0123456789';
const NOW = new Date('2026-11-10T10:00:00.000Z');
let db: KorumPrismaClient;

/**
 * El enlace y el código de la firma ya no salen del servicio hacia quien llama: viajan por email. Las pruebas los leen de la bandeja de
 * salida, que es lo que recibiría la persona firmante.
 */
async function secretsSentTo(client: KorumPrismaClient, userId: string): Promise<{ token: string; otp: string }> {
  const message = await client.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId }, orderBy: { id: 'desc' } });
  const payload = message.payloadJson as { token: string; otp: string };
  return { token: payload.token, otp: payload.otp };
}

const requestSignature = async (...args: Parameters<typeof requestSignatureReceipt>) => {
  const receipt = await requestSignatureReceipt(...args);
  return { ...receipt, ...(await secretsSentTo(args[0] as KorumPrismaClient, receipt.signerUserId)) };
};

beforeAll(async () => {
  db = createTestClient();
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.$disconnect();
});

const actorFor = (userId: string, overrides: Partial<Extract<SessionActor, { kind: 'user' }>> = {}, memberships: Array<{ organizationId: string; role: MemberRole }> = []): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true, ...overrides });

async function createIdea(organizationId: string, overrides: { phase?: 'PUBLIC_VOTING' | 'DOUBLE_CHECK' | 'PHASE0_MOD'; expiresAt?: Date; verifiedVotes?: number; authorCanonicalEmail?: string } = {}) {
  return db.idea.create({
    data: { organizationId, alias: uniqueId('#FAM'), authorCanonicalEmail: overrides.authorCanonicalEmail ?? `${uniqueId('autor')}@pruebas.example`, title: 'Taller de lectura', category: 'Cultura', description: 'Un taller para todo el curso', phase: overrides.phase ?? 'PUBLIC_VOTING', verifiedVotes: overrides.verifiedVotes ?? 1, expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 86_400_000) }
  });
}

const familyUser = (overrides: Parameters<typeof createUser>[1] = {}) => createUser(db, overrides);
const cookieOf = (result: Awaited<ReturnType<typeof signIdea>>) => (result.status === 'SIGNED' ? (result.newDeviceCookie ?? undefined) : undefined);

describe('QA-SEC02 · firma de ideas', () => {
  it('las variantes de un mismo Gmail solo firman una vez', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const local = uniqueId('laura').replace(/[^a-z0-9]/g, '');
    const first = await familyUser({ email: `${local}+1@gmail.com`, canonicalEmail: `antigua-1-${local}` });
    const second = await familyUser({ email: `${local.slice(0, 3)}.${local.slice(3)}@gmail.com`, canonicalEmail: `antigua-2-${local}` });
    expect((await signIdea(db, SECRET, { ideaId: idea.id, userId: first.id }, NOW)).status).toBe('SIGNED');
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: second.id }, NOW)).toEqual({ status: 'ALREADY_SIGNED' });
    expect(await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).toMatchObject({ votes: 2, verifiedVotes: 2 });
  });

  it('en un dispositivo, 1ª y 2ª cuenta verificadas; la 3ª no suma a verifiedVotes', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const [madre, padre, tercera] = [await familyUser(), await familyUser(), await familyUser()];
    const first = await signIdea(db, SECRET, { ideaId: idea.id, userId: madre.id }, NOW);
    expect(first).toMatchObject({ status: 'SIGNED', audit: { status: 'VERIFIED', deviceAccountOrder: 1 } });
    const deviceCookie = cookieOf(first);
    expect(deviceCookie).toBeTruthy();
    const second = await signIdea(db, SECRET, { ideaId: idea.id, userId: padre.id, deviceCookie }, NOW);
    expect(second).toMatchObject({ status: 'SIGNED', newDeviceCookie: null, audit: { status: 'VERIFIED', deviceAccountOrder: 2 } });
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: tercera.id, deviceCookie }, NOW)).toMatchObject({ audit: { status: 'SUSPICIOUS', reasonKey: 'ideas.audit.tooManyAccounts', deviceAccountOrder: 3 } });
    expect(await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).toMatchObject({ votes: 4, verifiedVotes: 3, suspiciousVotes: 1 });

    const other = await createIdea(organization.id);
    expect(await signIdea(db, SECRET, { ideaId: other.id, userId: madre.id, deviceCookie }, NOW)).toMatchObject({ audit: { status: 'VERIFIED', deviceAccountOrder: 1 } });
  });

  it('una ráfaga desde la misma red queda sospechosa; otra red y otra idea no se ven afectadas', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    for (let i = 0; i < 6; i += 1) expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id, ip: `83.45.12.${i + 1}` }, NOW)).toMatchObject({ audit: { status: 'VERIFIED' } });
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id, ip: '83.45.12.99' }, NOW)).toMatchObject({ audit: { status: 'SUSPICIOUS', reasonKey: 'ideas.audit.ipBurst' } });
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id, ip: '83.45.13.1' }, NOW)).toMatchObject({ audit: { status: 'VERIFIED' } });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id, ip: '83.45.12.100' }, later)).toMatchObject({ audit: { status: 'VERIFIED' } });
    const other = await createIdea(organization.id);
    expect(await signIdea(db, SECRET, { ideaId: other.id, userId: (await familyUser()).id, ip: '83.45.12.101' }, NOW)).toMatchObject({ audit: { status: 'VERIFIED' } });
    const stored = await db.ideaSignatureAudit.findMany({ where: { ideaId: idea.id } });
    expect(stored.every((row) => row.ipSubnetHash)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('83.45');
  });

  it('sin consentimiento no se guarda ni se usa la huella; al retirarlo se borra', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const fingerprint = uniqueId('huella');
    const sinPermiso = await familyUser();
    const result = await signIdea(db, SECRET, { ideaId: idea.id, userId: sinPermiso.id, fingerprint }, NOW);
    const audit = await db.ideaSignatureAudit.findFirstOrThrow({ where: { ideaId: idea.id, userId: sinPermiso.id } });
    expect((await db.device.findUniqueOrThrow({ where: { id: audit.deviceId! } })).fingerprintHmac).toBeNull();

    const conPermiso = await familyUser();
    await db.consentRecord.create({ data: { userId: conPermiso.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas', createdAt: new Date(NOW.getTime() - 1_000) } });
    await signIdea(db, SECRET, { ideaId: idea.id, userId: conPermiso.id, deviceCookie: cookieOf(result), fingerprint }, NOW);
    const device = await db.device.findUniqueOrThrow({ where: { id: audit.deviceId! } });
    expect(device.fingerprintHmac).toBeTruthy();
    expect(device.fingerprintHmac).not.toContain(fingerprint);

    await db.consentRecord.create({ data: { userId: conPermiso.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: 'v1', source: 'pruebas', createdAt: new Date(NOW.getTime() + 1_000) } });
    const other = await createIdea(organization.id);
    await signIdea(db, SECRET, { ideaId: other.id, userId: conPermiso.id, deviceCookie: cookieOf(result), fingerprint }, new Date(NOW.getTime() + 2_000));
    expect((await db.device.findUniqueOrThrow({ where: { id: audit.deviceId! } })).fingerprintHmac).toBeNull();
  });

  it('con consentimiento, borrar la cookie no reinicia la cuenta de la familia', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const fingerprint = uniqueId('huella');
    const users = [await familyUser(), await familyUser(), await familyUser()];
    for (const user of users) await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas' } });
    const results = [];
    for (const user of users) results.push(await signIdea(db, SECRET, { ideaId: idea.id, userId: user.id, fingerprint, ip: '83.61.1.1' }, NOW));
    expect(results.map((result) => (result.status === 'SIGNED' ? result.audit.status : null))).toEqual(['VERIFIED', 'VERIFIED', 'SUSPICIOUS']);
  });

  it('cambiar de email no da una segunda firma en la misma idea', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const user = await familyUser();
    await signIdea(db, SECRET, { ideaId: idea.id, userId: user.id }, NOW);
    await db.user.update({ where: { id: user.id }, data: { email: `${uniqueId('nuevo')}@pruebas.example` } });
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: user.id }, NOW)).toEqual({ status: 'ALREADY_SIGNED' });
    expect(await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).toMatchObject({ votes: 2, verifiedVotes: 2 });
  });

  it('una cuenta con email nuevo sigue siendo la misma en su dispositivo', async () => {
    const organization = await createOrganization(db);
    const user = await familyUser();
    const deviceCookie = cookieOf(await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: user.id }, NOW));
    await db.user.update({ where: { id: user.id }, data: { email: `${uniqueId('nuevo')}@pruebas.example` } });
    expect(await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: user.id, deviceCookie }, NOW)).toMatchObject({ audit: { status: 'VERIFIED', deviceAccountOrder: 1 } });
  });

  it('la 3ª cuenta no vuelve a ser 1ª en otra idea, con su cookie, con o sin huella', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const fingerprint = uniqueId('huella');
    const users = [await familyUser(), await familyUser(), await familyUser()];
    for (const user of users) await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas' } });
    let third;
    for (const user of users) third = await signIdea(db, SECRET, { ideaId: idea.id, userId: user.id, fingerprint, ip: '83.60.1.1' }, NOW);
    const deviceCookie = cookieOf(third!);
    const withFingerprint = await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: users[2]!.id, deviceCookie, fingerprint, ip: '83.60.1.1' }, NOW);
    expect(withFingerprint).toMatchObject({ audit: { status: 'SUSPICIOUS', deviceAccountOrder: 3 } });
    const without = await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: users[2]!.id, deviceCookie, ip: '83.60.1.1' }, NOW);
    expect(without).toMatchObject({ audit: { status: 'SUSPICIOUS', deviceAccountOrder: 3 } });
  });

  it('sin IP válida no hay cruce de huellas: el grupo común no es una red', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const fingerprint = uniqueId('huella');
    const users = [await familyUser(), await familyUser(), await familyUser()];
    for (const user of users) await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas' } });
    const results = [];
    for (const user of users) results.push(await signIdea(db, SECRET, { ideaId: idea.id, userId: user.id, fingerprint, ip: 'unknown' }, NOW));
    expect(results.map((result) => (result.status === 'SIGNED' ? result.audit.deviceAccountOrder : 0))).toEqual([1, 1, 1]);
  });

  it('una firma antigua desde la misma red no suma en el cruce de huellas', async () => {
    const organization = await createOrganization(db);
    const fingerprint = uniqueId('huella');
    const [stranger, neighbour] = [await familyUser(), await familyUser()];
    for (const user of [stranger, neighbour]) await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas', createdAt: new Date(NOW.getTime() - 40 * 86_400_000) } });
    const old = new Date(NOW.getTime() - 31 * 86_400_000);
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id, { expiresAt: NOW })).id, userId: stranger.id, fingerprint, ip: '83.62.1.1' }, old);
    expect(await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: neighbour.id, fingerprint, ip: '83.62.1.2' }, NOW)).toMatchObject({ audit: { deviceAccountOrder: 1 } });
  });

  it('una familia ya conocida no empeora porque otra persona con su huella pase por su red', async () => {
    const organization = await createOrganization(db);
    const fingerprint = uniqueId('huella');
    const stranger = await familyUser();
    const parent = await familyUser();
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: parent.id, ip: '83.63.1.1' }, NOW);
    const deviceCookie = cookieOf(await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: (await familyUser()).id, ip: '83.63.1.2' }, NOW));
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: parent.id, deviceCookie, ip: '83.63.1.2' }, NOW);
    await db.consentRecord.create({ data: { userId: stranger.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas' } });
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: stranger.id, fingerprint, ip: '83.63.1.3' }, NOW);
    await db.consentRecord.create({ data: { userId: parent.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas' } });
    expect(await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: parent.id, deviceCookie, fingerprint, ip: '83.63.1.2' }, NOW)).toMatchObject({ audit: { status: 'VERIFIED', deviceAccountOrder: 2 } });
  });

  it('al retirar el consentimiento, lo que sumó la huella deja de afectar', async () => {
    const organization = await createOrganization(db);
    const fingerprint = uniqueId('huella');
    const users = [await familyUser(), await familyUser(), await familyUser()];
    for (const user of users) await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas', createdAt: new Date(NOW.getTime() - 1_000) } });
    const idea = await createIdea(organization.id);
    let third;
    for (const user of users) third = await signIdea(db, SECRET, { ideaId: idea.id, userId: user.id, fingerprint, ip: '83.64.1.1' }, NOW);
    expect(third).toMatchObject({ audit: { status: 'SUSPICIOUS', deviceAccountOrder: 3 } });
    await db.consentRecord.create({ data: { userId: users[2]!.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: 'v1', source: 'pruebas', createdAt: new Date(NOW.getTime() + 1_000) } });
    const after = await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: users[2]!.id, deviceCookie: cookieOf(third!), ip: '83.65.1.1' }, new Date(NOW.getTime() + 2_000));
    expect(after).toMatchObject({ audit: { status: 'VERIFIED', deviceAccountOrder: 1 } });
  });

  it('dos familias con la misma huella en redes distintas no se suman', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const fingerprint = uniqueId('huella');
    const users = [await familyUser(), await familyUser(), await familyUser()];
    for (const user of users) await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas' } });
    const results = [];
    for (const [index, user] of users.entries()) results.push(await signIdea(db, SECRET, { ideaId: idea.id, userId: user.id, fingerprint, ip: `83.${70 + index}.1.1` }, NOW));
    expect(results.every((result) => result.status === 'SIGNED' && result.audit.status === 'VERIFIED')).toBe(true);
  });

  it('al retirar el consentimiento la huella se borra de todos sus dispositivos', async () => {
    const organization = await createOrganization(db);
    const user = await familyUser();
    await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: 'v1', source: 'pruebas', createdAt: new Date(NOW.getTime() - 1_000) } });
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: user.id, fingerprint: uniqueId('a') }, NOW);
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: user.id, fingerprint: uniqueId('b') }, NOW);
    await db.consentRecord.create({ data: { userId: user.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: 'v1', source: 'pruebas', createdAt: new Date(NOW.getTime() + 1_000) } });
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: user.id }, new Date(NOW.getTime() + 2_000));
    const devices = await db.device.findMany({ where: { accounts: { some: { userId: user.id } } } });
    expect(devices.length).toBeGreaterThanOrEqual(2);
    expect(devices.every((device) => device.fingerprintHmac === null)).toBe(true);
  });

  it('una IP manipulada no apaga el control de ráfagas', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    for (let i = 0; i < 6; i += 1) await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id, ip: `1.2.3.${i}, 5.6.7.8` }, NOW);
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id, ip: 'unknown' }, NOW)).toMatchObject({ audit: { status: 'SUSPICIOUS', reasonKey: 'ideas.audit.ipBurst' } });
  });

  it('una cookie alterada no sirve: se trata como un dispositivo nuevo', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const result = await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id, deviceCookie: 'inventada.0000' }, NOW);
    expect(cookieOf(result)).toBeTruthy();
    expect(cookieOf(result)).not.toContain('inventada');
  });

  it('el quórum se alcanza solo con firmas verificadas y lleva la idea a la doble firma', async () => {
    const organization = await createOrganization(db, { minVotes: 3 });
    const idea = await createIdea(organization.id, { verifiedVotes: 2 });
    const fingerprintFree = await signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id }, NOW);
    expect(fingerprintFree).toMatchObject({ quorumReached: true });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('DOUBLE_CHECK');
    await expect(signIdea(db, SECRET, { ideaId: idea.id, userId: (await familyUser()).id }, NOW)).rejects.toMatchObject({ reason: 'IDEA_CLOSED' });

    const suspiciousOnly = await createIdea(organization.id, { verifiedVotes: 2 });
    for (let i = 0; i < 6; i += 1) await db.ideaSignatureAudit.create({ data: { ideaId: suspiciousOnly.id, canonicalEmail: `${uniqueId('previa')}@x.es`, reason: 'ideas.audit.firstAccount', ipSubnetHash: null } });
    const deviceCookie = cookieOf(await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: (await familyUser()).id }, NOW));
    await signIdea(db, SECRET, { ideaId: (await createIdea(organization.id)).id, userId: (await familyUser()).id, deviceCookie }, NOW);
    expect(await signIdea(db, SECRET, { ideaId: suspiciousOnly.id, userId: (await familyUser()).id, deviceCookie }, NOW)).toMatchObject({ quorumReached: false, audit: { status: 'SUSPICIOUS' } });
    expect((await db.idea.findUniqueOrThrow({ where: { id: suspiciousOnly.id } })).phase).toBe('PUBLIC_VOTING');
  });

  it.each([
    ['sin verificar el email', { emailVerified: false }, 'EMAIL_NOT_VERIFIED'],
    ['con correo desechable', () => ({ email: `${uniqueId('x')}@mailinator.com` }), 'DISPOSABLE_EMAIL'],
    ['anonimizada', { gdprAnonymizedAt: NOW }, 'ACCOUNT_ANONYMIZED']
  ])('una cuenta %s no firma', async (_name, overrides, reason) => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const user = await familyUser(typeof overrides === 'function' ? overrides() : overrides);
    await expect(signIdea(db, SECRET, { ideaId: idea.id, userId: user.id }, NOW)).rejects.toMatchObject({ reason });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).votes).toBe(1);
  });

  it('no se firma una idea en moderación o vencida, y la autoría ya cuenta como voto', async () => {
    const organization = await createOrganization(db);
    const user = await familyUser();
    await expect(signIdea(db, SECRET, { ideaId: (await createIdea(organization.id, { phase: 'PHASE0_MOD' })).id, userId: user.id }, NOW)).rejects.toBeInstanceOf(IdeaSignatureRejectedError);
    await expect(signIdea(db, SECRET, { ideaId: (await createIdea(organization.id, { expiresAt: NOW })).id, userId: user.id }, NOW)).rejects.toBeInstanceOf(IdeaSignatureRejectedError);
    const own = await createIdea(organization.id, { authorCanonicalEmail: user.email });
    expect(await signIdea(db, SECRET, { ideaId: own.id, userId: user.id }, NOW)).toEqual({ status: 'ALREADY_SIGNED' });
  });

  it('firmas simultáneas de una misma persona y de varias no pierden votos ni duplican', async () => {
    const organization = await createOrganization(db);
    const idea = await createIdea(organization.id);
    const repeated = await familyUser();
    const other = await familyUser();
    const results = await Promise.all([repeated, repeated, other].map((user) => signIdea(db, SECRET, { ideaId: idea.id, userId: user.id }, NOW)));
    expect(results.filter((result) => result.status === 'SIGNED')).toHaveLength(2);
    expect(await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).toMatchObject({ votes: 3, verifiedVotes: 3 });
    expect(await db.ideaSignatureAudit.count({ where: { ideaId: idea.id } })).toBe(2);
  });
});

describe('QA-SEC03 · doble firma', () => {
  async function team() {
    const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    const director = await createUser(db, { twoFactorEnabled: true });
    const cosigner = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
    const memberships = (role: MemberRole) => [{ organizationId: organization.id, role }];
    return { organization, director, cosigner, directorActor: actorFor(director.id, {}, memberships('DIRECTOR')), cosignerActor: actorFor(cosigner.id, {}, memberships('COSIGNER')) };
  }

  async function ideaTarget(organizationId: string) {
    const idea = await createIdea(organizationId, { phase: 'DOUBLE_CHECK' });
    return { idea, target: { targetType: 'IDEA_APPROVAL', ideaId: idea.id } as SignatureTarget };
  }

  async function payoutTarget(organizationId: string, overrides: { destinationType?: 'ORGANIZATION' | 'PROVIDER' } = {}) {
    const initiative = await createInitiative(db, organizationId, { status: 'GOAL_REACHED', goalCents: 3_000 });
    const payout = await db.escrowPayout.create({ data: { organizationId, initiativeId: initiative.id, destinationType: overrides.destinationType ?? 'ORGANIZATION', beneficiaryName: 'AFA', beneficiaryIban: 'ES00', netPaidCents: 2_700, korumFeeSettledCents: 200 } });
    return { payout, target: { targetType: 'ESCROW_PAYOUT', payoutId: payout.id } as SignatureTarget };
  }

  const auditCount = (action: string, organizationId: string) => db.auditLog.count({ where: { action, organizationId } });

  it('una idea pasa de 1/2 a 2/2 con dos personas y se convierte', async () => {
    const { organization, directorActor, cosignerActor, cosigner } = await team();
    const { idea, target } = await ideaTarget(organization.id);
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    expect(challenge.otp).toMatch(/^\d{6}$/);
    const first = await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW);
    expect(first).toMatchObject({ status: 'SIGNED', signatures: 1, complete: false, ideaConverted: false });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('DOUBLE_CHECK');

    const next = first.status === 'SIGNED' ? first.nextChallenges : [];
    expect(next.map((entry) => entry.signerUserId)).toEqual([cosigner.id]);
    const second = await completeSignature(db, SECRET, cosignerActor, (await secretsSentTo(db, next[0]!.signerUserId)), NOW);
    expect(second).toMatchObject({ status: 'SIGNED', signatures: 2, complete: true, ideaConverted: true });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('CONVERTED');
    expect(await db.doubleCheckSignature.count({ where: { ideaId: idea.id } })).toBe(2);
    expect(await auditCount('double_check.signed', organization.id)).toBe(2);
  });

  it('el DIRECTOR no puede ocupar también el segundo hueco', async () => {
    const { organization, director, directorActor } = await team();
    const { idea, target } = await ideaTarget(organization.id);
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW);
    await expect(requestSignature(db, SECRET, directorActor, organization.id, target, NOW)).rejects.toMatchObject({ reason: 'ALREADY_SIGNED' });
    const denied = await db.auditLog.findFirstOrThrow({ where: { action: 'double_check.denied', organizationId: organization.id } });
    expect(denied.metadataJson).toMatchObject({ stage: 'request', reason: 'ALREADY_SIGNED' });

    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'COSIGNER' } });
    await expect(requestSignature(db, SECRET, directorActor, organization.id, target, NOW)).rejects.toMatchObject({ reason: 'HOLDS_BOTH_ROLES' });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('DOUBLE_CHECK');
  });

  it('un Super-Admin, otra entidad o quien no firma no pueden pedir la firma', async () => {
    const { organization, directorActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const admin = await createUser(db, { isSuperadmin: true });
    await expect(requestSignature(db, SECRET, actorFor(admin.id, { isSuperadmin: true }), organization.id, target, NOW)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(requestSignature(db, SECRET, { kind: 'anonymous' }, organization.id, target, NOW)).rejects.toBeInstanceOf(TenantAccessError);

    const family = await createUser(db);
    await expect(requestSignature(db, SECRET, actorFor(family.id, {}, [{ organizationId: organization.id, role: 'FAMILY' }]), organization.id, target, NOW)).rejects.toBeInstanceOf(TenantAccessError);

    // La sesión dice que firma, pero la base de datos ya no.
    const removed = await createUser(db, { twoFactorEnabled: true });
    await expect(requestSignature(db, SECRET, actorFor(removed.id, {}, [{ organizationId: organization.id, role: 'DIRECTOR' }]), organization.id, target, NOW)).rejects.toMatchObject({ reason: 'NOT_A_SIGNER' });

    const other = await team();
    await expect(requestSignature(db, SECRET, other.directorActor, other.organization.id, target, NOW)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await auditCount('tenant.resource_outside_tenant', other.organization.id)).toBe(1);
    await expect(requestSignature(db, SECRET, directorActor, organization.id, { targetType: 'IDEA_APPROVAL', ideaId: 999_999_999 }, NOW)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('el enlace es de un solo uso, caduca a las 72 h y solo sirve a su destinatario', async () => {
    const { organization, directorActor, cosignerActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const late = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    expect(await completeSignature(db, SECRET, directorActor, { token: late.token, otp: late.otp }, new Date(NOW.getTime() + 72 * 3_600_000))).toEqual({ status: 'INVALID_LINK' });

    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    expect(await completeSignature(db, SECRET, directorActor, { token: late.token, otp: late.otp }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await completeSignature(db, SECRET, cosignerActor, { token: challenge.token, otp: challenge.otp }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await completeSignature(db, SECRET, { kind: 'anonymous' }, { token: challenge.token, otp: challenge.otp }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await auditCount('double_check.wrong_signer', organization.id)).toBe(2);
    expect(await completeSignature(db, SECRET, directorActor, { token: 'inventado', otp: '000000' }, NOW)).toEqual({ status: 'INVALID_LINK' });

    expect((await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW)).status).toBe('SIGNED');
    expect(await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW)).toEqual({ status: 'INVALID_LINK' });
  });

  it('el enlace y el OTP no se guardan en claro', async () => {
    const { organization, directorActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    const row = await db.doubleCheckChallenge.findFirstOrThrow({ where: { organizationId: organization.id } });
    expect(JSON.stringify(row)).not.toContain(challenge.token);
    expect(row.otpHmac).not.toContain(challenge.otp);
  });

  it(`tras ${MAX_OTP_ATTEMPTS} códigos erróneos el enlace se anula, aunque llegue el correcto`, async () => {
    const { organization, directorActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    const wrong = challenge.otp === '000000' ? '000001' : '000000';
    for (let left = MAX_OTP_ATTEMPTS - 1; left >= 0; left -= 1) expect(await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: wrong }, NOW)).toEqual({ status: 'INVALID_OTP', attemptsLeft: left });
    expect(await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await auditCount('double_check.otp_locked', organization.id)).toBe(1);
    expect(await db.doubleCheckSignature.count({ where: { organizationId: organization.id } })).toBe(0);
  });

  it('el mismo enlace usado a la vez solo firma una vez', async () => {
    const { organization, directorActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    const results = await Promise.all([1, 2, 3].map(() => completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW)));
    expect(results.filter((result) => result.status === 'SIGNED')).toHaveLength(1);
    expect(await db.doubleCheckSignature.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it('si lo que se pidió firmar cambia, el enlace ya no vale', async () => {
    const { organization, directorActor } = await team();
    const { payout, target } = await payoutTarget(organization.id);
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await db.escrowPayout.update({ where: { id: payout.id }, data: { netPaidCents: 2_800 } });
    expect(await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW)).toEqual({ status: 'TARGET_CHANGED' });
    expect(await db.doubleCheckSignature.count({ where: { payoutId: payout.id } })).toBe(0);
  });

  it('QA-NOT01 · el enlace y el código no salen en la respuesta: van por la bandeja de salida, a la persona firmante y en su idioma; pedir otro anula el email anterior', async () => {
    const { organization, director, directorActor } = await team();
    await db.user.update({ where: { id: director.id }, data: { locale: 'ca' } });
    const { target, payout } = await payoutTarget(organization.id);

    const receipt = await requestSignatureReceipt(db, SECRET, directorActor, organization.id, target, NOW);
    // Solo quién, con qué cargo, hasta cuándo y qué aviso de la bandeja de salida enviar al momento (heredado del 2.6): nunca el enlace ni el código.
    expect(Object.keys(receipt).sort()).toEqual(['expiresAt', 'notificationId', 'signerRole', 'signerUserId']);
    expect(typeof receipt.notificationId).toBe('number');
    const first = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId: director.id }, orderBy: { id: 'desc' } });
    expect(first).toMatchObject({ status: 'PENDING', toAddress: director.email, locale: 'ca', organizationId: organization.id });
    expect(first.payloadJson).toMatchObject({ targetType: 'ESCROW_PAYOUT', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), otp: expect.stringMatching(/^\d{6}$/), expiresAt: receipt.expiresAt.toISOString() });
    const initiative = await db.initiative.findUniqueOrThrow({ where: { id: payout.initiativeId }, select: { title: true } });
    expect((first.payloadJson as { targetTitle: string }).targetTitle).toBe(initiative.title);

    // El email anterior, si aún no ha salido, ya no sirve: se cancela y se vacía.
    await requestSignatureReceipt(db, SECRET, directorActor, organization.id, target, NOW);
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'CANCELLED', payloadJson: {} });
    const pending = await db.outboxMessage.findMany({ where: { templateKey: 'doubleCheck.pending', userId: director.id, status: 'PENDING' } });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBeGreaterThan(first.id);
  });

  it('si cambia el importe, la firma anterior se sustituye al volver a firmar y queda constancia', async () => {
    const { organization, directorActor } = await team();
    const { payout, target } = await payoutTarget(organization.id);
    const first = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await completeSignature(db, SECRET, directorActor, { token: first.token, otp: first.otp }, NOW);
    const oldHash = (await db.doubleCheckSignature.findFirstOrThrow({ where: { payoutId: payout.id } })).signatureHash;
    await db.escrowPayout.update({ where: { id: payout.id }, data: { netPaidCents: 2_800 } });
    const again = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    expect((await completeSignature(db, SECRET, directorActor, { token: again.token, otp: again.otp }, NOW)).status).toBe('SIGNED');
    const rows = await db.doubleCheckSignature.findMany({ where: { payoutId: payout.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signatureHash).not.toBe(oldHash);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: 'double_check.signature_superseded', organizationId: organization.id } });
    expect(log.metadataJson).toMatchObject({ signatureHash: oldHash, reason: 'HASH_MISMATCH', signerRole: 'DIRECTOR', signedAt: NOW.toISOString(), otpVerifiedAt: NOW.toISOString() });
    // Lo guardado permite volver a verificar la huella antigua, aunque el importe ya sea otro.
    const metadata = log.metadataJson as { targetDigest: string };
    const membership = await db.organizationMember.findFirstOrThrow({ where: { organizationId: organization.id, role: 'DIRECTOR' } });
    expect(verifySignatureHash(SECRET, { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: metadata.targetDigest, signerUserId: membership.userId, signerRole: 'DIRECTOR', membershipId: membership.id, signedAt: NOW, otpVerifiedAt: NOW }, oldHash)).toBe(true);
  });

  it('quien sustituye a un firmante que ya no tiene el rol puede firmar', async () => {
    const { organization, director, directorActor } = await team();
    const { target, payout } = await payoutTarget(organization.id);
    const first = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await completeSignature(db, SECRET, directorActor, { token: first.token, otp: first.otp }, NOW);
    await db.organizationMember.deleteMany({ where: { organizationId: organization.id, userId: director.id } });
    const replacement = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: replacement.id, role: 'DIRECTOR' } });
    const actor = actorFor(replacement.id, {}, [{ organizationId: organization.id, role: 'DIRECTOR' }]);
    const challenge = await requestSignature(db, SECRET, actor, organization.id, target, NOW);
    expect((await completeSignature(db, SECRET, actor, { token: challenge.token, otp: challenge.otp }, NOW)).status).toBe('SIGNED');
    expect((await db.doubleCheckSignature.findFirstOrThrow({ where: { payoutId: payout.id } })).signerUserId).toBe(replacement.id);
  });

  it('quien pierde el rol después de pedir el enlace ya no puede firmar', async () => {
    const { organization, director, directorActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await db.organizationMember.deleteMany({ where: { organizationId: organization.id, userId: director.id } });
    expect(await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW)).toEqual({ status: 'NOT_ALLOWED', reason: 'NOT_A_SIGNER' });
  });

  it('de extremo a extremo: dos firmas reales aprueban la liquidación y mueven el dinero', async () => {
    const { organization, directorActor, cosignerActor } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 1_000, bracketFeeCents: 100 });
    const provider = new MockPaycometProvider({ secrets: { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración' } });
    const contribution = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'DONATION', amountCents: 1_000, totalChargedCents: 1_000, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING', createdAt: new Date('2026-11-01T00:00:00Z') } });
    const { rawBody, contentType } = provider.buildNotification({ kind: 'PAYMENT', order: contribution.paycometOrder!, amountCents: 1_000 });
    await handlePaymentWebhook(db, provider, rawBody, contentType);
    expect((await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).status).toBe('COMPLETED');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('GOAL_REACHED');

    const payout = await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId: initiative.id, destinationType: 'ORGANIZATION', beneficiaryName: 'AFA', beneficiaryIban: 'ES00', netPaidCents: 900, korumFeeSettledCents: 100 } });
    const target = { targetType: 'ESCROW_PAYOUT', payoutId: payout.id } as SignatureTarget;
    const first = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    const signed = await completeSignature(db, SECRET, directorActor, { token: first.token, otp: first.otp }, NOW);
    await expect(approvePayout(db, payout.id, SECRET, NOW)).rejects.toBeInstanceOf(PayoutNotAllowedError);
    const next = signed.status === 'SIGNED' ? signed.nextChallenges[0]! : null;
    expect(await completeSignature(db, SECRET, cosignerActor, (await secretsSentTo(db, next!.signerUserId)), NOW)).toMatchObject({ status: 'SIGNED', complete: true, ideaConverted: false });
    expect((await db.escrowPayout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('PENDING_DOUBLE_CHECK');

    expect(await approvePayout(db, payout.id, SECRET, NOW)).toEqual({ approved: true, splits: 1 });
    expect(await executeApprovedPayout(db, provider, payout.id, NOW)).toEqual({ status: 'EXECUTED', doneCents: 900 });
  });

  it('una firma sustituida se puede verificar aunque su firmante ya no tenga el cargo', async () => {
    const { organization, director, directorActor } = await team();
    const { payout, target } = await payoutTarget(organization.id);
    const first = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await completeSignature(db, SECRET, directorActor, { token: first.token, otp: first.otp }, NOW);
    const oldHash = (await db.doubleCheckSignature.findFirstOrThrow({ where: { payoutId: payout.id } })).signatureHash;
    await db.organizationMember.deleteMany({ where: { organizationId: organization.id, userId: director.id } });
    const replacement = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: replacement.id, role: 'DIRECTOR' } });
    const actor = actorFor(replacement.id, {}, [{ organizationId: organization.id, role: 'DIRECTOR' }]);
    const challenge = await requestSignature(db, SECRET, actor, organization.id, target, NOW);
    await completeSignature(db, SECRET, actor, { token: challenge.token, otp: challenge.otp }, NOW);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: 'double_check.signature_superseded', organizationId: organization.id } });
    const metadata = log.metadataJson as { targetDigest: string; membershipId: number; previousSignerUserId: string };
    expect(metadata.previousSignerUserId).toBe(director.id);
    expect(verifySignatureHash(SECRET, { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: metadata.targetDigest, signerUserId: director.id, signerRole: 'DIRECTOR', membershipId: metadata.membershipId, signedAt: NOW, otpVerifiedAt: NOW }, oldHash)).toBe(true);
  });

  it('un cargo no se modifica: quitar y devolver el rol exige una fila nueva, y la firma no revive', async () => {
    const { organization, cosigner } = await team();
    const member = await db.organizationMember.findFirstOrThrow({ where: { organizationId: organization.id, userId: cosigner.id } });
    await expect(db.organizationMember.update({ where: { id: member.id }, data: { role: 'FAMILY' } })).rejects.toThrow();
    await expect(db.organizationMember.update({ where: { id: member.id }, data: { userId: (await createUser(db)).id } })).rejects.toThrow();
    expect((await db.organizationMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe('COSIGNER');
    await db.organizationMember.update({ where: { id: member.id }, data: { roleLabel: 'Tesorería' } });
  });

  it('intercambiar los roles entre firmas no completa las dos con una sola persona', async () => {
    const { organization, director, directorActor } = await team();
    const { idea, target } = await ideaTarget(organization.id);
    const first = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await completeSignature(db, SECRET, directorActor, { token: first.token, otp: first.otp }, NOW);
    await db.organizationMember.deleteMany({ where: { organizationId: organization.id, role: { in: ['DIRECTOR', 'COSIGNER'] } } });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'COSIGNER' } });
    const actor = actorFor(director.id, {}, [{ organizationId: organization.id, role: 'COSIGNER' }]);
    const second = await requestSignature(db, SECRET, actor, organization.id, target, NOW);
    expect(await completeSignature(db, SECRET, actor, { token: second.token, otp: second.otp }, NOW)).toMatchObject({ status: 'SIGNED', complete: false });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('DOUBLE_CHECK');
  });

  it('dos DIRECTOR no completan las dos firmas', async () => {
    const { organization, directorActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const second = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: second.id, role: 'DIRECTOR' } });
    const challenge = await requestSignature(db, SECRET, directorActor, organization.id, target, NOW);
    await completeSignature(db, SECRET, directorActor, { token: challenge.token, otp: challenge.otp }, NOW);
    await expect(requestSignature(db, SECRET, actorFor(second.id, {}, [{ organizationId: organization.id, role: 'DIRECTOR' }]), organization.id, target, NOW)).rejects.toMatchObject({ reason: 'ALREADY_SIGNED' });
  });

  it('dos cuentas con la misma bandeja de entrada son una sola persona', async () => {
    const organization = await createOrganization(db);
    const local = uniqueId('ana').replace(/[^a-z0-9]/g, '');
    const first = await createUser(db, { email: `${local}@gmail.com`, canonicalEmail: `incoherente-1-${local}`, twoFactorEnabled: true });
    const second = await createUser(db, { email: `${local}+tesoreria@gmail.com`, canonicalEmail: `incoherente-2-${local}`, twoFactorEnabled: true });
    await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: first.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: second.id, role: 'COSIGNER' }] });
    const { target } = await ideaTarget(organization.id);
    const actor = actorFor(first.id, {}, [{ organizationId: organization.id, role: 'DIRECTOR' }]);
    const challenge = await requestSignature(db, SECRET, actor, organization.id, target, NOW);
    const signed = await completeSignature(db, SECRET, actor, { token: challenge.token, otp: challenge.otp }, NOW);
    const next = signed.status === 'SIGNED' ? signed.nextChallenges[0]! : null;
    expect(await completeSignature(db, SECRET, actorFor(second.id, {}, [{ organizationId: organization.id, role: 'COSIGNER' }]), (await secretsSentTo(db, next!.signerUserId)), NOW)).toEqual({ status: 'NOT_ALLOWED', reason: 'SAME_PERSON' });
  });

  it('aunque existan las dos firmas, la misma bandeja de entrada no completa la doble firma', async () => {
    const organization = await createOrganization(db);
    const local = uniqueId('ana').replace(/[^a-z0-9]/g, '');
    const { idea } = await ideaTarget(organization.id);
    const context = { organizationId: organization.id, targetType: 'IDEA_APPROVAL' as const, targetId: idea.id, targetDigest: ideaTargetDigest(SECRET, idea) };
    const signatures = [];
    for (const [email, signerRole] of [[`${local}@gmail.com`, 'DIRECTOR'], [`${local}+tesoreria@gmail.com`, 'COSIGNER']] as const) {
      const user = await createUser(db, { email, canonicalEmail: `incoherente-${signerRole}-${local}` });
      const membership = await db.organizationMember.create({ data: { organizationId: organization.id, userId: user.id, role: signerRole } });
      const signatureHash = computeSignatureHash(SECRET, { ...context, signerUserId: user.id, signerRole, membershipId: membership.id, signedAt: NOW, otpVerifiedAt: NOW });
      signatures.push(await db.doubleCheckSignature.create({ data: { organizationId: organization.id, targetType: 'IDEA_APPROVAL', ideaId: idea.id, signerUserId: user.id, signerRole, signatureHash, otpVerifiedAt: NOW, signedAt: NOW } }));
    }
    const evaluation = await evaluateDoubleCheck(db, SECRET, context, signatures);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.invalid.map((entry) => entry.reason)).toEqual(['SAME_INBOX', 'SAME_INBOX']);
  });

  it('sin 2FA no se firma; y un Super-Admin con la sesión desactualizada tampoco', async () => {
    const { organization, cosigner, cosignerActor, directorActor, director } = await team();
    const { target } = await ideaTarget(organization.id);
    await db.user.update({ where: { id: cosigner.id }, data: { twoFactorEnabled: false } });
    await expect(requestSignature(db, SECRET, cosignerActor, organization.id, target, NOW)).rejects.toMatchObject({ reason: 'TWO_FACTOR_REQUIRED' });
    await db.user.update({ where: { id: director.id }, data: { isSuperadmin: true } });
    await expect(requestSignature(db, SECRET, directorActor, organization.id, target, NOW)).rejects.toMatchObject({ reason: 'NOT_A_SIGNER' });
  });

  it('con 2FA en la cuenta pero una sesión abierta solo con el enlace mágico, no se firma ni se completa una firma (Sprint 3.2)', async () => {
    const { organization, cosigner, cosignerActor } = await team();
    const { target } = await ideaTarget(organization.id);
    const emailOnly = { ...cosignerActor, secondFactor: false } as SessionActor;
    await expect(requestSignature(db, SECRET, emailOnly, organization.id, target, NOW)).rejects.toMatchObject({ reason: 'TWO_FACTOR_REQUIRED' });
    expect(await db.auditLog.count({ where: { actorUserId: cosigner.id, action: 'double_check.denied' } })).toBeGreaterThan(0);

    // Con la sesión verificada pide el enlace; si quien lo usa no superó el segundo factor, la firma no se hace.
    const { token, otp } = await requestSignature(db, SECRET, cosignerActor, organization.id, target, NOW);
    const result = await completeSignature(db, SECRET, emailOnly, { token, otp }, NOW);
    expect(result).toEqual({ status: 'NOT_ALLOWED', reason: 'TWO_FACTOR_REQUIRED' });
  });

  it('una liquidación a proveedor no se puede firmar sin su factura', async () => {
    const { organization, directorActor } = await team();
    const { target } = await payoutTarget(organization.id, { destinationType: 'PROVIDER' });
    await expect(requestSignature(db, SECRET, directorActor, organization.id, target, NOW)).rejects.toMatchObject({ reason: 'PROVIDER_INVOICE_MISSING' });
    await expect(requestSignature(db, SECRET, directorActor, organization.id, target, NOW)).rejects.toBeInstanceOf(DoubleCheckNotAllowedError);
  });
});
