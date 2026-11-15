import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY_VISIBLE_ACTIONS } from '@/core/audit/audit-catalog';
import { parseAuditQuery } from '@/core/audit/audit-query';
import type { Prisma } from '@/generated/prisma/client';
import { createKorumAuth, type KorumAuth } from '@/lib/auth/auth-config';
import type { KorumPrismaClient } from '@/lib/prisma';
import { countAttempts } from '@/lib/rate-limit';
import { ACCOUNT_PROBE_RULE, AUTH_SIGN_IN_FAILURE_RULE } from '@/lib/rate-limit-rules';
import { getConsoleAudit, getEntityAudit, resolveAuditPerson } from '@/repositories/audit.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { recordForeignCertificateAttempt, recordForeignPasskeyAttempt } from '@/services/audit/account-probes';
import { hashAuditIp } from '@/services/audit/audit.service';
import { AUDIT_PAGE_SIZE } from '@/services/audit/audit-viewer.service';
import { closeInitiativeAfterPayout } from '@/services/payments/campaign-close';
import { markGoalReached } from '@/services/payments/goal-reached';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, uniqueId } from './test-database';

/**
 * Sprint 5.8a · trazabilidad contra PostgreSQL real.
 *
 * - **QA-SEC11 · visor de la auditoría:** la consola busca por persona, entidad, campaña, tipo, acción y fechas; la entidad ve solo lo suyo, sin las
 *   consultas de KORUM ni el detalle guardado, y de las personas solo el nombre de quien firma hoy por ella. Nadie más entra, y el intento queda anotado.
 * - **QA-SEC12 · huecos de registro:** abrir el certificado o quitar la llave de otra persona, los inicios de sesión fallidos repetidos y cada cambio de
 *   estado de una iniciativa con su motivo dejan su fila, sin emails ni otros datos personales.
 */

let db: KorumPrismaClient;
let auth: KorumAuth;
const APP = 'http://localhost:3000';

beforeAll(() => {
  db = createTestClient();
  auth = createKorumAuth({ db, secret: 'integration-better-auth-secret-0123456789', hmacSecret: TEST_HMAC_SECRET, baseURL: APP, production: false, dispatch: () => undefined });
});

afterAll(async () => {
  await db.$disconnect();
});

const superadmin = async (secondFactor = true): Promise<Extract<SessionActor, { kind: 'user' }>> => {
  const user = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true, name: 'Equipo KORUM' });
  return { kind: 'user', userId: user.id, isSuperadmin: true, memberships: [], secondFactor };
};

async function entityWithSigners(name: string) {
  const organization = await createOrganization(db, { name });
  const director = await createUser(db, { name: `Dirección de ${name}`, twoFactorEnabled: true });
  const cosigner = await createUser(db, { name: `Cofirma de ${name}`, twoFactorEnabled: true });
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR', roleLabel: 'Dirección del centro' } });
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' } });
  const actorOf = (userId: string, role: 'DIRECTOR' | 'COSIGNER', secondFactor = true): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId: organization.id, role }], secondFactor });
  return { organization, director, cosigner, directorActor: actorOf(director.id, 'DIRECTOR'), cosignerActor: actorOf(cosigner.id, 'COSIGNER'), actorOf };
}

const row = (data: Partial<Prisma.AuditLogUncheckedCreateInput> & { action: string }) =>
  db.auditLog.create({ data: { actorType: 'USER', targetType: 'Organization', targetId: 'x', ...data } });

const query = (raw: Record<string, string>, console = true) => parseAuditQuery(raw, { allowUnclassified: console });
const auditOf = (where: Prisma.AuditLogWhereInput) => db.auditLog.findMany({ where, orderBy: { id: 'asc' } });

describe('QA-SEC11 · visor de la auditoría en la consola', () => {
  it('busca por entidad, tipo de actividad, acción, persona, campaña y fechas, de lo más reciente a lo más antiguo', async () => {
    const admin = await superadmin();
    const a = await entityWithSigners('Colegio Auditoría A');
    const b = await entityWithSigners('Club Auditoría B');
    const initiative = await createInitiative(db, a.organization.id);
    const family = await createUser(db, { name: 'Marta Familia' });

    const approved = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'payout.approved', targetType: 'EscrowPayout', targetId: '12', metadataJson: { initiativeId: initiative.id, netPaidCents: 561_000 }, ipHash: hashAuditIp(TEST_HMAC_SECRET, '203.0.113.7'), userAgent: 'Chrome/Windows' });
    const published = await row({ actorUserId: a.cosigner.id, organizationId: a.organization.id, action: 'studio.initiative_published', targetType: 'Initiative', targetId: String(initiative.id) });
    const aboutFamily = await row({ actorType: 'SYSTEM', organizationId: null, action: 'privacy.erasure_blocked', targetType: 'User', targetId: family.id });
    const otherEntity = await row({ actorUserId: b.director.id, organizationId: b.organization.id, action: 'payout.approved', targetType: 'EscrowPayout', targetId: '13' });
    const old = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'sponsor.approved', targetType: 'Sponsor', targetId: '4', occurredAt: new Date('2026-03-10T10:00:00.000Z') });

    const ids = async (raw: Record<string, string>) => (await getConsoleAudit(db, admin, query(raw))).page.rows.map((entry) => entry.id);

    const byEntity = await ids({ entidad: a.organization.id });
    expect(byEntity).toEqual(expect.arrayContaining([approved.id, published.id, old.id]));
    expect(byEntity).not.toContain(otherEntity.id);
    expect([...byEntity].sort((x, y) => y - x)).toEqual(byEntity);

    expect(await ids({ entidad: a.organization.id, familia: 'money' })).toEqual([approved.id]);
    expect(await ids({ entidad: a.organization.id, accion: 'sponsor.approved' })).toEqual([old.id]);
    expect(await ids({ persona: a.cosigner.id })).toEqual([published.id]);
    // Persona: lo que hizo y también lo que se hizo sobre su cuenta.
    expect(await ids({ persona: family.id })).toEqual([aboutFamily.id]);
    // Campaña: por su objetivo y por el detalle guardado (la liquidación apunta a la campaña desde `initiativeId`).
    expect((await ids({ iniciativa: String(initiative.id) })).sort()).toEqual([approved.id, published.id].sort());
    // Fechas en hora de España: el 10 de marzo entero, y nada el día 11.
    expect(await ids({ entidad: a.organization.id, desde: '2026-03-10', hasta: '2026-03-10' })).toEqual([old.id]);
    expect(await ids({ entidad: a.organization.id, desde: '2026-03-11', hasta: '2026-03-11' })).toEqual([]);

    const view = await getConsoleAudit(db, admin, query({ entidad: a.organization.id, accion: 'payout.approved' }));
    expect(view.page.rows[0]).toMatchObject({
      action: 'payout.approved',
      category: 'money',
      actor: { kind: 'person', name: a.director.name, email: a.director.email },
      organization: { id: a.organization.id, name: 'Colegio Auditoría A' },
      target: { type: 'EscrowPayout', id: '12' },
      device: 'Chrome/Windows'
    });
    // De la red, solo una marca corta del HMAC: nunca la IP.
    expect(view.page.rows[0]!.network).toMatch(/^[0-9a-f]{8}$/);
    // Una cuenta sobre la que se actuó se dice por su nombre y su email, no por su código; la entidad de la propia fila, sin código.
    expect((await getConsoleAudit(db, admin, query({ persona: family.id }))).page.rows[0]!.target).toMatchObject({ type: 'User', id: `Marta Familia (${family.email})` });
    await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'organization.settings_updated', targetType: 'Organization', targetId: a.organization.id });
    expect((await getConsoleAudit(db, admin, query({ entidad: a.organization.id, accion: 'organization.settings_updated' }))).page.rows[0]!.target).toMatchObject({ type: 'Organization', id: null });
    expect(JSON.stringify(view.page.rows)).not.toContain('203.0.113.7');
    expect(view.page.rows[0]!.details).toEqual(expect.arrayContaining([{ key: 'netPaidCents', value: '561000' }]));
    // El desplegable de entidades va por orden alfabético.
    const names = view.organizations.map((organization) => organization.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, 'es')));
  });

  it('pagina de 50 en 50 sin repetir ni perder filas', async () => {
    const admin = await superadmin();
    const { organization } = await entityWithSigners('Entidad con mucha actividad');
    await db.auditLog.createMany({ data: Array.from({ length: AUDIT_PAGE_SIZE + 7 }, (_, index) => ({ actorType: 'SYSTEM' as const, organizationId: organization.id, action: 'gate.check_in', targetType: 'Initiative', targetId: String(index + 1) })) });
    const first = await getConsoleAudit(db, admin, query({ entidad: organization.id, accion: 'gate.check_in' }));
    expect(first.page.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.page.nextBefore).toBe(first.page.rows.at(-1)!.id);
    const second = await getConsoleAudit(db, admin, query({ entidad: organization.id, accion: 'gate.check_in', antes: String(first.page.nextBefore) }));
    expect(second.page.rows).toHaveLength(7);
    expect(second.page.nextBefore).toBeNull();
    expect(new Set([...first.page.rows, ...second.page.rows].map((entry) => entry.id)).size).toBe(AUDIT_PAGE_SIZE + 7);
  });

  it('enseña las acciones que aún no están en el catálogo como «sin clasificar» y vuelve a limpiar el detalle', async () => {
    const admin = await superadmin();
    const { organization } = await entityWithSigners('Entidad con una acción nueva');
    // `prueba.*` es el único prefijo que la comprobación global del catálogo deja pasar (`global-setup.ts`).
    const action = `prueba.sin_clasificar_${Date.now().toString(36)}`;
    await row({ actorType: 'SYSTEM', organizationId: organization.id, action, metadataJson: { contactEmail: 'ana@ejemplo.com', note: 'llamar a ana@ejemplo.com', amountCents: 100 } });
    const view = await getConsoleAudit(db, admin, query({ entidad: organization.id, familia: 'unclassified' }));
    expect(view.page.rows).toHaveLength(1);
    expect(view.page.rows[0]).toMatchObject({ action, category: null, actor: { kind: 'system' } });
    expect(JSON.stringify(view.page.rows[0]!.details)).not.toContain('ana@ejemplo.com');
    expect(view.page.rows[0]!.details).toEqual(expect.arrayContaining([{ key: 'amountCents', value: '100' }]));
    // La entidad no la ve: su lista es cerrada.
    const director: SessionActor = { kind: 'user', userId: (await db.organizationMember.findFirstOrThrow({ where: { organizationId: organization.id, role: 'DIRECTOR' } })).userId, isSuperadmin: false, memberships: [{ organizationId: organization.id, role: 'DIRECTOR' }], secondFactor: true };
    expect((await getEntityAudit(db, director, organization.id, {})).page.rows.map((entry) => entry.action)).not.toContain(action);
  });

  it('una cuenta suprimida sale como tal, sin nombre ni email', async () => {
    const admin = await superadmin();
    const { organization } = await entityWithSigners('Entidad con una cuenta suprimida');
    const erased = await createUser(db, { name: 'Nombre que ya no debe verse', gdprAnonymizedAt: new Date() });
    await row({ actorUserId: erased.id, organizationId: organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: '1', metadataJson: { topic: 'INITIATIVE', target: 'ORGANIZATION' } });
    const view = await getConsoleAudit(db, admin, query({ entidad: organization.id, persona: erased.id }));
    expect(view.page.rows[0]!.actor).toEqual({ kind: 'erased' });
    expect(view.person).toMatchObject({ erased: true, name: null, email: null });
    expect(JSON.stringify(view)).not.toContain('Nombre que ya no debe verse');
  });

  it('traduce un email a su cuenta sin guardarlo, y dice cuándo no hay ninguna', async () => {
    const admin = await superadmin();
    const person = await createUser(db, { name: 'Laura Buscada' });
    const before = await db.auditLog.count();
    expect(await resolveAuditPerson(db, admin, `  ${person.email.toUpperCase()} `)).toBe(person.id);
    expect(await resolveAuditPerson(db, admin, 'nadie-con-este-email@pruebas.example')).toBeNull();
    expect(await resolveAuditPerson(db, admin, 'no es un email')).toBeNull();
    const written = await db.auditLog.findMany({ where: { id: { gt: 0 }, actorUserId: admin.userId }, select: { action: true, metadataJson: true } });
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(await db.auditLog.count()).toBeGreaterThan(before);
    expect(JSON.stringify(written)).not.toContain(person.email);
    expect(JSON.stringify(written)).not.toContain('nadie-con-este-email');

    const view = await getConsoleAudit(db, admin, query({ persona: 'cuenta-que-no-existe' }));
    expect(view.personNotFound).toBe(true);
    expect(view.page.rows).toEqual([]);
  });

  it('solo entra el Super-Admin con su segundo factor; los demás quedan anotados y no leen nada', async () => {
    const { directorActor, director } = await entityWithSigners('Entidad que intenta leer la consola');
    await expect(getConsoleAudit(db, directorActor, {})).rejects.toBeInstanceOf(TenantAccessError);
    await expect(resolveAuditPerson(db, directorActor, 'alguien@pruebas.example')).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getConsoleAudit(db, { kind: 'anonymous' }, {})).rejects.toBeInstanceOf(TenantAccessError);
    const denied = await auditOf({ actorUserId: director.id, action: 'tenant.access_denied' });
    expect(denied.map((entry) => (entry.metadataJson as { attempted: string }).attempted).sort()).toEqual(['console.audit', 'console.audit_person_lookup']);
    expect(JSON.stringify(denied)).not.toContain('alguien@pruebas.example');

    const withoutSecondFactor = await superadmin(false);
    await expect(getConsoleAudit(db, withoutSecondFactor, {})).rejects.toBeInstanceOf(TenantAccessError);
    expect((await auditOf({ actorUserId: withoutSecondFactor.userId, action: 'tenant.access_denied' }))[0]?.metadataJson).toMatchObject({ reason: 'SECOND_FACTOR_REQUIRED' });

    const admin = await superadmin();
    await getConsoleAudit(db, admin, {});
    expect((await auditOf({ actorUserId: admin.userId, action: 'superadmin.access' }))[0]?.metadataJson).toMatchObject({ operation: 'console.audit' });

    // Sus propias consultas quedan guardadas, pero no tapan el visor: solo salen si se piden por tipo o por acción.
    const mine = async (raw: Record<string, string>) => (await getConsoleAudit(db, admin, query({ persona: admin.userId, ...raw }))).page.rows.map((entry) => entry.action);
    expect(await mine({})).toEqual([]);
    expect((await mine({ familia: 'korumAccess' })).length).toBeGreaterThanOrEqual(2);
    expect(new Set(await mine({ accion: 'superadmin.access' }))).toEqual(new Set(['superadmin.access']));
  });
});

describe('QA-SEC11 · registro de actividad de la entidad: solo lo suyo', () => {
  it('ve sus filas y ninguna de otra entidad, ni las consultas de KORUM, ni los ajustes de la plataforma, ni las tareas automáticas', async () => {
    const a = await entityWithSigners('Colegio que mira su registro');
    const b = await entityWithSigners('Otra entidad');
    const admin = await superadmin();
    const family = await createUser(db, { name: 'Familia Con Nombre Privado' });

    const signed = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'double_check.signed', targetType: 'ESCROW_PAYOUT', targetId: '5', metadataJson: { signerRole: 'DIRECTOR', signatureId: 9 }, ipHash: 'f'.repeat(64), userAgent: 'Safari/iOS' });
    const byFamily = await row({ actorUserId: family.id, organizationId: a.organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: '77', metadataJson: { topic: 'INITIATIVE', target: 'ORGANIZATION' } });
    const byKorum = await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'organization.tariffs_updated', targetId: a.organization.id });
    const denied = await row({ actorUserId: b.director.id, organizationId: a.organization.id, action: 'tenant.access_denied', metadataJson: { attempted: 'panel.view', organizations: [`${b.organization.id}:DIRECTOR`] } });
    const bySystem = await row({ actorType: 'SYSTEM', organizationId: a.organization.id, action: 'initiative.expired', targetType: 'Initiative', targetId: '3' });
    // Lo que una entidad no ve aunque lleve su identificador.
    await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'superadmin.access', metadataJson: { operation: 'console.organization_360' } });
    await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'ops_alert.resolved', targetType: 'OpsAlert', targetId: '1' });
    await row({ actorType: 'SYSTEM', organizationId: a.organization.id, action: 'job.completed', targetType: 'Job', targetId: '1' });
    // Y lo de otra entidad.
    await row({ actorUserId: b.director.id, organizationId: b.organization.id, action: 'double_check.signed', targetType: 'ESCROW_PAYOUT', targetId: '6' });

    const view = await getEntityAudit(db, a.directorActor, a.organization.id, {});
    expect(view.page.rows.map((entry) => entry.id).sort()).toEqual([signed.id, byFamily.id, byKorum.id, denied.id, bySystem.id].sort());
    expect(view.page.rows.every((entry) => ENTITY_VISIBLE_ACTIONS.includes(entry.action))).toBe(true);

    const byId = new Map(view.page.rows.map((entry) => [entry.id, entry]));
    // Quien firma hoy por ella, con su nombre y su cargo.
    expect(byId.get(signed.id)).toMatchObject({ actor: { kind: 'member', name: a.director.name, role: 'DIRECTOR', roleLabel: 'Dirección del centro' }, device: 'Safari/iOS', target: { type: 'ESCROW_PAYOUT', id: '5' } });
    // Una familia, la firmante de otra entidad y KORUM: sin nombre ni email.
    expect(byId.get(byFamily.id)!.actor).toEqual({ kind: 'other' });
    expect(byId.get(denied.id)!.actor).toEqual({ kind: 'other' });
    expect(byId.get(byKorum.id)!.actor).toEqual({ kind: 'korum', name: null, email: null });
    expect(byId.get(bySystem.id)!.actor).toEqual({ kind: 'system' });
    // Su propia entidad sale como «Entidad», sin el código interno; los números de liquidación o de consulta sí se ven.
    expect(byId.get(byKorum.id)!.target).toMatchObject({ type: 'Organization', id: null });
    expect(byId.get(byFamily.id)!.target).toMatchObject({ type: 'SupportTicket', id: '77' });
    // Ni el detalle guardado, ni la red, ni el nombre de la entidad (ya sabe cuál es).
    expect(view.page.rows.every((entry) => entry.details.length === 0 && entry.network === null && entry.organization === null)).toBe(true);
    const text = JSON.stringify(view);
    for (const secret of [family.name, family.email, b.director.name, b.director.email, b.organization.id, admin.userId, 'Equipo KORUM', 'ffffffff']) expect(text).not.toContain(secret);

    // Las personas por las que puede filtrar son quienes firman hoy por ella.
    expect(view.members.map((member) => member.userId)).toEqual([a.director.id, a.cosigner.id]);
  });

  it('los filtros que llegan del navegador solo estrechan lo suyo: ni otra entidad, ni otra persona', async () => {
    const a = await entityWithSigners('Entidad que filtra');
    const b = await entityWithSigners('Entidad ajena al filtro');
    const outsider = await createUser(db);
    const mine = await row({ actorUserId: a.cosigner.id, organizationId: a.organization.id, action: 'payout.requested', targetType: 'EscrowPayout', targetId: '1' });
    const theirs = await row({ actorUserId: b.director.id, organizationId: b.organization.id, action: 'payout.requested', targetType: 'EscrowPayout', targetId: '2' });
    await row({ actorUserId: outsider.id, organizationId: a.organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: '2', metadataJson: { topic: 'INITIATIVE', target: 'ORGANIZATION' } });

    // Pedir la entidad de otra en la dirección no cambia nada: la consulta lleva siempre la propia.
    const forced = await getEntityAudit(db, a.directorActor, a.organization.id, query({ entidad: b.organization.id, accion: 'payout.requested' }, false));
    expect(forced.page.rows.map((entry) => entry.id)).toEqual([mine.id]);
    expect(forced.page.rows.map((entry) => entry.id)).not.toContain(theirs.id);
    expect(forced.applied.organizationId).toBeUndefined();

    // Filtrar por una persona que no firma por la entidad se descarta: no sirve para saber qué hizo una familia concreta.
    const byOutsider = await getEntityAudit(db, a.directorActor, a.organization.id, query({ persona: outsider.id }, false));
    expect(byOutsider.applied.personUserId).toBeUndefined();
    expect(byOutsider.page.rows.length).toBeGreaterThanOrEqual(2);
    const byCosigner = await getEntityAudit(db, a.directorActor, a.organization.id, query({ persona: a.cosigner.id }, false));
    expect(byCosigner.page.rows.map((entry) => entry.id)).toEqual([mine.id]);

    // Las familias de la consola no existen aquí.
    expect((await getEntityAudit(db, a.directorActor, a.organization.id, query({ familia: 'platform' }, false))).page.rows).toEqual([]);
    expect(query({ familia: 'unclassified' }, false).category).toBeUndefined();
  });

  it('quien firma por otra entidad, quien no ha pasado el segundo factor y quien no tiene sesión no leen nada, y queda anotado', async () => {
    const a = await entityWithSigners('Entidad protegida');
    const b = await entityWithSigners('Entidad curiosa');
    await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'payout.approved', targetType: 'EscrowPayout', targetId: '1' });

    await expect(getEntityAudit(db, b.directorActor, a.organization.id, {})).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getEntityAudit(db, { kind: 'anonymous' }, a.organization.id, {})).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getEntityAudit(db, a.actorOf(a.cosigner.id, 'COSIGNER', false), a.organization.id, {})).rejects.toBeInstanceOf(TenantAccessError);
    const gatekeeper: SessionActor = { kind: 'user', userId: (await createUser(db)).id, isSuperadmin: false, memberships: [{ organizationId: a.organization.id, role: 'GATEKEEPER' }], secondFactor: true };
    await expect(getEntityAudit(db, gatekeeper, a.organization.id, {})).rejects.toBeInstanceOf(TenantAccessError);

    const intruder = await auditOf({ actorUserId: b.director.id, organizationId: a.organization.id, action: 'tenant.access_denied' });
    expect(intruder).toHaveLength(1);
    expect(intruder[0]!.metadataJson).toMatchObject({ attempted: 'audit.read', reason: 'NOT_A_MEMBER' });
    expect((await auditOf({ actorUserId: a.cosigner.id, organizationId: a.organization.id, action: 'tenant.access_denied' }))[0]?.metadataJson).toMatchObject({ attempted: 'audit.read', reason: 'SECOND_FACTOR_REQUIRED' });

    // La segunda persona firmante sí lo ve: no es solo de Dirección.
    expect((await getEntityAudit(db, a.cosignerActor, a.organization.id, {})).page.rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('QA-SEC12 · huecos de registro', () => {
  const contribution = (organizationId: string, initiativeId: number, data: Partial<Prisma.ContributionUncheckedCreateInput>) =>
    db.contribution.create({ data: { organizationId, initiativeId, fiscalYear: 2026, amountCents: 2_500, totalChargedCents: 2_500, paymentMethod: 'CARD', status: 'COMPLETED', type: 'DONATION', paycometOrder: uniqueId('ORD'), ...data } });

  it('abrir el certificado de otra persona queda anotado; uno que no existe o uno propio, no', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const ana = await createUser(db);
    const otra = await createUser(db);
    const foreign = await contribution(organization.id, initiative.id, { userId: otra.id, canonicalEmail: otra.canonicalEmail });
    const ownRefunded = await contribution(organization.id, initiative.id, { userId: ana.id, canonicalEmail: ana.canonicalEmail, status: 'REFUNDED', refundedCents: 2_500 });
    const probe = { userId: ana.id, requestMeta: { ipHash: hashAuditIp(TEST_HMAC_SECRET, '198.51.100.9'), userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } };

    expect(await recordForeignCertificateAttempt(db, probe, foreign.id)).toBe(true);
    expect(await recordForeignCertificateAttempt(db, probe, 2_000_000_000)).toBe(false);
    expect(await recordForeignCertificateAttempt(db, probe, ownRefunded.id)).toBe(false);

    const rows = await auditOf({ actorUserId: ana.id, action: 'account.certificate_denied' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'USER', organizationId: null, targetType: 'Contribution', targetId: String(foreign.id), userAgent: 'Safari/iOS', metadataJson: { reason: 'NOT_OWNER' } });
    expect(rows[0]!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    // Ni el email ni el identificador de la otra persona, ni la IP.
    const text = JSON.stringify(rows);
    for (const secret of [otra.id, otra.email, ana.email, '198.51.100.9']) expect(text).not.toContain(secret);
  });

  it('recorrer números de donación no llena la auditoría: solo las primeras de cada cuarto de hora', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const curious = await createUser(db);
    const victim = await createUser(db);
    const foreign = await contribution(organization.id, initiative.id, { userId: victim.id, canonicalEmail: victim.canonicalEmail });
    const now = new Date();
    const results: boolean[] = [];
    for (let attempt = 0; attempt < ACCOUNT_PROBE_RULE.limit + 5; attempt += 1) results.push(await recordForeignCertificateAttempt(db, { userId: curious.id }, foreign.id, now));
    expect(results.filter(Boolean)).toHaveLength(ACCOUNT_PROBE_RULE.limit);
    expect(await db.auditLog.count({ where: { actorUserId: curious.id, action: 'account.certificate_denied' } })).toBe(ACCOUNT_PROBE_RULE.limit);
    // Pasada la ventana, vuelve a anotarse.
    expect(await recordForeignCertificateAttempt(db, { userId: curious.id }, foreign.id, new Date(now.getTime() + ACCOUNT_PROBE_RULE.windowMs + 1_000))).toBe(true);
  });

  it('intentar quitar la llave de acceso de otra persona queda anotado, y la llave sigue en su sitio', async () => {
    const owner = await createUser(db);
    const intruder = await createUser(db);
    const key = await db.passkey.create({ data: { id: uniqueId('pk'), userId: owner.id, publicKey: 'clave-publica', credentialID: uniqueId('cred'), counter: 0, deviceType: 'singleDevice', backedUp: false } });

    expect(await recordForeignPasskeyAttempt(db, { userId: intruder.id }, key.id)).toBe(true);
    expect(await recordForeignPasskeyAttempt(db, { userId: owner.id }, key.id)).toBe(false);
    expect(await recordForeignPasskeyAttempt(db, { userId: intruder.id }, 'llave-que-no-existe')).toBe(false);

    const rows = await auditOf({ actorUserId: intruder.id, action: 'account.passkey_delete_denied' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'Passkey', targetId: key.id, organizationId: null, metadataJson: { reason: 'NOT_OWNER' } });
    expect(JSON.stringify(rows)).not.toContain(owner.id);
    expect(await db.passkey.count({ where: { id: key.id } })).toBe(1);
  });

  const withPassword = async (password: string) => {
    const user = await createUser(db);
    await db.account.create({ data: { id: uniqueId('acc'), userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) } });
    return user;
  };
  const signIn = (email: string, password: string, ip: string) =>
    auth.api
      .signInEmail({ body: { email, password }, headers: new Headers({ 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', origin: APP }), asResponse: true })
      .then((response) => response.status)
      .catch((error: { statusCode?: number }) => error.statusCode ?? 500);

  it('tres contraseñas mal seguidas dejan una fila; después, una cada cinco; entrar bien pone el contador a cero', async () => {
    const password = 'una-contraseña-larga-de-pruebas';
    const user = await withPassword(password);
    const key = `${AUTH_SIGN_IN_FAILURE_RULE.prefix}u:${user.id}`;
    const failed = () => db.auditLog.findMany({ where: { action: 'auth.sign_in_failed_repeatedly', targetId: user.id }, orderBy: { id: 'asc' } });

    expect(await signIn(user.email, 'no-es-la-contraseña', '192.0.2.10')).toBe(401);
    expect(await signIn(user.email, 'tampoco-es-esta', '192.0.2.11')).toBe(401);
    expect(await failed()).toHaveLength(0);
    // El tercero, aunque venga de otra red: se cuenta por cuenta.
    expect(await signIn(user.email, 'ni-esta-otra', '192.0.2.12')).toBe(401);
    let rows = await failed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'USER', actorUserId: null, organizationId: null, targetType: 'User', userAgent: 'Chrome/Windows', metadataJson: { method: 'password', failures: 3, windowMinutes: 15, knownAccount: true } });
    expect(rows[0]!.ipHash).toBe(hashAuditIp(TEST_HMAC_SECRET, '192.0.2.12'));
    // Ni el email ni lo que se tecleó como contraseña.
    const text = JSON.stringify(rows);
    for (const secret of [user.email, 'ni-esta-otra', 'no-es-la-contraseña', '192.0.2.12']) expect(text).not.toContain(secret);

    for (let attempt = 4; attempt <= 8; attempt += 1) await signIn(user.email, `intento-${attempt}-equivocado`, '192.0.2.13');
    rows = await failed();
    expect(rows.map((entry) => (entry.metadataJson as { failures: number }).failures)).toEqual([3, 8]);

    expect(await signIn(user.email, password, '192.0.2.14')).toBe(200);
    expect(await countAttempts(db, key)).toBe(0);
    await signIn(user.email, 'otra-vez-mal', '192.0.2.15');
    expect(await countAttempts(db, key)).toBe(1);
    expect(await failed()).toHaveLength(2);
  });

  it('contra una cuenta que no existe se cuenta por red y no se guarda nada del email tecleado', async () => {
    const ip = `192.0.2.${100 + Math.floor(Math.random() * 100)}`;
    const email = `${uniqueId('fantasma')}@pruebas.example`;
    const ipHash = hashAuditIp(TEST_HMAC_SECRET, ip);
    await db.rateLimit.deleteMany({ where: { key: `${AUTH_SIGN_IN_FAILURE_RULE.prefix}n:${ipHash}` } });
    const before = await db.auditLog.count({ where: { action: 'auth.sign_in_failed_repeatedly', ipHash } });
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await signIn(email, 'cualquier-contraseña-larga', ip)).toBe(401);
    const rows = await db.auditLog.findMany({ where: { action: 'auth.sign_in_failed_repeatedly', ipHash }, orderBy: { id: 'desc' } });
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({ targetType: 'Account', targetId: 'unknown', actorUserId: null, metadataJson: { method: 'password', failures: 3, knownAccount: false } });
    expect(JSON.stringify(rows[0])).not.toContain('fantasma');
  });

  it('cada cambio de estado de una iniciativa deja de qué estado a cuál y por qué, en la misma transacción', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const changes = () => auditOf({ action: 'initiative.status_changed', targetType: 'Initiative', targetId: String(initiative.id) });

    await db.$transaction((tx) => markGoalReached(tx, organization.id, initiative.id, new Date()));
    await db.$transaction((tx) => closeInitiativeAfterPayout(tx, { payoutId: 1, initiativeId: initiative.id, organizationId: organization.id, netPaidCents: 100, destinationType: 'ORGANIZATION' }, new Date()));
    const rows = await changes();
    expect(rows.map((entry) => entry.metadataJson)).toEqual([
      { initiativeId: initiative.id, from: 'FUNDRAISING', to: 'GOAL_REACHED', reason: 'GOAL_REACHED' },
      { initiativeId: initiative.id, from: 'GOAL_REACHED', to: 'CLOSED', reason: 'PAYOUT_SENT' }
    ]);
    expect(rows.every((entry) => entry.actorType === 'SYSTEM' && entry.organizationId === organization.id)).toBe(true);
    // Repetir el cierre no cambia nada y no deja otra fila.
    await db.$transaction((tx) => closeInitiativeAfterPayout(tx, { payoutId: 1, initiativeId: initiative.id, organizationId: organization.id, netPaidCents: 100, destinationType: 'ORGANIZATION' }, new Date()));
    expect(await changes()).toHaveLength(2);

    // Si la operación se deshace, el rastro también: nunca dice que cambió algo que no cambió.
    const other = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    await expect(
      db.$transaction(async (tx) => {
        await markGoalReached(tx, organization.id, other.id, new Date());
        throw new Error('la operación falla después');
      })
    ).rejects.toThrow('la operación falla después');
    expect(await db.auditLog.count({ where: { action: 'initiative.status_changed', targetId: String(other.id) } })).toBe(0);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: other.id }, select: { status: true } })).status).toBe('FUNDRAISING');

    // La entidad lo ve en su registro, con el motivo.
    const { directorActor } = { directorActor: { kind: 'user', userId: (await createUser(db)).id, isSuperadmin: false, memberships: [{ organizationId: organization.id, role: 'DIRECTOR' }], secondFactor: true } as SessionActor };
    const view = await getEntityAudit(db, directorActor, organization.id, query({ accion: 'initiative.status_changed', iniciativa: String(initiative.id) }, false));
    expect(view.page.rows.map((entry) => entry.statusChange)).toEqual([
      { from: 'GOAL_REACHED', to: 'CLOSED', reason: 'PAYOUT_SENT' },
      { from: 'FUNDRAISING', to: 'GOAL_REACHED', reason: 'GOAL_REACHED' }
    ]);
  });
});
