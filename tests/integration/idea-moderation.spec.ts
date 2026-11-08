import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInitiativeFromIdea, quarterOf } from '@/core/ideas/idea-conversion';
import { approveIdeaForVoting, IdeaModerationError, rejectIdea, replyToIdea, revalidateSignature } from '@/core/ideas/idea-moderation.service';
import { signIdea } from '@/core/security/device-quorum.service';
import { completeSignature, requestSignature } from '@/core/security/double-check.service';
import { previewChallenge } from '@/core/security/double-check-preview';
import { hashIpSubnet } from '@/core/security/device-signals';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { signIdeaForRequest } from '@/services/ideas/idea-requests.service';
import { loadApprovalsData } from '@/services/panel/approvals-data';
import { createOrganization, createTestClient, createUser, uniqueId } from './test-database';

/**
 * Sprint 4.2a · moderación del buzón de ideas y doble firma desde el panel (QA-S02): aprobar con el plazo desde ese día y el quórum comprobado,
 * desestimar con el motivo en el chat, responder, revalidar firmas sospechosas y convertir la idea en iniciativa al completar las dos firmas.
 */

const SECRET = 'secreto-de-integracion-de-la-moderacion-0123456789';
const NOW = new Date('2026-11-10T10:00:00.000Z');
const DAY_MS = 86_400_000;
let db: KorumPrismaClient;

beforeAll(async () => {
  db = createTestClient();
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.$disconnect();
});

const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>, overrides: Partial<Extract<SessionActor, { kind: 'user' }>> = {}): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true, ...overrides });

async function team(overrides: { minVotes?: number; maxIdeaDays?: number } = {}) {
  const organization = await createOrganization(db, { minVotes: overrides.minVotes ?? 3, maxIdeaDays: overrides.maxIdeaDays ?? 45 });
  await db.organizationCategory.create({ data: { organizationId: organization.id, name: 'Cultura' } });
  await db.organizationCategory.create({ data: { organizationId: organization.id, name: 'Patios' } });
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR', roleLabel: 'Dirección del centro' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER', roleLabel: 'Presidencia de la AFA' }] });
  return {
    organization,
    director,
    cosigner,
    directorActor: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]),
    cosignerActor: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }])
  };
}

async function createIdea(organizationId: string, overrides: { phase?: 'PHASE0_MOD' | 'PUBLIC_VOTING' | 'DOUBLE_CHECK' | 'CONVERTED'; verifiedVotes?: number; authorCanonicalEmail?: string; expiresAt?: Date } = {}) {
  return db.idea.create({
    data: {
      organizationId,
      alias: `#FAM-${1000 + Math.floor(Math.random() * 9000)}`,
      authorCanonicalEmail: overrides.authorCanonicalEmail ?? `${uniqueId('autora')}@pruebas.example`,
      title: 'Taller de lectura en voz alta',
      category: 'Cultura',
      description: 'Un taller semanal de lectura para todo el curso, con libros nuevos.',
      phase: overrides.phase ?? 'PHASE0_MOD',
      verifiedVotes: overrides.verifiedVotes ?? 1,
      expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 2 * DAY_MS),
      createdAt: new Date(NOW.getTime() - 20 * DAY_MS)
    }
  });
}

const outboxOf = (templateKey: string, organizationId: string) => db.outboxMessage.findMany({ where: { templateKey, organizationId }, orderBy: { id: 'asc' } });

async function secretsSentTo(userId: string): Promise<{ token: string; otp: string }> {
  const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId }, orderBy: { id: 'desc' } });
  const payload = message.payloadJson as { token: string; otp: string };
  return { token: payload.token, otp: payload.otp };
}

describe('Aprobar una propuesta (PHASE0_MOD → PUBLIC_VOTING)', () => {
  it('abre las firmas desde hoy, guarda las correcciones y lo deja en la auditoría', async () => {
    const { organization, directorActor } = await team({ maxIdeaDays: 30 });
    const idea = await createIdea(organization.id);
    const result = await approveIdeaForVoting(db, directorActor, organization.id, { ideaId: idea.id, title: '  Taller de lectura   en voz alta ', category: 'Patios', description: idea.description }, NOW);
    expect(result).toEqual({ phase: 'PUBLIC_VOTING' });
    const stored = await db.idea.findUniqueOrThrow({ where: { id: idea.id } });
    expect(stored).toMatchObject({ phase: 'PUBLIC_VOTING', title: 'Taller de lectura en voz alta', category: 'Patios' });
    expect(stored.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 30 * DAY_MS).toISOString());
    expect(await db.auditLog.findFirst({ where: { action: 'idea.approved', targetId: String(idea.id) } })).toMatchObject({ metadataJson: { edited: true, quorumReached: false } });
  });

  it('avisa a quien propuso que su idea ya recoge firmas, y si se corrigió el texto', async () => {
    const { organization, directorActor } = await team();
    const author = await createUser(db);
    const idea = await createIdea(organization.id, { authorCanonicalEmail: author.canonicalEmail });
    await approveIdeaForVoting(db, directorActor, organization.id, { ideaId: idea.id, title: 'Taller de lectura para toda Primaria', category: 'Cultura', description: idea.description }, NOW);
    const [notice] = await outboxOf('idea.centerReplied', organization.id);
    expect(notice).toMatchObject({ userId: author.id });
    expect(notice!.payloadJson).toEqual({ ideaId: idea.id, alias: idea.alias, kind: 'APPROVED', edited: true });
  });

  it('con la firma de quien propone ya en el mínimo, pasa a la doble firma y avisa a las dos personas firmantes', async () => {
    const { organization, directorActor, director, cosigner } = await team({ minVotes: 1 });
    const idea = await createIdea(organization.id);
    expect(await approveIdeaForVoting(db, directorActor, organization.id, { ideaId: idea.id, title: idea.title, category: idea.category, description: idea.description }, NOW)).toEqual({ phase: 'DOUBLE_CHECK' });
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('DOUBLE_CHECK');
    const notices = await outboxOf('idea.quorumReached', organization.id);
    expect(notices.map((notice) => notice.userId).sort()).toEqual([director.id, cosigner.id].sort());
    expect(notices[0]!.payloadJson).toMatchObject({ ideaId: idea.id, alias: idea.alias });
  });

  it('rechaza una categoría ajena, una fase que no toca y un texto demasiado corto', async () => {
    const { organization, directorActor } = await team();
    const idea = await createIdea(organization.id);
    await expect(approveIdeaForVoting(db, directorActor, organization.id, { ideaId: idea.id, title: idea.title, category: 'Inventada', description: idea.description }, NOW)).rejects.toMatchObject({ reason: 'INVALID_CATEGORY' });
    await expect(approveIdeaForVoting(db, directorActor, organization.id, { ideaId: idea.id, title: 'Corto', category: 'Cultura', description: idea.description }, NOW)).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    const voting = await createIdea(organization.id, { phase: 'PUBLIC_VOTING' });
    await expect(approveIdeaForVoting(db, directorActor, organization.id, { ideaId: voting.id, title: voting.title, category: 'Cultura', description: voting.description }, NOW)).rejects.toMatchObject({ reason: 'WRONG_PHASE' });
  });
});

describe('Aislamiento y permisos (QA-SEC01)', () => {
  it('quien firma en otra entidad recibe lo mismo que con una idea inexistente, y queda registrado', async () => {
    const { organization } = await team();
    const other = await team();
    const idea = await createIdea(organization.id);
    const payload = { ideaId: idea.id, title: idea.title, category: 'Cultura', description: idea.description };
    await expect(approveIdeaForVoting(db, other.directorActor, other.organization.id, payload, NOW)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(rejectIdea(db, other.directorActor, other.organization.id, { ideaId: idea.id, reason: 'No encaja con el proyecto del centro' }, NOW)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(approveIdeaForVoting(db, other.directorActor, organization.id, payload, NOW)).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('PHASE0_MOD');
    expect(await db.auditLog.count({ where: { organizationId: other.organization.id, action: 'tenant.resource_outside_tenant' } })).toBeGreaterThan(0);
  });

  it('ni el Super-Admin ni una familia ni una sesión sin segundo factor moderan', async () => {
    const { organization, director } = await team();
    const idea = await createIdea(organization.id);
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const family = await createUser(db);
    const payload = { ideaId: idea.id, reason: 'Motivo suficiente para probar' };
    await expect(rejectIdea(db, actorFor(admin.id, [], { isSuperadmin: true }), organization.id, payload, NOW)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(rejectIdea(db, actorFor(family.id, []), organization.id, payload, NOW)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(loadApprovalsData(db, SECRET, actorFor(family.id, []), organization.id, NOW)).rejects.toBeInstanceOf(TenantAccessError);
    // Con el cargo pero con una sesión abierta solo con el enlace mágico: el servicio también lo rechaza (no solo la acción) y queda rastro.
    await expect(rejectIdea(db, actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }], { secondFactor: false }), organization.id, payload, NOW)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'tenant.access_denied', targetId: String(idea.id) } })).toBeGreaterThan(0);
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('PHASE0_MOD');
  });
});

describe('Desestimar, responder y el chat con la familia', () => {
  it('desestimar deja el motivo con el cargo, avisa a la familia sin el texto y anula los enlaces de firma abiertos', async () => {
    const { organization, directorActor, cosignerActor } = await team();
    const author = await createUser(db);
    const idea = await createIdea(organization.id, { phase: 'DOUBLE_CHECK', authorCanonicalEmail: author.canonicalEmail });
    await requestSignature(db, SECRET, directorActor, organization.id, { targetType: 'IDEA_APPROVAL', ideaId: idea.id }, NOW);
    const reason = 'Este curso no podemos asumir el mantenimiento. ¡Gracias por proponerlo!';
    await rejectIdea(db, cosignerActor, organization.id, { ideaId: idea.id, reason }, NOW);

    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).phase).toBe('REJECTED');
    const message = await db.ideaMessage.findFirstOrThrow({ where: { ideaId: idea.id, senderRole: 'ORGANIZATION' } });
    expect(message).toMatchObject({ senderLabel: 'Presidencia de la AFA', body: reason });
    expect(await db.doubleCheckChallenge.count({ where: { ideaId: idea.id, revokedAt: null } })).toBe(0);
    expect((await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', organizationId: organization.id } })).status).toBe('CANCELLED');
    const [notice] = await outboxOf('idea.centerReplied', organization.id);
    expect(notice).toMatchObject({ userId: author.id, toAddress: author.email });
    expect(notice!.payloadJson).toEqual({ ideaId: idea.id, alias: idea.alias, kind: 'REJECTED' });
    expect(JSON.stringify(notice!.payloadJson)).not.toContain('mantenimiento');
    await expect(replyToIdea(db, directorActor, organization.id, { ideaId: idea.id, body: '¿Seguimos?' }, NOW)).rejects.toMatchObject({ reason: 'CHAT_CLOSED' });
  });

  it('las respuestas se firman con el cargo y avisan como mucho una vez al día por idea', async () => {
    const { organization, directorActor } = await team();
    const author = await createUser(db);
    const idea = await createIdea(organization.id, { phase: 'PUBLIC_VOTING', authorCanonicalEmail: author.canonicalEmail });
    await replyToIdea(db, directorActor, organization.id, { ideaId: idea.id, body: '¡Gracias! ¿Para qué cursos lo pensáis?' }, NOW);
    await replyToIdea(db, directorActor, organization.id, { ideaId: idea.id, body: 'Y otra pregunta: ¿en qué horario?' }, new Date(NOW.getTime() + 3_600_000));
    expect(await db.ideaMessage.count({ where: { ideaId: idea.id, senderRole: 'ORGANIZATION', senderLabel: 'Dirección del centro' } })).toBe(2);
    expect(await outboxOf('idea.centerReplied', organization.id)).toHaveLength(1);
    await replyToIdea(db, directorActor, organization.id, { ideaId: idea.id, body: 'Al día siguiente, otro aviso.' }, new Date(NOW.getTime() + DAY_MS));
    expect(await outboxOf('idea.centerReplied', organization.id)).toHaveLength(2);
  });

  it('una propuesta de una cuenta suprimida se puede responder, pero no hay a quién avisar', async () => {
    const { organization, directorActor } = await team();
    const idea = await createIdea(organization.id, { phase: 'PUBLIC_VOTING', authorCanonicalEmail: 'anonimizado:hmac:abc' });
    await replyToIdea(db, directorActor, organization.id, { ideaId: idea.id, body: 'Mensaje para el historial.' }, NOW);
    expect(await outboxOf('idea.centerReplied', organization.id)).toHaveLength(0);
  });
});

describe('Firmas sospechosas y quórum', () => {
  it('revalidar una firma sospechosa la hace contar y, si llega al mínimo, lleva la idea a la doble firma', async () => {
    const { organization, directorActor } = await team({ minVotes: 3 });
    const idea = await createIdea(organization.id, { phase: 'PUBLIC_VOTING', verifiedVotes: 2 });
    const signature = await db.ideaSignatureAudit.create({ data: { ideaId: idea.id, canonicalEmail: `${uniqueId('vecina')}@x.es`, status: 'SUSPICIOUS', reason: 'ideas.audit.ipBurst', accountOrder: 1 } });
    await db.idea.update({ where: { id: idea.id }, data: { votes: 3, suspiciousVotes: 1 } });

    expect(await revalidateSignature(db, directorActor, organization.id, { ideaId: idea.id, signatureId: signature.id }, NOW)).toEqual({ quorumReached: true });
    expect(await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).toMatchObject({ phase: 'DOUBLE_CHECK', verifiedVotes: 3, suspiciousVotes: 0 });
    expect((await db.ideaSignatureAudit.findUniqueOrThrow({ where: { id: signature.id } })).reason).toBe('ideas.audit.ipBurst');
    await expect(revalidateSignature(db, directorActor, organization.id, { ideaId: idea.id, signatureId: signature.id }, NOW)).rejects.toMatchObject({ reason: 'NOT_SUSPICIOUS' });

    // Una idea que ya venció no se resucita revalidando firmas.
    const expired = await createIdea(organization.id, { phase: 'PUBLIC_VOTING', verifiedVotes: 2, expiresAt: new Date(NOW.getTime() - 1000) });
    const late = await db.ideaSignatureAudit.create({ data: { ideaId: expired.id, canonicalEmail: `${uniqueId('tarde')}@x.es`, status: 'SUSPICIOUS', reason: 'ideas.audit.ipBurst', accountOrder: 1 } });
    await expect(revalidateSignature(db, directorActor, organization.id, { ideaId: expired.id, signatureId: late.id }, NOW)).rejects.toMatchObject({ reason: 'WRONG_PHASE' });
    expect((await db.idea.findUniqueOrThrow({ where: { id: expired.id } })).phase).toBe('PUBLIC_VOTING');

    const view = await loadApprovalsData(db, SECRET, directorActor, organization.id, NOW);
    const listed = view.open.find((entry) => entry.id === idea.id)!;
    expect(listed.signatures.find((entry) => entry.id === signature.id)).toMatchObject({ status: 'VERIFIED', revalidated: true });
  });

  it('al llegar al quórum por una firma, quienes firman tienen el plazo completo y reciben el aviso', async () => {
    const { organization } = await team({ minVotes: 2, maxIdeaDays: 20 });
    const idea = await createIdea(organization.id, { phase: 'PUBLIC_VOTING', expiresAt: new Date(NOW.getTime() + 3_600_000) });
    const result = await signIdea(db, SECRET, { ideaId: idea.id, userId: (await createUser(db)).id }, NOW);
    expect(result).toMatchObject({ status: 'SIGNED', quorumReached: true });
    const stored = await db.idea.findUniqueOrThrow({ where: { id: idea.id } });
    expect(stored.phase).toBe('DOUBLE_CHECK');
    expect(stored.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 20 * DAY_MS).toISOString());
    expect(await outboxOf('idea.quorumReached', organization.id)).toHaveLength(2);
  });

  it('la alerta de IP de confianza se cierra sola cuando el proxy vuelve a pasar la IP (heredado del 3.6)', async () => {
    const { organization } = await team({ minVotes: 50 });
    const idea = await createIdea(organization.id, { phase: 'PUBLIC_VOTING' });
    const deps = { db, hmacSecret: SECRET };
    await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, { userId: (await createUser(db)).id, ip: null }, NOW);
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'trusted-ip-missing:idea.sign' } })).status).toBe('OPEN');
    await signIdeaForRequest(deps, { orgSlug: organization.slug, ideaId: idea.id }, { userId: (await createUser(db)).id, ip: '83.45.30.9' }, NOW);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'trusted-ip-missing:idea.sign' } })).toMatchObject({ status: 'RESOLVED' });
  });

  it('la ráfaga cuenta dispositivos distintos de la misma red, no firmas', async () => {
    const { organization } = await team({ minVotes: 50 });
    const idea = await createIdea(organization.id, { phase: 'PUBLIC_VOTING' });
    const device = await db.device.create({ data: { cookieIdHash: uniqueId('cookie') } });
    const ipSubnetHash = hashIpSubnet(SECRET, '83.45.20.7');
    for (let i = 0; i < 6; i += 1) await db.ideaSignatureAudit.create({ data: { ideaId: idea.id, canonicalEmail: `${uniqueId('misma')}@x.es`, deviceId: device.id, ipSubnetHash, reason: 'ideas.audit.firstAccount', createdAt: NOW } });
    expect(await signIdea(db, SECRET, { ideaId: idea.id, userId: (await createUser(db)).id, ip: '83.45.20.8' }, NOW)).toMatchObject({ audit: { status: 'VERIFIED' } });
  });
});

describe('Doble firma 1/2 → 2/2 y conversión en iniciativa', () => {
  it('la segunda firma convierte la idea y crea su iniciativa en presupuestación en la misma operación', async () => {
    const { organization, directorActor, cosignerActor, cosigner } = await team();
    const idea = await createIdea(organization.id, { phase: 'DOUBLE_CHECK' });
    const receipt = await requestSignature(db, SECRET, directorActor, organization.id, { targetType: 'IDEA_APPROVAL', ideaId: idea.id }, NOW);
    expect(receipt.notificationId).toBeGreaterThan(0);
    const first = await completeSignature(db, SECRET, directorActor, await secretsSentTo(directorActor.kind === 'user' ? directorActor.userId : ''), NOW);
    expect(first).toMatchObject({ status: 'SIGNED', complete: false, initiativeId: null });
    expect(first.status === 'SIGNED' && first.nextChallenges.map((entry) => entry.signerUserId)).toEqual([cosigner.id]);

    const half = await loadApprovalsData(db, SECRET, cosignerActor, organization.id, NOW);
    expect(half.open.find((entry) => entry.id === idea.id)?.doubleCheck).toMatchObject({ signed: 1, mySlotOpen: true, slots: [{ role: 'DIRECTOR', signedBy: { roleLabel: 'Dirección del centro' } }, { role: 'COSIGNER', signedBy: null }] });

    const second = await completeSignature(db, SECRET, cosignerActor, await secretsSentTo(cosigner.id), NOW);
    expect(second).toMatchObject({ status: 'SIGNED', complete: true, ideaConverted: true });
    const initiative = await db.initiative.findUniqueOrThrow({ where: { sourceIdeaId: idea.id } });
    expect(second.status === 'SIGNED' && second.initiativeId).toBe(initiative.id);
    expect(initiative).toMatchObject({ organizationId: organization.id, status: 'BUDGETING', stepIndex: 3, format: 'BUDGET', title: idea.title, category: idea.category, description: idea.description, goalCents: 0, academicYear: '2026-2027', quarter: quarterOf(initiative.closesAt) });
    expect(initiative.walletEscrowId).toMatch(/^WLT-ESC-[A-HJ-NP-Z2-9]{6}$/);
    expect(initiative.closesAt.getTime() - NOW.getTime()).toBe(60 * DAY_MS);
    expect(await db.auditLog.count({ where: { action: 'idea.converted', organizationId: organization.id } })).toBe(1);

    const after = await loadApprovalsData(db, SECRET, directorActor, organization.id, NOW);
    expect(after.closed.find((entry) => entry.id === idea.id)?.initiative).toEqual({ id: initiative.id, walletEscrowId: initiative.walletEscrowId });
  });

  it('convertir dos veces la misma idea devuelve la misma iniciativa', async () => {
    const { organization } = await team();
    const idea = await createIdea(organization.id, { phase: 'CONVERTED' });
    const first = await createInitiativeFromIdea(db, idea.id, NOW);
    const second = await createInitiativeFromIdea(db, idea.id, NOW);
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(await db.initiative.count({ where: { sourceIdeaId: idea.id } })).toBe(1);
    const pending = await createIdea(organization.id, { phase: 'DOUBLE_CHECK' });
    await expect(createInitiativeFromIdea(db, pending.id, NOW)).rejects.toThrow(/no está convertida/);
  });

  it('la vista previa del enlace es solo de su destinatario, no gasta intentos y no sirve en otra entidad', async () => {
    const { organization, directorActor, cosignerActor, director } = await team();
    const idea = await createIdea(organization.id, { phase: 'DOUBLE_CHECK' });
    await requestSignature(db, SECRET, directorActor, organization.id, { targetType: 'IDEA_APPROVAL', ideaId: idea.id }, NOW);
    const { token } = await secretsSentTo(director.id);
    const preview = await previewChallenge(db, SECRET, directorActor, { token, organizationSlug: organization.slug }, NOW);
    expect(preview).toMatchObject({ status: 'READY', targetType: 'IDEA_APPROVAL', signerRole: 'DIRECTOR', idea: { alias: idea.alias, title: idea.title, revalidatedVotes: 0 } });
    expect(JSON.stringify(preview)).not.toContain(idea.authorCanonicalEmail);
    expect(await previewChallenge(db, SECRET, cosignerActor, { token, organizationSlug: organization.slug }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await previewChallenge(db, SECRET, { ...directorActor, secondFactor: false } as SessionActor, { token, organizationSlug: organization.slug }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await previewChallenge(db, SECRET, directorActor, { token, organizationSlug: 'otra-entidad' }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await previewChallenge(db, SECRET, directorActor, { token: 'x'.repeat(43), organizationSlug: organization.slug }, NOW)).toEqual({ status: 'INVALID_LINK' });
    expect(await previewChallenge(db, SECRET, directorActor, { token, organizationSlug: organization.slug }, new Date(NOW.getTime() + 73 * 3_600_000))).toEqual({ status: 'INVALID_LINK' });
    expect((await db.doubleCheckChallenge.findFirstOrThrow({ where: { ideaId: idea.id } })).attempts).toBe(0);
  });

  it('la bandeja no enseña emails ni datos de dispositivo de las familias', async () => {
    const { organization, directorActor } = await team();
    const author = `${uniqueId('privada')}@pruebas.example`;
    const idea = await createIdea(organization.id, { phase: 'PUBLIC_VOTING', authorCanonicalEmail: author });
    const signerEmail = `${uniqueId('firmante')}@pruebas.example`;
    await db.ideaSignatureAudit.create({ data: { ideaId: idea.id, canonicalEmail: signerEmail, ipSubnetHash: 'hash-de-red', status: 'SUSPICIOUS', reason: 'ideas.audit.tooManyAccounts', accountOrder: 3 } });
    const view = await loadApprovalsData(db, SECRET, directorActor, organization.id, NOW);
    const text = JSON.stringify(view);
    expect(text).not.toContain(author);
    expect(text).not.toContain(signerEmail);
    expect(text).not.toContain('hash-de-red');
    expect(view.open.find((entry) => entry.id === idea.id)?.signatures[0]).toMatchObject({ status: 'SUSPICIOUS', reason: 'ideas.audit.tooManyAccounts', accountOrder: 3 });
  });

  it('un error de moderación es siempre un IdeaModerationError con su motivo', async () => {
    const { organization, directorActor } = await team();
    await expect(rejectIdea(db, directorActor, organization.id, { ideaId: 1, reason: 'corto' }, NOW)).rejects.toBeInstanceOf(IdeaModerationError);
  });
});
