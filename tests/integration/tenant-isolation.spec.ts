import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import { listContributions } from '@/repositories/contribution.repository';
import { getInitiative, listInitiatives } from '@/repositories/initiative.repository';
import { getOrganization, listOrganizations, updateOrganizationBranding } from '@/repositories/organization.repository';
import { getPublicInitiative, getPublicOrganization, listPublicInitiatives } from '@/repositories/public.repository';
import { listIdeas, listSponsors } from '@/repositories/sponsor-idea.repository';
import { authorizeTenant, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { createInitiative, createOrganization, createTestClient, createUser, uniqueId } from './test-database';

/** QA-SEC01 · aislamiento entre entidades (anti-IDOR): dos colegios, sus personas y sus datos. */

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let db: KorumPrismaClient;

interface Tenant {
  orgId: string;
  slug: string;
  initiativeId: number;
  draftInitiativeId: number;
  director: SessionActor;
  cosigner: SessionActor;
  gatekeeper: SessionActor;
  directorId: string;
}

let cervantes: Tenant;
let sanJose: Tenant;
let superadmin: SessionActor;
let superadminId: string;
let outsider: SessionActor;

async function createTenant(name: string, brand: string): Promise<Tenant> {
  const organization = await createOrganization(db, { name, brandPrimary: brand, brandSecondary: brand, iban: 'ES91 2100 0418 4502 0005 1332', cif: uniqueId('G'), contactEmail: `${uniqueId('c')}@entidad.example` });
  const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', title: `Campaña de ${name}`, gatePinHash: 'hash-secreto-del-pin' });
  const draft = await createInitiative(db, organization.id, { status: 'BUDGETING', title: `Borrador de ${name}` });
  await db.contribution.create({
    data: { organizationId: organization.id, initiativeId: initiative.id, guestEmail: `donante-${organization.id}@familias.example`, canonicalEmail: `donante-${organization.id}@familias.example`, fiscalYear: 2026, amountCents: 2_500, totalChargedCents: 2_500, paymentMethod: 'CARD', status: 'COMPLETED' }
  });
  await db.sponsor.create({ data: { organizationId: organization.id, name: `Comercio de ${name}`, cif: 'B-1', contactPerson: 'x', phone: '1', email: 'c@x.test', sector: 's', tierLabel: 't', amountCents: 10_000, feeGeneratedCents: 1_500, promo: 'p', code: uniqueId('C'), expiresAt: new Date('2027-01-01') } });
  await db.idea.create({ data: { organizationId: organization.id, alias: 'Código #FAM-0001', authorCanonicalEmail: `autor-${organization.id}@familias.example`, title: `Idea de ${name}`, category: 'Patios y Deporte', description: 'd', expiresAt: new Date('2027-01-01') } });

  const members = await Promise.all(
    (['DIRECTOR', 'COSIGNER', 'GATEKEEPER'] as const).map(async (role) => {
      const user = await createUser(db);
      await db.organizationMember.create({ data: { userId: user.id, organizationId: organization.id, role } });
      return { role, userId: user.id, actor: await loadUserActor(db, user.id, { ipHash: 'hash-de-ip', userAgent: CHROME_WINDOWS }) };
    })
  );
  const pick = (role: string) => members.find((member) => member.role === role)!;
  return { orgId: organization.id, slug: organization.slug, initiativeId: initiative.id, draftInitiativeId: draft.id, director: pick('DIRECTOR').actor, cosigner: pick('COSIGNER').actor, gatekeeper: pick('GATEKEEPER').actor, directorId: pick('DIRECTOR').userId };
}

beforeAll(async () => {
  db = createTestClient();
  cervantes = await createTenant('CEIP Cervantes', '#101F38');
  sanJose = await createTenant('Colegio San José', '#0284C7');
  const admin = await createUser(db, { isSuperadmin: true });
  superadminId = admin.id;
  superadmin = await loadUserActor(db, admin.id);
  outsider = await loadUserActor(db, (await createUser(db)).id);
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

const denied = (organizationId: string, userId?: string) => db.auditLog.findMany({ where: { action: 'tenant.access_denied', organizationId, ...(userId ? { actorUserId: userId } : {}) }, orderBy: { id: 'desc' } });

describe('QA-SEC01 · el director de Cervantes invoca todo con la entidad de San José', () => {
  it('cada repositorio responde 403 y queda en AuditLog sin que se lea ni modifique nada', async () => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['organization.get', () => getOrganization(db, cervantes.director, sanJose.orgId)],
      ['initiative.list', () => listInitiatives(db, cervantes.director, sanJose.orgId)],
      ['initiative.get', () => getInitiative(db, cervantes.director, sanJose.orgId, sanJose.initiativeId)],
      ['contribution.list', () => listContributions(db, cervantes.director, sanJose.orgId, sanJose.initiativeId)],
      ['sponsor.list', () => listSponsors(db, cervantes.director, sanJose.orgId)],
      ['idea.list', () => listIdeas(db, cervantes.director, sanJose.orgId)],
      ['organization.branding.update', () => updateOrganizationBranding(db, cervantes.director, sanJose.orgId, { brandPrimary: '#FF0000', brandSecondary: '#FF0000' })]
    ];
    for (const [action, attempt] of attempts) {
      const error = await attempt().catch((caught: unknown) => caught);
      expect(error, action).toBeInstanceOf(TenantAccessError);
      expect((error as TenantAccessError).status).toBe(403);
    }

    const logged = await denied(sanJose.orgId, cervantes.directorId);
    expect(logged.map((row) => (row.metadataJson as { attempted: string }).attempted).sort()).toEqual(attempts.map(([action]) => action).sort());
    for (const row of logged) {
      expect(row).toMatchObject({ actorType: 'USER', actorUserId: cervantes.directorId, organizationId: sanJose.orgId, ipHash: 'hash-de-ip', userAgent: 'Chrome/Windows' });
      expect(row.metadataJson).toMatchObject({ reason: 'NOT_A_MEMBER' });
    }
    // Nada de San José cambió.
    const stored = await db.organization.findUniqueOrThrow({ where: { id: sanJose.orgId }, select: { brandPrimary: true } });
    expect(stored.brandPrimary).toBe('#0284C7');
  });

  it('en su propia entidad sí funciona y nunca aparece nada de la otra', async () => {
    const own = await listInitiatives(db, cervantes.director, cervantes.orgId);
    expect(own.map((initiative) => initiative.id).sort()).toEqual([cervantes.initiativeId, cervantes.draftInitiativeId].sort());
    expect(own.every((initiative) => initiative.organizationId === cervantes.orgId)).toBe(true);
    expect((await listSponsors(db, cervantes.director, cervantes.orgId)).map((sponsor) => sponsor.name)).toEqual(['Comercio de CEIP Cervantes']);
    expect((await listIdeas(db, cervantes.director, cervantes.orgId)).map((idea) => idea.title)).toEqual(['Idea de CEIP Cervantes']);
  });
});

describe('anti-enumeración: identificadores de recursos de otra entidad', () => {
  it('pedir la iniciativa de San José desde Cervantes da el mismo 404 que una inexistente, y se registra', async () => {
    const other = await getInitiative(db, cervantes.director, cervantes.orgId, sanJose.initiativeId).catch((error: unknown) => error);
    const missing = await getInitiative(db, cervantes.director, cervantes.orgId, 999_999_999).catch((error: unknown) => error);
    expect(other).toBeInstanceOf(ResourceNotFoundError);
    expect(missing).toBeInstanceOf(ResourceNotFoundError);
    expect((other as Error).message).toBe((missing as Error).message);

    const attempts = await db.auditLog.findMany({ where: { action: 'tenant.resource_outside_tenant', organizationId: cervantes.orgId, targetId: String(sanJose.initiativeId) } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.metadataJson).toMatchObject({ ownerOrganizationId: sanJose.orgId });
    // Una iniciativa inexistente se registra como sondeo, no como «cruce»: el trabajo es el mismo en ambos casos.
    expect(await db.auditLog.count({ where: { action: 'tenant.resource_outside_tenant', targetId: '999999999' } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'tenant.resource_not_found', organizationId: cervantes.orgId, targetId: '999999999' } })).toBe(1);
  });

  it('las aportaciones de una iniciativa ajena tampoco se listan con el identificador de la propia entidad', async () => {
    await expect(listContributions(db, cervantes.director, cervantes.orgId, sanJose.initiativeId)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await listContributions(db, cervantes.director, cervantes.orgId, cervantes.initiativeId)).toHaveLength(1);
  });
});

describe('roles dentro de la propia entidad', () => {
  it('portería no gestiona la entidad; la persona que cofirma lee pero no cambia la marca', async () => {
    await expect(listInitiatives(db, cervantes.gatekeeper, cervantes.orgId)).rejects.toMatchObject({ status: 403, reason: 'ROLE_NOT_ALLOWED' });
    await expect(getOrganization(db, cervantes.cosigner, cervantes.orgId)).resolves.toMatchObject({ id: cervantes.orgId });
    await expect(updateOrganizationBranding(db, cervantes.cosigner, cervantes.orgId, { brandPrimary: '#000000', brandSecondary: '#FFFFFF' })).rejects.toMatchObject({ status: 403, reason: 'ROLE_NOT_ALLOWED' });
    expect((await db.organization.findUniqueOrThrow({ where: { id: cervantes.orgId } })).brandPrimary).toBe('#101F38');
  });

  it('quien dirige cambia la marca, con validación y con el antes y el después en AuditLog', async () => {
    const result = await updateOrganizationBranding(db, cervantes.director, cervantes.orgId, { brandPrimary: '#047857', brandSecondary: '#F59E0B' });
    expect(result).toEqual({ brandPrimary: '#047857', brandSecondary: '#F59E0B' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'organization.branding.updated', organizationId: cervantes.orgId } });
    expect(audit.metadataJson).toMatchObject({ before: { brandPrimary: '#101F38' }, after: { brandPrimary: '#047857' } });

    await expect(updateOrganizationBranding(db, cervantes.director, cervantes.orgId, { brandPrimary: 'rojo', brandSecondary: '#FFFFFF' })).rejects.toThrow(/Color no válido/);
    await expect(updateOrganizationBranding(db, cervantes.director, cervantes.orgId, { brandPrimary: '#000000', brandSecondary: '#FFFFFF', iban: 'ES00' })).rejects.toThrow();
    expect((await db.organization.findUniqueOrThrow({ where: { id: cervantes.orgId } })).brandPrimary).toBe('#047857');
  });
});

describe('las vistas no filtran datos que no tocan', () => {
  it('la iniciativa no incluye el PIN de portería; las aportaciones no incluyen datos personales; las ideas no incluyen el correo', async () => {
    const initiative = await getInitiative(db, cervantes.director, cervantes.orgId, cervantes.initiativeId);
    expect(Object.keys(initiative)).not.toContain('gatePinHash');
    const [contribution] = await listContributions(db, cervantes.director, cervantes.orgId, cervantes.initiativeId);
    expect(Object.keys(contribution!)).not.toEqual(expect.arrayContaining(['guestEmail']));
    for (const forbidden of ['guestEmail', 'canonicalEmail', 'donorTaxIdEnc', 'donorFullName', 'userId']) expect(Object.keys(contribution!)).not.toContain(forbidden);
    const [idea] = await listIdeas(db, cervantes.director, cervantes.orgId);
    expect(Object.keys(idea!)).not.toContain('authorCanonicalEmail');
    expect(idea!.alias).toBe('Código #FAM-0001');
  });

  it('la ficha de gestión incluye CIF e IBAN, que son solo para quien gestiona la entidad', async () => {
    const organization = await getOrganization(db, cervantes.director, cervantes.orgId);
    expect(organization.iban).toBeTruthy();
    expect(organization.cif).toBeTruthy();
  });
});

describe('Super-Admin, anónimos y sesiones de portería', () => {
  it('el Super-Admin accede a cualquier entidad y queda registrado en AuditLog', async () => {
    await expect(getOrganization(db, superadmin, sanJose.orgId)).resolves.toMatchObject({ id: sanJose.orgId });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: 'superadmin.access', actorUserId: superadminId, organizationId: sanJose.orgId } });
    expect(log.metadataJson).toMatchObject({ operation: 'organization.get' });
  });

  it('el listado transversal es solo del Super-Admin; el resto recibe 403 y queda registrado', async () => {
    expect((await listOrganizations(db, superadmin)).length).toBeGreaterThanOrEqual(2);
    await expect(listOrganizations(db, cervantes.director)).rejects.toMatchObject({ status: 403, reason: 'SUPERADMIN_ONLY' });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: 'tenant.access_denied', actorUserId: cervantes.directorId, targetType: 'Organization', targetId: '*' } });
    expect(log.metadataJson).toMatchObject({ attempted: 'organization.list', reason: 'SUPERADMIN_ONLY' });
  });

  it('una persona registrada sin membresías no accede a nada', async () => {
    await expect(getOrganization(db, outsider, cervantes.orgId)).rejects.toBeInstanceOf(TenantAccessError);
  });

  it('una persona sin sesión se deniega y se registra sin identificador de usuario', async () => {
    await expect(listInitiatives(db, { kind: 'anonymous', requestMeta: { ipHash: 'ip-anonima' } }, cervantes.orgId)).rejects.toMatchObject({ reason: 'ANONYMOUS' });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: 'tenant.access_denied', organizationId: cervantes.orgId, ipHash: 'ip-anonima' } });
    expect(log).toMatchObject({ actorType: 'USER', actorUserId: null });
  });

  it('la sesión de portería solo sirve en su entidad y en SU evento, y se registra como sesión de portería', async () => {
    const gate: SessionActor = { kind: 'gate', gateSessionId: 'gate-1', organizationId: cervantes.orgId, initiativeId: cervantes.initiativeId };
    const scan = (organizationId: string, initiativeId: number) =>
      authorizeTenant(db, gate, organizationId, { roles: ['GATEKEEPER'], action: 'gate.scan', targetType: 'Initiative', targetId: initiativeId });
    await expect(scan(cervantes.orgId, cervantes.initiativeId)).resolves.toMatchObject({ via: 'GATE_SESSION' });
    await expect(scan(sanJose.orgId, sanJose.initiativeId)).rejects.toMatchObject({ reason: 'GATE_SESSION_OTHER_TENANT' });
    // Otro evento de la MISMA entidad: antes de la auditoría 1.3 se permitía.
    await expect(scan(cervantes.orgId, cervantes.draftInitiativeId)).rejects.toMatchObject({ status: 403, reason: 'GATE_SESSION_OTHER_EVENT' });

    const log = await db.auditLog.findFirstOrThrow({ where: { action: 'tenant.access_denied', organizationId: sanJose.orgId, actorType: 'GATE_SESSION' } });
    expect(log.metadataJson).toMatchObject({ gateSessionId: 'gate-1', reason: 'GATE_SESSION_OTHER_TENANT' });
    const otherEvent = await db.auditLog.findFirstOrThrow({ where: { action: 'tenant.access_denied', organizationId: cervantes.orgId, targetId: String(cervantes.draftInitiativeId), actorType: 'GATE_SESSION' } });
    expect(otherEvent.metadataJson).toMatchObject({ reason: 'GATE_SESSION_OTHER_EVENT', initiativeId: cervantes.initiativeId });
  });

  it('el Super-Admin queda excluido de lo que la operación excluye (firmar por otra persona)', async () => {
    const guarded = authorizeTenant(db, superadmin, cervantes.orgId, { roles: ['DIRECTOR'], action: 'payout.sign', targetType: 'EscrowPayout', allowSuperadmin: false });
    await expect(guarded).rejects.toMatchObject({ status: 403, reason: 'SUPERADMIN_EXCLUDED' });
  });

  it('la auditoría del Super-Admin es obligatoria: si no se puede registrar, no se concede el acceso (falla cerrada)', async () => {
    const spy = vi.spyOn(db.auditLog, 'create').mockRejectedValueOnce(new Error('auditoría caída'));
    await expect(getOrganization(db, superadmin, cervantes.orgId)).rejects.toThrow('auditoría caída');
    spy.mockRestore();
    await expect(getOrganization(db, superadmin, cervantes.orgId)).resolves.toMatchObject({ id: cervantes.orgId });
  });

  it('una denegación sigue siendo una denegación aunque la auditoría falle', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(db.auditLog, 'create').mockRejectedValueOnce(new Error('auditoría caída'));
    await expect(getOrganization(db, outsider, sanJose.orgId)).rejects.toBeInstanceOf(TenantAccessError);
    spy.mockRestore();
    quiet.mockRestore();
  });

  it('los identificadores que llegan del cliente se acotan antes de guardarse en la auditoría inmutable', async () => {
    const hostile = `x${'A'.repeat(400)}\u0007\n`;
    await expect(getOrganization(db, cervantes.director, hostile)).rejects.toBeInstanceOf(TenantAccessError);
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'tenant.access_denied', actorUserId: cervantes.directorId, targetType: 'Organization' }, orderBy: { id: 'desc' } });
    expect(row.organizationId!.length).toBeLessThanOrEqual(120);
    expect(row.targetId.length).toBeLessThanOrEqual(120);
    expect(row.organizationId).not.toMatch(/[\u0000-\u001f]/);
  });

  it('una entidad archivada deja de dar acceso a sus miembros y una cuenta anonimizada no tiene sesión', async () => {
    const archived = await createOrganization(db);
    const member = await createUser(db);
    await db.organizationMember.create({ data: { userId: member.id, organizationId: archived.id, role: 'DIRECTOR' } });
    expect(await loadUserActor(db, member.id)).toMatchObject({ kind: 'user', memberships: [{ organizationId: archived.id, role: 'DIRECTOR' }] });
    await db.organization.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    expect(await loadUserActor(db, member.id)).toMatchObject({ kind: 'user', memberships: [] });

    const erased = await createUser(db, { gdprAnonymizedAt: new Date() });
    expect(await loadUserActor(db, erased.id)).toMatchObject({ kind: 'anonymous' });
    expect(await loadUserActor(db, 'no-existe')).toMatchObject({ kind: 'anonymous' });
  });
});

describe('lecturas públicas (familias, socios y comercios)', () => {
  it('la entidad pública muestra su titular legal pero nunca CIF, IBAN ni correos', async () => {
    const organization = await getPublicOrganization(db, cervantes.slug);
    expect(organization).toMatchObject({ slug: cervantes.slug, legalName: 'AFA CEIP de pruebas' });
    for (const forbidden of ['cif', 'iban', 'contactEmail', 'contactPhone', 'kybStatus', 'exemptRemainingCents']) expect(Object.keys(organization)).not.toContain(forbidden);
  });

  it('solo las campañas abiertas son públicas y sin datos internos', async () => {
    const listed = await listPublicInitiatives(db, cervantes.slug);
    expect(listed.map((initiative) => initiative.id)).toEqual([cervantes.initiativeId]);
    for (const forbidden of ['gatePinHash', 'costMatCents', 'bracketFeeCents', 'organizationId']) expect(Object.keys(listed[0]!)).not.toContain(forbidden);
    await expect(getPublicInitiative(db, cervantes.slug, cervantes.draftInitiativeId)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getPublicInitiative(db, cervantes.slug, sanJose.initiativeId)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getPublicInitiative(db, cervantes.slug, cervantes.initiativeId)).resolves.toMatchObject({ id: cervantes.initiativeId });
  });

  it('una entidad archivada o inexistente no es pública', async () => {
    const archived = await createOrganization(db, { archivedAt: new Date() });
    await expect(getPublicOrganization(db, archived.slug)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getPublicOrganization(db, 'no-existe')).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await listPublicInitiatives(db, archived.slug)).toEqual([]);
  });
});
