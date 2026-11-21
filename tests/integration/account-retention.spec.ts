import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyOldIdeaDescriptions, purgeClosedPrivacyRequests, purgeFinishedJobs, purgeResolvedOpsAlerts, purgeUnverifiedSignups } from '@/core/privacy/retention-cleanup';
import { purgeOldIdeaChats } from '@/core/privacy/retention-purge';
import { buildPersonalDataExport } from '@/core/privacy/personal-data-export';
import { AUDIT_PERSON_KEYS, UNLINKED_ACCOUNT, UNLINKED_HANDOVER, unlinkExpiredAuditRows, unlinkExpiredContributions, unlinkExpiredHandovers, unlinkExpiredPollCreators, unlinkOldSecurityTraces } from '@/core/privacy/retention-unlink';
import { markSessionReauthenticated, verifyAccountSession } from '@/core/security/verified-actor';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { exportOwnData } from '@/services/account/account-privacy.service';
import { archiveLegalVersion, LegalVersionConflictError, resolveLegalVersion } from '@/services/legal/legal-archive.service';
import { runPrivacyPolicyNotices } from '@/services/notifications/privacy-policy-notices';
import es from '../../messages/es.json';
import { createInitiative, createOrganization, createTestClient, createUser, table, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/** Sprint 5.10b · QA-LEG04: copia de «mis datos» con los rastros de seguridad y la información sobre el tratamiento, y los plazos que faltaban (`L-011`, `L-015`, `L-064`, `L-067`). */

let db: KorumPrismaClient;
const DAY = 86_400_000;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

const asClient = (tx: Db) => tx as unknown as KorumPrismaClient;
const ROLLBACK = new Error('rollback de la prueba');
/** La purga recorre toda la base: cada prueba de plazos va en una transacción que se deshace al final. */
async function inRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  await expect(db.$transaction(async (tx) => {
    await fn(tx);
    throw ROLLBACK;
  }, { timeout: 180_000, maxWait: 30_000 })).rejects.toBe(ROLLBACK);
}

async function verified(userId: string) {
  const session = await db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId, expiresAt: new Date(Date.now() + 3_600_000) } });
  await markSessionReauthenticated(db, session.id, { secondFactor: false });
  return verifyAccountSession(db, { userId, sessionId: session.id, operation: 'privacy.export' });
}

/** Traductor sobre el catálogo castellano, como hará next-intl en la ruta. */
const translate = (path: string, values: Record<string, string> = {}) => {
  const text = path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es.privacy.export);
  return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '') : path;
};

describe('QA-LEG04 · copia de «mis datos»', () => {
  it('incluye los rastros de seguridad propios de los últimos 12 meses, sin identificadores de entidades, y la información sobre el tratamiento', async () => {
    const organization = await createOrganization(db);
    const person = await createUser(db);
    const other = await createUser(db);
    const now = Date.now();
    await db.auditLog.create({ data: { actorType: 'USER', actorUserId: null, action: 'auth.sign_in_failed_repeatedly', targetType: 'User', targetId: person.id, ipHash: 'red', metadataJson: { method: 'email_code', failures: 5, windowMinutes: 15, knownAccount: true }, occurredAt: new Date(now - 150 * DAY) } });
    await db.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, organizationId: organization.id, action: 'tenant.access_denied', targetType: 'Initiative', targetId: '987654', metadataJson: { reason: 'ROLE_NOT_ALLOWED', attempted: 'gate.pin_set' }, occurredAt: new Date(now - 30 * DAY) } });
    await db.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, action: 'tenant.access_denied', targetType: 'AccountSession', targetId: '*', metadataJson: { reason: 'REAUTH_REQUIRED' }, occurredAt: new Date(now - 400 * DAY) } });
    await db.auditLog.create({ data: { actorType: 'USER', actorUserId: other.id, action: 'tenant.access_denied', targetType: 'AccountSession', targetId: '*', occurredAt: new Date(now - 10 * DAY) } });
    // Lo que no es un rastro de seguridad no entra en esta lista.
    await db.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, action: 'account.passkey_added', targetType: 'Passkey', targetId: 'llave', occurredAt: new Date(now - DAY) } });

    const data = await buildPersonalDataExport(db, TEST_KEYRING, { kind: 'self', actor: await verified(person.id) });
    expect(data.securityTraces.map((row) => [row.action, row.reason, row.method, row.failures])).toEqual([
      ['auth.sign_in_failed_repeatedly', null, 'email_code', 5],
      ['tenant.access_denied', 'ROLE_NOT_ALLOWED', null, null]
    ]);
    expect(JSON.stringify(data.securityTraces)).not.toContain(organization.id);
    expect(JSON.stringify(data.securityTraces)).not.toContain('987654');

    const file = await exportOwnData(db, { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { actor: await verified(person.id), format: 'json', locale: 'es', t: translate });
    expect(file.status).toBe('OK');
    if (file.status !== 'OK') return;
    const json = JSON.parse(new TextDecoder().decode(file.file.bytes)) as { processingInfo: Array<{ title: string; text: string }>; securityTraces: unknown[] };
    expect(json.processingInfo.map((section) => section.title)).toEqual(['Quién es responsable', 'Para qué usamos tus datos', 'Con qué base legal', 'Quién recibe tus datos', 'Fuera de la Unión Europea', 'Cuánto tiempo los conservamos', 'De dónde salen', 'Decisiones automáticas', 'Tus derechos', 'Si no estás de acuerdo']);
    expect(json.processingInfo.every((section) => section.text.length > 40 && !section.text.includes('{'))).toBe(true);
    expect(json.securityTraces).toHaveLength(2);
  });
});

describe('QA-LEG04 · plazos: desvincular a la persona de lo que se conserva', () => {
  it('un rastro de seguridad de más de 12 meses queda sin la cuenta; el resto de la auditoría, a los 6 años desde el cierre del ejercicio', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const person = await createUser(asClient(tx));
      const ago = (days: number) => new Date(now.getTime() - days * DAY);
      const oldTrace = await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: null, action: 'auth.sign_in_failed_repeatedly', targetType: 'User', targetId: person.id, ipHash: 'red', userAgent: 'Navegador', metadataJson: { failures: 5 }, occurredAt: ago(370) } });
      const recentTrace = await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, action: 'tenant.access_denied', targetType: 'Organization', targetId: 'org', occurredAt: ago(300) } });
      const oldMoney = await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, action: 'sponsor.approved', targetType: 'Sponsor', targetId: '7', metadataJson: { amountCents: 25_000, by: person.id, matching: true }, occurredAt: new Date(Date.UTC(now.getUTCFullYear() - 7, 5, 1)) } });
      const recentMoney = await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, action: 'sponsor.approved', targetType: 'Sponsor', targetId: '8', metadataJson: { amountCents: 25_000, by: person.id }, occurredAt: new Date(Date.UTC(now.getUTCFullYear() - 6, 5, 1)) } });

      expect(await unlinkOldSecurityTraces(tx, now, 1000)).toBeGreaterThanOrEqual(1);
      expect(await unlinkExpiredAuditRows(tx, now, 1000)).toBeGreaterThanOrEqual(1);
      expect(await tx.auditLog.findUniqueOrThrow({ where: { id: oldTrace.id } })).toMatchObject({ actorUserId: null, targetId: UNLINKED_ACCOUNT, action: 'auth.sign_in_failed_repeatedly', ipHash: 'red', metadataJson: { failures: 5 } });
      expect(await tx.auditLog.findUniqueOrThrow({ where: { id: recentTrace.id } })).toMatchObject({ actorUserId: person.id });
      const money = await tx.auditLog.findUniqueOrThrow({ where: { id: oldMoney.id } });
      expect(money).toMatchObject({ actorUserId: null, targetId: '7', metadataJson: { amountCents: 25_000, matching: true } });
      expect(Object.keys(money.metadataJson as object)).not.toContain('by');
      // Del ejercicio de hace 6 años todavía no: vence el 1 de enero siguiente.
      expect(await tx.auditLog.findUniqueOrThrow({ where: { id: recentMoney.id } })).toMatchObject({ actorUserId: person.id, metadataJson: { by: person.id } });
      // Una segunda pasada no encuentra nada que desvincular en esas filas.
      expect(await tx.auditLog.count({ where: { id: { in: [oldTrace.id, oldMoney.id] }, OR: [{ actorUserId: { not: null } }, { targetId: person.id }] } })).toBe(0);
    });
  });

  it('la guarda de la auditoría solo deja quitar lo personal de una anotación de más de 12 meses: no cambia la acción, no añade detalles, no apunta a otra cuenta y no borra', async () => {
    const person = await createUser(db);
    const row = await db.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, action: 'sponsor.approved', targetType: 'User', targetId: person.id, metadataJson: { by: person.id, amountCents: 100 }, occurredAt: new Date(Date.now() - 400 * DAY) } });
    const today = await db.auditLog.create({ data: { actorType: 'USER', actorUserId: person.id, action: 'payout.approved', targetType: 'User', targetId: person.id } });
    const raw = (sql: string) => db.$executeRawUnsafe(sql.replaceAll('"AuditLog"', table('AuditLog')));
    // Una anotación de hoy no se desvincula: ningún plazo lo pide antes de 12 meses.
    await expect(raw(`UPDATE "AuditLog" SET "actorUserId" = NULL WHERE id = ${today.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(raw(`UPDATE "AuditLog" SET "action" = 'otra' WHERE id = ${row.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(raw(`UPDATE "AuditLog" SET "metadataJson" = '{"amountCents": 999}' WHERE id = ${row.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(raw(`UPDATE "AuditLog" SET "targetId" = 'otra-cuenta' WHERE id = ${row.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(raw(`UPDATE "AuditLog" SET "actorUserId" = 'otra-cuenta' WHERE id = ${row.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(raw(`DELETE FROM "AuditLog" WHERE id = ${row.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    // Las claves que la guarda deja quitar son exactamente las del código.
    const keys = AUDIT_PERSON_KEYS.map((key) => `'${key}'`).join(', ');
    await raw(`UPDATE "AuditLog" SET "actorUserId" = NULL, "targetId" = 'desvinculado', "metadataJson" = "metadataJson" - ARRAY[${keys}] WHERE id = ${row.id}`);
    expect(await db.auditLog.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ actorUserId: null, targetId: 'desvinculado', metadataJson: { amountCents: 100 } });
  });

  it('relevos, quién lanzó una votación y aportaciones hechas con una cuenta, a los 6 años desde el cierre del ejercicio', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const longAgo = new Date(Date.UTC(now.getUTCFullYear() - 7, 2, 1));
      const organization = await createOrganization(asClient(tx));
      const person = await createUser(asClient(tx));
      const incoming = await createUser(asClient(tx));
      const handover = (createdAt: Date) =>
        tx.signerHandover.create({ data: { organizationId: organization.id, role: 'COSIGNER', outgoingMemberId: 1, outgoingUserId: person.id, incomingUserId: incoming.id, proposedByUserId: person.id, roleLabel: 'Tesorería', displayName: 'Laura Pérez', status: 'COMPLETED', consentedAt: createdAt, expiresAt: createdAt, createdAt, closedAt: createdAt } });
      const oldHandover = await handover(longAgo);
      const recentHandover = await handover(new Date(now.getTime() - 30 * DAY));
      const expired = await createInitiative(asClient(tx), organization.id, { status: 'EXPIRED', format: 'BUDGET' });
      const poll = await tx.resizePoll.create({ data: { initiativeId: expired.id, optionsJson: ['Toldo pequeño', 'Solo un banco'], closesAt: new Date(longAgo.getTime() + 7 * DAY), createdById: person.id, originalGoalCents: 100_000, raisedAtLaunchCents: 50_000, createdAt: longAgo } });
      const initiative = await createInitiative(asClient(tx), organization.id);
      const contribution = (fiscalYear: number) => tx.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, userId: person.id, fiscalYear, amountCents: 2_000, totalChargedCents: 2_000, paymentMethod: 'CARD', status: 'COMPLETED' } });
      const oldContribution = await contribution(now.getUTCFullYear() - 7);
      const currentContribution = await contribution(now.getUTCFullYear());

      await unlinkExpiredHandovers(tx, now, 1000);
      await unlinkExpiredPollCreators(tx, now, 1000);
      await unlinkExpiredContributions(tx, now, 1000);
      expect(await tx.signerHandover.findUniqueOrThrow({ where: { id: oldHandover.id } })).toMatchObject({ ...UNLINKED_HANDOVER, roleLabel: 'Tesorería' });
      expect(await tx.signerHandover.findUniqueOrThrow({ where: { id: recentHandover.id } })).toMatchObject({ outgoingUserId: person.id, displayName: 'Laura Pérez' });
      expect(await tx.resizePoll.findUniqueOrThrow({ where: { id: poll.id } })).toMatchObject({ createdById: null, originalGoalCents: 100_000 });
      expect(await tx.contribution.findUniqueOrThrow({ where: { id: oldContribution.id } })).toMatchObject({ userId: null, amountCents: 2_000 });
      expect(await tx.contribution.findUniqueOrThrow({ where: { id: currentContribution.id } })).toMatchObject({ userId: person.id });
    });
  });
});

describe('QA-LEG04 · aceptaciones de los textos legales', () => {
  it('solo se borra la de un alta sin verificar; nunca la de una cuenta verificada, y la tabla no se vacía', async () => {
    const legal = await db.legalDocumentVersion.findFirstOrThrow({ where: { document: 'condiciones-entidades', locale: 'es' }, orderBy: { publishedAt: 'desc' } });
    const accept = async (emailVerified: boolean, daysAgo: number) => {
      const user = await createUser(db, { emailVerified });
      return db.legalAcceptance.create({ data: { userId: user.id, document: legal.document, locale: legal.locale, version: legal.version, source: 'alta', acceptedAt: new Date(Date.now() - daysAgo * DAY) } });
    };
    const verifiedOld = await accept(true, 30);
    const unverifiedRecent = await accept(false, 2);
    const unverifiedOld = await accept(false, 8);
    // La guarda responde con `restrict_violation`, que Prisma presenta como una restricción violada: se comprueba que se rechaza y que la fila sigue.
    await expect(db.legalAcceptance.deleteMany({ where: { id: verifiedOld.id } })).rejects.toThrow();
    expect(await db.legalAcceptance.count({ where: { id: verifiedOld.id } })).toBe(1);
    expect((await db.legalAcceptance.deleteMany({ where: { id: unverifiedRecent.id } })).count).toBe(1);
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('LegalAcceptance')} WHERE id = ${verifiedOld.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    expect((await db.legalAcceptance.deleteMany({ where: { id: unverifiedOld.id } })).count).toBe(1);
    await expect(db.$executeRawUnsafe(`TRUNCATE ${table('LegalAcceptance')}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    // Y la aplicación no reescribe ninguna.
    await expect(db.legalAcceptance.updateMany({ where: { id: verifiedOld.id }, data: { version: 'otra' } })).rejects.toThrow(/KORUM_IMMUTABLE/);
  });
});

describe('QA-LEG04 · plazos: lo que ya no hace falta se borra', () => {
  it('alertas y tareas a los 12 meses de terminar, solicitudes a los 3 años de cerrarse, y la descripción y la conversación de una idea al año de su fin', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const ago = (days: number) => new Date(now.getTime() - days * DAY);
      const alert = (status: 'OPEN' | 'RESOLVED', resolvedAt: Date | null) => tx.opsAlert.create({ data: { type: 'JOB_FAILED', severity: 'WARNING', status, dedupeKey: uniqueId('alerta'), detailJson: {}, resolvedAt, firstSeenAt: ago(800), lastSeenAt: ago(800) } });
      const oldAlert = await alert('RESOLVED', ago(400));
      const openAlert = await alert('OPEN', null);
      const recentAlert = await alert('RESOLVED', ago(100));
      const job = (status: 'DONE' | 'PENDING', updatedAt: Date) => tx.job.create({ data: { idempotencyKey: uniqueId('tarea'), type: 'OPS_HOUSEKEEPING', payloadJson: {}, runAt: updatedAt, status, updatedAt } });
      const oldJob = await job('DONE', ago(400));
      const pendingJob = await job('PENDING', ago(400));
      const recentJob = await job('DONE', ago(10));
      const request = (completedAt: Date) => tx.privacyRequest.create({ data: { requesterEmailHmac: 'hmac', type: 'EXPORT', status: 'COMPLETED', dueAt: completedAt, completedAt, createdAt: completedAt } });
      const oldRequest = await request(ago(4 * 365));
      const recentRequest = await request(ago(2 * 365));
      const organization = await createOrganization(asClient(tx));
      const idea = (expiresAt: Date) => tx.idea.create({ data: { organizationId: organization.id, alias: uniqueId('FAM'), authorCanonicalEmail: 'autora@pruebas.example', title: 'Huerto', category: 'Patio', description: 'Mi hija Marta propone un huerto', expiresAt } });
      const oldIdea = await idea(ago(400));
      const liveIdea = await idea(ago(30));
      for (const target of [oldIdea, liveIdea]) {
        await tx.ideaMessage.create({ data: { ideaId: target.id, senderRole: 'FAMILY', senderLabel: target.alias, body: '¿Hay novedades?' } });
        await tx.ideaMessage.create({ data: { ideaId: target.id, senderRole: 'ORGANIZATION', senderLabel: 'AFA', body: 'Lo hablamos con la familia de Marta.' } });
      }

      await purgeResolvedOpsAlerts(tx, now, 1000);
      await purgeFinishedJobs(tx, now, 1000);
      await purgeClosedPrivacyRequests(tx, now, 1000);
      await emptyOldIdeaDescriptions(tx, now, 1000);
      await purgeOldIdeaChats(tx, now, 1000);

      expect(await tx.opsAlert.findUnique({ where: { id: oldAlert.id } })).toBeNull();
      expect(await tx.opsAlert.count({ where: { id: { in: [openAlert.id, recentAlert.id] } } })).toBe(2);
      expect(await tx.job.findUnique({ where: { id: oldJob.id } })).toBeNull();
      expect(await tx.job.count({ where: { id: { in: [pendingJob.id, recentJob.id] } } })).toBe(2);
      expect(await tx.privacyRequest.findUnique({ where: { id: oldRequest.id } })).toBeNull();
      expect(await tx.privacyRequest.findUnique({ where: { id: recentRequest.id } })).not.toBeNull();
      expect(await tx.idea.findUniqueOrThrow({ where: { id: oldIdea.id } })).toMatchObject({ description: '', title: 'Huerto' });
      expect(await tx.ideaMessage.count({ where: { ideaId: oldIdea.id } })).toBe(0);
      expect((await tx.idea.findUniqueOrThrow({ where: { id: liveIdea.id } })).description).toContain('huerto');
      expect(await tx.ideaMessage.count({ where: { ideaId: liveIdea.id } })).toBe(2);
    });
  });

  it('un alta que nunca verificó su email se borra a los 7 días con su entidad, su aceptación de los textos y la invitación; una reciente o una entidad usada, no', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const legal = await tx.legalDocumentVersion.findFirstOrThrow({ where: { document: 'condiciones-entidades', locale: 'es' }, orderBy: { publishedAt: 'desc' } });
      const signup = async (daysAgo: number, used = false) => {
        const createdAt = new Date(now.getTime() - daysAgo * DAY);
        const director = await createUser(asClient(tx), { emailVerified: false, createdAt });
        await tx.account.create({ data: { id: uniqueId('acc'), userId: director.id, accountId: director.id, providerId: 'credential', password: 'hash' } });
        const organization = await createOrganization(asClient(tx), { createdAt });
        await tx.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
        await tx.legalAcceptance.create({ data: { userId: director.id, organizationId: organization.id, document: legal.document, locale: legal.locale, version: legal.version, source: 'alta', acceptedAt: createdAt } });
        const cosigner = await createUser(asClient(tx), { emailVerified: false, createdAt });
        await tx.verification.create({ data: { id: uniqueId('inv'), identifier: `korum-invite:${cosigner.id}:${organization.id}`, value: '{}', expiresAt: new Date(createdAt.getTime() + 3 * DAY) } });
        if (used) await createInitiative(asClient(tx), organization.id);
        return { director, organization, cosigner };
      };
      const stale = await signup(8);
      const fresh = await signup(3);
      const used = await signup(8, true);

      expect(await purgeUnverifiedSignups(tx, now, 1000)).toBeGreaterThanOrEqual(1);
      expect(await tx.user.findUnique({ where: { id: stale.director.id } })).toBeNull();
      expect(await tx.user.findUnique({ where: { id: stale.cosigner.id } })).toBeNull();
      expect(await tx.organization.findUnique({ where: { id: stale.organization.id } })).toBeNull();
      expect(await tx.legalAcceptance.count({ where: { organizationId: stale.organization.id } })).toBe(0);
      expect(await tx.verification.count({ where: { identifier: { endsWith: `:${stale.organization.id}` } } })).toBe(0);
      expect(await tx.auditLog.count({ where: { action: 'privacy.unverified_signup_deleted' } })).toBeGreaterThanOrEqual(1);
      for (const kept of [fresh, used]) {
        expect(await tx.user.findUnique({ where: { id: kept.director.id } })).not.toBeNull();
        expect(await tx.organization.findUnique({ where: { id: kept.organization.id } })).not.toBeNull();
      }
    });
  });
});

describe('Aviso de un cambio importante de la política de privacidad (política §13)', () => {
  it('se marca al publicar, exige «qué cambia», solo vale para la política y reparte un email por cuenta verificada, una sola vez', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const verifiedUser = await createUser(asClient(tx));
      const unverified = await createUser(asClient(tx), { emailVerified: false });
      const markdown = '# Política de privacidad\n\nVersión de prueba con un cambio importante.';
      await expect(archiveLegalVersion(tx, { document: 'privacidad', locale: 'es', version: '2099-01-01', markdown, now, importantChange: true })).rejects.toMatchObject({ reason: 'SUMMARY_REQUIRED' });
      await expect(archiveLegalVersion(tx, { document: 'cookies', locale: 'es', version: '2099-01-01', markdown, now, importantChange: true, changeSummary: 'Algo' })).rejects.toBeInstanceOf(LegalVersionConflictError);
      const archived = await archiveLegalVersion(tx, { document: 'privacidad', locale: 'es', version: '2099-01-02', markdown, now, importantChange: true, changeSummary: 'Añadimos un proveedor de emails en la UE.' });
      expect(archived).toMatchObject({ created: true, privacyNotice: true });
      expect(await resolveLegalVersion(tx, 'privacidad', 'ca')).toMatchObject({ version: '2099-01-02', importantChange: true, changeSummary: 'Añadimos un proveedor de emails en la UE.' });

      const first = await runPrivacyPolicyNotices(tx, { now, batchSize: 500 });
      expect(first.hasMore).toBe(false);
      const mine = await tx.outboxMessage.findMany({ where: { templateKey: 'legal.privacyChange', userId: { in: [verifiedUser.id, unverified.id] } } });
      expect(mine.map((row) => row.userId)).toEqual([verifiedUser.id]);
      expect(mine[0]!.payloadJson).toEqual({ version: '2099-01-02', changeSummary: 'Añadimos un proveedor de emails en la UE.' });
      expect(await tx.privacyPolicyNotice.findFirstOrThrow({ where: { version: '2099-01-02' } })).toMatchObject({ completedAt: now });
      // Ya repartido: otra pasada no escribe nada.
      expect((await runPrivacyPolicyNotices(tx, { now, batchSize: 500 })).queued).toBe(0);
    });
  });
});
