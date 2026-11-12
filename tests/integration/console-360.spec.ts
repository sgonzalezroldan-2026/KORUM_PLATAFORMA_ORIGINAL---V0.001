import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { donationOrTicketPayinLines } from '@/core/finance/payment-journals';
import { getAccountBalance, postJournal } from '@/core/finance/ledger.service';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { checkExpiredSignerHandovers } from '@/core/jobs/handlers/handover-checks';
import type { JobContext } from '@/core/jobs/job-types';
import { inTransaction } from '@/lib/db';
import { applyChargebackInTx } from '@/services/payments/payment-provider-reversals';
import { raiseAlert } from '@/core/jobs/ops-alerts';
import { SelfBoostNotAllowedError } from '@/core/finance/self-boost';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import type { VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import { getConsoleOrganizations, getInitiativePopup, getOrganization360 } from '@/repositories/console.repository';
import { getPublicImpact, isSelfBoostShown } from '@/repositories/public.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadBiSnapshot } from '@/services/admin/bi-snapshot';
import { requeueFailedEmails } from '@/services/admin/console-alerts.service';
import { KybReviewRejectedError, releaseOrganizationCif, reviewKyb } from '@/services/admin/kyb-review.service';
import { addOrganizationCategory, saveOrganizationTariffs, setOrganizationCategoryRule } from '@/services/admin/org-admin.service';
import { executeSelfBoost, fixNegativeReturnTariff, previewNegativeReturnFix, TariffFixNotNeededError } from '@/services/admin/self-boost.service';
import { payoutCandidates } from '@/services/payments/payout-candidates';
import { seedDatabase } from '@/seed/seed';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_KEYRING, TEST_SCHEMA, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.2 · Pop-up ejecutivo, Auto-Impulso y ficha 360º contra PostgreSQL real (QA-A02, QA-A03). Lo que se prueba: el Auto-Impulso gasta exactamente lo que
 * se vio, una sola vez, con su asiento y sin contar como aportación de familias; la corrección de tarifas no toca lo ya prometido; la revisión del KYB decide
 * una vez y avisa; las tarifas rechazan lo imposible; y todo lo que cambia dinero o precios exige el Super-Admin verificado y queda en la auditoría.
 */

const SECRETS = { hmacSecret: 'integration-data-hmac-secret-0123456789', qrSecret: 'integration-qr-hmac-secret-0123456789ab', keyring: TEST_KEYRING };
const DAY = 86_400_000;

let db: KorumPrismaClient;
let admin: SessionActor;
let verified: VerifiedSuperadminActor;

beforeAll(async () => {
  db = createTestClient();
  await seedDatabase(db, { ...SECRETS, schema: TEST_SCHEMA });
  const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
  admin = await loadUserActor(db, superadmin.id, { ipHash: 'hash-de-ip' }, { secondFactor: true });
  verified = (await verifiedSuperadmin(db)).actor;
}, 600_000);

afterAll(async () => {
  await db.$disconnect();
});

/** Entidad con sus dos personas que firman (para comprobar los avisos). */
async function organizationWithSigners(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, overrides);
  const [director, cosigner] = await Promise.all([createUser(db, { twoFactorEnabled: true }), createUser(db, { twoFactorEnabled: true })]);
  const [directorMember, cosignerMember] = await Promise.all([
    db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR', roleLabel: 'Dirección del centro' } }),
    db.organizationMember.create({ data: { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER', roleLabel: 'Presidencia del AMPA' } })
  ]);
  return { organization, director, cosigner, directorMember, cosignerMember };
}

/** Campaña recaudando con su cobro y su asiento: la hucha tiene exactamente lo recaudado, como en producción. */
async function openCampaign(organizationId: string, goalCents = 100_000, raisedCents = 85_000, overrides: Parameters<typeof createInitiative>[2] = {}) {
  const initiative = await createInitiative(db, organizationId, { status: 'FUNDRAISING', goalCents, raisedCents, totalContributions: 5, firstPayinAt: new Date(), ...overrides });
  const order = uniqueId('KO');
  const contribution = await db.contribution.create({
    data: { organizationId, initiativeId: initiative.id, fiscalYear: 2026, type: 'DONATION', amountCents: raisedCents, totalChargedCents: raisedCents, paymentMethod: 'CARD', paycometOrder: order, paycometAuthCode: 'A12345', status: 'COMPLETED', guestEmail: 'familia@correo.example', canonicalEmail: 'familia@correo.example' }
  });
  const scope = { organizationId, initiativeId: initiative.id };
  await postJournal(db, {
    ...scope,
    idempotencyKey: `test:payin:${order}`,
    kind: 'PAYIN_DONATION',
    description: `Cobro ${order}`,
    contributionId: contribution.id,
    lines: donationOrTicketPayinLines(scope, { type: 'DONATION', amountCents: raisedCents, guaranteeCents: 0, serviceFeeCents: 0, totalChargedCents: raisedCents })
  });
  return { initiative, contribution };
}

const escrowOf = async (organizationId: string, initiativeId: number) => (await getAccountBalance(db, 'INITIATIVE_ESCROW', { organizationId, initiativeId })).balanceCents;

describe('QA-A02 · Auto-Impulso de KORUM', () => {
  it('aporta justo lo que falta: asiento, aportación SELF_BOOST, meta lograda, avisos y auditoría en una sola transacción', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    const result = await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: false, acceptLoss: true });
    expect(result).toMatchObject({ amountCents: 15_000, publiclyDisclosed: false });

    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(after).toMatchObject({ raisedCents: 100_000, status: 'GOAL_REACHED', stepIndex: 5 });
    // Suma +1 al 💛 como cualquier aportación (decisión del 2026-11-12), pero KORUM no pertenece a ningún curso.
    expect(after.totalContributions).toBe(6);
    expect(await db.initiativeCourseProgress.count({ where: { initiativeId: initiative.id } })).toBe(0);

    const boost = await db.contribution.findUniqueOrThrow({ where: { id: result.contributionId } });
    expect(boost).toMatchObject({ type: 'SELF_BOOST', status: 'COMPLETED', amountCents: 15_000, publiclyDisclosed: false, paymentMethod: 'PLATFORM', userId: null, guestEmail: null, paycometOrder: `KB-${initiative.id}-1` });

    // El libro: la hucha recibe 15.000 y el gasto de KORUM los asienta; el cuadre de la caché con el libro se mantiene.
    expect(await escrowOf(organization.id, initiative.id)).toBe(100_000);
    const journal = await db.ledgerJournal.findFirstOrThrow({ where: { initiativeId: initiative.id, kind: 'SELF_BOOST_INJECTION' }, include: { entries: true } });
    expect(journal.contributionId).toBe(boost.id);
    expect(journal.entries.map((entry) => `${entry.account}:${entry.direction}:${entry.amountCents}`).sort()).toEqual(['AUTO_BOOST_EXPENSE:DEBIT:15000', 'INITIATIVE_ESCROW:CREDIT:15000']);
    expect((await getAccountBalance(db, 'AUTO_BOOST_EXPENSE', { organizationId: organization.id })).balanceCents).toBe(15_000);

    // Quien firma sabe al instante que toca liquidar, y la ejecución queda registrada con quién y cuánto.
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'initiative.goalReached' } })).toBe(2);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'selfboost.executed', targetId: String(initiative.id) } });
    expect(audit).toMatchObject({ actorUserId: verified.userId, organizationId: organization.id });
    expect(audit.metadataJson).toMatchObject({ amountCents: 15_000, publiclyDisclosed: false, contributionId: boost.id });
  });

  it('si la campaña con Auto-Impulso se reabre por un contracargo y vence, el Auto-Impulso vuelve a KORUM con su contra-asiento: no queda dinero huérfano en la hucha', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    const { contributionId } = await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true });
    expect(await isSelfBoostShown(db, initiative.id)).toBe(true);
    // Un contracargo de 10.000 € devuelve la campaña a recaudar y su plazo ya pasó (se simula el estado que dejaría).
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'FUNDRAISING', raisedCents: 90_000, closesAt: new Date(Date.now() - DAY) } });

    const context: JobContext = { db, now: new Date(), batchSize: 50, deps: {} as unknown as JobContext['deps'] };
    await campaignExpiryHandler(context);

    const after = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    // Lo recaudado vuelve a ser solo dinero de las personas.
    expect(after).toMatchObject({ status: 'EXPIRED', raisedCents: 75_000 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contributionId } })).toMatchObject({ status: 'REFUNDED', type: 'SELF_BOOST', refundedCents: 15_000 });
    expect((await db.contribution.findUniqueOrThrow({ where: { id: contributionId } })).refundedAt).not.toBeNull();
    expect(await isSelfBoostShown(db, initiative.id)).toBe(false);
    // El 💛 que sumó el Auto-Impulso se quita al devolverse (de 6 a 5).
    expect(after.totalContributions).toBe(5);
    // El libro: un contra-asiento deshace el asiento del Auto-Impulso, la hucha pierde los 15.000 y el gasto de KORUM vuelve a 0.
    expect(await escrowOf(organization.id, initiative.id)).toBe(85_000);
    expect((await getAccountBalance(db, 'AUTO_BOOST_EXPENSE', { organizationId: organization.id })).balanceCents).toBe(0);
    const original = await db.ledgerJournal.findFirstOrThrow({ where: { initiativeId: initiative.id, kind: 'SELF_BOOST_INJECTION' } });
    const reversal = await db.ledgerJournal.findFirstOrThrow({ where: { reversesJournalId: original.id }, include: { entries: true } });
    expect(reversal.kind).toBe('REVERSAL');
    expect(reversal.entries.map((entry) => `${entry.account}:${entry.direction}:${entry.amountCents}`).sort()).toEqual(['AUTO_BOOST_EXPENSE:CREDIT:15000', 'INITIATIVE_ESCROW:DEBIT:15000']);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'initiative.expired', targetId: String(initiative.id) } });
    expect(audit.metadataJson).toMatchObject({ raisedCents: 75_000, selfBoostReturnedCents: 15_000 });

    // Repetir la tarea no devuelve nada más (ya no está en FUNDRAISING) y el contra-asiento es único.
    await campaignExpiryHandler(context);
    expect(await escrowOf(organization.id, initiative.id)).toBe(85_000);
    expect(await db.ledgerJournal.count({ where: { reversesJournalId: original.id } })).toBe(1);
  });

  it('una campaña vencida sin Auto-Impulso no cambia: nada que devolver', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { closesAt: new Date(Date.now() - DAY) });
    await campaignExpiryHandler({ db, now: new Date(), batchSize: 50, deps: {} as unknown as JobContext['deps'] });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'EXPIRED', raisedCents: 85_000 });
    expect(await db.ledgerJournal.count({ where: { initiativeId: initiative.id, kind: 'REVERSAL' } })).toBe(0);
    expect(await escrowOf(organization.id, initiative.id)).toBe(85_000);
  });

  it('un doble clic o dos personas a la vez: solo se aporta una vez', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    const results = await Promise.allSettled([
      executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true }),
      executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SelfBoostNotAllowedError);
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, type: 'SELF_BOOST' } })).toBe(1);
    expect(await escrowOf(organization.id, initiative.id)).toBe(100_000);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).raisedCents).toBe(100_000);
  });

  it('si lo que faltaba cambió mientras se miraba la ficha, no se gasta nada', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    // Llegó otra aportación de 50 € entre medias.
    await db.initiative.update({ where: { id: initiative.id }, data: { raisedCents: 90_000 } });
    await expect(executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true })).rejects.toMatchObject({ reason: 'AMOUNT_CHANGED' });
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, type: 'SELF_BOOST' } })).toBe(0);
    expect(await db.ledgerJournal.count({ where: { initiativeId: initiative.id, kind: 'SELF_BOOST_INJECTION' } })).toBe(0);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('FUNDRAISING');
  });

  it.each([
    ['en borrador', { status: 'BUDGETING' as const }, 'NOT_FUNDRAISING'],
    ['ya lograda', { status: 'GOAL_REACHED' as const }, 'NOT_FUNDRAISING'],
    ['devuelta', { status: 'REFUNDED' as const }, 'NOT_FUNDRAISING'],
    ['pasada su fecha límite', { closesAt: new Date(Date.now() - DAY) }, 'PAST_DEADLINE']
  ])('una campaña %s no recibe Auto-Impulso', async (_name, overrides, reason) => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, overrides);
    await expect(executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true })).rejects.toMatchObject({ reason });
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, type: 'SELF_BOOST' } })).toBe(0);
  });

  it('el servidor recalcula la rentabilidad: sin aceptar la pérdida no se aporta a una campaña que no compensa; compensando, no hace falta (auditoría financiera, I3)', async () => {
    const { organization } = await organizationWithSigners();
    const losing = await openCampaign(organization.id);
    await expect(executeSelfBoost(db, verified, { initiativeId: losing.initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true })).rejects.toMatchObject({ reason: 'NOT_PROFITABLE' });
    expect(await db.contribution.count({ where: { initiativeId: losing.initiative.id, type: 'SELF_BOOST' } })).toBe(0);
    expect(await escrowOf(organization.id, losing.initiative.id)).toBe(85_000);

    // Con 300 € de comisión por tramos que se liquidan al completar la meta, aportar 150 € compensa (+150 €).
    const paying = await openCampaign(organization.id, 100_000, 85_000, { bracketFeeCents: 30_000 });
    await executeSelfBoost(db, verified, { initiativeId: paying.initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'selfboost.executed', targetId: String(paying.initiative.id) } });
    expect(audit.metadataJson).toMatchObject({ profitable: true, lossAccepted: false });
  });

  it('una entidad archivada no recibe Auto-Impulso', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    await db.organization.update({ where: { id: organization.id }, data: { archivedAt: new Date() } });
    await expect(executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true })).rejects.toMatchObject({ reason: 'ORG_ARCHIVED' });
  });

  it('el BI cuenta el Auto-Impulso ya gastado también en la fila abierta: la pérdida no espera al cierre y Σ fuentes − costes sigue siendo el neto (auditoría financiera, I2)', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { bracketFeeCents: 20_000 });
    const rowOf = async () => (await loadBiSnapshot(db, { organizationId: organization.id })).initiatives.find((row) => row.id === initiative.id)!;
    const before = await rowOf();
    await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: false, acceptLoss: true });
    const after = await rowOf();
    expect(after.status).toBe('GOAL_REACHED');
    // El neto proyectado baja justo lo gastado.
    expect(after.netRevenueCents).toBe(before.netRevenueCents - 15_000);
    const sources = Object.values(after.sourcesCents).reduce((total, cents) => total + cents, 0);
    expect(sources - after.gatewayLossCents - after.sunkCostsCents).toBe(after.netRevenueCents);
    // Lo gastado va en su propio campo, no disfrazado de coste de pasarela (auditoría financiera del 5.2).
    expect(after.sunkCostsCents).toBeGreaterThanOrEqual(15_000);
    expect(after.gatewayLossCents).toBe(before.gatewayLossCents);
  });

  it('el 💎 de una campaña reabierta descuenta el Auto-Impulso anterior, que volvería a KORUM si la campaña fracasa: el servidor tampoco la da por rentable (ejemplo del promotor, 2026-11-12)', async () => {
    const { organization } = await organizationWithSigners();
    // Meta 1.000 €, 850 € recaudados y 200 € de comisión por tramos: aportar los 150 € que faltan compensa (+50 €).
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { bracketFeeCents: 20_000 });
    const control = await openCampaign(organization.id, 100_000, 85_000, { bracketFeeCents: 20_000 });
    await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: false });
    // Un contracargo de 120 € la reabre (se simula el estado que deja): faltan 120 €. La otra campaña, igual pero sin Auto-Impulso anterior.
    const reopen = (id: number) => db.initiative.update({ where: { id }, data: { status: 'FUNDRAISING', raisedCents: 88_000, closesAt: new Date(Date.now() + 20 * DAY) } });
    await reopen(initiative.id);
    await reopen(control.initiative.id);
    const rows = (await loadBiSnapshot(db, { organizationId: organization.id })).initiatives;
    // Sin Auto-Impulso anterior: «Aportar 120 € ➔ Retorno +80 €».
    expect(rows.find((row) => row.id === control.initiative.id)).toMatchObject({ missingTo100Cents: 12_000, netProfitAfterBoostCents: 8_000, recoverableSelfBoostCents: 0, isProfitableSelfBoost: true });
    // Con él: aportar deja 200 − 120 − 150 = −70 €; no aportar recupera los 150 € si la campaña vence. No compensa.
    expect(rows.find((row) => row.id === initiative.id)).toMatchObject({ missingTo100Cents: 12_000, netProfitAfterBoostCents: -7_000, recoverableSelfBoostCents: 15_000, isProfitableSelfBoost: false });
    // El servidor recalcula lo mismo: sin aceptar la pérdida no se gasta ni un euro más; la campaña sin Auto-Impulso anterior sí se completa.
    await expect(executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 12_000, publiclyDisclosed: false })).rejects.toMatchObject({ reason: 'NOT_PROFITABLE' });
    expect((await db.contribution.count({ where: { initiativeId: initiative.id, type: 'SELF_BOOST', status: 'COMPLETED' } }))).toBe(1);
    await executeSelfBoost(db, verified, { initiativeId: control.initiative.id, expectedAmountCents: 12_000, publiclyDisclosed: false });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: control.initiative.id } })).status).toBe('GOAL_REACHED');

    // Si la campaña vence, el Auto-Impulso vuelve a KORUM y el 💎 deja de descontarlo (la campaña ya no recauda).
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() - DAY) } });
    await campaignExpiryHandler({ db, now: new Date(), batchSize: 50, deps: {} as unknown as JobContext['deps'] });
    const expired = (await loadBiSnapshot(db, { organizationId: organization.id })).initiatives.find((row) => row.id === initiative.id)!;
    expect(expired).toMatchObject({ status: 'EXPIRED', recoverableSelfBoostCents: 0, isProfitableSelfBoost: false });
  });

  it('«Corregir tarifas» tampoco se acepta en el servidor cuando el negativo lo explica un Auto-Impulso ya gastado: subir tarifas no lo arregla (auditoría financiera del 5.2, H1)', async () => {
    // Con tarifas propias por debajo de las globales: sin la guarda del servidor, la corrección SÍ las subiría (y la prueba lo notaría).
    const { organization } = await organizationWithSigners({ customRules: true, fullIntegrityCheckCents: 0 });
    // Comisión de 100 €: aportar 150 € no compensa, pero se acepta la pérdida. Tras un contracargo la campaña vuelve a recaudar.
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { bracketFeeCents: 10_000 });
    await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: false, acceptLoss: true });
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'FUNDRAISING', raisedCents: 88_000, closesAt: new Date(Date.now() + 20 * DAY) } });
    const row = (await loadBiSnapshot(db, { organizationId: organization.id })).initiatives.find((candidate) => candidate.id === initiative.id)!;
    expect(row).toMatchObject({ isNegativeReturnAlert: true, sunkCostsCents: 15_000 });
    // Sin lo ya gastado el neto sería positivo: no hay nada que corregir en las tarifas.
    expect(row.netRevenueCents + row.sunkCostsCents).toBeGreaterThanOrEqual(0);
    await expect(fixNegativeReturnTariff(db, verified, initiative.id)).rejects.toBeInstanceOf(TariffFixNotNeededError);
    // Y no se tocó nada: ni las tarifas de la entidad ni un registro de corrección.
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { fullIntegrityCheckCents: true } })).fullIntegrityCheckCents).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'tariff.negative_return_fixed', targetId: String(initiative.id) } })).toBe(0);
  });

  it('una iniciativa que no existe se rechaza sin tocar nada', async () => {
    await expect(executeSelfBoost(db, verified, { initiativeId: 2_000_000_000, expectedAmountCents: 100, publiclyDisclosed: true, acceptLoss: true })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('exige el Super-Admin verificado: un actor inventado o una persona sin rol no gasta dinero de KORUM', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    const forged = { kind: 'verified-superadmin', userId: verified.userId, sessionId: verified.sessionId } as VerifiedSuperadminActor;
    await expect(executeSelfBoost(db, forged, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true })).rejects.toBeInstanceOf(SuperadminRequiredError);
    await expect(fixNegativeReturnTariff(db, forged, initiative.id)).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, type: 'SELF_BOOST' } })).toBe(0);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).raisedCents).toBe(85_000);
  });

  it('lo que se muestra en público lo decide cada ejecución: oculto no se dice que la plataforma ayudó; mostrado, sí (siempre sin importe)', async () => {
    const hidden = await organizationWithSigners();
    const shown = await organizationWithSigners();
    const [a, b] = await Promise.all([openCampaign(hidden.organization.id), openCampaign(shown.organization.id)]);
    await executeSelfBoost(db, verified, { initiativeId: a.initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: false, acceptLoss: true });
    await executeSelfBoost(db, verified, { initiativeId: b.initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true });
    expect(await isSelfBoostShown(db, a.initiative.id)).toBe(false);
    expect(await isSelfBoostShown(db, b.initiative.id)).toBe(true);
  });

  it('la barra de impacto de la portada cuenta el Auto-Impulso y coincide con la ficha, se muestre o no (decisión del promotor, 2026-11-12)', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    const before = await getPublicImpact(db, organization.slug);
    expect(before.raisedCents).toBe(85_000);
    await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true });
    const after = await getPublicImpact(db, organization.slug);
    // La campaña llega al 100 % y la barra de impacto suma exactamente lo mismo que la ficha: nunca dos cifras distintas.
    expect(after.raisedCents).toBe(100_000);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).raisedCents).toBe(100_000);
  });

  it('la liquidación puede repartir desde el Auto-Impulso: es origen del reparto y nunca más de lo aportado', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative, contribution } = await openCampaign(organization.id);
    const { contributionId } = await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true });
    const candidates = await payoutCandidates(db, initiative.id, 0);
    expect(candidates.find((candidate) => candidate.contributionId === contributionId)?.totalChargedCents).toBe(15_000);
    expect(candidates.find((candidate) => candidate.contributionId === contribution.id)?.totalChargedCents).toBe(85_000);
    expect(candidates.reduce((total, candidate) => total + candidate.totalChargedCents, 0)).toBe(100_000);
  });

  it('un contracargo que reabre la campaña permite otro Auto-Impulso con su propia referencia', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    // Un Auto-Impulso anterior ya asentado (sin su gasto en el libro, para que la campaña siga sin 🚨) y la campaña vuelve a recaudar con 5 € menos.
    await db.contribution.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'SELF_BOOST', amountCents: 15_000, totalChargedCents: 15_000, paymentMethod: 'PLATFORM', paycometOrder: `KB-${initiative.id}-1`, paycometAuthCode: 'KORUM', status: 'COMPLETED' }
    });
    await db.initiative.update({ where: { id: initiative.id }, data: { status: 'FUNDRAISING', raisedCents: 99_500 } });
    const second = await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 500, publiclyDisclosed: false, acceptLoss: true });
    const orders = (await db.contribution.findMany({ where: { initiativeId: initiative.id, type: 'SELF_BOOST' }, orderBy: { id: 'asc' }, select: { paycometOrder: true } })).map((row) => row.paycometOrder);
    expect(orders).toEqual([`KB-${initiative.id}-1`, `KB-${initiative.id}-2`]);
    expect(second.amountCents).toBe(500);
  });
});

describe('QA-A02 · pop-up ejecutivo y corrección de tarifas en 1 clic', () => {
  it('la ficha de una iniciativa da los mismos números que la tabla y lleva su enlace público, comercios y el Auto-Impulso posible', async () => {
    const popup = await getInitiativePopup(db, admin, 1);
    expect(popup).not.toBeNull();
    expect(popup!.row).toMatchObject({ id: 1, status: 'FUNDRAISING', isProfitableSelfBoost: true, missingTo100Cents: 15_000 });
    expect(popup!.publicPath).toBe(`/${popup!.row.organizationSlug}/iniciativas/1`);
    expect(popup!.boost.availableCents).toBe(15_000);
    expect(['SHOW', 'HIDE']).toContain(popup!.boost.defaultDisclosure);
    expect(popup!.sponsors.length).toBeGreaterThan(0);
    for (const sponsor of popup!.sponsors) expect(Object.keys(sponsor).sort()).toEqual(['amountCents', 'categoryLevel', 'feeCents', 'id', 'isMatchingPool', 'name', 'status']);
    expect(await getInitiativePopup(db, admin, 2_000_000_000)).toBeNull();
  });

  it('solo el Super-Admin abre la ficha: cualquier otra sesión se deniega y queda registrada', async () => {
    const stranger = await createUser(db);
    const actor = await loadUserActor(db, stranger.id, { ipHash: 'otro' }, { secondFactor: true });
    await expect(getInitiativePopup(db, actor, 1)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getOrganization360(db, actor, 'CERVANTES')).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getConsoleOrganizations(db, { kind: 'anonymous' })).rejects.toBeInstanceOf(TenantAccessError);
    // Un Super-Admin cuya sesión no superó el segundo factor tampoco abre la ficha por la acción de servidor.
    const noFactor = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await expect(getInitiativePopup(db, await loadUserActor(db, noFactor.id, { ipHash: 'sin-factor' }, { secondFactor: false }), 1)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.auditLog.count({ where: { actorUserId: stranger.id, action: 'tenant.access_denied' } })).toBeGreaterThanOrEqual(2);
  });

  it('con la cobertura de pasarela de una campaña publicada no se toca: no hay nada que corregir y no cambia ni una fila', async () => {
    const { organization } = await organizationWithSigners({ customRules: false });
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { absorbsGatewayCostByKorum: true, gatewayFeeCents: 6_250 });
    const plan = await previewNegativeReturnFix(db, initiative.id);
    expect(plan).toMatchObject({ publishedLeftUntouched: true });
    await expect(fixNegativeReturnTariff(db, verified, initiative.id)).rejects.toBeInstanceOf(TariffFixNotNeededError);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).absorbsGatewayCostByKorum).toBe(true);
    expect(await db.auditLog.count({ where: { action: 'tariff.negative_return_fixed', targetId: String(initiative.id) } })).toBe(0);
  });

  it('con tarifa propia por debajo de las globales la sube para las próximas campañas, pero la campaña publicada queda como estaba', async () => {
    const { organization } = await organizationWithSigners({ customRules: true, fullIntegrityCheckCents: 0, ticketFeeFixedCents: 10, ticketFeeBps: 300 });
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { absorbsGatewayCostByKorum: true, gatewayFeeCents: 6_250 });
    const global = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } });
    const plan = await fixNegativeReturnTariff(db, verified, initiative.id);
    expect(plan.organization).toEqual({ fullIntegrityCheckCents: global.fullIntegrityCheckCents, ticketFeeFixedCents: global.ticketFeeFixedCents });
    const org = await db.organization.findUniqueOrThrow({ where: { id: organization.id } });
    // Sube lo que estaba por debajo; lo que ya era mayor que el global (300 > 200) no se baja.
    expect(org).toMatchObject({ fullIntegrityCheckCents: global.fullIntegrityCheckCents, ticketFeeFixedCents: global.ticketFeeFixedCents, ticketFeeBps: 300 });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).absorbsGatewayCostByKorum).toBe(true);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'tariff.negative_return_fixed', targetId: String(initiative.id) } });
    expect(audit.metadataJson).toMatchObject({ organizationBefore: { fullIntegrityCheckCents: 0, ticketFeeFixedCents: 10, ticketFeeBps: 300 }, publishedLeftUntouched: true });
    // Repetirlo ya no hace nada.
    await expect(fixNegativeReturnTariff(db, verified, initiative.id)).rejects.toBeInstanceOf(TariffFixNotNeededError);
  });

  it('un borrador no tiene 🚨, así que el botón no actúa sobre él ni toca su cobertura de pasarela, y una campaña que no pierde dinero no cambia las tarifas de su entidad', async () => {
    const { organization } = await organizationWithSigners({ customRules: true, fullIntegrityCheckCents: 0 });
    const draft = await createInitiative(db, organization.id, { status: 'BUDGETING', absorbsGatewayCostByKorum: true });
    await expect(fixNegativeReturnTariff(db, verified, draft.id)).rejects.toBeInstanceOf(TariffFixNotNeededError);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: draft.id } })).absorbsGatewayCostByKorum).toBe(true);
    // Una campaña abierta que no pierde dinero (sin cobertura de pasarela) tampoco toca las tarifas de la entidad (auditoría financiera, M3).
    const fine = await openCampaign(organization.id, 100_000, 85_000, { absorbsGatewayCostByKorum: false });
    await expect(fixNegativeReturnTariff(db, verified, fine.initiative.id)).rejects.toBeInstanceOf(TariffFixNotNeededError);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).fullIntegrityCheckCents).toBe(0);
  });

  it('con una taquilla a la venta, la corrección no toca los gastos de gestión de las entradas de la entidad (la compra lee la tarifa actual): auditoría financiera, B1', async () => {
    const { organization } = await organizationWithSigners({ customRules: true, fullIntegrityCheckCents: 0, ticketFeeFixedCents: 0, ticketFeeBps: 0 });
    await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketPriceCents: 1_000, ticketMax: 50 });
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { absorbsGatewayCostByKorum: true, gatewayFeeCents: 6_250 });
    const global = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } });
    const plan = await fixNegativeReturnTariff(db, verified, initiative.id);
    expect(plan.organization).toEqual({ fullIntegrityCheckCents: global.fullIntegrityCheckCents });
    expect(plan.publishedLeftUntouched).toBe(true);
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ ticketFeeFixedCents: 0, ticketFeeBps: 0 });
  });
});

describe('QA-A03 · tarifas y categorías de una entidad', () => {
  it('guarda la tarifa propia con el antes y el después, y el cupo exento se mueve lo mismo', async () => {
    const { organization } = await organizationWithSigners({ exemptLimitCents: 100_000, exemptRemainingCents: 40_000 });
    await saveOrganizationTariffs(db, verified, organization.id, {
      customRules: true,
      exemptLimitCents: 150_000,
      t1Bps: 450,
      t2Bps: 350,
      t3Bps: 250,
      sponsorFeeBps: 1_200,
      fullIntegrityCheckCents: 200,
      ticketFeeFixedCents: 50,
      ticketFeeBps: 250,
      maintActive: true,
      maintPerInitCents: 3_000,
      maintAnnualCapCents: 9_000
    });
    const after = await db.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(after).toMatchObject({ customRules: true, exemptLimitCents: 150_000, exemptRemainingCents: 90_000, t1Bps: 450, sponsorFeeBps: 1_200, maintActive: true, maintAnnualCapCents: 9_000 });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'organization.tariffs_updated', organizationId: organization.id } });
    expect(audit.metadataJson).toMatchObject({ before: { customRules: false, exemptLimitCents: 100_000, exemptRemainingCents: 40_000 }, after: { customRules: true, exemptLimitCents: 150_000, exemptRemainingCents: 90_000 } });
  });

  it.each([
    ['decimales', { t1Bps: 4.5 }],
    ['un negativo', { sponsorFeeBps: -1 }],
    ['texto', { ticketFeeBps: '200' }],
    ['más del 100 %', { t3Bps: 10_001 }],
    ['un tope de mantenimiento imposible', { maintAnnualCapCents: 1_000_000_000 }]
  ])('rechaza %s y no cambia ni una fila ni deja auditoría', async (_name, patch) => {
    const { organization } = await organizationWithSigners();
    const valid = { customRules: true, exemptLimitCents: 100_000, t1Bps: 500, t2Bps: 400, t3Bps: 300, sponsorFeeBps: 1_500, fullIntegrityCheckCents: 180, ticketFeeFixedCents: 45, ticketFeeBps: 200, maintActive: false, maintPerInitCents: 4_900, maintAnnualCapCents: 14_700 };
    await expect(saveOrganizationTariffs(db, verified, organization.id, { ...valid, ...patch })).rejects.toMatchObject({ reason: 'INVALID' });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).customRules).toBe(false);
    expect(await db.auditLog.count({ where: { action: 'organization.tariffs_updated', organizationId: organization.id } })).toBe(0);
  });

  const OWN_TARIFF = { customRules: true as const, exemptLimitCents: 100_000, t1Bps: 500, t2Bps: 400, t3Bps: 300, sponsorFeeBps: 1_500, fullIntegrityCheckCents: 180, ticketFeeFixedCents: 45, ticketFeeBps: 200, maintActive: false, maintPerInitCents: 4_900, maintAnnualCapCents: 14_700 };

  it('con una taquilla o rifa a la venta no se cambian los gastos de gestión de las entradas, ni a mano ni volviendo a los valores globales; el resto sí (auditoría financiera, B1)', async () => {
    const { organization } = await organizationWithSigners({ customRules: true, ticketFeeFixedCents: 0, ticketFeeBps: 0 });
    await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketPriceCents: 1_000, ticketMax: 50 });
    await expect(saveOrganizationTariffs(db, verified, organization.id, { ...OWN_TARIFF, ticketFeeFixedCents: 65 })).rejects.toMatchObject({ reason: 'PUBLISHED_TICKETING' });
    await expect(saveOrganizationTariffs(db, verified, organization.id, { customRules: false })).rejects.toMatchObject({ reason: 'PUBLISHED_TICKETING' });
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ ticketFeeFixedCents: 0, ticketFeeBps: 0, customRules: true });
    // Dejando los gastos de gestión como están, el resto de la tarifa sí se guarda.
    await saveOrganizationTariffs(db, verified, organization.id, { ...OWN_TARIFF, ticketFeeFixedCents: 0, ticketFeeBps: 0, t1Bps: 450 });
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ t1Bps: 450, ticketFeeFixedCents: 0 });
  });

  it('el límite exento nunca crea cupo de la nada: bajar por debajo de lo gastado se rechaza, y bajar y volver a subir deja el mismo cupo (auditoría financiera, I4)', async () => {
    const { organization } = await organizationWithSigners({ exemptLimitCents: 100_000, exemptRemainingCents: 30_000 });
    await expect(saveOrganizationTariffs(db, verified, organization.id, { ...OWN_TARIFF, exemptLimitCents: 20_000 })).rejects.toMatchObject({ reason: 'LIMIT_BELOW_USED' });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(30_000);
    await saveOrganizationTariffs(db, verified, organization.id, { ...OWN_TARIFF, exemptLimitCents: 70_000 });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(0);
    await saveOrganizationTariffs(db, verified, organization.id, { ...OWN_TARIFF, exemptLimitCents: 100_000 });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(30_000);
  });

  it('apagar la tarifa propia iguala la entidad a los valores globales', async () => {
    const { organization } = await organizationWithSigners({ customRules: true, t1Bps: 1, sponsorFeeBps: 9_999, ticketFeeBps: 7 });
    await saveOrganizationTariffs(db, verified, organization.id, { customRules: false });
    const global = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } });
    const after = await db.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(after).toMatchObject({ customRules: false, t1Bps: global.t1Bps, sponsorFeeBps: global.sponsorFeeBps, ticketFeeBps: global.ticketFeeBps, maintAnnualCapCents: global.maintAnnualCapCents });
  });

  it('una entidad archivada o inexistente no se toca, y sin el Super-Admin verificado no se guarda nada', async () => {
    const archived = await createOrganization(db, { archivedAt: new Date() });
    await expect(saveOrganizationTariffs(db, verified, archived.id, { customRules: false })).rejects.toMatchObject({ reason: 'ARCHIVED' });
    await expect(saveOrganizationTariffs(db, verified, 'no-existe', { customRules: false })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const forged = { kind: 'verified-superadmin', userId: verified.userId, sessionId: verified.sessionId } as VerifiedSuperadminActor;
    await expect(saveOrganizationTariffs(db, forged, archived.id, { customRules: false })).rejects.toBeInstanceOf(SuperadminRequiredError);
  });

  it('una categoría global con otra regla crea la fila propia de la entidad; una propia nueva no puede repetir una global', async () => {
    const global = await db.globalCategory.upsert({ where: { name: 'Patios y Deporte' }, update: {}, create: { name: 'Patios y Deporte', icon: '🌳', rule: 'BRACKETS' } });
    const { organization } = await organizationWithSigners();
    await setOrganizationCategoryRule(db, verified, organization.id, { name: 'Patios y Deporte', rule: 'EXEMPT' });
    expect(await db.organizationCategory.findUniqueOrThrow({ where: { organizationId_name: { organizationId: organization.id, name: 'Patios y Deporte' } } })).toMatchObject({ rule: 'EXEMPT', isCustom: false, icon: global.icon });
    // Volver a cambiarla actualiza la misma fila.
    await setOrganizationCategoryRule(db, verified, organization.id, { name: 'Patios y Deporte', rule: 'BRACKETS' });
    expect(await db.organizationCategory.count({ where: { organizationId: organization.id } })).toBe(1);

    await addOrganizationCategory(db, verified, organization.id, { name: 'Huerto escolar', rule: 'EXEMPT' });
    await expect(addOrganizationCategory(db, verified, organization.id, { name: 'Huerto escolar', rule: 'EXEMPT' })).rejects.toMatchObject({ reason: 'CATEGORY_EXISTS' });
    await expect(addOrganizationCategory(db, verified, organization.id, { name: 'Patios y Deporte', rule: 'EXEMPT' })).rejects.toMatchObject({ reason: 'CATEGORY_EXISTS' });
    await expect(setOrganizationCategoryRule(db, verified, organization.id, { name: 'No existe esta', rule: 'EXEMPT' })).rejects.toMatchObject({ reason: 'CATEGORY_NOT_FOUND' });

    const view = (await getOrganization360(db, admin, organization.id))!;
    expect(view.categories.find((category) => category.name === 'Patios y Deporte')).toMatchObject({ source: 'OVERRIDE', rule: 'BRACKETS' });
    expect(view.categories.find((category) => category.name === 'Huerto escolar')).toMatchObject({ source: 'CUSTOM', rule: 'EXEMPT' });
  });
});

const KINDS = ['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP', 'LEY49_ACCREDITATION'] as const;

async function submittedOrganization(kinds: readonly (typeof KINDS)[number][] = KINDS, overrides: Parameters<typeof createOrganization>[1] = {}) {
  const team = await organizationWithSigners({ kybStatus: 'SUBMITTED', kybSubmittedAt: new Date(), ley49: true, cif: `G${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, ...overrides });
  for (const kind of kinds) {
    const file = await db.fileAsset.create({ data: { bucket: 'private', objectKey: uniqueId(`kyb/${kind}`), visibility: 'PRIVATE', purpose: 'KYB_DOCUMENT', mimeType: 'application/pdf', sizeBytes: 1_000, sha256: 'a'.repeat(64), organizationId: team.organization.id } });
    await db.kybDocument.create({ data: { organizationId: team.organization.id, kind, fileId: file.id } });
  }
  return team;
}

describe('QA-A03 · revisión del KYB por el Super-Admin', () => {
  it('verificar: estado, quién y cuándo, Ley 49/2002 acreditada, cuenta destino y aviso a las dos firmas', async () => {
    const { organization } = await submittedOrganization();
    const result = await reviewKyb(db, verified, organization.id, { decision: 'VERIFIED', ley49Accredited: true, paycometSplitId: uniqueId('split') });
    expect(result).toEqual({ decision: 'VERIFIED', cifReleased: false });
    const after = await db.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(after).toMatchObject({ kybStatus: 'VERIFIED', kybReviewedById: verified.userId, kybReviewNote: null });
    expect(after.kybReviewedAt).not.toBeNull();
    expect(after.ley49VerifiedAt).not.toBeNull();
    expect(after.paycometSplitId).not.toBeNull();
    const mail = await db.outboxMessage.findMany({ where: { organizationId: organization.id, templateKey: 'org.kybStatus' } });
    expect(mail).toHaveLength(2);
    expect(mail[0]!.payloadJson).toEqual({ stage: 'VERIFIED', ley49: 'VERIFIED' });
    expect(await db.auditLog.count({ where: { action: 'kyb.verified', organizationId: organization.id } })).toBe(1);
  });

  it('verificar sin acreditar la Ley 49/2002 deja la entidad con justificante nominativo y lo dice en el aviso', async () => {
    const { organization } = await submittedOrganization();
    await reviewKyb(db, verified, organization.id, { decision: 'VERIFIED', ley49Accredited: false });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).ley49VerifiedAt).toBeNull();
    expect((await db.outboxMessage.findFirstOrThrow({ where: { organizationId: organization.id, templateKey: 'org.kybStatus' } })).payloadJson).toEqual({ stage: 'VERIFIED', ley49: 'NOT_ACCREDITED' });
  });

  it('devolver: nota para la entidad, CIF liberado si se pide, aviso con la nota y sin datos de nadie en la auditoría', async () => {
    const { organization } = await submittedOrganization();
    const note = 'Falta la página con la firma del acta fundacional';
    expect(await reviewKyb(db, verified, organization.id, { decision: 'REJECTED', note, releaseCif: true })).toEqual({ decision: 'REJECTED', cifReleased: true });
    const after = await db.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(after).toMatchObject({ kybStatus: 'REJECTED', kybReviewNote: note, cif: null, kybReviewedById: verified.userId });
    expect((await db.outboxMessage.findFirstOrThrow({ where: { organizationId: organization.id, templateKey: 'org.kybStatus' } })).payloadJson).toEqual({ stage: 'REJECTED', note });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'kyb.rejected', organizationId: organization.id } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('acta');
  });

  it('una nota con un email o un DNI se rechaza y la entidad sigue esperando revisión', async () => {
    const { organization } = await submittedOrganization();
    await expect(reviewKyb(db, verified, organization.id, { decision: 'REJECTED', note: 'Escribid a afa@sol.example con el acta', releaseCif: false })).rejects.toMatchObject({ reason: 'INVALID' });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).kybStatus).toBe('SUBMITTED');
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'org.kybStatus' } })).toBe(0);
  });

  it('solo decide una persona: la segunda decisión, a la vez o después, se rechaza y no avisa dos veces', async () => {
    const { organization } = await submittedOrganization();
    const results = await Promise.allSettled([
      reviewKyb(db, verified, organization.id, { decision: 'VERIFIED', ley49Accredited: true }),
      reviewKyb(db, verified, organization.id, { decision: 'REJECTED', note: 'Falta la firma del acta', releaseCif: false })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(KybReviewRejectedError);
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'org.kybStatus' } })).toBe(2);
    await expect(reviewKyb(db, verified, organization.id, { decision: 'VERIFIED', ley49Accredited: true })).rejects.toMatchObject({ reason: 'NOT_SUBMITTED' });
  });

  it('no se verifica con documentos o CIF que faltan, ni se acredita una Ley 49/2002 que no se declaró', async () => {
    const missing = await submittedOrganization(['TAX_ID_CARD', 'STATUTES']);
    await expect(reviewKyb(db, verified, missing.organization.id, { decision: 'VERIFIED', ley49Accredited: false })).rejects.toMatchObject({ reason: 'INCOMPLETE' });
    const noCif = await submittedOrganization(KINDS, { cif: null });
    await expect(reviewKyb(db, verified, noCif.organization.id, { decision: 'VERIFIED', ley49Accredited: true })).rejects.toMatchObject({ reason: 'INCOMPLETE' });
    const undeclared = await submittedOrganization(['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP'], { ley49: false });
    await expect(reviewKyb(db, verified, undeclared.organization.id, { decision: 'VERIFIED', ley49Accredited: true })).rejects.toMatchObject({ reason: 'LEY49_NOT_DECLARED' });
    for (const { organization } of [missing, noCif, undeclared]) expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).kybStatus).toBe('SUBMITTED');
  });

  it('una entidad que no espera revisión (pendiente, verificada, archivada o inexistente) no se decide, y la cuenta destino no se comparte', async () => {
    const pending = await organizationWithSigners({ kybStatus: 'PENDING' });
    await expect(reviewKyb(db, verified, pending.organization.id, { decision: 'VERIFIED', ley49Accredited: false })).rejects.toMatchObject({ reason: 'NOT_SUBMITTED' });
    await expect(reviewKyb(db, verified, 'no-existe', { decision: 'VERIFIED', ley49Accredited: false })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const splitId = uniqueId('split');
    const first = await submittedOrganization();
    const second = await submittedOrganization();
    await reviewKyb(db, verified, first.organization.id, { decision: 'VERIFIED', ley49Accredited: true, paycometSplitId: splitId });
    await expect(reviewKyb(db, verified, second.organization.id, { decision: 'VERIFIED', ley49Accredited: true, paycometSplitId: splitId })).rejects.toMatchObject({ reason: 'SPLIT_ID_IN_USE' });
    // La transacción se deshace entera: la segunda sigue esperando y no se avisó.
    expect((await db.organization.findUniqueOrThrow({ where: { id: second.organization.id } })).kybStatus).toBe('SUBMITTED');
    expect(await db.outboxMessage.count({ where: { organizationId: second.organization.id, templateKey: 'org.kybStatus' } })).toBe(0);
  });

  it('sin el Super-Admin verificado no se decide nada', async () => {
    const { organization } = await submittedOrganization();
    const forged = { kind: 'verified-superadmin', userId: verified.userId, sessionId: verified.sessionId } as VerifiedSuperadminActor;
    await expect(reviewKyb(db, forged, organization.id, { decision: 'VERIFIED', ley49Accredited: true })).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).kybStatus).toBe('SUBMITTED');
  });

  it('liberar un CIF ocupado: hasta que se verifica; una entidad verificada conserva el suyo', async () => {
    const squatter = await organizationWithSigners({ kybStatus: 'REJECTED', cif: 'G11111111' });
    await releaseOrganizationCif(db, verified, squatter.organization.id);
    expect((await db.organization.findUniqueOrThrow({ where: { id: squatter.organization.id } })).cif).toBeNull();
    // Ya liberado, la legítima puede registrarlo.
    await createOrganization(db, { cif: 'G11111111' });
    await expect(releaseOrganizationCif(db, verified, squatter.organization.id)).rejects.toBeInstanceOf(KybReviewRejectedError);
    const verifiedOrg = await organizationWithSigners({ kybStatus: 'VERIFIED', cif: 'G22222222' });
    await expect(releaseOrganizationCif(db, verified, verifiedOrg.organization.id)).rejects.toBeInstanceOf(KybReviewRejectedError);
    expect((await db.organization.findUniqueOrThrow({ where: { id: verifiedOrg.organization.id } })).cif).toBe('G22222222');
    expect(await db.auditLog.count({ where: { action: 'kyb.cif_released', organizationId: squatter.organization.id } })).toBe(1);
  });
});

describe('QA-A03 · firmas, relevos caducados y ficha 360º', () => {
  it('un relevo caducado se cierra solo en la comprobación diaria, sin alerta para el Super-Admin, y cierra las alertas antiguas (decisión del promotor, 2026-11-12)', async () => {
    const { organization, director, cosigner, cosignerMember } = await organizationWithSigners();
    const outsider = await createUser(db);
    const handover = await db.signerHandover.create({
      data: { organizationId: organization.id, role: 'COSIGNER', outgoingMemberId: cosignerMember.id, outgoingUserId: cosigner.id, incomingUserId: outsider.id, roleLabel: 'Presidencia nueva', displayName: 'Persona nueva', proposedByUserId: director.id, status: 'INVITED', consentedAt: new Date(), expiresAt: new Date(Date.now() - 2 * DAY) }
    });
    // Una alerta que dejó la versión anterior sigue abierta hasta que la comprobación la cierra.
    const legacy = await db.opsAlert.create({ data: { type: 'SIGNER_HANDOVER_EXPIRED', severity: 'WARNING', dedupeKey: `SIGNER_HANDOVER_EXPIRED:${handover.id}`, organizationId: organization.id, targetType: 'SignerHandover', targetId: handover.id, detailJson: {} } });
    expect(await checkExpiredSignerHandovers(db, new Date())).toBeGreaterThanOrEqual(1);
    expect((await db.signerHandover.findUniqueOrThrow({ where: { id: handover.id } })).status).toBe('EXPIRED');
    expect((await db.opsAlert.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('RESOLVED');
    // Ya no se abre ninguna alerta nueva por un relevo caducado.
    const other = await organizationWithSigners();
    const stale = await db.signerHandover.create({
      data: { organizationId: other.organization.id, role: 'COSIGNER', outgoingMemberId: other.cosignerMember.id, outgoingUserId: other.cosigner.id, incomingUserId: outsider.id, roleLabel: 'Presidencia nueva', displayName: 'Persona nueva', proposedByUserId: other.director.id, status: 'INVITED', consentedAt: new Date(), expiresAt: new Date(Date.now() - 2 * DAY) }
    });
    await checkExpiredSignerHandovers(db, new Date());
    expect((await db.signerHandover.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
    expect(await db.opsAlert.count({ where: { dedupeKey: `SIGNER_HANDOVER_EXPIRED:${stale.id}` } })).toBe(0);
    // Un relevo vigente no se toca.
    const live = await organizationWithSigners();
    const open = await db.signerHandover.create({
      data: { organizationId: live.organization.id, role: 'COSIGNER', outgoingMemberId: live.cosignerMember.id, outgoingUserId: live.cosigner.id, incomingUserId: outsider.id, roleLabel: 'Presidencia nueva', displayName: 'Persona nueva', proposedByUserId: live.director.id, status: 'INVITED', consentedAt: new Date(), expiresAt: new Date(Date.now() + 2 * DAY) }
    });
    await checkExpiredSignerHandovers(db, new Date());
    expect((await db.signerHandover.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('INVITED');
  });

  it('la ficha 360º enseña al titular sin datos de más: email de quien firma a medias, IBAN solo con sus últimos cuatro, documentos sin fichero', async () => {
    const { organization } = await submittedOrganization(KINDS, { iban: 'ES9121000418450200051332' });
    await db.invoice.create({
      data: { invoiceNumber: uniqueId('K-2026'), organizationId: organization.id, recipientName: 'Panadería Luna', concept: 'Fee de gestión publicitaria', baseAmountCents: 3_750, taxAmountCents: 788, totalAmountCents: 4_538, verifactuHash: uniqueId('hash'), verifactuQrUrl: 'https://verifactu.example/qr', verifactuStatus: 'ACCEPTED' }
    });
    const view = (await getOrganization360(db, admin, organization.id))!;
    expect(view.organization).toMatchObject({ id: organization.id, kybStatus: 'SUBMITTED', ley49: true, ibanHint: 'ES•• •••• 1332', archived: false });
    expect(JSON.stringify(view)).not.toContain('ES9121000418450200051332');
    expect(view.seats).toHaveLength(2);
    for (const seat of view.seats) expect(seat.maskedEmail).toMatch(/•••@/);
    expect(view.documents.map((document) => document.kind).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(view.documents[0]!).sort()).toEqual(['createdAt', 'id', 'kind']);
    expect(view.readiness.ready).toBe(true);
    expect(view.invoices[0]).toMatchObject({ concept: 'Fee de gestión publicitaria', totalAmountCents: 4_538, verifactuStatus: 'ACCEPTED' });
    // Lo abierto queda en la auditoría.
    expect(await db.auditLog.count({ where: { actorUserId: admin.kind === 'user' ? admin.userId : '', action: 'superadmin.access' } })).toBeGreaterThan(0);
    expect(await getOrganization360(db, admin, 'no-existe')).toBeNull();
  });

  it('el negocio de la ficha sale del mismo BI filtrado por entidad: las 6 fuentes y sus iniciativas cuadran con las de la consola', async () => {
    const view = (await getOrganization360(db, admin, 'CERVANTES'))!;
    expect(view.business.initiatives.length).toBeGreaterThan(0);
    for (const row of view.business.initiatives) expect(row.organizationId).toBe('CERVANTES');
    expect(view.business.real.sourcesTotalCents - view.business.real.gatewayNetCostCents - view.business.real.autoBoostExpenseCents - view.business.real.chargebackLossesCents).toBe(view.business.real.netRevenueCents);
    expect(view.business.projection.sourcesTotalCents - view.business.projection.gatewayLossCents - view.business.projection.sunkCostsCents).toBe(view.business.projection.netRevenueCents);
  });

  it('la lista de entidades trae a todas, incluidas las que esperan revisión', async () => {
    const { organization } = await submittedOrganization();
    const rows = await getConsoleOrganizations(db, admin);
    expect(rows.find((row) => row.id === organization.id)).toMatchObject({ kybStatus: 'SUBMITTED', archived: false });
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Sprint 5.2 · «Volver a poner en cola» los emails fallidos', () => {
  const failedMessage = (templateKey: string) =>
    db.outboxMessage.create({ data: { idempotencyKey: uniqueId('outbox'), templateKey, toAddress: 'destino@correo.example', payloadJson: {}, status: 'FAILED', attempts: 5, lastError: 'Rechazado por el proveedor' } });
  const emailAlert = async (templateKey: string) => {
    const dedupeKey = `email:failed:${templateKey}`;
    await raiseAlert(db, { type: 'EMAIL_DELIVERY_FAILED', severity: 'WARNING', dedupeKey, detail: { templateKey, reason: 'permanent' } });
    return db.opsAlert.findUniqueOrThrow({ where: { dedupeKey } });
  };

  it('los mensajes de la plantilla vuelven a la cola con los intentos a cero, la alerta se cierra y queda auditado sin direcciones', async () => {
    const templateKey = `qa.requeue${Math.floor(Math.random() * 1e6)}`;
    const [first, second] = await Promise.all([failedMessage(templateKey), failedMessage(templateKey)]);
    const other = await failedMessage(`qa.other${Math.floor(Math.random() * 1e6)}`);
    const alert = await emailAlert(templateKey);
    const result = await requeueFailedEmails(db, admin, alert.id);
    expect(result).toEqual({ status: 'REQUEUED', requeued: 2, skipped: 0 });
    for (const id of [first.id, second.id]) expect(await db.outboxMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
    // Los de otra plantilla no se tocan.
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('FAILED');
    expect((await db.opsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('RESOLVED');
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'outbox.requeued', targetId: alert.id } });
    expect(audit.metadataJson).toEqual({ templateKey, requeued: 2, skipped: 0 });
    // Repetirlo no hace nada: la alerta ya no está abierta.
    expect(await requeueFailedEmails(db, admin, alert.id)).toEqual({ status: 'NOT_OPEN' });
  });

  it('los emails de acceso o invitación (código de un solo uso) no se reactivan', async () => {
    const message = await failedMessage('auth.magicLink');
    const alert = await emailAlert('auth.magicLink');
    const result = await requeueFailedEmails(db, admin, alert.id);
    expect(result).toMatchObject({ status: 'REQUEUED', skipped: expect.any(Number) });
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).status).toBe('FAILED');
  });

  it('una alerta de configuración del email no se «pone en cola»: se arregla cambiando el ajuste', async () => {
    await raiseAlert(db, { type: 'EMAIL_DELIVERY_FAILED', severity: 'CRITICAL', dedupeKey: 'email:configuration', detail: { reason: 'configuration' } });
    const alert = await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: 'email:configuration' } });
    expect(await requeueFailedEmails(db, admin, alert.id)).toEqual({ status: 'NOT_REQUEUEABLE' });
    expect((await db.opsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('OPEN');
  });

  it('solo el Super-Admin con segundo factor: otra sesión, o sin el segundo factor, se deniega sin tocar nada', async () => {
    const templateKey = `qa.denied${Math.floor(Math.random() * 1e6)}`;
    const message = await failedMessage(templateKey);
    const alert = await emailAlert(templateKey);
    const stranger = await createUser(db);
    const strangerActor = await loadUserActor(db, stranger.id, { ipHash: 'x' }, { secondFactor: true });
    await expect(requeueFailedEmails(db, strangerActor, alert.id)).rejects.toBeInstanceOf(TenantAccessError);
    const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    const noSecondFactor = await loadUserActor(db, superadmin.id, { ipHash: 'y' }, { secondFactor: false });
    await expect(requeueFailedEmails(db, noSecondFactor, alert.id)).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).status).toBe('FAILED');
    expect((await db.opsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('OPEN');
  });
});

const jobContext = (): JobContext => ({ db, now: new Date(), batchSize: 50, deps: {} as unknown as JobContext['deps'] });

describe('QA-A02 · Auto-Impulso de una campaña que fracasa, con contracargo real y reembolso encadenado', () => {
  it('un contracargo real reabre la campaña, vence, el Auto-Impulso vuelve a KORUM y la hucha, raisedCents y las aportaciones por devolver cuadran en cero: no queda dinero huérfano', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative, contribution } = await openCampaign(organization.id);
    await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true });
    // Contracargo real de la donación de 850 €: el dinero sale de la hucha y la campaña vuelve a recaudar.
    await inTransaction(db, (tx) => applyChargebackInTx(tx, { externalEventId: uniqueId('evt'), kind: 'CHARGEBACK', order: contribution.paycometOrder!, amountCents: 85_000, currency: 'EUR', authCode: 'A12345', occurredAt: new Date(), payload: {} } as never, new Date()));
    const reopened = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(reopened.status).toBe('FUNDRAISING');
    expect(reopened.raisedCents).toBe(15_000);
    expect(await escrowOf(organization.id, initiative.id)).toBe(15_000);
    // Su plazo pasa sin llegar a la meta.
    await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() - DAY) } });

    await campaignExpiryHandler(jobContext());
    const expired = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    // La caché y el libro valen lo mismo (cero): nada queda en la hucha.
    expect(expired).toMatchObject({ status: 'EXPIRED', raisedCents: 0 });
    expect(await escrowOf(organization.id, initiative.id)).toBe(0);
    expect((await getAccountBalance(db, 'AUTO_BOOST_EXPENSE', { organizationId: organization.id })).balanceCents).toBe(0);

    // Nada queda por devolver ni en la hucha: la tarea de reembolsos cerraría la campaña como `REFUNDED` sin `ESCROW_LEFTOVER` (no se ejecuta aquí: la base de pruebas
    // se comparte con otros archivos que tienen campañas propias esperando su reembolso).
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, status: { in: ['COMPLETED', 'REFUND_PENDING'] }, type: { in: ['DONATION', 'TICKET', 'SPONSORSHIP'] } } })).toBe(0);
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, status: 'COMPLETED', type: 'SELF_BOOST' } })).toBe(0);
  });

  it('si el Auto-Impulso no tiene su asiento, esa campaña no vence y avisa, pero las demás sí vencen y la tarea falla al final', async () => {
    const { organization } = await organizationWithSigners();
    const broken = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 100_000, raisedCents: 15_000, closesAt: new Date(Date.now() - DAY) });
    await db.contribution.create({
      data: { organizationId: organization.id, initiativeId: broken.id, fiscalYear: 2026, type: 'SELF_BOOST', amountCents: 15_000, totalChargedCents: 15_000, paymentMethod: 'PLATFORM', paycometOrder: `KB-${broken.id}-1`, paycometAuthCode: 'KORUM', status: 'COMPLETED' }
    });
    const healthy = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 100_000, raisedCents: 2_000, closesAt: new Date(Date.now() - DAY) });
    await expect(campaignExpiryHandler(jobContext())).rejects.toThrow(/no tiene su asiento/);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: healthy.id } })).status).toBe('EXPIRED');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: broken.id } })).status).toBe('FUNDRAISING');
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `CAMPAIGN_EXPIRY:${broken.id}` } })).toMatchObject({ type: 'JOB_FAILED', severity: 'CRITICAL', status: 'OPEN' });
    // La base de pruebas se comparte con otros archivos que ejecutan esta misma tarea: no se deja una campaña rota esperando a que venza ni su alerta abierta.
    await db.initiative.update({ where: { id: broken.id }, data: { status: 'CANCELLED', raisedCents: 0 } });
    await db.opsAlert.deleteMany({ where: { dedupeKey: `CAMPAIGN_EXPIRY:${broken.id}` } });
  });

  it('el servidor no ejecuta un Auto-Impulso en una campaña con retorno negativo (🚨) aunque llegue acceptLoss', async () => {
    const { organization } = await organizationWithSigners({ customRules: false });
    const { initiative } = await openCampaign(organization.id, 100_000, 85_000, { absorbsGatewayCostByKorum: true, gatewayFeeCents: 6_250 });
    const row = (await loadBiSnapshot(db, {})).initiatives.find((candidate) => candidate.id === initiative.id);
    expect(row?.isNegativeReturnAlert).toBe(true);
    await expect(executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 15_000, publiclyDisclosed: true, acceptLoss: true })).rejects.toMatchObject({ reason: 'NEGATIVE_RETURN' });
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, type: 'SELF_BOOST' } })).toBe(0);
  });
});

const FULL_TARIFF = { customRules: true as const, exemptLimitCents: 100_000, t1Bps: 500, t2Bps: 400, t3Bps: 300, sponsorFeeBps: 1_500, fullIntegrityCheckCents: 180, ticketFeeFixedCents: 45, ticketFeeBps: 200, maintActive: false, maintPerInitCents: 4_900, maintAnnualCapCents: 14_700 };

describe('QA-A03 · tarifas: taquilla en curso y vuelta a los valores globales', () => {
  it('una taquilla que ya cumplió la meta pero no ha cerrado también protege los gastos de gestión de la entidad', async () => {
    const { organization } = await organizationWithSigners({ customRules: true, ticketFeeFixedCents: 50, ticketFeeBps: 100 });
    await createInitiative(db, organization.id, { status: 'GOAL_REACHED', format: 'TICKETING', closesAt: new Date(Date.now() + 5 * DAY) });
    await expect(saveOrganizationTariffs(db, verified, organization.id, { ...FULL_TARIFF, ticketFeeFixedCents: 80 })).rejects.toMatchObject({ reason: 'PUBLISHED_TICKETING' });
    // Una taquilla que ya cerró no protege nada.
    const { organization: closed } = await organizationWithSigners({ customRules: true, ticketFeeFixedCents: 50, ticketFeeBps: 100 });
    await createInitiative(db, closed.id, { status: 'GOAL_REACHED', format: 'TICKETING', closesAt: new Date(Date.now() - DAY) });
    await expect(saveOrganizationTariffs(db, verified, closed.id, { ...FULL_TARIFF, ticketFeeFixedCents: 80 })).resolves.toBeUndefined();
  });

  it('una entidad que gastó más cupo exento que el límite global puede volver a las tarifas globales: el cupo restante queda a 0 y no se crea cupo nuevo', async () => {
    const global = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } });
    const limit = global.exemptLimitCents + 200_000;
    const { organization } = await organizationWithSigners({ customRules: true, exemptLimitCents: limit, exemptRemainingCents: limit - (global.exemptLimitCents + 100_000) });
    await saveOrganizationTariffs(db, verified, organization.id, { customRules: false });
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({ customRules: false, exemptLimitCents: global.exemptLimitCents, exemptRemainingCents: 0 });
    // Editando un límite propio por debajo de lo gastado sigue rechazándose.
    const { organization: own } = await organizationWithSigners({ customRules: true, exemptLimitCents: 300_000, exemptRemainingCents: 100_000 });
    await expect(saveOrganizationTariffs(db, verified, own.id, { ...FULL_TARIFF, exemptLimitCents: 150_000 })).rejects.toMatchObject({ reason: 'LIMIT_BELOW_USED' });
  });
});

describe('QA-A03 · abrir la ficha y el pop-up queda en la auditoría con su entidad y su iniciativa', () => {
  it('superadmin.access guarda qué entidad y qué iniciativa se abrieron', async () => {
    const { organization } = await organizationWithSigners();
    const { initiative } = await openCampaign(organization.id);
    await getOrganization360(db, admin, organization.id);
    await getInitiativePopup(db, admin, initiative.id);
    expect(await db.auditLog.count({ where: { action: 'superadmin.access', organizationId: organization.id, targetType: 'Organization', targetId: organization.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'superadmin.access', organizationId: organization.id, targetType: 'Initiative', targetId: String(initiative.id) } })).toBe(1);
  });
});
