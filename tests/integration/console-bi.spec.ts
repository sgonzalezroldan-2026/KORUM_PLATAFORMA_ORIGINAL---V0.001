import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVENUE_SOURCE_KEYS } from '@/core/finance/bi-analytics.service';
import { postJournal } from '@/core/finance/ledger.service';
import { raiseAlert } from '@/core/jobs/ops-alerts';
import { evaluatePricingHealth } from '@/core/finance/pricing-health';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadUserActor } from '@/repositories/actor';
import { getConsoleBusiness, getConsoleOverview, getConsolePricingHealth } from '@/repositories/console.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadBiSnapshot } from '@/services/admin/bi-snapshot';
import { loadGlobalRules } from '@/services/admin/bi-facts';
import { resolveOpsAlertById, resolveStuckRefund } from '@/services/admin/console-alerts.service';
import { loadRealSourceMargins } from '@/services/admin/pricing-health-data';
import { invalidateSettingsCache, updateSetting } from '@/services/settings/settings.service';
import { seedDatabase } from '@/seed/seed';
import { RefundNotAllowedError } from '@/services/payments/payment-reversals';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_KEYRING, TEST_SCHEMA, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.1 · BI de la consola con la semilla completa (QA-A01, QA-A02, QA-FIN05, QA-FIN06): los ingresos reales salen del libro mayor, la
 * proyección de las campañas abiertas, y las dos cuadran al céntimo. Las cifras fijadas son las del análisis de la semilla en
 * `tests/unit/bi-analytics.spec.ts`: la consola, que lee de la base de datos, tiene que dar exactamente las mismas.
 */

const SECRETS = { hmacSecret: 'integration-data-hmac-secret-0123456789', qrSecret: 'integration-qr-hmac-secret-0123456789ab', keyring: TEST_KEYRING };
const SEED_INITIATIVE_IDS = [1, 2, 3, 4, 5, 6, 7, 8];

let db: KorumPrismaClient;
let admin: SessionActor;

/** La portada lista las 50 alertas más recientes por gravedad: otras suites dejan alertas con fechas futuras, así que las de esta suite llevan una fecha lejana para salir siempre las primeras. */
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

beforeAll(async () => {
  db = createTestClient();
  await seedDatabase(db, { ...SECRETS, schema: TEST_SCHEMA });
  const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
  admin = await loadUserActor(db, superadmin.id, { ipHash: 'hash-de-ip' }, { secondFactor: true });
}, 600_000);

afterAll(async () => {
  await db.$disconnect();
});

const seedRows = async () => (await loadBiSnapshot(db, {})).initiatives.filter((row) => SEED_INITIATIVE_IDS.includes(row.id));

describe('QA-FIN05 · ingresos reales (libro mayor) por entidad', () => {
  it.each([
    ['CERVANTES', 53_000],
    ['SANJOSE', -389],
    ['CLUBKORUM', 3_458],
    ['MEDITERRANEO', -2_856]
  ])('el neto real de %s es el de su balance: ingresos − gastos === activo − pasivo', async (organizationId, expectedNetCents) => {
    const snapshot = await loadBiSnapshot(db, { organizationId });
    expect(snapshot.real.netRevenueCents).toBe(expectedNetCents);
    const sources = REVENUE_SOURCE_KEYS.reduce((total, key) => total + snapshot.real.sourcesCents[key], 0);
    expect(sources).toBe(snapshot.real.sourcesTotalCents);
    expect(sources - snapshot.real.gatewayNetCostCents - snapshot.real.autoBoostExpenseCents - snapshot.real.chargebackLossesCents).toBe(expectedNetCents);
  });

  it('lo real no depende del trimestre elegido y lo proyectado sí', async () => {
    const all = await loadBiSnapshot(db, { organizationId: 'CERVANTES' });
    const quarter = all.options.quarters[0]!;
    const filtered = await loadBiSnapshot(db, { organizationId: 'CERVANTES', quarter });
    expect(filtered.real).toEqual(all.real);
    expect(filtered.initiatives.every((row) => row.quarter === quarter)).toBe(true);
    expect(filtered.initiatives.length).toBeLessThanOrEqual(all.initiatives.length);
  });

  it('los filtros de provincia y entidad acotan entidades, filas, ingresos reales y proyección', async () => {
    const everything = await loadBiSnapshot(db, {});
    const province = everything.organizations.find((organization) => organization.id === 'MEDITERRANEO')!.province;
    const byProvince = await loadBiSnapshot(db, { province });
    expect(byProvince.organizations.every((organization) => organization.province === province)).toBe(true);
    expect(byProvince.initiatives.every((row) => row.province === province)).toBe(true);
    const none = await loadBiSnapshot(db, { organizationId: 'NO-EXISTE' });
    expect(none.organizations).toEqual([]);
    expect(none.initiatives).toEqual([]);
    expect(none.real.netRevenueCents).toBe(0);
    expect(none.projection.kpis.potentialGoalCents).toBe(0);
  });
});

describe('QA-A02 · 6 fuentes y alertas con la semilla, leídas de la base de datos', () => {
  it('las 6 fuentes menos la pérdida de pasarela suman el neto de cada fila al céntimo', async () => {
    const rows = await seedRows();
    expect(rows.map((row) => row.id).sort()).toEqual(SEED_INITIATIVE_IDS);
    for (const row of rows) {
      const total = REVENUE_SOURCE_KEYS.reduce((sum, key) => sum + row.sourcesCents[key], 0);
      expect(total - row.gatewayLossCents - row.sunkCostsCents, `iniciativa ${row.id}`).toBe(row.netRevenueCents);
    }
  });

  it('#1 (97,4 %) dispara 💎 con las cifras exactas del análisis de la semilla', async () => {
    const row = (await seedRows()).find((candidate) => candidate.id === 1)!;
    expect(row.sourcesCents).toEqual({ bracketFeeCents: 14_440, supportGuaranteeCents: 8_356, sponsorFeeCents: 12_750, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 });
    expect(row.netRevenueCents).toBe(35_546);
    expect(row.missingTo100Cents).toBe(15_000);
    // Sin los 2,56 € proyectados ni los 127,50 € de fee de patrocinio (KORUM los conserva aporte o no).
    expect(row.collectedNetRevenueCents).toBe(22_540);
    expect(row.netProfitAfterBoostCents).toBe(7_540);
    expect(row.isProfitableSelfBoost).toBe(true);
    expect(row.isNegativeReturnAlert).toBe(false);
  });

  it('#8 exenta dispara 🚨: KORUM absorbe 62,50 € sin ingresos; las demás alertas son las de la semilla', async () => {
    const rows = await seedRows();
    const eight = rows.find((candidate) => candidate.id === 8)!;
    expect(eight.sourcesCents).toEqual({ bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 });
    expect(eight.netRevenueCents).toBe(-6_250);
    expect(rows.filter((row) => row.isNegativeReturnAlert).map((row) => row.id)).toEqual([8]);
    expect(rows.filter((row) => row.isProfitableSelfBoost).map((row) => row.id).sort()).toEqual([1, 2, 5, 7]);
    // #2 (taquilla): el libro mayor da 86,60 € de margen real (las compras de varias entradas comparten el fijo de Paycomet; el modelo, con una entrada por
    // cobro, daba 78,40 €). Proyección = lo cobrado + 4 entradas que faltan × 0,40 €; el retorno del 💎 solo cuenta lo cobrado.
    expect(rows.find((row) => row.id === 2)).toMatchObject({ netRevenueCents: 8_820, collectedNetRevenueCents: 8_660, netProfitAfterBoostCents: 6_660 });
    expect(rows.find((row) => row.id === 5)).toMatchObject({ netRevenueCents: 61_907, netProfitAfterBoostCents: 9_013 });
    expect(rows.find((row) => row.id === 7)).toMatchObject({ netRevenueCents: 46_104, netProfitAfterBoostCents: 23_700 });
  });

  it('cada fila lleva sus aportaciones y la tabla de entidades suma la proyección', async () => {
    const snapshot = await loadBiSnapshot(db, {});
    for (const row of snapshot.initiatives.filter((candidate) => SEED_INITIATIVE_IDS.includes(candidate.id))) expect(row.totalContributions).toBeGreaterThan(0);
    expect(snapshot.organizations.reduce((sum, row) => sum + row.expectedNetCents, 0)).toBe(snapshot.projection.kpis.expectedNetCents);
    expect(snapshot.organizations.reduce((sum, row) => sum + row.weightedNetCents, 0)).toBe(snapshot.projection.kpis.weightedNetCents);
    expect(snapshot.forecast.reduce((sum, quarter) => sum + quarter.unweightedNetCents, 0)).toBe(snapshot.projection.kpis.expectedNetCents);
    expect(snapshot.projection.sourcesTotalCents - snapshot.projection.gatewayLossCents - snapshot.projection.sunkCostsCents).toBe(snapshot.projection.netRevenueCents);
  });
});

describe('QA-FIN06 · salud de precios con el libro mayor', () => {
  it('con los valores por defecto avisa de Mi Hucha y del escalón; ninguna fuente de la semilla tiene margen negativo', async () => {
    const margins = await loadRealSourceMargins(db);
    expect(Object.values(margins).every((margin) => margin >= 0)).toBe(true);
    const rules = await loadGlobalRules(db);
    expect(evaluatePricingHealth(rules, margins).map((alert) => alert.code)).toEqual(['HUCHA_FEE_BELOW_GATEWAY_COST', 'BRACKET_CLIFF']);
    // La taquilla de la semilla: 196 entradas en 112 compras, con 0,55 € de gestión por entrada: 107,80 € de ingreso menos 21,20 € de pasarela real.
    // (Otras suites de este mismo esquema también cobran entradas: aquí basta con que la semilla aporte al menos lo suyo; su cifra exacta está en la fila del #2.)
    expect(margins.digitalTicketFeeCents).toBeGreaterThanOrEqual(196 * 55 - 2_120);
  });

  it('el margen real sale de los cobros: una fuente que pierde dinero abre SOURCE_NEGATIVE_MARGIN', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const before = await loadRealSourceMargins(db);
    const contribution = await db.contribution.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'TICKET', amountCents: 500, totalChargedCents: 500, paymentMethod: 'CARD', status: 'COMPLETED', guestEmail: `${uniqueId('t')}@example.test`, canonicalEmail: `${uniqueId('t')}@example.test` }
    });
    // Un cobro de 5,00 € sin gastos de gestión cuyo coste de pasarela fue de 0,14 €: el margen de la fuente baja 14 céntimos por debajo de lo anterior.
    await postJournal(db, { idempotencyKey: uniqueId('bi-gateway'), kind: 'GATEWAY_FEE', organizationId: organization.id, initiativeId: initiative.id, contributionId: contribution.id, description: 'Pasarela de una entrada', lines: [
      { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: 14, organizationId: organization.id },
      { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: 14, organizationId: organization.id }
    ] });
    const after = await loadRealSourceMargins(db);
    expect(after.digitalTicketFeeCents).toBe((before.digitalTicketFeeCents ?? 0) - 14);
    const rules = await loadGlobalRules(db);
    expect(evaluatePricingHealth(rules, { digitalTicketFeeCents: -1 }).map((alert) => alert.code)).toContain('SOURCE_NEGATIVE_MARGIN');
  });

  it('un aviso aceptado se ve atenuado y deja de contar en la insignia; si cambia la configuración, vuelve a saltar', async () => {
    const { actor } = await verifiedSuperadmin(db);
    invalidateSettingsCache();
    const before = await getConsolePricingHealth(db, admin);
    const hucha = before.alerts.find((alert) => alert.code === 'HUCHA_FEE_BELOW_GATEWAY_COST')!;
    expect(hucha.acknowledgement).toBeNull();
    const critical = before.openCritical;

    await updateSetting(db, actor, 'pricing.acknowledgements', [{ code: hucha.code, fingerprint: hucha.fingerprint, acknowledgedById: actor.userId, acknowledgedAt: new Date().toISOString(), note: 'Captación de familias' }]);
    invalidateSettingsCache();
    const accepted = await getConsolePricingHealth(db, admin);
    expect(accepted.alerts.find((alert) => alert.code === 'HUCHA_FEE_BELOW_GATEWAY_COST')?.acknowledgement?.note).toBe('Captación de familias');
    expect(accepted.openCritical).toBe(critical - 1);
    expect(accepted.open).toBe(before.open - 1);

    // Cambia el fee de Mi Hucha: la huella ya no coincide y el aviso vuelve como nuevo.
    await db.globalConfig.update({ where: { id: 'GLOBAL' }, data: { topupFeeCents: 24 } });
    const changed = await getConsolePricingHealth(db, admin);
    expect(changed.alerts.find((alert) => alert.code === 'HUCHA_FEE_BELOW_GATEWAY_COST')?.acknowledgement).toBeNull();
    await db.globalConfig.update({ where: { id: 'GLOBAL' }, data: { topupFeeCents: 25 } });
    await updateSetting(db, actor, 'pricing.acknowledgements', []);
    invalidateSettingsCache();
  });
});

describe('QA-OPS01 · alertas, tareas y resolución desde la consola', () => {
  it('la portada lista las alertas con el tipo de descuadre y la última ejecución de cada tarea', async () => {
    const key = uniqueId('RECON');
    await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', dedupeKey: key, detail: { kind: 'AMOUNT_MISMATCH', secret: 'no debe salir' } }, FAR_FUTURE);
    const hostile = uniqueId('HOSTILE');
    await raiseAlert(db, { type: 'RECONCILIATION_MISMATCH', severity: 'WARNING', dedupeKey: hostile, detail: { kind: '<script>alert(1)</script>' } }, FAR_FUTURE);
    await db.job.create({ data: { idempotencyKey: uniqueId('job'), type: 'PSP_RECONCILIATION', payloadJson: {}, runAt: new Date(), status: 'FAILED', attempts: 5, lastError: 'detalle interno que no debe salir' } });

    const overview = await getConsoleOverview(db, admin);
    const alert = overview.alerts.find((candidate) => candidate.kind === 'AMOUNT_MISMATCH');
    expect(alert).toMatchObject({ type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', resolvableId: null });
    expect(JSON.stringify(overview.alerts)).not.toContain('no debe salir');
    expect(overview.alerts.some((candidate) => candidate.kind === '<script>alert(1)</script>')).toBe(false);
    const reconciliation = overview.jobs.find((job) => job.type === 'PSP_RECONCILIATION');
    expect(reconciliation).toBeDefined();
    expect(JSON.stringify(overview.jobs)).not.toContain('detalle interno');
    expect(new Set(overview.jobs.map((job) => job.type)).size).toBe(overview.jobs.length);
  });

  it('una devolución o factura atascada lleva el identificador que se resuelve a mano; las demás no', async () => {
    await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: 'REFUND_STUCK:424242', targetType: 'Contribution', targetId: '424242', detail: {} }, FAR_FUTURE);
    await raiseAlert(db, { type: 'INVOICE_STUCK', severity: 'CRITICAL', dedupeKey: 'INVOICE_STUCK:737373', targetType: 'Invoice', targetId: '737373', detail: {} }, FAR_FUTURE);
    await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: 'REFUND_STUCK:mal', targetType: 'Contribution', targetId: '12; DROP', detail: {} }, FAR_FUTURE);
    await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: 'REFUND_STUCK:otro', targetType: 'Invoice', targetId: '5', detail: {} }, FAR_FUTURE);
    const { alerts } = await getConsoleOverview(db, admin);
    expect(alerts.find((alert) => alert.type === 'REFUND_STUCK' && alert.resolvableId === 424_242)).toBeDefined();
    expect(alerts.find((alert) => alert.type === 'INVOICE_STUCK' && alert.resolvableId === 737_373)).toBeDefined();
    // Un identificador mal formado o de otro tipo de objetivo no se ofrece (otras suites del esquema pueden tener sus propias alertas atascadas).
    const offered = alerts.map((alert) => alert.resolvableId);
    expect(offered).toEqual(expect.arrayContaining([424_242, 737_373]));
    expect(offered).not.toContain(12);
    expect(offered).not.toContain(5);
  });

  it('resolver una alerta la cierra, deja la auditoría y una segunda vez no hace nada', async () => {
    const key = uniqueId('RESOLVE');
    await raiseAlert(db, { type: 'JOB_FAILED', severity: 'WARNING', dedupeKey: key, detail: {} });
    const alert = await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: key } });

    expect(await resolveOpsAlertById(db, admin, alert.id)).toEqual({ status: 'RESOLVED' });
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: key } })).toMatchObject({ status: 'RESOLVED' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ops_alert.resolved', targetId: alert.id } });
    expect(audit.actorUserId).toBe((admin as { userId: string }).userId);
    expect(audit.metadataJson).toEqual({ type: 'JOB_FAILED' });
    expect(await resolveOpsAlertById(db, admin, alert.id)).toEqual({ status: 'NOT_OPEN' });
    expect(await resolveOpsAlertById(db, admin, 'no-existe')).toEqual({ status: 'NOT_OPEN' });

    // Si el problema reaparece, la alerta se reabre sola.
    await raiseAlert(db, { type: 'JOB_FAILED', severity: 'WARNING', dedupeKey: key, detail: {} });
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: key } })).toMatchObject({ status: 'OPEN', occurrences: 2 });
  });

  it('quien no es Super-Admin, o lo es sin el segundo factor de su sesión, recibe un 403 y no cierra nada', async () => {
    const key = uniqueId('FORBIDDEN');
    await raiseAlert(db, { type: 'JOB_FAILED', severity: 'WARNING', dedupeKey: key, detail: {} });
    const alert = await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: key } });
    const person = await createUser(db);
    const family = await loadUserActor(db, person.id, undefined, { secondFactor: true });
    const noSecondFactor = await loadUserActor(db, (admin as { userId: string }).userId, { ipHash: 'otra-ip' }, { secondFactor: false });

    for (const actor of [family, noSecondFactor, { kind: 'anonymous' } as SessionActor]) await expect(resolveOpsAlertById(db, actor, alert.id)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: 'OPEN' });
    expect(await db.auditLog.count({ where: { action: 'tenant.access_denied', actorUserId: person.id } })).toBeGreaterThan(0);
    await expect(getConsoleOverview(db, family)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getConsoleBusiness(db, family, {})).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getConsolePricingHealth(db, family)).rejects.toBeInstanceOf(TenantAccessError);
  });

  it('resolver a mano una devolución atascada exige el Super-Admin verificado, solo vale si de verdad está pendiente y cierra su alerta', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'REFUNDING' });
    const stuck = await db.contribution.create({
      data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, type: 'DONATION', amountCents: 1_000, totalChargedCents: 1_000, paymentMethod: 'CARD', status: 'REFUND_PENDING', refundSendingAt: new Date(), guestEmail: `${uniqueId('s')}@example.test`, canonicalEmail: `${uniqueId('s')}@example.test` }
    });
    await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: `REFUND_STUCK:${stuck.id}`, organizationId: organization.id, targetType: 'Contribution', targetId: String(stuck.id), detail: {} });
    const { actor } = await verifiedSuperadmin(db);

    // Un cobro que no está pendiente de resolver no se toca y su alerta sigue abierta.
    await expect(resolveStuckRefund(db, actor, 2_000_000_000, true)).rejects.toBeInstanceOf(RefundNotAllowedError);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_STUCK:${stuck.id}` } })).toMatchObject({ status: 'OPEN' });

    // «Paycomet no devolvió»: se libera la reserva para poder reintentar y la alerta se cierra.
    await resolveStuckRefund(db, actor, stuck.id, false);
    expect(await db.contribution.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: 'REFUND_PENDING', refundSendingAt: null });
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_STUCK:${stuck.id}` } })).toMatchObject({ status: 'RESOLVED' });
    expect(await db.auditLog.count({ where: { action: 'payment.refund_resolved', targetId: String(stuck.id) } })).toBe(1);
  });
});

describe('Auditoría 5.1 · campañas que ya no están abiertas, muestra coherente y resolución a mano', () => {
  const donation = (organizationId: string, initiativeId: number, overrides: Record<string, unknown> = {}) =>
    db.contribution.create({
      data: { organizationId, initiativeId, fiscalYear: 2026, type: 'DONATION', amountCents: 1_000, totalChargedCents: 1_000, paymentMethod: 'CARD', status: 'COMPLETED', guestEmail: `${uniqueId('d')}@example.test`, canonicalEmail: `${uniqueId('d')}@example.test`, ...overrides }
    });
  const rowOf = async (organizationId: string, initiativeId: number) => (await loadBiSnapshot(db, { organizationId })).initiatives.find((row) => row.id === initiativeId)!;
  const gatewayJournal = (organizationId: string, initiativeId: number, contributionId: number, cents: number) =>
    postJournal(db, {
      idempotencyKey: uniqueId('bi-gw'),
      kind: 'GATEWAY_FEE',
      organizationId,
      initiativeId,
      contributionId,
      description: 'Pasarela',
      lines: [
        { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: cents, organizationId },
        { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: cents, organizationId }
      ]
    });

  it('una campaña devuelta lleva la pasarela que KORUM pagó y no recupera: su neto es negativo y salta 🚨', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'REFUNDED', bracketFeeCents: 20_000, absorbsGatewayCostByKorum: true, gatewayFeeCents: 5_000 });
    const refunded = await donation(organization.id, initiative.id, { status: 'REFUNDED', refundedCents: 1_000 });
    await gatewayJournal(organization.id, initiative.id, refunded.id, 31);
    const row = await rowOf(organization.id, initiative.id);
    // Nada del plan (comisión de 200 €, pasarela absorbida de 50 €) se cobró: solo cuenta lo asentado.
    expect(row).toMatchObject({ netRevenueCents: -31, gatewayLossCents: 31, isNegativeReturnAlert: true, isProfitableSelfBoost: false });
    expect((await loadBiSnapshot(db, { organizationId: organization.id })).real.netRevenueCents).toBe(-31);
  });

  it('una campaña cerrada que cobró su comisión y recuperó parte de la pasarela vale lo asentado: fuentes menos pasarela neta', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'CLOSED', bracketFeeCents: 999_999 });
    const payment = await donation(organization.id, initiative.id);
    await gatewayJournal(organization.id, initiative.id, payment.id, 100);
    await postJournal(db, {
      idempotencyKey: uniqueId('bi-closed-payout'),
      kind: 'PAYOUT_APPROVAL',
      organizationId: organization.id,
      initiativeId: initiative.id,
      description: 'Liquidación',
      lines: [
        { account: 'INITIATIVE_ESCROW', direction: 'DEBIT', amountCents: 540, organizationId: organization.id, initiativeId: initiative.id },
        { account: 'KORUM_REVENUE_BRACKET', direction: 'CREDIT', amountCents: 500, organizationId: organization.id },
        { account: 'GATEWAY_FEES_RECOVERED', direction: 'CREDIT', amountCents: 40, organizationId: organization.id }
      ]
    });
    const row = await rowOf(organization.id, initiative.id);
    expect(row.sourcesCents.bracketFeeCents).toBe(500);
    expect(row).toMatchObject({ gatewayLossCents: 60, netRevenueCents: 440 });
    // La fila de una campaña cerrada coincide con lo real de la entidad (es la única que tiene).
    expect((await loadBiSnapshot(db, { organizationId: organization.id })).real.netRevenueCents).toBe(440);
  });

  it('la muestra de la aportación voluntaria sale de una sola lectura: nunca es incoherente, ni con todas las donaciones con garantía', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING', goalCents: 100_000, raisedCents: 2_000 });
    await donation(organization.id, initiative.id, { guaranteeContributionCents: 200, totalChargedCents: 1_200 });
    await donation(organization.id, initiative.id, { guaranteeContributionCents: 200, totalChargedCents: 1_200 });
    const row = await rowOf(organization.id, initiative.id);
    expect(row.status).toBe('FUNDRAISING');
    // Dos donaciones, las dos con garantía de 2,00 €: la proyección al 100 % parte de lo observado y no lanza.
    expect(row.sourcesCents.supportGuaranteeCents).toBeGreaterThan(0);
  });

  it('una devolución no cuenta en el margen de una fuente: no abre SOURCE_NEGATIVE_MARGIN por un precio que no es el problema', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const before = await loadRealSourceMargins(db);
    const refundedTicket = await donation(organization.id, initiative.id, { type: 'TICKET', status: 'REFUNDED' });
    await gatewayJournal(organization.id, initiative.id, refundedTicket.id, 30);
    expect(await loadRealSourceMargins(db)).toEqual(before);
  });

  it('las alertas de dinero atascado no se cierran con el botón genérico, y resolver a mano exige su alerta abierta', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'REFUNDING' });
    const stuck = await donation(organization.id, initiative.id, { status: 'REFUND_PENDING', refundSendingAt: new Date() });
    const { actor } = await verifiedSuperadmin(db);

    // Una devolución en vuelo (sin alerta de atasco) no se puede dar por devuelta ni liberar.
    await expect(resolveStuckRefund(db, actor, stuck.id, true)).rejects.toBeInstanceOf(RefundNotAllowedError);
    const untouched = await db.contribution.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(untouched.status).toBe('REFUND_PENDING');
    expect(untouched.refundSendingAt).not.toBeNull();

    // Con la alerta abierta, el botón genérico responde «usa su formulario» y no cierra nada.
    await raiseAlert(db, { type: 'REFUND_STUCK', severity: 'CRITICAL', dedupeKey: `REFUND_STUCK:${stuck.id}`, organizationId: organization.id, targetType: 'Contribution', targetId: String(stuck.id), detail: {} });
    const alert = await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `REFUND_STUCK:${stuck.id}` } });
    expect(await resolveOpsAlertById(db, admin, alert.id)).toEqual({ status: 'USE_RESOLVER' });
    expect(await db.opsAlert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: 'OPEN' });
  });
});
