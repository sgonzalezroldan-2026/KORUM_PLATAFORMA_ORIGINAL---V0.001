import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseInitiativeQuotas, renewOrganizationQuotas, reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import { raiseAlert } from '@/core/jobs/ops-alerts';
import type { Prisma } from '@/generated/prisma/client';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import { getConsoleOverview, getConsoleRules, getConsoleSupport } from '@/repositories/console.repository';
import { loadStudioContext } from '@/repositories/studio.repository';
import { secretsExpired } from '@/services/email/outbox-secrets';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { resolveOpsAlertById, resolveOpsAlertWithNote } from '@/services/admin/console-alerts.service';
import { answerPlatformTicket, closeRectificationRequest, rectifyAccountName, sendDirectEmailToOrganization } from '@/services/admin/console-support.service';
import { loadExemptCampaigns } from '@/services/admin/exempt-campaigns';
import {
  acknowledgePricingAlert,
  addGlobalCategory,
  GlobalRulesRejectedError,
  loadGlobalRulesView,
  loadMedalsView,
  saveGlobalRules,
  saveMedals,
  setGlobalCategoryRule
} from '@/services/admin/global-rules.service';
import { loadPricingHealth } from '@/services/admin/pricing-health-data';
import { invalidateSettingsCache } from '@/services/settings/settings.service';
import { seedDatabase } from '@/seed/seed';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, TEST_SCHEMA, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.3 · Motor de reglas globales, medallas, categorías, avisos de precios, soporte de KORUM, email directo y alertas con nota contra PostgreSQL real (QA-A03,
 * QA-A04). Lo que se prueba: lo imposible se rechaza y lo que pierde dinero no; guardar es atómico, auditado y no se pisa entre dos personas; el cambio llega a las
 * entidades sin tarifa propia y a ninguna otra; una taquilla a la venta no cambia de gastos de gestión; aceptar un aviso solo vale para el aviso que se vio; el soporte
 * contesta una vez, solo lo que es de KORUM y sin copiar la respuesta al email; y todo exige el Super-Admin (con el segundo factor o verificado).
 *
 * La configuración global es compartida por todos los archivos de integración: cada prueba que la cambia la devuelve a como estaba.
 */

const SECRETS = { hmacSecret: 'integration-data-hmac-secret-0123456789', qrSecret: 'integration-qr-hmac-secret-0123456789ab', keyring: TEST_KEYRING };
const TICKET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let db: KorumPrismaClient;
let admin: SessionActor;
let original: Awaited<ReturnType<typeof loadGlobalRulesView>>['rules'];
let originalMedals: Awaited<ReturnType<typeof loadMedalsView>>['tiers'];

const verified = async (now: Date = new Date()): Promise<VerifiedSuperadminActor> => (await verifiedSuperadmin(db, now)).actor;
const ticketCode = () => `TCK-${Array.from({ length: 6 }, () => TICKET_ALPHABET[Math.floor(Math.random() * TICKET_ALPHABET.length)]).join('')}`;

/** Guarda un cambio sobre las reglas actuales, con la versión que tiene la pantalla en ese momento. */
async function save(patch: Partial<typeof original>, now?: Date) {
  const view = await loadGlobalRulesView(db);
  return saveGlobalRules(db, await verified(now), { ...view.rules, ...patch }, view.version, now);
}

/** Devuelve las medallas a como estaban, directamente en la base de pruebas (el servicio no deja bajar una beca con campañas que tienen beca reservada). */
async function restoreMedals() {
  for (const tier of originalMedals) await db.medalTierConfig.update({ where: { key: tier.key }, data: { campaignsRequired: tier.campaignsRequired, grantCents: tier.grantCents } });
}

async function restoreRules() {
  const view = await loadGlobalRulesView(db);
  await saveGlobalRules(db, await verified(), original, view.version);
}

beforeAll(async () => {
  db = createTestClient();
  await seedDatabase(db, { ...SECRETS, schema: TEST_SCHEMA });
  const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
  admin = await loadUserActor(db, superadmin.id, { ipHash: 'hash-de-ip' }, { secondFactor: true });
  original = (await loadGlobalRulesView(db)).rules;
  originalMedals = (await loadMedalsView(db)).tiers;
}, 600_000);

afterAll(async () => {
  await restoreRules();
  await restoreMedals();
  // Las aceptaciones de avisos de precios las leen otros archivos de pruebas (BI de la consola): se dejan como estaban, sin ninguna.
  await db.platformSetting.deleteMany({ where: { key: 'pricing.acknowledgements' } });
  invalidateSettingsCache('pricing.acknowledgements');
  await db.$disconnect();
});

async function organizationWithSigners(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, overrides);
  const [director, cosigner] = await Promise.all([createUser(db, { twoFactorEnabled: true, locale: 'ca' }), createUser(db, { twoFactorEnabled: true })]);
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR', roleLabel: 'Dirección' } });
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER', roleLabel: 'Presidencia' } });
  return { organization, director, cosigner };
}

describe('QA-A04 · motor de reglas globales', () => {
  it('guarda, audita y lleva el cambio a las entidades sin tarifa propia; no toca las de tarifa propia ni las archivadas', async () => {
    const plain = await createOrganization(db, { customRules: false, exemptLimitCents: 100_000, exemptRemainingCents: 40_000, t1Bps: 500, sponsorFeeBps: 1_500, maintActive: false });
    const own = await createOrganization(db, { customRules: true, exemptLimitCents: 50_000, exemptRemainingCents: 20_000, t1Bps: 123 });
    const archived = await createOrganization(db, { customRules: false, exemptLimitCents: 100_000, exemptRemainingCents: 100_000, archivedAt: new Date() });

    const result = await save({ exemptLimitCents: 150_000, t1Bps: 700, sponsorFeeBps: 1_700, maintActive: true, maintPerInitCents: 5_000 });
    expect(result.changed).toBe(5);
    expect(result.organizationsUpdated).toBeGreaterThanOrEqual(1);

    // Lo gastado (60.000) no cambia: el cupo restante sube lo mismo que el límite.
    expect(await db.organization.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ exemptLimitCents: 150_000, exemptRemainingCents: 90_000, t1Bps: 700, sponsorFeeBps: 1_700, maintActive: true, maintPerInitCents: 5_000 });
    expect(await db.organization.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ exemptLimitCents: 50_000, exemptRemainingCents: 20_000, t1Bps: 123 });
    expect(await db.organization.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({ exemptLimitCents: 100_000, exemptRemainingCents: 100_000, t1Bps: 500 });
    // El Estudio lee lo nuevo al instante.
    expect((await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } })).t1Bps).toBe(700);
    expect((await loadStudioContext(db, plain.id)).bracket.ratesBps.t1).toBe(700);

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'rules.global_updated' }, orderBy: { id: 'desc' } });
    expect(audit.actorUserId).not.toBeNull();
    expect(audit.metadataJson).toMatchObject({ changes: { t1Bps: { from: original.t1Bps, to: 700 }, exemptLimitCents: { from: original.exemptLimitCents, to: 150_000 } } });

    await restoreRules();
    expect(await db.organization.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ exemptLimitCents: original.exemptLimitCents, t1Bps: original.t1Bps, sponsorFeeBps: original.sponsorFeeBps, maintActive: original.maintActive });
  });

  it('si el límite exento nuevo no cubre lo ya gastado, la entidad conserva lo gastado y al subir otra vez el cupo reaparece exacto (nunca de la nada)', async () => {
    const org = await createOrganization(db, { customRules: false, exemptLimitCents: original.exemptLimitCents, exemptRemainingCents: original.exemptLimitCents - 60_000 });
    await save({ exemptLimitCents: 30_000 });
    // Gastó 60.000: su límite queda en 60.000 y el restante a 0; no se recorta lo gastado.
    expect(await db.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ exemptLimitCents: 60_000, exemptRemainingCents: 0 });
    await save({ exemptLimitCents: original.exemptLimitCents });
    expect(await db.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ exemptLimitCents: original.exemptLimitCents, exemptRemainingCents: original.exemptLimitCents - 60_000 });
  });

  it('rechaza lo imposible (decimales, negativos, días fuera de rango) diciendo qué campo, sin guardar nada ni auditar', async () => {
    const view = await loadGlobalRulesView(db);
    const before = await db.auditLog.count({ where: { action: 'rules.global_updated' } });
    for (const [patch, field] of [
      [{ topupFeeCents: 25.5 }, 'topupFeeCents'],
      [{ gatewayFixedCents: -1 }, 'gatewayFixedCents'],
      [{ maxCampaignDays: 76 }, 'maxCampaignDays'],
      [{ creditPoolMaxDays: 71 }, 'creditPoolMaxDays']
    ] as const) {
      await expect(saveGlobalRules(db, await verified(), { ...view.rules, ...patch }, view.version)).rejects.toMatchObject({ reason: 'INVALID', fields: expect.arrayContaining([field]) });
    }
    expect((await loadGlobalRulesView(db)).version).toBe(view.version);
    expect(await db.auditLog.count({ where: { action: 'rules.global_updated' } })).toBe(before);
  });

  it('NO bloquea una combinación que pierde dinero: guarda y la salud de precios avisa con la cifra', async () => {
    await save({ topupFeeCents: 0, topupFeeBps: 0 });
    const health = await loadPricingHealth(db);
    const alert = health.alerts.find((candidate) => candidate.code === 'HUCHA_FEE_BELOW_GATEWAY_COST');
    expect(alert).toMatchObject({ severity: 'CRITICAL', acknowledgement: null });
    expect(alert?.params.lossCents).toBeGreaterThan(0);
    await restoreRules();
  });

  it('dos personas que guardan a la vez no se pisan: solo gana una y la otra recibe STALE; con una versión antigua también', async () => {
    const view = await loadGlobalRulesView(db);
    const first = await verified();
    const second = await verified();
    const results = await Promise.allSettled([
      saveGlobalRules(db, first, { ...view.rules, t3Bps: view.rules.t3Bps + 7 }, view.version),
      saveGlobalRules(db, second, { ...view.rules, t3Bps: view.rules.t3Bps + 9 }, view.version)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(GlobalRulesRejectedError);
    expect(rejected.reason).toMatchObject({ reason: 'STALE' });
    await expect(saveGlobalRules(db, await verified(), view.rules, view.version)).rejects.toMatchObject({ reason: 'STALE' });
    await restoreRules();
  });

  it('los gastos de gestión digital no cambian con una taquilla a la venta en una entidad sin tarifa propia; una con tarifa propia no lo impide', async () => {
    const view = await loadGlobalRulesView(db);
    const onSaleElsewhere = await db.initiative.count({ where: { format: 'TICKETING', status: { in: ['FUNDRAISING', 'GOAL_REACHED'] }, closesAt: { gt: new Date() }, organization: { customRules: false, archivedAt: null } } });

    const own = await createOrganization(db, { customRules: true });
    const ownEvent = await createInitiative(db, own.id, { format: 'TICKETING', status: 'FUNDRAISING', ticketSubtype: 'EVENT', goalCents: 10_000 });
    const plain = await createOrganization(db, { customRules: false });
    const plainEvent = await createInitiative(db, plain.id, { format: 'TICKETING', status: 'FUNDRAISING', ticketSubtype: 'EVENT', goalCents: 10_000 });

    await expect(saveGlobalRules(db, await verified(), { ...view.rules, ticketFeeBps: view.rules.ticketFeeBps + 50 }, view.version)).rejects.toMatchObject({ reason: 'TICKETING_ON_SALE', fields: ['ticketFeeFixedCents', 'ticketFeeBps'] });
    expect((await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } })).ticketFeeBps).toBe(view.rules.ticketFeeBps);
    // Otros cambios sí se guardan con esa taquilla a la venta.
    await save({ t2Bps: view.rules.t2Bps + 1 });

    // Al terminar la taquilla de la entidad sin tarifa propia ya no hay nada prometido que cambiar (si no hay otra a la venta en la base compartida).
    await db.initiative.update({ where: { id: plainEvent.id }, data: { status: 'CLOSED' } });
    if (onSaleElsewhere === 0) {
      await save({ ticketFeeBps: view.rules.ticketFeeBps + 50 });
      expect((await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } })).ticketFeeBps).toBe(view.rules.ticketFeeBps + 50);
      expect(await db.initiative.findUniqueOrThrow({ where: { id: ownEvent.id } })).toMatchObject({ status: 'FUNDRAISING' });
    }
    await restoreRules();
  });

  it('pide el Super-Admin verificado con segundo factor reciente: con la sesión de hace más de 10 minutos no se guarda', async () => {
    const view = await loadGlobalRulesView(db);
    const stale = await verified();
    await expect(saveGlobalRules(db, stale, { ...view.rules, t1Bps: view.rules.t1Bps + 1 }, view.version, new Date(Date.now() + 11 * 60_000))).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect((await loadGlobalRulesView(db)).version).toBe(view.version);
  });

  it('la pantalla lee con el segundo factor de la sesión: una persona cualquiera o un Super-Admin sin él se deniegan', async () => {
    const plain = await createUser(db);
    const familyActor = await loadUserActor(db, plain.id, { ipHash: 'h' }, { secondFactor: true });
    await expect(getConsoleRules(db, familyActor)).rejects.toBeInstanceOf(TenantAccessError);
    const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const noSecondFactor = await loadUserActor(db, superadmin.id, { ipHash: 'h' }, { secondFactor: false });
    await expect(getConsoleRules(db, noSecondFactor)).rejects.toBeInstanceOf(TenantAccessError);
    const view = await getConsoleRules(db, admin);
    expect(view.rules.rules.gatewayPctBps).toBe(original.gatewayPctBps);
    expect(view.medals.tiers.map((tier) => tier.key)).toEqual(['bronze', 'silver', 'gold']);
    expect(view.categories.length).toBeGreaterThan(0);
  });
});

describe('QA-A04 · medallas', () => {
  const tiers = (bronze: number, silver: number, gold: number, grant = 50_000) => [
    { key: 'bronze', campaignsRequired: bronze, grantCents: grant },
    { key: 'silver', campaignsRequired: silver, grantCents: grant * 2 },
    { key: 'gold', campaignsRequired: gold, grantCents: grant * 4 }
  ];

  it('guarda los niveles con su auditoría, no pisa una edición más reciente y rechaza niveles que no suben', async () => {
    const view = await loadMedalsView(db);
    await saveMedals(db, await verified(), tiers(2, 4, 6, 75_000), view.updatedAt);
    const after = await loadMedalsView(db);
    expect(after.tiers.find((tier) => tier.key === 'silver')).toMatchObject({ campaignsRequired: 4, grantCents: 150_000 });
    expect(await db.auditLog.count({ where: { action: 'rules.medals_updated' } })).toBeGreaterThanOrEqual(1);

    // La versión de antes de guardar ya no vale.
    await expect(saveMedals(db, await verified(), tiers(1, 2, 3), view.updatedAt)).rejects.toMatchObject({ reason: 'STALE' });
    // Niveles que no piden más campañas cada vez, o con importes imposibles.
    await expect(saveMedals(db, await verified(), tiers(3, 3, 4), after.updatedAt)).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(saveMedals(db, await verified(), [{ ...tiers(1, 2, 3)[0]!, grantCents: 500.5 }, ...tiers(1, 2, 3).slice(1)], after.updatedAt)).rejects.toMatchObject({ reason: 'INVALID' });
    expect(await loadMedalsView(db)).toMatchObject({ updatedAt: after.updatedAt });
    await restoreMedals();
  });
});

describe('QA-A04 · categorías globales', () => {
  it('añade una categoría que el Estudio ve al instante, no admite repetidas y cambia la regla de una existente con su auditoría', async () => {
    const name = `Categoría ${uniqueId('c')}`.slice(0, 50);
    await addGlobalCategory(db, await verified(), { name, icon: '🌳', rule: 'EXEMPT' });
    await expect(addGlobalCategory(db, await verified(), { name, rule: 'BRACKETS' })).rejects.toMatchObject({ reason: 'CATEGORY_EXISTS' });
    await expect(addGlobalCategory(db, await verified(), { name: 'x', rule: 'BRACKETS' })).rejects.toMatchObject({ reason: 'INVALID' });

    const org = await createOrganization(db);
    expect((await loadStudioContext(db, org.id)).categories.find((category) => category.name === name)).toMatchObject({ rule: 'EXEMPT', icon: '🌳' });

    await setGlobalCategoryRule(db, await verified(), { name, rule: 'BRACKETS' });
    expect((await loadStudioContext(db, org.id)).categories.find((category) => category.name === name)?.rule).toBe('BRACKETS');
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'rules.category_rule_set', targetId: name } });
    expect(audit.metadataJson).toMatchObject({ previousRule: 'EXEMPT', categoryRule: 'BRACKETS' });
    await expect(setGlobalCategoryRule(db, await verified(), { name: 'No existe de verdad', rule: 'EXEMPT' })).rejects.toMatchObject({ reason: 'CATEGORY_NOT_FOUND' });
  });
});

describe('QA-A04 · «Aceptar y registrar» un aviso de precios', () => {
  it('solo vale para el aviso que se vio: guarda la aceptación con su nota, es idempotente y deja de valer si cambia la configuración implicada', async () => {
    const alerts = (await loadPricingHealth(db)).alerts;
    const alert = alerts.find((candidate) => candidate.code === 'HUCHA_FEE_BELOW_GATEWAY_COST');
    expect(alert).toBeDefined();
    const target = { code: alert!.code, fingerprint: alert!.fingerprint };

    // Sin nota, o con una nota con datos personales, no se acepta.
    await expect(acknowledgePricingAlert(db, await verified(), target, 'corta')).rejects.toMatchObject({ reason: 'INVALID', fields: ['note'] });
    await expect(acknowledgePricingAlert(db, await verified(), target, 'Lo hablé con ana.lopez@example.com ayer')).rejects.toMatchObject({ reason: 'INVALID', fields: ['note'] });
    // Un aviso que no era el que se vio (otra huella) tampoco.
    await expect(acknowledgePricingAlert(db, await verified(), { ...target, fingerprint: 'otra-huella' }, 'La Hucha es coste de captación')).rejects.toMatchObject({ reason: 'ALERT_CHANGED' });
    await expect(acknowledgePricingAlert(db, await verified(), { code: 'SOURCE_NEGATIVE_MARGIN', fingerprint: 'x', source: 'huchaTopupFeeCents' }, 'No existe ese aviso ahora')).rejects.toMatchObject({ reason: 'ALERT_NOT_FOUND' });

    expect(await acknowledgePricingAlert(db, await verified(), target, 'La Hucha es un coste de captación asumido por el promotor.')).toEqual({ alreadyAccepted: false });
    invalidateSettingsCache('pricing.acknowledgements');
    const accepted = (await loadPricingHealth(db)).alerts.find((candidate) => candidate.code === 'HUCHA_FEE_BELOW_GATEWAY_COST');
    expect(accepted?.acknowledgement).toMatchObject({ code: 'HUCHA_FEE_BELOW_GATEWAY_COST', note: 'La Hucha es un coste de captación asumido por el promotor.' });
    const health = await loadPricingHealth(db);
    expect(health.open).toBe(health.alerts.filter((candidate) => !candidate.acknowledgement).length);
    expect(health.openCritical).toBe(health.alerts.filter((candidate) => candidate.severity === 'CRITICAL' && !candidate.acknowledgement).length);

    // Aceptar dos veces lo mismo no duplica ni la nota ni la auditoría.
    const audits = await db.auditLog.count({ where: { action: 'PRICING_ALERT_ACKNOWLEDGED', targetId: 'HUCHA_FEE_BELOW_GATEWAY_COST' } });
    expect(audits).toBe(1);
    expect(await acknowledgePricingAlert(db, await verified(), target, 'La Hucha es un coste de captación asumido por el promotor.')).toEqual({ alreadyAccepted: true });
    expect(await db.auditLog.count({ where: { action: 'PRICING_ALERT_ACKNOWLEDGED', targetId: 'HUCHA_FEE_BELOW_GATEWAY_COST' } })).toBe(1);

    // Cambia lo implicado (otro fee de Hucha que sigue perdiendo): es otro aviso y vuelve a saltar sin aceptar.
    await save({ topupFeeCents: original.topupFeeCents + 1 });
    invalidateSettingsCache('pricing.acknowledgements');
    const again = (await loadPricingHealth(db)).alerts.find((candidate) => candidate.code === 'HUCHA_FEE_BELOW_GATEWAY_COST');
    expect(again?.acknowledgement).toBeNull();
    expect(again?.fingerprint).not.toBe(alert!.fingerprint);
    await restoreRules();
  });

  it('pide el Super-Admin verificado', async () => {
    const alert = (await loadPricingHealth(db)).alerts[0];
    expect(alert).toBeDefined();
    await expect(acknowledgePricingAlert(db, await verified(), { code: alert!.code, fingerprint: alert!.fingerprint }, 'Nota suficiente para aceptar', new Date(Date.now() + 11 * 60_000))).rejects.toBeInstanceOf(SuperadminRequiredError);
  });
});

describe('QA-A04 · campañas al 0 % por revisar', () => {
  it('lista las campañas de presupuesto calculadas al 0 % (comisión, exento y beca a cero), con la marca del candado, también si la categoría pasó luego a tramos; no las taquillas ni las canceladas', async () => {
    const exempt = (await db.globalCategory.findFirstOrThrow({ where: { rule: 'EXEMPT' } })).name;
    const org = await createOrganization(db);
    const flagged = await createInitiative(db, org.id, { category: exempt, status: 'FUNDRAISING', title: 'Toldos del patio' });
    const quiet = await createInitiative(db, org.id, { category: exempt, status: 'BUDGETING', title: 'Biblioteca de aula' });
    // Calculada con comisión por tramos o con exento: no es una campaña al 0 %.
    const withFee = await createInitiative(db, org.id, { category: exempt, bracketFeeCents: 25_000 });
    const withExempt = await createInitiative(db, org.id, { category: exempt, defaultExemptAppliedCents: 100_000 });
    const withMedal = await createInitiative(db, org.id, { category: exempt, medalExemptAppliedCents: 50_000 });
    const ticketing = await createInitiative(db, org.id, { category: exempt, format: 'TICKETING', ticketSubtype: 'EVENT' });
    const cancelled = await createInitiative(db, org.id, { category: exempt, status: 'CANCELLED' });
    const noGoal = await createInitiative(db, org.id, { category: exempt, goalCents: 0 });
    for (const initiative of [flagged, quiet, withFee, withExempt, withMedal, ticketing, cancelled, noGoal]) {
      await db.auditLog.create({ data: { actorType: 'USER', organizationId: initiative.organizationId, action: 'studio.exempt_category_saved', targetType: 'Initiative', targetId: String(initiative.id), metadataJson: { initiativeId: initiative.id, category: initiative.category } } });
    }
    await db.auditLog.create({ data: { actorType: 'USER', organizationId: org.id, action: 'studio.semantic_lock_triggered', targetType: 'Initiative', targetId: String(flagged.id), metadataJson: { initiativeId: flagged.id } } });

    // La categoría pasa después a «por tramos»: las campañas ya calculadas al 0 % siguen en la lista (siguen al 0 %).
    await setGlobalCategoryRule(db, await verified(), { name: exempt, rule: 'BRACKETS' });
    try {
      const rows = await loadExemptCampaigns(db);
      expect(rows.find((row) => row.initiativeId === flagged.id)).toMatchObject({ title: 'Toldos del patio', category: exempt, lockTriggered: true, organizationId: org.id });
      expect(rows.find((row) => row.initiativeId === quiet.id)).toMatchObject({ lockTriggered: false });
      for (const hidden of [withFee, withExempt, withMedal, ticketing, cancelled, noGoal]) expect(rows.some((row) => row.initiativeId === hidden.id)).toBe(false);
      // Sin datos personales: solo lo que hace falta para revisar.
      expect(Object.keys(rows[0]!).sort()).toEqual(['category', 'goalCents', 'initiativeId', 'lastSavedAt', 'lockTriggered', 'organizationId', 'organizationName', 'status', 'title']);
    } finally {
      await setGlobalCategoryRule(db, await verified(), { name: exempt, rule: 'EXEMPT' });
    }
  });
});

describe('QA-A04 · alertas de dinero que solo se arreglan con Paycomet', () => {
  it('se cierran únicamente con una nota sin datos personales, que queda en la auditoría; la consola enseña sus cifras', async () => {
    const org = await createOrganization(db);
    await raiseAlert(db, { type: 'PAYOUT_BLOCKED', severity: 'CRITICAL', dedupeKey: `PAYOUT_BLOCKED:${uniqueId('p')}`, organizationId: org.id, targetType: 'EscrowPayout', targetId: '99', detail: { initiativeId: 5, blockedCents: 30_000 } }, new Date('2100-01-01T00:00:00Z'));
    const alertRow = await db.opsAlert.findFirstOrThrow({ where: { organizationId: org.id, type: 'PAYOUT_BLOCKED' } });

    const figures = (await getConsoleOverview(db, admin)).alerts.find((alert) => alert.id === alertRow.id)?.figures;
    expect(figures).toMatchObject({ blockedCents: 30_000, amountCents: null, stuckCents: null });

    // El botón genérico de resolver no la cierra.
    expect(await resolveOpsAlertById(db, admin, alertRow.id)).toEqual({ status: 'USE_RESOLVER' });
    expect(await resolveOpsAlertWithNote(db, admin, { alertId: alertRow.id, note: 'corta' })).toEqual({ status: 'INVALID' });
    expect(await resolveOpsAlertWithNote(db, admin, { alertId: alertRow.id, note: 'Hablado con ana.lopez@example.com de Paycomet' })).toEqual({ status: 'INVALID' });
    expect(await resolveOpsAlertWithNote(db, admin, { alertId: alertRow.id, note: 'Pedido 20261113 a Paycomet hablado con soporte' })).toEqual({ status: 'RESOLVED' });
    await db.opsAlert.update({ where: { id: alertRow.id }, data: { status: 'OPEN', resolvedAt: null } });
    expect((await db.opsAlert.findUniqueOrThrow({ where: { id: alertRow.id } })).status).toBe('OPEN');

    expect(await resolveOpsAlertWithNote(db, admin, { alertId: alertRow.id, note: 'Paycomet repondrá el importe por escrito; lo sigue el promotor.' })).toEqual({ status: 'RESOLVED' });
    expect((await db.opsAlert.findUniqueOrThrow({ where: { id: alertRow.id } })).status).toBe('RESOLVED');
    // La primera nota se cerró y se reabrió a propósito: la auditoría guarda las dos y la segunda barrera (el limpiador) ya enmascaró el número de pedido de la primera.
    const audits = await db.auditLog.findMany({ where: { action: 'ops_alert.resolved_with_note', targetId: alertRow.id }, orderBy: { id: 'asc' } });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.metadataJson).toMatchObject({ note: 'Pedido [redactado] Paycomet hablado con soporte' });
    const audit = audits[1]!;
    expect(audit.metadataJson).toMatchObject({ type: 'PAYOUT_BLOCKED', note: 'Paycomet repondrá el importe por escrito; lo sigue el promotor.' });
    expect(await resolveOpsAlertWithNote(db, admin, { alertId: alertRow.id, note: 'Otra nota suficientemente larga' })).toEqual({ status: 'NOT_OPEN' });
  });

  it('una alerta de otro tipo no se cierra con nota, y una persona que no es Super-Admin se deniega', async () => {
    const other = await raiseAndFind('JOB_FAILED', `JOB_FAILED:${uniqueId('j')}`);
    expect(await resolveOpsAlertWithNote(db, admin, { alertId: other.id, note: 'Nota larga suficiente para valer' })).toEqual({ status: 'NOT_ALLOWED' });
    const plain = await createUser(db);
    const familyActor = await loadUserActor(db, plain.id, { ipHash: 'h' }, { secondFactor: true });
    await expect(resolveOpsAlertWithNote(db, familyActor, { alertId: other.id, note: 'Nota larga suficiente para valer' })).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.opsAlert.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('OPEN');
  });
});

async function raiseAndFind(type: 'JOB_FAILED' | 'PAYOUT_BLOCKED', dedupeKey: string) {
  await raiseAlert(db, { type, severity: 'WARNING', dedupeKey, detail: {} });
  return db.opsAlert.findUniqueOrThrow({ where: { dedupeKey } });
}

describe('QA-A04 · bandeja de soporte de KORUM', () => {
  async function familyTicket(overrides: Partial<Prisma.SupportTicketUncheckedCreateInput> = {}) {
    const user = await createUser(db, { locale: 'ca' });
    const org = await createOrganization(db);
    const ticket = await db.supportTicket.create({
      data: { ticketCode: ticketCode(), organizationId: org.id, originLabel: org.name, senderEmail: user.email, target: 'SUPERADMIN', topic: 'PAYMENT', subject: 'No me llega el recibo', message: 'Pagué ayer la donación y todavía no he recibido el recibo.', ...overrides }
    });
    return { user, org, ticket };
  }

  it('lista solo lo que es de KORUM, las consultas de las entidades primero, y no las dirigidas a un centro', async () => {
    const { ticket: familyOne } = await familyTicket();
    const org = await createOrganization(db);
    const signer = await createUser(db);
    const fromOrg = await db.supportTicket.create({ data: { ticketCode: ticketCode(), organizationId: org.id, originLabel: org.name, senderEmail: signer.email, target: 'SUPERADMIN', fromOrganization: true, topic: 'PAYMENT', subject: 'Duda con una liquidación', message: 'Necesitamos saber cuándo llegará nuestra liquidación.' } });
    const { ticket: toCenter } = await familyTicket({ target: 'ORGANIZATION', topic: 'INITIATIVE', subject: 'Sobre el cartel del festival' });

    const view = await getConsoleSupport(db, admin);
    const codes = view.waiting.map((ticket) => ticket.ticketCode);
    expect(codes).toContain(familyOne.ticketCode);
    expect(codes).toContain(fromOrg.ticketCode);
    expect(codes).not.toContain(toCenter.ticketCode);
    expect(codes.indexOf(fromOrg.ticketCode)).toBeLessThan(codes.indexOf(familyOne.ticketCode));
    expect(view.waiting.find((ticket) => ticket.ticketCode === fromOrg.ticketCode)).toMatchObject({ fromOrganization: true, orgSlug: org.slug });
    expect(view.priorityCount).toBeGreaterThanOrEqual(1);
    expect(view.waitingCount).toBeGreaterThanOrEqual(2);
  });

  it('contesta una sola vez, el estado solo avanza y el aviso por email no copia la respuesta', async () => {
    const { user, ticket } = await familyTicket();
    const outcome = await answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode, reply: 'Hemos reenviado el recibo a tu correo.' });
    expect(outcome).toMatchObject({ status: 'OK', resolved: false });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'IN_PROGRESS', replyMessage: 'Hemos reenviado el recibo a tu correo.' });

    const mail = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'support.replied', toAddress: user.email } });
    expect(mail).toMatchObject({ locale: 'ca', idempotencyKey: `support.replied:${ticket.ticketCode}` });
    expect(mail.payloadJson).toEqual({ ticketCode: ticket.ticketCode, organization: 'KORUM' });
    expect(JSON.stringify(mail.payloadJson)).not.toContain('reenviado');

    // Una sola respuesta por consulta.
    expect(await answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode, reply: 'Otra respuesta distinta de la anterior' })).toEqual({ status: 'REJECTED', reason: 'ALREADY_REPLIED' });
    // El estado avanza: resuelta, y una resuelta ya no se toca.
    expect(await answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode, status: 'RESOLVED' })).toMatchObject({ status: 'OK', resolved: true });
    expect((await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).resolvedAt).not.toBeNull();
    expect(await answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode, status: 'IN_PROGRESS' })).toEqual({ status: 'REJECTED', reason: 'ALREADY_RESOLVED' });
    expect(await db.outboxMessage.count({ where: { templateKey: 'support.replied', toAddress: user.email } })).toBe(1);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'support.platform_answered', targetId: String(ticket.id) }, orderBy: { id: 'asc' } });
    expect(audit.metadataJson).toMatchObject({ ticketCode: ticket.ticketCode, replied: true, from: 'OPEN', to: 'IN_PROGRESS' });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('reenviado');
  });

  it('la respuesta a lo que escribe una entidad se lee en su panel: el aviso lleva su slug', async () => {
    const org = await createOrganization(db);
    const signer = await createUser(db);
    const fromOrg = await db.supportTicket.create({ data: { ticketCode: ticketCode(), organizationId: org.id, originLabel: org.name, senderEmail: signer.email, target: 'SUPERADMIN', fromOrganization: true, topic: 'PAYMENT', subject: 'Duda con una liquidación', message: 'Necesitamos saber cuándo llegará nuestra liquidación.' } });
    expect(await answerPlatformTicket(db, admin, { ticketCode: fromOrg.ticketCode, reply: 'Llegará en dos días laborables.' })).toMatchObject({ status: 'OK' });
    const mail = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'support.replied', toAddress: signer.email } });
    expect(mail.payloadJson).toEqual({ ticketCode: fromOrg.ticketCode, organization: 'KORUM', panelOrgSlug: org.slug });
  });

  it('no contesta lo que no es de KORUM, lo que no existe, lo que ya no tiene texto ni entradas inválidas', async () => {
    const { ticket: toCenter } = await familyTicket({ target: 'ORGANIZATION', topic: 'INITIATIVE' });
    expect(await answerPlatformTicket(db, admin, { ticketCode: toCenter.ticketCode, reply: 'Respuesta de KORUM a una del centro' })).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    expect(await answerPlatformTicket(db, admin, { ticketCode: ticketCode(), reply: 'Una respuesta a una consulta inexistente' })).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    const { ticket: purged } = await familyTicket({ message: '', senderEmail: null });
    expect(await answerPlatformTicket(db, admin, { ticketCode: purged.ticketCode, reply: 'Una respuesta que nadie leerá' })).toEqual({ status: 'REJECTED', reason: 'PURGED' });
    const { ticket } = await familyTicket();
    expect(await answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode, reply: 'x' })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await answerPlatformTicket(db, admin, { ticketCode: 'no-es-un-codigo', reply: 'Una respuesta válida de largo' })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    expect((await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('OPEN');
  });

  it('dos sesiones que contestan a la vez no se pisan: una sola respuesta queda', async () => {
    const { ticket } = await familyTicket();
    const results = await Promise.all([
      answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode, reply: 'Primera respuesta de una sesión' }),
      answerPlatformTicket(db, admin, { ticketCode: ticket.ticketCode, reply: 'Segunda respuesta de otra sesión' })
    ]);
    expect(results.filter((result) => result.status === 'OK')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(1);
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `support.replied:${ticket.ticketCode}` } })).toBe(1);
  });

  it('solo el Super-Admin con segundo factor: una familia, una persona firmante o un Super-Admin sin él se deniegan sin tocar nada', async () => {
    const { ticket } = await familyTicket();
    const { director } = await organizationWithSigners();
    const familyActor = await loadUserActor(db, (await createUser(db)).id, { ipHash: 'h' }, { secondFactor: true });
    const signerActor = await loadUserActor(db, director.id, { ipHash: 'h' }, { secondFactor: true });
    const noSecondFactor = await loadUserActor(db, (await createUser(db, { isSuperadmin: true, twoFactorEnabled: true })).id, { ipHash: 'h' }, { secondFactor: false });
    for (const actor of [familyActor, signerActor, noSecondFactor]) {
      await expect(answerPlatformTicket(db, actor, { ticketCode: ticket.ticketCode, reply: 'Respuesta que no debe guardarse' })).rejects.toBeInstanceOf(TenantAccessError);
      await expect(getConsoleSupport(db, actor)).rejects.toBeInstanceOf(TenantAccessError);
    }
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'OPEN', replyMessage: null });
  });

  it('una consulta de rectificación enseña su solicitud RGPD con el plazo y se cierra una sola vez, con el Super-Admin verificado', async () => {
    const { ticket, user } = await familyTicket({ topic: 'RECTIFICATION', subject: 'Corregir mi nombre', message: 'Mi apellido está mal escrito en la cuenta.' });
    const request = await db.privacyRequest.create({ data: { userId: user.id, requesterEmailHmac: uniqueId('hmac'), type: 'RECTIFICATION', notes: `Soporte ${ticket.ticketCode}`, dueAt: new Date(Date.now() - 86_400_000) } });
    const view = await getConsoleSupport(db, admin);
    expect(view.waiting.find((candidate) => candidate.ticketCode === ticket.ticketCode)?.rectification).toMatchObject({ requestId: request.id, status: 'RECEIVED', overdue: true });

    const person = await verified();
    expect(await closeRectificationRequest(db, person, { ticketCode: ticket.ticketCode, outcome: 'COMPLETED', notes: 'Cambiado tras comprobar la identidad.' })).toEqual({ status: 'CLOSED' });
    expect(await db.privacyRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'COMPLETED', notes: `Soporte ${ticket.ticketCode}: Cambiado tras comprobar la identidad.` });
    expect(await db.auditLog.count({ where: { action: 'privacy.request_closed', targetId: String(request.id) } })).toBe(1);
    expect(await closeRectificationRequest(db, person, { ticketCode: ticket.ticketCode, outcome: 'COMPLETED' })).toEqual({ status: 'ALREADY_CLOSED' });
    expect(await closeRectificationRequest(db, person, { ticketCode: ticketCode(), outcome: 'COMPLETED' })).toEqual({ status: 'NOT_FOUND' });
    expect(await closeRectificationRequest(db, person, { ticketCode: ticket.ticketCode, outcome: 'REJECTED', notes: 'Nuevo email ana@example.com' })).toEqual({ status: 'INVALID' });
    await expect(closeRectificationRequest(db, person, { ticketCode: ticket.ticketCode, outcome: 'COMPLETED' }, new Date(Date.now() + 11 * 60_000))).rejects.toBeInstanceOf(SuperadminRequiredError);
  });
});

describe('QA-A03 · email directo de KORUM al centro', () => {
  const message = { subject: 'Revisión de vuestros documentos', message: 'Hola. Hemos revisado la documentación de vuestra entidad y todo está en orden.\n\nUn saludo.' };

  it('sale a quienes firman, en su idioma, con KORUM como remitente, con tope por entidad y día, y la auditoría guarda cuánto se envió y desde dónde pero no el texto', async () => {
    const { organization, director, cosigner } = await organizationWithSigners();
    const person = await verified();
    const meta = { ipHash: 'hmac-de-la-ip', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' };
    const base = Date.now();
    const first = await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, message, new Date(base), meta);
    expect(first).toMatchObject({ status: 'SENT', recipients: 2 });
    const rows = await db.outboxMessage.findMany({ where: { organizationId: organization.id, templateKey: 'platform.message' } });
    expect(rows.map((row) => row.toAddress).sort()).toEqual([cosigner.email, director.email].sort());
    expect(rows.find((row) => row.toAddress === director.email)?.locale).toBe('ca');
    expect(rows[0]!.payloadJson).toMatchObject({ organization: organization.name, subject: message.subject, message: message.message });
    // La clave de idempotencia lleva la entidad: dos envíos a entidades distintas en el mismo milisegundo no se pisan.
    expect(rows.every((row) => row.idempotencyKey.startsWith(`platform.message:direct:${organization.id}:${base}:`))).toBe(true);
    if (first.status === 'SENT') expect(first.outboxIds.sort()).toEqual(rows.map((row) => row.id).sort());

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'support.direct_email_sent', organizationId: organization.id } });
    expect(audit).toMatchObject({ actorUserId: person.userId, ipHash: 'hmac-de-la-ip', userAgent: 'Chrome/Windows' });
    expect(audit.metadataJson).toMatchObject({ recipients: 2, subjectLength: message.subject.length });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('documentación');
    expect(JSON.stringify(audit)).not.toContain(director.email);

    // Tope de 3 por entidad y día.
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, message, new Date(base + 1))).toMatchObject({ status: 'SENT' });
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, message, new Date(base + 2))).toMatchObject({ status: 'SENT' });
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, message, new Date(base + 3))).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'platform.message' } })).toBe(6);
  });

  it('el mismo milisegundo para dos entidades que comparten una persona firmante no pierde ningún email', async () => {
    const first = await organizationWithSigners();
    const second = await createOrganization(db);
    await db.organizationMember.create({ data: { organizationId: second.id, userId: first.director.id, role: 'DIRECTOR', roleLabel: 'Dirección' } });
    const person = await verified();
    const now = new Date();
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, first.organization.id, message, now)).toMatchObject({ status: 'SENT' });
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, second.id, message, now)).toMatchObject({ status: 'SENT', recipients: 1 });
    expect(await db.outboxMessage.count({ where: { toAddress: first.director.email, templateKey: 'platform.message', organizationId: { in: [first.organization.id, second.id] } } })).toBe(2);
  });

  it('no admite enlaces ni direcciones (el camino más corto a un phishing) y tampoco gasta el cupo', async () => {
    const { organization } = await organizationWithSigners();
    const person = await verified();
    for (const text of ['Entra en https://korum-soporte.example/login para revisarlo todo.', 'Escribe a soporte@korum.example con los datos de la entidad.', 'Abre korum-soporte.com para revisar el panel de la entidad.']) {
      expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, { subject: 'Revisión de documentos', message: text })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    }
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'platform.message' } })).toBe(0);
    const base = Date.now();
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, message, new Date(base + attempt))).toMatchObject({ status: 'SENT' });
  });

  it('una sesión robada no puede escribir a todas las entidades: hay un tope por persona y día', async () => {
    const person = await verified();
    const base = Date.now();
    let sent = 0;
    for (let index = 0; index < 7; index += 1) {
      const { organization } = await organizationWithSigners();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, message, new Date(base + sent));
        if (outcome.status === 'SENT') sent += 1;
        else expect(outcome).toEqual({ status: 'REJECTED', reason: 'RATE_LIMITED' });
      }
    }
    expect(sent).toBe(20);
    // Otra persona verificada no gasta del cupo de la anterior.
    const { organization } = await organizationWithSigners();
    expect(await sendDirectEmailToOrganization(db, await verified(), TEST_HMAC_SECRET, organization.id, message, new Date(base + 99))).toMatchObject({ status: 'SENT' });
  });

  it('un intento que no sale no gasta el cupo: texto inválido, entidad archivada o sin personas que firmen', async () => {
    const { organization } = await organizationWithSigners();
    const person = await verified();
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, organization.id, { subject: 'abc', message: 'corto' })).toEqual({ status: 'REJECTED', reason: 'INVALID_INPUT' });
    const archived = await createOrganization(db, { archivedAt: new Date() });
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, archived.id, message)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    const empty = await createOrganization(db);
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, empty.id, message)).toEqual({ status: 'REJECTED', reason: 'NO_RECIPIENTS' });
    expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, 'no-existe', message)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
    // Ninguno de esos intentos gastó el cupo de la entidad ni el de la persona.
    const base = Date.now();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await sendDirectEmailToOrganization(db, person, TEST_HMAC_SECRET, empty.id, message, new Date(base + attempt))).toEqual({ status: 'REJECTED', reason: 'NO_RECIPIENTS' });
    }
  });

  it('pide el Super-Admin verificado: con la sesión de hace más de 10 minutos no sale nada', async () => {
    const { organization } = await organizationWithSigners();
    const stale = await verified();
    await expect(sendDirectEmailToOrganization(db, stale, TEST_HMAC_SECRET, organization.id, message, new Date(Date.now() + 11 * 60_000))).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'platform.message' } })).toBe(0);
  });
});

describe('auditorías del Sprint 5.3 · cupos, versión y límites', () => {
  it('la renovación del curso usa el límite global para una entidad sin tarifa propia: no arrastra para siempre un límite más alto que el de las demás (I1)', async () => {
    const plain = await createOrganization(db, { customRules: false, quotaPeriod: '2025-2026', exemptLimitCents: original.exemptLimitCents, exemptRemainingCents: original.exemptLimitCents - 60_000 });
    const own = await createOrganization(db, { customRules: true, quotaPeriod: '2025-2026', exemptLimitCents: 80_000, exemptRemainingCents: 10_000 });
    await save({ exemptLimitCents: 30_000 });
    try {
      // Gastó 60.000 con un límite global de 30.000: conserva lo gastado en este curso…
      expect(await db.organization.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ exemptLimitCents: 60_000, exemptRemainingCents: 0 });
      // …pero en el curso siguiente empieza con el límite global, igual que las demás. La de tarifa propia conserva el suyo.
      expect((await renewOrganizationQuotas(db, plain.id, '2026-2027')).renewed).toBe(true);
      expect((await renewOrganizationQuotas(db, own.id, '2026-2027')).renewed).toBe(true);
      expect(await db.organization.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ exemptLimitCents: 30_000, exemptRemainingCents: 30_000, quotaPeriod: '2026-2027' });
      expect(await db.organization.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ exemptLimitCents: 80_000, exemptRemainingCents: 80_000 });
    } finally {
      await restoreRules();
    }
  });

  it('bajar la beca de un nivel a mitad de curso no destruye la beca ya reservada: al reembolsar la campaña vuelve entera, y también la que se reserve después (I3)', async () => {
    const org = await createOrganization(db, { quotaPeriod: '2026-2027', medalRank: 2, medalGrantAvailableCents: 60_000 });
    const campaign = await createInitiative(db, org.id, { status: 'FUNDRAISING', quotaReservedAt: new Date(), quotaReservedMedalCents: 40_000, quotaReservedPeriod: '2026-2027' });
    const asTiers = (view: Awaited<ReturnType<typeof loadMedalsView>>, silverGrant: number) => view.tiers.map((tier) => ({ key: tier.key, campaignsRequired: tier.campaignsRequired, grantCents: tier.key === 'silver' ? silverGrant : tier.grantCents }));
    const view = await loadMedalsView(db);
    const silver = view.tiers.find((tier) => tier.key === 'silver')!;
    try {
      // Con una campaña que tiene beca reservada se puede bajar: la devolución no depende de la beca vigente.
      await saveMedals(db, await verified(), asTiers(view, 50_000), view.updatedAt);
      expect(await releaseInitiativeQuotas(db, campaign.id)).toEqual({ released: true, credited: true });
      expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).medalGrantAvailableCents).toBe(100_000);

      // La beca baja y la entidad usa 800 € de los 1.000 € que conserva este curso: al reembolsarla vuelven los 800, no 300.
      const another = await createInitiative(db, org.id, { status: 'FUNDRAISING', quotaReservedAt: new Date(), quotaReservedMedalCents: 80_000, quotaReservedPeriod: '2026-2027' });
      await db.organization.update({ where: { id: org.id }, data: { medalGrantAvailableCents: 20_000 } });
      expect(await releaseInitiativeQuotas(db, another.id)).toEqual({ released: true, credited: true });
      expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).medalGrantAvailableCents).toBe(100_000);
    } finally {
      await restoreMedals();
      expect(silver.grantCents).toBeGreaterThan(0);
    }
  });

  it('abrir el Estudio sin que toque renovar el curso no escribe en la entidad ni cambia su fecha de modificación (N2)', async () => {
    const org = await createOrganization(db, { quotaPeriod: '2026-2027' });
    const before = (await db.organization.findUniqueOrThrow({ where: { id: org.id } })).updatedAt;
    expect(await renewOrganizationQuotas(db, org.id, '2026-2027')).toEqual({ renewed: false });
    expect(await renewOrganizationQuotas(db, org.id, '2025-2026')).toEqual({ renewed: false });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).updatedAt).toEqual(before);
  });

  it('una renovación de curso a la vez que un guardado del exento global no escribe un límite global ya viejo (M-A)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const org = await createOrganization(db, { customRules: false, quotaPeriod: '2025-2026', exemptLimitCents: original.exemptLimitCents, exemptRemainingCents: 0 });
      await Promise.all([renewOrganizationQuotas(db, org.id, '2026-2027'), save({ exemptLimitCents: original.exemptLimitCents + 50_000 })]);
      const after = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
      expect(after, `ronda ${round}`).toMatchObject({ exemptLimitCents: original.exemptLimitCents + 50_000, exemptRemainingCents: original.exemptLimitCents + 50_000 });
      await restoreRules();
    }
  });

  it('guardar el exento a la vez que una campaña reserva cupo no pierde ni crea cupo: lo gastado + lo reservado cuadra siempre (I2)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const org = await createOrganization(db, { customRules: false, exemptLimitCents: original.exemptLimitCents, exemptRemainingCents: original.exemptLimitCents });
      const campaign = await createInitiative(db, org.id, { status: 'BUDGETING', defaultExemptAppliedCents: 40_000 });
      await Promise.all([reserveInitiativeQuotas(db, campaign.id), save({ exemptLimitCents: original.exemptLimitCents + 50_000 })]);
      const after = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
      expect(after.exemptLimitCents - after.exemptRemainingCents, `ronda ${round}: gastado + reservado`).toBe(40_000);
      expect(after.exemptLimitCents).toBe(original.exemptLimitCents + 50_000);
      await restoreRules();
    }
  });

  it('un cobro de patrocinio que se factura mientras se edita (toca la fecha de la configuración) no da un «otra persona guardó antes» falso (M1)', async () => {
    const view = await loadGlobalRulesView(db);
    await db.globalConfig.update({ where: { id: 'GLOBAL' }, data: { updatedAt: new Date() } });
    await expect(saveGlobalRules(db, await verified(), { ...view.rules, t3Bps: view.rules.t3Bps + 1 }, view.version)).resolves.toMatchObject({ changed: 1 });
    // Pero otra persona que cambió de verdad las reglas sí lo provoca.
    await expect(saveGlobalRules(db, await verified(), { ...view.rules, t3Bps: view.rules.t3Bps + 2 }, view.version)).rejects.toMatchObject({ reason: 'STALE' });
    await restoreRules();
  });

  it('la duración de las bolsas no cambia con comercios que ya tienen dinero en la bolsa y su fecha comunicada (I4)', async () => {
    const view = await loadGlobalRulesView(db);
    const org = await createOrganization(db);
    const sponsor = await db.sponsor.create({
      data: { organizationId: org.id, name: 'Comercio de pruebas', contactPerson: 'Persona', phone: '600000000', email: 'comercio@pruebas.example', sector: 'Papelería', tierLabel: 'Plata', amountCents: 25_000, feeGeneratedCents: 3_750, promo: 'Promo', code: uniqueId('c'), expiresAt: new Date(Date.now() + 86_400_000), status: 'CREDIT_POOL', creditPoolAt: new Date() }
    });
    try {
      await expect(saveGlobalRules(db, await verified(), { ...view.rules, creditPoolMaxDays: view.rules.creditPoolMaxDays === 30 ? 31 : 30 }, view.version)).rejects.toMatchObject({ reason: 'CREDIT_POOL_OPEN', fields: ['creditPoolMaxDays'] });
      expect((await loadGlobalRulesView(db)).version).toBe(view.version);
      // Otros cambios sí se guardan con el comercio en la bolsa.
      await save({ t3Bps: view.rules.t3Bps + 1 });
    } finally {
      await db.sponsor.update({ where: { id: sponsor.id }, data: { status: 'APPROVED', creditPoolAt: null } });
      await restoreRules();
    }
  });

  it('la aportación voluntaria y el fijo de la pasarela no admiten lo que el checkout y el Estudio no pueden cobrar (I5, M2)', async () => {
    const view = await loadGlobalRulesView(db);
    await expect(saveGlobalRules(db, await verified(), { ...view.rules, fullIntegrityCheckCents: 6_000 }, view.version)).rejects.toMatchObject({ reason: 'INVALID', fields: ['fullIntegrityCheckCents'] });
    await expect(saveGlobalRules(db, await verified(), { ...view.rules, guaranteePresetsCents: [0, 6_000, 8_000, 10_000] }, view.version)).rejects.toMatchObject({ reason: 'INVALID', fields: ['guaranteePresetsCents'] });
    await expect(saveGlobalRules(db, await verified(), { ...view.rules, gatewayFixedCents: 40_000 }, view.version)).rejects.toMatchObject({ reason: 'INVALID', fields: ['gatewayFixedCents'] });
  });

  it('aceptar un aviso es idempotente con la fila leída en la transacción y el recorte conserva las aceptaciones que siguen valiendo (M4, M5)', async () => {
    const alert = (await loadPricingHealth(db)).alerts.find((candidate) => candidate.code === 'HUCHA_FEE_BELOW_GATEWAY_COST')!;
    const target = { code: alert.code, fingerprint: alert.fingerprint };
    // 205 aceptaciones antiguas de avisos que ya no existen: al aceptar la vigente, el recorte tira las antiguas y conserva la vigente.
    const old = Array.from({ length: 205 }, (_, index) => ({ code: 'BRACKET_RATES_NOT_DECREASING', fingerprint: `antigua-${index}`, acknowledgedById: 'u', acknowledgedAt: new Date(Date.now() - 1000 * (300 - index)).toISOString(), note: 'Nota antigua suficiente' }));
    await db.platformSetting.upsert({ where: { key: 'pricing.acknowledgements' }, create: { key: 'pricing.acknowledgements', valueJson: old, version: 1 }, update: { valueJson: old, version: 1 } });
    invalidateSettingsCache('pricing.acknowledgements');
    expect(await acknowledgePricingAlert(db, await verified(), target, 'La Hucha es un coste de captación asumido.')).toEqual({ alreadyAccepted: false });
    // «Ya aceptado» sale de la fila, no de la caché de este proceso: aunque la caché esté vacía, no se duplica.
    invalidateSettingsCache('pricing.acknowledgements');
    expect(await acknowledgePricingAlert(db, await verified(), target, 'Otra nota distinta de la primera.')).toEqual({ alreadyAccepted: true });
    const stored = (await db.platformSetting.findUniqueOrThrow({ where: { key: 'pricing.acknowledgements' } })).valueJson as Array<{ code: string; fingerprint: string; note: string }>;
    expect(stored.length).toBeLessThanOrEqual(200);
    expect(stored.filter((item) => item.code === target.code && item.fingerprint === target.fingerprint)).toEqual([expect.objectContaining({ note: 'La Hucha es un coste de captación asumido.' })]);
  });
});

describe('auditorías del Sprint 5.3 · soporte y rectificación', () => {
  async function rectificationTicket() {
    const user = await createUser(db, { name: 'Ana Lopes Garcia' });
    const org = await createOrganization(db);
    const code = ticketCode();
    const ticket = await db.supportTicket.create({ data: { ticketCode: code, organizationId: org.id, originLabel: org.name, senderEmail: user.email, target: 'SUPERADMIN', topic: 'RECTIFICATION', subject: 'Corregir mi nombre', message: 'Mi apellido está mal escrito en la cuenta.' } });
    const request = await db.privacyRequest.create({ data: { userId: user.id, requesterEmailHmac: uniqueId('hmac'), type: 'RECTIFICATION', notes: `Soporte ${code}`, dueAt: new Date(Date.now() + 86_400_000) } });
    return { user, org, ticket, request, code };
  }

  it('corrige el nombre de la cuenta con el Super-Admin verificado, sin guardar el nombre en la auditoría, y solo con una solicitud abierta y una cuenta viva (I1)', async () => {
    const { user, code, request } = await rectificationTicket();
    const person = await verified();
    expect(await rectifyAccountName(db, person, { ticketCode: code, name: '  Ana   López García ' }, new Date(), { ipHash: 'hmac-ip', userAgent: 'Mozilla/5.0 Firefox/120.0 Windows NT 10.0' })).toEqual({ status: 'DONE' });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBe('Ana López García');
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'privacy.account_name_rectified', targetId: user.id } });
    expect(audit).toMatchObject({ actorUserId: person.userId, ipHash: 'hmac-ip' });
    expect(audit.metadataJson).toMatchObject({ ticketCode: code, requestId: request.id, characters: 16 });
    expect(JSON.stringify(audit)).not.toContain('López');

    // Cerrada la solicitud, ya no se puede renombrar con esa consulta; sin consulta de rectificación tampoco; una cuenta anonimizada no tiene nombre que corregir.
    expect(await closeRectificationRequest(db, person, { ticketCode: code, outcome: 'COMPLETED' })).toEqual({ status: 'CLOSED' });
    expect(await rectifyAccountName(db, person, { ticketCode: code, name: 'Otro Nombre' })).toEqual({ status: 'NOT_FOUND' });
    expect(await rectifyAccountName(db, person, { ticketCode: ticketCode(), name: 'Otro Nombre' })).toEqual({ status: 'NOT_FOUND' });
    expect(await rectifyAccountName(db, person, { ticketCode: code, name: 'x' })).toEqual({ status: 'INVALID' });
    const gone = await rectificationTicket();
    await db.user.update({ where: { id: gone.user.id }, data: { gdprAnonymizedAt: new Date() } });
    expect(await rectifyAccountName(db, person, { ticketCode: gone.code, name: 'Nombre Correcto' })).toEqual({ status: 'NO_ACCOUNT' });
    await expect(rectifyAccountName(db, await verified(), { ticketCode: gone.code, name: 'Nombre Correcto' }, new Date(Date.now() + 11 * 60_000))).rejects.toBeInstanceOf(SuperadminRequiredError);
  });

  it('no renombra la cuenta de otra persona: la cuenta tiene que ser la de quien abrió la solicitud (N6)', async () => {
    const first = await rectificationTicket();
    const other = await createUser(db, { name: 'Otra Persona' });
    // El email de la consulta pasó a otra cuenta (cambiado fuera de la aplicación): la solicitud sigue siendo de la primera persona.
    await db.supportTicket.update({ where: { ticketCode: first.code }, data: { senderEmail: other.email } });
    expect(await rectifyAccountName(db, await verified(), { ticketCode: first.code, name: 'Nombre Correcto' })).toEqual({ status: 'NOT_FOUND' });
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).name).toBe('Otra Persona');
    expect((await db.user.findUniqueOrThrow({ where: { id: first.user.id } })).name).toBe('Ana Lopes Garcia');
  });

  it('el email directo no se cancela a la hora aunque el texto se borre al enviar: vale 7 días (N3)', async () => {
    const { organization } = await organizationWithSigners();
    const now = new Date();
    expect(await sendDirectEmailToOrganization(db, await verified(), TEST_HMAC_SECRET, organization.id, { subject: 'Revisión de documentos', message: 'Hola. Hemos revisado todo y está en orden con vuestra entidad.' }, now)).toMatchObject({ status: 'SENT' });
    const row = await db.outboxMessage.findFirstOrThrow({ where: { organizationId: organization.id, templateKey: 'platform.message' } });
    expect((row.payloadJson as { expiresAt: string }).expiresAt).toBe(new Date(now.getTime() + 7 * 86_400_000).toISOString());
    // Con el proveedor de email caído una hora, o un día, no caduca; a los 8 días sí.
    expect(secretsExpired(row, new Date(now.getTime() + 2 * 3_600_000))).toBe(false);
    expect(secretsExpired(row, new Date(now.getTime() + 86_400_000))).toBe(false);
    expect(secretsExpired(row, new Date(now.getTime() + 8 * 86_400_000))).toBe(true);
  });

  it('una nota que nombra otra consulta no hace que esa consulta muestre la solicitud de la primera (M4)', async () => {
    const first = await rectificationTicket();
    const second = await rectificationTicket();
    await closeRectificationRequest(db, await verified(), { ticketCode: first.code, outcome: 'COMPLETED', notes: `Revisado junto con Soporte ${second.code} sin más cambios` });
    const view = await getConsoleSupport(db, admin);
    const all = [...view.waiting, ...view.resolved];
    expect(all.find((ticket) => ticket.ticketCode === first.code)?.rectification).toMatchObject({ requestId: first.request.id, status: 'COMPLETED' });
    // La segunda sigue enseñando **su** solicitud, abierta, y se puede cerrar.
    expect(all.find((ticket) => ticket.ticketCode === second.code)?.rectification).toMatchObject({ requestId: second.request.id, status: 'RECEIVED' });
    expect(await closeRectificationRequest(db, await verified(), { ticketCode: second.code, outcome: 'COMPLETED' })).toEqual({ status: 'CLOSED' });
  });

  it('la auditoría de contestar a una familia no queda atada a la entidad; la de contestar a una entidad, sí (M5)', async () => {
    const user = await createUser(db);
    const org = await createOrganization(db);
    const family = await db.supportTicket.create({ data: { ticketCode: ticketCode(), organizationId: org.id, originLabel: org.name, senderEmail: user.email, target: 'SUPERADMIN', topic: 'PAYMENT', subject: 'No me llega el recibo', message: 'Pagué ayer la donación y todavía no he recibido el recibo.' } });
    const fromOrg = await db.supportTicket.create({ data: { ticketCode: ticketCode(), organizationId: org.id, originLabel: org.name, senderEmail: user.email, target: 'SUPERADMIN', fromOrganization: true, topic: 'PAYMENT', subject: 'Duda con una liquidación', message: 'Necesitamos saber cuándo llegará nuestra liquidación.' } });
    await answerPlatformTicket(db, admin, { ticketCode: family.ticketCode, reply: 'Hemos reenviado el recibo a tu correo.' });
    await answerPlatformTicket(db, admin, { ticketCode: fromOrg.ticketCode, reply: 'Llegará en dos días laborables.' });
    expect((await db.auditLog.findFirstOrThrow({ where: { action: 'support.platform_answered', targetId: String(family.id) } })).organizationId).toBeNull();
    expect((await db.auditLog.findFirstOrThrow({ where: { action: 'support.platform_answered', targetId: String(fromOrg.id) } })).organizationId).toBe(org.id);
  });

  it('la portada de la consola pide el segundo factor de la sesión, como el resto de lecturas (M7)', async () => {
    const noSecondFactor = await loadUserActor(db, (await createUser(db, { isSuperadmin: true, twoFactorEnabled: true })).id, { ipHash: 'h' }, { secondFactor: false });
    await expect(getConsoleOverview(db, noSecondFactor)).rejects.toBeInstanceOf(TenantAccessError);
    expect((await getConsoleOverview(db, admin)).splitsToResolve).toEqual(expect.any(Array));
  });
});
