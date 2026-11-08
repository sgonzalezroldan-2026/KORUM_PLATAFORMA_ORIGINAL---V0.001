import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Model182NotAllowedError, exportModel182 } from '@/core/tax/model182.service';
import { validateTaxId } from '@/core/tax/tax-id';
import { sealDonorTaxId } from '@/core/tax/tax-id-vault';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import { getDashboardData, getMedalImpact, getPanelOverview } from '@/repositories/panel.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { buildMedalKitFile, MedalKitUnavailableError, type MedalKitRequest } from '@/services/panel/medal-kit.service';
import { TEST_HMAC_SECRET, TEST_KEYRING, createInitiative, createOrganization, createTestClient, createUser, uniqueId } from './test-database';

/**
 * Sprint 4.1 · cabecera de gestión, cuadro de mandos, kit de medallas y Modelo 182 contra PostgreSQL real (QA-SEC01, QA-S02, QA-S05, QA-REG02):
 * aislamiento entre dos entidades, lo que cuenta cada indicador y que el kit solo se entrega de una medalla ya conseguida.
 */

let db: KorumPrismaClient;

interface Tenant {
  orgId: string;
  director: SessionActor;
  cosigner: SessionActor;
  gatekeeper: SessionActor;
  directorId: string;
}

let silverOrg: Tenant;
let otherOrg: Tenant;
const NOW = new Date('2026-11-08T10:00:00Z');

/** Un CIF con dígito de control válido: el fichero del Modelo 182 valida al declarante. */
let nextCif = 3_000_000 + (Date.now() % 5_000_000);
function validCif(): string {
  for (;;) {
    nextCif += 1;
    for (const control of '0123456789') {
      const cif = `G${nextCif}${control}`;
      if (validateTaxId(cif).valid) return cif;
    }
  }
}

const TIERS = [
  { key: 'bronze', name: 'Bronce', icon: '🥉', rank: 1, campaignsRequired: 1, grantCents: 50_000 },
  { key: 'silver', name: 'Plata', icon: '🥈', rank: 2, campaignsRequired: 2, grantCents: 100_000 },
  { key: 'gold', name: 'Oro', icon: '🥇', rank: 3, campaignsRequired: 3, grantCents: 200_000 }
];

async function createTenant(overrides: Parameters<typeof createOrganization>[1]): Promise<Tenant> {
  const organization = await createOrganization(db, { iban: 'ES91 2100 0418 4502 0005 1332', cif: uniqueId('G'), contactEmail: `${uniqueId('c')}@entidad.example`, quotaPeriod: '2026-2027', ...overrides });
  const members = await Promise.all(
    (['DIRECTOR', 'COSIGNER', 'GATEKEEPER'] as const).map(async (role) => {
      const user = await createUser(db, { twoFactorEnabled: true });
      await db.organizationMember.create({ data: { userId: user.id, organizationId: organization.id, role, roleLabel: role === 'DIRECTOR' ? 'Dirección del centro' : null } });
      return { role, userId: user.id, actor: await loadUserActor(db, user.id, { ipHash: 'hash-de-ip' }, { secondFactor: true }) };
    })
  );
  const pick = (role: string) => members.find((member) => member.role === role)!;
  return { orgId: organization.id, director: pick('DIRECTOR').actor, cosigner: pick('COSIGNER').actor, gatekeeper: pick('GATEKEEPER').actor, directorId: pick('DIRECTOR').userId };
}

beforeAll(async () => {
  db = createTestClient();
  for (const tier of TIERS) await db.medalTierConfig.upsert({ where: { key: tier.key }, create: tier, update: tier });
  silverOrg = await createTenant({ name: 'CEIP Plata', medalRank: 2, completedThisYear: 2, medalGrantAvailableCents: 100_000, exemptLimitCents: 100_000, exemptRemainingCents: 40_000, ley49: false });
  otherOrg = await createTenant({ name: 'Colegio Ajeno', medalRank: 3 });

  await createInitiative(db, silverOrg.orgId, { status: 'FUNDRAISING', stepIndex: 4, raisedCents: 100_000, title: 'Campaña viva' });
  await createInitiative(db, silverOrg.orgId, { status: 'GOAL_REACHED', stepIndex: 5, raisedCents: 583_300, title: 'Campaña conseguida' });
  await createInitiative(db, silverOrg.orgId, { status: 'CLOSED', stepIndex: 5, raisedCents: 300_000, title: 'Campaña cerrada' });
  await createInitiative(db, silverOrg.orgId, { status: 'CLOSED', stepIndex: 5, raisedCents: 777_700, title: 'Campaña del curso pasado', academicYear: '2025-2026' });
  await createInitiative(db, silverOrg.orgId, { status: 'BUDGETING', stepIndex: 3, title: 'Borrador' });
  await createInitiative(db, otherOrg.orgId, { status: 'GOAL_REACHED', stepIndex: 5, raisedCents: 999_900, title: 'Campaña de otra entidad' });

  const sponsor = (overrides: Record<string, unknown>) =>
    db.sponsor.create({
      data: { organizationId: silverOrg.orgId, name: uniqueId('Comercio'), contactPerson: 'x', phone: '1', email: 'c@x.test', sector: 's', tierLabel: 't', amountCents: 10_000, feeGeneratedCents: 1_500, promo: 'p', code: uniqueId('C'), expiresAt: new Date('2027-06-01'), ...overrides }
    });
  await sponsor({ status: 'APPROVED', paidAt: new Date('2026-09-01') });
  await sponsor({ status: 'APPROVED', paidAt: new Date('2026-09-02') });
  await sponsor({ status: 'APPROVED', paidAt: null });
  await sponsor({ status: 'PENDING', paidAt: new Date('2026-09-03') });
  await sponsor({ status: 'APPROVED', paidAt: new Date('2026-01-01'), expiresAt: new Date('2026-06-01') });
  await db.sponsor.create({
    data: { organizationId: otherOrg.orgId, name: 'Comercio ajeno', contactPerson: 'x', phone: '1', email: 'c@x.test', sector: 's', tierLabel: 't', amountCents: 10_000, feeGeneratedCents: 1_500, promo: 'p', code: uniqueId('C'), expiresAt: new Date('2027-06-01'), status: 'APPROVED', paidAt: new Date('2026-09-01') }
  });
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

const denied = (organizationId: string, attempted: string) =>
  db.auditLog.findMany({ where: { action: 'tenant.access_denied', organizationId, metadataJson: { path: ['attempted'], equals: attempted } } });

describe('cabecera de gestión (QA-S02)', () => {
  it('da la entidad, las dos personas firmantes con su cargo y los niveles de medalla, sin IBAN ni CIF', async () => {
    const overview = await getPanelOverview(db, silverOrg.director, silverOrg.orgId);
    expect(overview.organization).toMatchObject({ medalRank: 2, completedThisYear: 2, medalGrantAvailableCents: 100_000, exemptRemainingCents: 40_000, quotaPeriod: '2026-2027' });
    expect(Object.keys(overview.organization)).not.toContain('iban');
    expect(Object.keys(overview.organization)).not.toContain('cif');
    expect(overview.signers.map((signer) => [signer.role, signer.status])).toEqual([
      ['DIRECTOR', 'ACTIVE'],
      ['COSIGNER', 'ACTIVE']
    ]);
    expect(overview.signers[0]!.roleLabel).toBe('Dirección del centro');
    expect(overview.signers.some((signer) => 'email' in signer)).toBe(false);
    expect(overview.tiers.map((tier) => tier.key)).toEqual(['bronze', 'silver', 'gold']);
  });

  it('las dos firmas ven su panel; quien tiene otro cargo (portería) o es de otra entidad, no, y queda en AuditLog', async () => {
    await expect(getPanelOverview(db, silverOrg.cosigner, silverOrg.orgId)).resolves.toBeDefined();
    for (const actor of [silverOrg.gatekeeper, otherOrg.director]) {
      const error = await getPanelOverview(db, actor, silverOrg.orgId).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TenantAccessError);
      expect((error as TenantAccessError).status).toBe(403);
    }
    expect((await denied(silverOrg.orgId, 'panel.overview')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('cuadro de mandos (QA-SEC01)', () => {
  it('lista todas las iniciativas de la entidad (de todos los cursos) y cuenta solo los comercios cobrados, aprobados y vigentes', async () => {
    const data = await getDashboardData(db, silverOrg.director, silverOrg.orgId, NOW);
    expect(data.initiatives.map((item) => item.title).sort()).toEqual(['Borrador', 'Campaña conseguida', 'Campaña cerrada', 'Campaña del curso pasado', 'Campaña viva'].sort());
    expect(data.initiatives.every((item) => item.organizationId === silverOrg.orgId)).toBe(true);
    expect(data.initiatives.every((item) => !('gatePinHash' in item))).toBe(true);
    expect(data.activeSponsors).toBe(2);
  });

  it('desde otra entidad responde 403 sin leer nada, con rastro', async () => {
    const error = await getDashboardData(db, otherOrg.director, silverOrg.orgId, NOW).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantAccessError);
    expect((await denied(silverOrg.orgId, 'initiative.list')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('kit de medallas (QA-S05)', () => {
  const translate: MedalKitRequest['translate'] = {
    report: (key, values) => `${key}${values ? `|${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(',')}` : ''}`,
    seal: (key, values) => (key === 'headline' ? 'Comunidad Impulsora' : `Sello ${values?.tier ?? ''} ${values?.entity ?? ''}`)
  };
  const request = (organizationId: string, levelKey: string, kind: MedalKitRequest['kind']): MedalKitRequest => ({ organizationId, levelKey, kind, locale: 'es', translate, now: NOW });

  it('el informe cuenta solo las campañas conseguidas del curso vigente de esta entidad', async () => {
    const impact = await getMedalImpact(db, silverOrg.director, silverOrg.orgId, NOW);
    expect(impact.achievements.map((item) => item.title).sort()).toEqual(['Campaña cerrada', 'Campaña conseguida']);
    expect(impact.achievements.reduce((sum, item) => sum + item.raisedCents, 0)).toBe(883_300);
    expect(impact.activeSponsors).toBe(2);
  });

  it('entrega el PDF y el SVG de una medalla conseguida y deja cada descarga en AuditLog', async () => {
    const pdf = await buildMedalKitFile(db, silverOrg.director, request(silverOrg.orgId, 'silver', 'report'));
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.fileName).toMatch(/^korum-medalla-silver-ceip-plata\.pdf$/);
    const pdfText = new TextDecoder().decode(pdf.bytes);
    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText).toContain('8.833,00');

    const svg = await buildMedalKitFile(db, silverOrg.cosigner, request(silverOrg.orgId, 'bronze', 'seal'));
    expect(svg.contentType).toContain('image/svg+xml');
    const svgText = new TextDecoder().decode(svg.bytes);
    expect(svgText).toContain('BRONCE');
    expect(svgText).toContain('CEIP Plata');
    expect(svgText).toContain('2026-2027');

    const downloads = await db.auditLog.findMany({ where: { action: 'panel.medal_kit_downloaded', organizationId: silverOrg.orgId } });
    expect(downloads.map((row) => (row.metadataJson as { kind: string }).kind).sort()).toEqual(['report', 'seal']);
    expect(JSON.stringify(downloads.map((row) => row.metadataJson))).not.toMatch(/@/);
  });

  it('una medalla que la entidad aún no tiene no tiene kit, y un nivel inventado no existe', async () => {
    const notEarned = await buildMedalKitFile(db, silverOrg.director, request(silverOrg.orgId, 'gold', 'seal')).catch((caught: unknown) => caught);
    expect(notEarned).toBeInstanceOf(MedalKitUnavailableError);
    expect((notEarned as MedalKitUnavailableError).reason).toBe('NOT_EARNED');
    expect(await db.auditLog.count({ where: { action: 'panel.medal_kit_denied', organizationId: silverOrg.orgId, targetId: 'gold' } })).toBe(1);
    const unknown = await buildMedalKitFile(db, silverOrg.director, request(silverOrg.orgId, 'diamante', 'report')).catch((caught: unknown) => caught);
    expect((unknown as MedalKitUnavailableError).reason).toBe('UNKNOWN_LEVEL');
  });

  it('desde otra entidad o sin cargo de firmante no se entrega nada', async () => {
    for (const actor of [otherOrg.director, silverOrg.gatekeeper]) {
      const error = await buildMedalKitFile(db, actor, request(silverOrg.orgId, 'bronze', 'report')).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TenantAccessError);
    }
  });
});

describe('Modelo 182 (QA-REG02)', () => {
  it('sin la Ley 49/2002 verificada no se exporta: el error dice el motivo y el intento queda en AuditLog', async () => {
    const error = await exportModel182(db, TEST_KEYRING, silverOrg.director, { organizationId: silverOrg.orgId, fiscalYear: 2025, contactPhone: '934128890', contactName: 'Carla Puig' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Model182NotAllowedError);
    expect((error as Model182NotAllowedError).reason).toBe('LEY49_NOT_VERIFIED');
    expect(await db.auditLog.count({ where: { action: 'tax.model182_denied', organizationId: silverOrg.orgId } })).toBe(1);
  });

  it('marcada la Ley 49/2002 pero sin verificar (ley49VerifiedAt nulo) tampoco', async () => {
    const organization = await createOrganization(db, { ley49: true, ley49VerifiedAt: null, cif: uniqueId('G') });
    const user = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { userId: user.id, organizationId: organization.id, role: 'DIRECTOR' } });
    const actor = await loadUserActor(db, user.id, {}, { secondFactor: true });
    const error = await exportModel182(db, TEST_KEYRING, actor, { organizationId: organization.id, fiscalYear: 2025, contactPhone: '934128890', contactName: 'Persona' }).catch((caught: unknown) => caught);
    expect((error as Model182NotAllowedError).reason).toBe('LEY49_NOT_VERIFIED');
  });

  it('el Super-Admin no extrae el Modelo 182 de una entidad, aunque entre a su panel; queda en AuditLog', async () => {
    const organization = await createOrganization(db, { ley49: true, ley49VerifiedAt: new Date('2026-01-10'), cif: validCif() });
    const admin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const actor = await loadUserActor(db, admin.id, {}, { secondFactor: true });
    const error = await exportModel182(db, TEST_KEYRING, actor, { organizationId: organization.id, fiscalYear: 2025, contactPhone: '934128890', contactName: 'Super' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantAccessError);
    const rows = await db.auditLog.findMany({ where: { action: 'tenant.access_denied', organizationId: organization.id, actorUserId: admin.id } });
    expect(rows[0]!.metadataJson).toMatchObject({ attempted: 'tax.model182_export', reason: 'SUPERADMIN_EXCLUDED' });
  });

  it('una campaña que se devuelve o se canceló no se declara: se cuenta aparte; las sin resolver sí entran y se señalan', async () => {
    const organization = await createOrganization(db, { ley49: true, ley49VerifiedAt: new Date('2026-01-10'), cif: validCif(), legalName: 'AFA Devoluciones' });
    const user = await createUser(db, { twoFactorEnabled: true, name: 'Carla Puig' });
    await db.organizationMember.create({ data: { userId: user.id, organizationId: organization.id, role: 'DIRECTOR' } });
    const actor = await loadUserActor(db, user.id, {}, { secondFactor: true });
    const refunding = await createInitiative(db, organization.id, { status: 'REFUNDING' });
    const cancelled = await createInitiative(db, organization.id, { status: 'CANCELLED' });
    const live = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const sealed = sealDonorTaxId('X1234567L', { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET });
    const donation = (initiativeId: number, amountCents: number) =>
      db.contribution.create({
        data: {
          organizationId: organization.id,
          initiativeId,
          guestEmail: 'donante@familias.example',
          canonicalEmail: 'donante@familias.example',
          fiscalYear: 2025,
          amountCents,
          totalChargedCents: amountCents,
          paymentMethod: 'CARD',
          status: 'COMPLETED',
          type: 'DONATION',
          donorFullName: 'Pérez Ruiz, Luis',
          ...sealed,
          donorProvinceCode: '28'
        }
      });
    await donation(refunding.id, 10_000);
    await donation(cancelled.id, 5_000);
    await donation(live.id, 2_500);
    const result = await exportModel182(db, TEST_KEYRING, actor, { organizationId: organization.id, fiscalYear: 2025, contactPhone: '934128890', contactName: 'Carla Puig' });
    expect(result.returned).toEqual({ contributions: 2, amountCents: 15_000 });
    expect(result.unresolved).toEqual({ contributions: 1, amountCents: 2_500 });
    expect(result.donorCount).toBe(1);
    expect(result.totalCents).toBe(2_500);
  });

  it('con la Ley 49/2002 verificada devuelve un fichero con registros de 250 posiciones', async () => {
    const organization = await createOrganization(db, { ley49: true, ley49VerifiedAt: new Date('2026-01-10'), cif: validCif(), legalName: 'AFA CEIP Prueba' });
    const user = await createUser(db, { twoFactorEnabled: true, name: 'Carla Puig' });
    await db.organizationMember.create({ data: { userId: user.id, organizationId: organization.id, role: 'DIRECTOR' } });
    const actor = await loadUserActor(db, user.id, {}, { secondFactor: true });
    const result = await exportModel182(db, TEST_KEYRING, actor, { organizationId: organization.id, fiscalYear: 2025, contactPhone: '934128890', contactName: 'Carla Puig' });
    expect(result.donorCount).toBe(0);
    const records = result.content.split('\r\n').filter(Boolean);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.every((record) => record.length === 250)).toBe(true);
  });
});
