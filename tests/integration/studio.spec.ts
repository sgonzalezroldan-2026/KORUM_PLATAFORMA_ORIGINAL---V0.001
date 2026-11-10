import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InitiativeNotPublishableError, publishInitiative } from '@/core/finance/campaign-window';
import { blankStudioDraft, defaultCloseOn, TICKETING_CATEGORY, type StudioDraft } from '@/core/studio/studio-draft';
import { storedBudgetBoard } from '@/core/studio/studio-board';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { MAX_OPEN_DRAFTS, getPosterData, getStudioInitiative, getStudioOverview, loadStudioContext } from '@/repositories/studio.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { discardStudioDraft, publishStudioInitiative, saveStudioDraft, StudioError } from '@/services/panel/studio.service';
import { createInitiative, createOrganization, createTestClient, createUser } from './test-database';

/**
 * Sprint 4.3 · Estudio de edición contra PostgreSQL real (QA-S01): guardar y publicar recalcula la pizarra en el servidor con las reglas y los cupos de
 * la base de datos, publicar reserva los cupos, una campaña recaudando solo admite cambios que no mueven dinero, una rifa exige premios y la confirmación
 * de normativa (que queda en la auditoría), y nada se hace desde otra entidad, sin segundo factor ni como Super-Admin.
 */

let db: KorumPrismaClient;

beforeAll(async () => {
  db = createTestClient();
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
  await db.globalCategory.upsert({ where: { name: 'Infraestructura y Confort' }, create: { name: 'Infraestructura y Confort', icon: '🌡️', rule: 'BRACKETS', sortOrder: 1 }, update: { rule: 'BRACKETS' } });
  await db.globalCategory.upsert({ where: { name: 'Comunidad y Viajes' }, create: { name: 'Comunidad y Viajes', icon: '🎒', rule: 'EXEMPT', sortOrder: 4 }, update: { rule: 'EXEMPT' } });
  await db.globalCategory.upsert({ where: { name: TICKETING_CATEGORY }, create: { name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT', sortOrder: 6 }, update: { rule: 'EXEMPT' } });
});

afterAll(async () => {
  await db.$disconnect();
});

const actorFor = (userId: string, organizationId: string, role: MemberRole, secondFactor = true): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor });

async function entity(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, { kybStatus: 'VERIFIED', exemptRemainingCents: 100_000, exemptLimitCents: 100_000, ...overrides });
  const [director, cosigner] = await Promise.all([createUser(db, { twoFactorEnabled: true }), createUser(db, { twoFactorEnabled: true })]);
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, director: actorFor(director.id, organization.id, 'DIRECTOR'), cosigner: actorFor(cosigner.id, organization.id, 'COSIGNER') };
}

const closesOn = () => defaultCloseOn(new Date(), 30);

const budget = (overrides: Partial<StudioDraft> = {}): StudioDraft => ({
  ...blankStudioDraft('BUDGET', 'SCHOOL', closesOn()),
  title: 'Aulas más frescas',
  description: 'Ventilación para las aulas',
  category: 'Infraestructura y Confort',
  costMatCents: 380_000,
  costInstCents: 130_000,
  rewardText: 'Tarde de cine',
  ...overrides
});

const raffle = (overrides: Partial<StudioDraft> = {}): StudioDraft => ({
  ...blankStudioDraft('TICKETING', 'SCHOOL', closesOn()),
  title: 'Rifa solidaria',
  description: 'Papeletas numeradas',
  ticketSubtype: 'RAFFLE',
  ticketPriceCents: 200,
  ticketMax: 500,
  rafflePrizeCount: 3,
  raffleNoticeConfirmed: true,
  ...overrides
});

async function reason(promise: Promise<unknown>): Promise<StudioError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(StudioError);
  return error as StudioError;
}

describe('guardar el borrador', () => {
  it('crea la campaña en presupuestación con la pizarra calculada por el servidor, y deja rastro', async () => {
    const { organization, director } = await entity();
    const saved = await saveStudioDraft(db, director, organization.id, budget());
    expect(saved).toMatchObject({ status: 'BUDGETING', created: true, goalCents: 587_400 });

    const row = await db.initiative.findUniqueOrThrow({ where: { id: saved.initiativeId } });
    expect(row).toMatchObject({
      organizationId: organization.id,
      status: 'BUDGETING',
      stepIndex: 3,
      format: 'BUDGET',
      goalCents: 587_400,
      defaultExemptAppliedCents: 100_000,
      bracketRateAppliedBps: 400,
      bracketFeeCents: 18_440,
      maintFeeCents: 0,
      gatewayFeeCents: 7_960,
      costMatCents: 380_000,
      raisedCents: 0
    });
    expect(row.walletEscrowId).toMatch(/^WLT-ESC-/);
    expect(row.quotaReservedAt).toBeNull();
    // Guardar no reserva cupos: eso ocurre al publicar.
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(100_000);
    const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: 'studio.initiative_saved' } });
    expect(audit.metadataJson).toMatchObject({ initiativeId: saved.initiativeId, created: true, goalCents: 587_400 });
  });

  it('actualizar un borrador recalcula todo y conserva la hucha; también la puede editar la cofirma', async () => {
    const { organization, director, cosigner } = await entity();
    const first = await saveStudioDraft(db, director, organization.id, budget());
    const second = await saveStudioDraft(db, cosigner, organization.id, budget({ initiativeId: first.initiativeId, costMatCents: 100_000, costInstCents: 0 }));
    expect(second).toMatchObject({ initiativeId: first.initiativeId, created: false });
    const row = await db.initiative.findUniqueOrThrow({ where: { id: first.initiativeId } });
    // 1.000 € + 10 % = 1.100 €: 1.000 € exentos y 100 € al 5 % = 5,00 €; 45 cobros de 25 €.
    expect(row.bracketFeeCents).toBe(500);
    expect(row.goalCents).toBe(112_100);
    expect(await db.initiative.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it('cambiar de formato en un borrador deja la campaña coherente con el nuevo', async () => {
    const { organization, director } = await entity();
    const first = await saveStudioDraft(db, director, organization.id, budget());
    await saveStudioDraft(db, director, organization.id, { ...raffle(), initiativeId: first.initiativeId });
    const row = await db.initiative.findUniqueOrThrow({ where: { id: first.initiativeId } });
    expect(row).toMatchObject({ format: 'TICKETING', category: TICKETING_CATEGORY, costMatCents: 0, bracketFeeCents: 0, ticketSubtype: 'RAFFLE', ticketMax: 500, rafflePrizeCount: 3, goalCents: 100_000 });
  });

  it('el candado semántico deja rastro para la revisión del Super-Admin: una categoría al 0 % y un texto bloqueado', async () => {
    const { organization, director } = await entity();
    const exempt = await saveStudioDraft(db, director, organization.id, budget({ category: 'Comunidad y Viajes', title: 'Excursión de fin de curso', description: 'Autocar y entradas' }));
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'studio.exempt_category_saved', targetId: String(exempt.initiativeId) } })).toBe(1);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: exempt.initiativeId } })).bracketFeeCents).toBe(0);

    const blocked = await saveStudioDraft(db, director, organization.id, budget({ category: 'Comunidad y Viajes', title: 'Ventiladores para el comedor' }));
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'studio.semantic_lock_triggered', targetId: String(blocked.initiativeId) } })).toBe(1);
    // Con el candado activado paga la comisión por tramos como cualquier otra campaña.
    expect((await db.initiative.findUniqueOrThrow({ where: { id: blocked.initiativeId } })).bracketFeeCents).toBeGreaterThan(0);
  });

  it('rechaza lo que no se puede guardar: cierre demasiado lejano o ya pasado, categoría inventada y campos de más', async () => {
    const { organization, director } = await entity();
    expect((await reason(saveStudioDraft(db, director, organization.id, budget({ closesOn: defaultCloseOn(new Date(), 90) })))).detail).toContain('CLOSING_TOO_LATE');
    expect((await reason(saveStudioDraft(db, director, organization.id, budget({ closesOn: defaultCloseOn(new Date(), -2) })))).detail).toContain('CLOSING_PAST');
    expect((await reason(saveStudioDraft(db, director, organization.id, budget({ category: 'Inventada' })))).detail).toContain('INVALID_CATEGORY');
    expect((await reason(saveStudioDraft(db, director, organization.id, { ...budget(), goalCents: 1 }))).reason).toBe('INVALID_INPUT');
    expect((await reason(saveStudioDraft(db, director, organization.id, { ...budget(), costMatCents: 10.5 }))).reason).toBe('INVALID_INPUT');
    expect(await db.initiative.count({ where: { organizationId: organization.id } })).toBe(0);
  });

  it('no admite más de 20 borradores abiertos por entidad', async () => {
    const { organization, director } = await entity();
    for (let index = 0; index < MAX_OPEN_DRAFTS; index += 1) await createInitiative(db, organization.id, { status: 'BUDGETING' });
    expect((await getStudioOverview(db, director, organization.id)).canCreate).toBe(false);
    expect((await reason(saveStudioDraft(db, director, organization.id, budget()))).reason).toBe('TOO_MANY_DRAFTS');
  });
});

describe('aislamiento y permisos', () => {
  it('nadie de otra entidad, sin segundo factor ni el Super-Admin guarda, publica o lee', async () => {
    const { organization, director } = await entity();
    const other = await entity();
    const saved = await saveStudioDraft(db, director, organization.id, budget());
    const payload = { draft: budget({ initiativeId: saved.initiativeId }), expectedGoalCents: 587_400 };

    await expect(saveStudioDraft(db, other.director, organization.id, budget())).rejects.toBeInstanceOf(TenantAccessError);
    await expect(publishStudioInitiative(db, other.director, organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(saveStudioDraft(db, { ...director, secondFactor: false } as SessionActor, organization.id, budget())).rejects.toBeInstanceOf(TenantAccessError);
    const superadmin: SessionActor = { kind: 'user', userId: 'root', isSuperadmin: true, memberships: [], secondFactor: true };
    await expect(saveStudioDraft(db, superadmin, organization.id, budget())).rejects.toBeInstanceOf(TenantAccessError);
    await expect(getStudioOverview(db, other.director, organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.initiative.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it('una campaña de otra entidad responde igual que una inexistente y queda registrado el sondeo', async () => {
    const mine = await entity();
    const theirs = await entity();
    const foreign = await saveStudioDraft(db, theirs.director, theirs.organization.id, budget());
    const missing = 2_000_000_000;

    for (const id of [foreign.initiativeId, missing]) {
      await expect(saveStudioDraft(db, mine.director, mine.organization.id, budget({ initiativeId: id }))).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(getStudioInitiative(db, mine.director, mine.organization.id, id)).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(getPosterData(db, mine.director, mine.organization.id, id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    }
    expect(await db.auditLog.count({ where: { organizationId: mine.organization.id, action: 'tenant.resource_outside_tenant' } })).toBeGreaterThan(0);
    // La campaña ajena no cambió.
    expect((await db.initiative.findUniqueOrThrow({ where: { id: foreign.initiativeId } })).title).toBe('Aulas más frescas');
  });

  it('la lectura del Estudio no trae el PIN de portería ni datos de las personas', async () => {
    const { organization, director } = await entity();
    const saved = await saveStudioDraft(db, director, organization.id, raffle({ raffleNoticeConfirmed: false }));
    await db.initiative.update({ where: { id: saved.initiativeId }, data: { gatePinHash: 'secreto-no-mostrar' } });
    const initiative = await getStudioInitiative(db, director, organization.id, saved.initiativeId);
    expect(JSON.stringify(initiative)).not.toContain('secreto-no-mostrar');
    expect(Object.keys(initiative)).not.toContain('gatePinHash');
  });
});

describe('publicar', () => {
  it('sin los documentos del titular verificados se guarda el borrador pero no se publica', async () => {
    const { organization, director } = await entity({ kybStatus: 'SUBMITTED' });
    const error = await reason(publishStudioInitiative(db, director, organization.id, { draft: budget(), expectedGoalCents: 587_400 }));
    expect(error.reason).toBe('BLOCKED');
    expect(error.detail).toContain('KYB');
    const row = await db.initiative.findUniqueOrThrow({ where: { id: error.initiativeId! } });
    expect(row.status).toBe('BUDGETING');
    expect(row.quotaReservedAt).toBeNull();
  });

  it('publica con la meta aceptada, reserva los cupos de la entidad y deja la campaña recaudando', async () => {
    const { organization, director } = await entity();
    const result = await publishStudioInitiative(db, director, organization.id, { draft: budget(), expectedGoalCents: 587_400 });
    expect(result.published).toBe(true);
    const row = await db.initiative.findUniqueOrThrow({ where: { id: result.initiativeId } });
    expect(row).toMatchObject({ status: 'FUNDRAISING', stepIndex: 4, goalCents: 587_400, quotaReservedExemptCents: 100_000 });
    expect(row.quotaReservedAt).not.toBeNull();
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'studio.initiative_published' } })).toBe(1);
  });

  it('si la meta que se aceptó ya no es la del servidor (cambiaron los cupos), no publica y deja el borrador con la cifra nueva', async () => {
    const { organization, director } = await entity();
    const error = await reason(publishStudioInitiative(db, director, organization.id, { draft: budget(), expectedGoalCents: 123_400 }));
    expect(error.reason).toBe('STALE_BOARD');
    const row = await db.initiative.findUniqueOrThrow({ where: { id: error.initiativeId! } });
    expect(row.status).toBe('BUDGETING');
    expect(row.goalCents).toBe(587_400);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(100_000);
  });

  it('con el exento ya gastado por otra campaña, la meta que se ve ya lo recoge y la publicada descuenta lo que queda', async () => {
    const { organization, director } = await entity({ exemptRemainingCents: 30_000 });
    const context = await loadStudioContext(db, organization.id);
    expect(context.exemptRemainingCents).toBe(30_000);
    const saved = await saveStudioDraft(db, director, organization.id, budget());
    const row = await db.initiative.findUniqueOrThrow({ where: { id: saved.initiativeId } });
    expect(row.defaultExemptAppliedCents).toBe(30_000);
    const result = await publishStudioInitiative(db, director, organization.id, { draft: budget({ initiativeId: saved.initiativeId }), expectedGoalCents: saved.goalCents });
    expect(result.published).toBe(true);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(0);
  });

  it('repetir la publicación no hace nada más, y con la campaña recaudando solo se cambian descripción, reto y placa', async () => {
    const { organization, director } = await entity();
    const first = await publishStudioInitiative(db, director, organization.id, { draft: budget(), expectedGoalCents: 587_400 });
    const before = await db.initiative.findUniqueOrThrow({ where: { id: first.initiativeId } });

    const again = await publishStudioInitiative(db, director, organization.id, {
      draft: budget({ initiativeId: first.initiativeId, description: 'Nueva descripción', plaqueEnabled: false, rewardText: 'Otro premio', costMatCents: 1, title: 'Otro título', closesOn: defaultCloseOn(new Date(), 10) }),
      expectedGoalCents: 587_400
    });
    expect(again).toEqual({ initiativeId: first.initiativeId, published: false });
    const after = await db.initiative.findUniqueOrThrow({ where: { id: first.initiativeId } });
    expect(after).toMatchObject({ description: 'Nueva descripción', plaqueEnabled: false, rewardText: 'Otro premio', title: before.title, costMatCents: before.costMatCents, goalCents: before.goalCents });
    expect(after.closesAt.getTime()).toBe(before.closesAt.getTime());
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).exemptRemainingCents).toBe(0);

    const soft = await saveStudioDraft(db, director, organization.id, budget({ initiativeId: first.initiativeId, description: 'Una más' }));
    expect(soft.status).toBe('FUNDRAISING');
    // Pasar una campaña recaudando a otro formato no se admite.
    expect((await reason(saveStudioDraft(db, director, organization.id, { ...raffle(), initiativeId: first.initiativeId }))).reason).toBe('NOT_EDITABLE');
  });

  it('una campaña cerrada no admite ningún cambio', async () => {
    const { organization, director } = await entity();
    const closed = await createInitiative(db, organization.id, { status: 'CLOSED', title: 'Cerrada' });
    expect((await reason(saveStudioDraft(db, director, organization.id, budget({ initiativeId: closed.id })))).reason).toBe('NOT_EDITABLE');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: closed.id } })).title).toBe('Cerrada');
  });

  it('guardar y publicar a la vez deja la campaña coherente: lo recaudando nunca se queda con la mitad de otro presupuesto', async () => {
    const { organization, director } = await entity();
    const saved = await saveStudioDraft(db, director, organization.id, budget());
    const results = await Promise.allSettled([
      publishStudioInitiative(db, director, organization.id, { draft: budget({ initiativeId: saved.initiativeId }), expectedGoalCents: saved.goalCents }),
      saveStudioDraft(db, director, organization.id, budget({ initiativeId: saved.initiativeId, costMatCents: 100_000, costInstCents: 0 }))
    ]);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StudioError);
    }
    const row = await db.initiative.findUniqueOrThrow({ where: { id: saved.initiativeId } });
    const board = storedBudgetBoard(row);
    expect(board.netCents + board.bracketFeeCents + board.maintFeeCents + board.gatewayFeeCents).toBe(row.goalCents);
    expect(row.goalCents).toBeGreaterThan(0);
  });
});

describe('rifas y taquilla', () => {
  it('una rifa no se publica sin premios ni sin la confirmación de normativa', async () => {
    const { organization, director } = await entity();
    const error = await reason(publishStudioInitiative(db, director, organization.id, { draft: raffle({ rafflePrizeCount: null, raffleNoticeConfirmed: false }), expectedGoalCents: 100_000 }));
    expect(error.reason).toBe('BLOCKED');
    expect(error.detail).toEqual(expect.arrayContaining(['RAFFLE_PRIZES', 'RAFFLE_NOTICE']));
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'studio.raffle_notice_confirmed' } })).toBe(0);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: error.initiativeId! } })).status).toBe('BUDGETING');
  });

  it('con los premios y la confirmación se publica: los premios quedan fijados, la meta es la recaudación del aforo y la confirmación está en la auditoría', async () => {
    const { organization, director } = await entity();
    const result = await publishStudioInitiative(db, director, organization.id, { draft: raffle(), expectedGoalCents: 100_000 });
    expect(result.published).toBe(true);
    const row = await db.initiative.findUniqueOrThrow({ where: { id: result.initiativeId } });
    expect(row).toMatchObject({ status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'RAFFLE', rafflePrizeCount: 3, ticketMax: 500, ticketPriceCents: 200, goalCents: 100_000, category: TICKETING_CATEGORY, defaultExemptAppliedCents: 0 });
    const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: 'studio.raffle_notice_confirmed' } });
    expect(audit.metadataJson).toMatchObject({ initiativeId: result.initiativeId, prizes: 3 });
    // Publicada, los premios ya no se cambian: el trigger de la base de datos lo impide y el Estudio ni lo intenta.
    await saveStudioDraft(db, director, organization.id, raffle({ initiativeId: result.initiativeId, rafflePrizeCount: 9 }));
    expect((await db.initiative.findUniqueOrThrow({ where: { id: result.initiativeId } })).rafflePrizeCount).toBe(3);
  });

  it('en `INC` la meta es lo que entra de verdad en la hucha; sin importe para la hucha no se publica', async () => {
    const { organization, director } = await entity();
    const inc = await saveStudioDraft(db, director, organization.id, raffle({ ticketFeeMode: 'INC', ticketPriceCents: 500, ticketMax: 200 }));
    expect(inc.goalCents).toBe(200 * (500 - 55));
    const free = await reason(publishStudioInitiative(db, director, organization.id, { draft: raffle({ ticketPriceCents: 0 }), expectedGoalCents: 0 }));
    expect(free.detail).toContain('TICKET_PRICE_ZERO');
    const tooCheap = await reason(publishStudioInitiative(db, director, organization.id, { draft: raffle({ ticketFeeMode: 'INC', ticketPriceCents: 46 }), expectedGoalCents: 0 }));
    expect(tooCheap.detail).toContain('TICKET_FEE_EXCEEDS_PRICE');
  });

  it('un evento con entradas no pide premios ni confirmación', async () => {
    const { organization, director } = await entity();
    const result = await publishStudioInitiative(db, director, organization.id, { draft: raffle({ ticketSubtype: 'EVENT', rafflePrizeCount: null, raffleNoticeConfirmed: false, ticketMax: 100, ticketPriceCents: 500 }), expectedGoalCents: 50_000 });
    expect(result.published).toBe(true);
    const row = await db.initiative.findUniqueOrThrow({ where: { id: result.initiativeId } });
    expect(row).toMatchObject({ ticketSubtype: 'EVENT', rafflePrizeCount: null });
  });
});

describe('`publishInitiative` protege el cobro aunque el Estudio no se use', () => {
  it('rechaza una campaña sin meta (una idea convertida nace con meta 0), sin curso beneficiario o sin documentos verificados', async () => {
    const verified = await createOrganization(db, { kybStatus: 'VERIFIED' });
    const pending = await createOrganization(db, { kybStatus: 'PENDING' });
    const future = new Date(Date.now() + 20 * 86_400_000);
    const noGoal = await createInitiative(db, verified.id, { status: 'BUDGETING', goalCents: 0, closesAt: future });
    const noStage = await createInitiative(db, verified.id, { status: 'BUDGETING', stage: '', closesAt: future });
    const noKyb = await createInitiative(db, pending.id, { status: 'BUDGETING', closesAt: future });
    for (const initiative of [noGoal, noStage, noKyb]) await expect(publishInitiative(db, initiative.id)).rejects.toBeInstanceOf(InitiativeNotPublishableError);
    for (const initiative of [noGoal, noStage, noKyb]) expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('BUDGETING');
    const ok = await createInitiative(db, verified.id, { status: 'BUDGETING', closesAt: future });
    await expect(publishInitiative(db, ok.id)).resolves.toEqual({ published: true });
  });
});

describe('contexto del Estudio', () => {
  it('una categoría propia con el mismo nombre que una global manda sobre ella, y la de taquilla siempre está', async () => {
    const { organization } = await entity();
    await db.organizationCategory.create({ data: { organizationId: organization.id, name: 'Comunidad y Viajes', icon: '🚌', rule: 'BRACKETS', isCustom: true } });
    await db.organizationCategory.create({ data: { organizationId: organization.id, name: 'Equipamiento Extra', icon: '⚽', rule: 'BRACKETS', isCustom: true } });
    const context = await loadStudioContext(db, organization.id);
    expect(context.categories.find((category) => category.name === 'Comunidad y Viajes')).toMatchObject({ rule: 'BRACKETS', icon: '🚌' });
    expect(context.categories.map((category) => category.name)).toEqual(expect.arrayContaining(['Equipamiento Extra', TICKETING_CATEGORY]));
    expect(context.categories.filter((category) => category.name === 'Comunidad y Viajes')).toHaveLength(1);
    expect(context.kybVerified).toBe(true);
  });

  it('las reglas propias de la entidad (`customRules`) mandan sobre las globales en los tramos', async () => {
    const { organization } = await entity({ customRules: true, t1Bps: 100, t2Bps: 100, t3Bps: 100 });
    const context = await loadStudioContext(db, organization.id);
    expect(context.bracket.ratesBps).toEqual({ t1: 100, t2: 100, t3: 100 });
  });
});

describe('correcciones de la auditoría del 4.3', () => {
  it('guardar y publicar a la vez no publica algo distinto de lo aceptado: un evento nunca sale como rifa sin la confirmación de normativa', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { organization, director, cosigner } = await entity();
      const event = raffle({ ticketSubtype: 'EVENT', rafflePrizeCount: null, raffleNoticeConfirmed: false, ticketMax: 200, ticketPriceCents: 500 });
      const saved = await saveStudioDraft(db, director, organization.id, event);
      const results = await Promise.allSettled([
        publishStudioInitiative(db, director, organization.id, { draft: { ...event, initiativeId: saved.initiativeId }, expectedGoalCents: saved.goalCents }),
        saveStudioDraft(db, cosigner, organization.id, raffle({ initiativeId: saved.initiativeId, ticketMax: 200, ticketPriceCents: 500, rafflePrizeCount: 2, raffleNoticeConfirmed: false }))
      ]);
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StudioError);
      const row = await db.initiative.findUniqueOrThrow({ where: { id: saved.initiativeId } });
      if (row.status === 'FUNDRAISING') {
        // Se publicó lo que aceptó quien publicó (un evento); una rifa publicada sin su confirmación sería el fallo.
        expect(row.ticketSubtype).toBe('EVENT');
        expect(row.rafflePrizeCount).toBeNull();
      }
    }
  });

  it('una campaña publicada al 0 % no puede cambiar su texto a uno de equipamiento, y queda rastro', async () => {
    const { organization, director } = await entity();
    const exempt = budget({ category: 'Comunidad y Viajes', title: 'Excursión de fin de curso', description: 'Autocar y entradas' });
    const published = await publishStudioInitiative(db, director, organization.id, { draft: exempt, expectedGoalCents: (await saveStudioDraft(db, director, organization.id, exempt)).goalCents });
    const error = await reason(saveStudioDraft(db, director, organization.id, { ...exempt, initiativeId: published.initiativeId, description: '12 ventiladores y aire acondicionado' }));
    expect(error.reason).toBe('SEMANTIC_LOCK');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: published.initiativeId } })).description).toBe('Autocar y entradas');
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'studio.semantic_lock_after_publish' } })).toBe(1);
    // Un cambio de texto inocente sí se guarda.
    expect((await saveStudioDraft(db, director, organization.id, { ...exempt, initiativeId: published.initiativeId, description: 'Autocar, entradas y merienda' })).status).toBe('FUNDRAISING');
  });

  it('en taquilla no se guarda pasarela en la meta (ya la pagan los gastos de gestión): la liquidación no la restaría otra vez', async () => {
    const { organization, director } = await entity();
    const saved = await saveStudioDraft(db, director, organization.id, raffle());
    expect((await db.initiative.findUniqueOrThrow({ where: { id: saved.initiativeId } })).gatewayFeeCents).toBe(0);
  });

  it('al cambiar de curso la pizarra ya cuenta con el exento renovado, no cobra comisión sobre el del curso anterior', async () => {
    const { organization, director } = await entity({ quotaPeriod: '2020-2021', exemptRemainingCents: 0 });
    const saved = await saveStudioDraft(db, director, organization.id, budget());
    expect((await db.initiative.findUniqueOrThrow({ where: { id: saved.initiativeId } })).defaultExemptAppliedCents).toBe(100_000);
    expect(saved.goalCents).toBe(587_400);
  });

  it('seis creaciones a la vez con 17 borradores abiertos no pasan de 20', async () => {
    const { organization, director } = await entity();
    for (let index = 0; index < 17; index += 1) await createInitiative(db, organization.id, { status: 'BUDGETING' });
    await Promise.allSettled(Array.from({ length: 6 }, () => saveStudioDraft(db, director, organization.id, budget())));
    expect(await db.initiative.count({ where: { organizationId: organization.id, status: 'BUDGETING' } })).toBeLessThanOrEqual(MAX_OPEN_DRAFTS);
  });

  it('un identificador que no cabe en la base de datos responde como uno inexistente, no con un error del servidor', async () => {
    const { organization, director } = await entity();
    expect((await reason(saveStudioDraft(db, director, organization.id, budget({ initiativeId: 3_000_000_000 })))).reason).toBe('INVALID_INPUT');
    await expect(getStudioInitiative(db, director, organization.id, 3_000_000_000)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getPosterData(db, director, organization.id, 3_000_000_000)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('un título corto no se guarda con su motivo, y un borrador sin descripción sí se guarda pero no se publica', async () => {
    const { organization, director } = await entity();
    const short = await reason(saveStudioDraft(db, director, organization.id, budget({ title: 'Ab' })));
    expect(short).toMatchObject({ reason: 'PROBLEMS', detail: ['TITLE_MISSING'] });
    const blank = await reason(publishStudioInitiative(db, director, organization.id, { draft: budget({ description: '' }), expectedGoalCents: 587_400 }));
    expect(blank.reason).toBe('BLOCKED');
    expect(blank.detail).toContain('DESCRIPTION_MISSING');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: blank.initiativeId! } })).description).toBe('');
  });

  it('rechaza caracteres de dirección de texto en lo que sale en la ficha pública y el cartel', async () => {
    const { organization, director } = await entity();
    expect((await reason(saveStudioDraft(db, director, organization.id, budget({ title: 'Aulas\u202Eabc' })))).reason).toBe('INVALID_INPUT');
  });

  it('un evento cuyo mantenimiento no cubre lo recaudable no se publica', async () => {
    const { organization, director } = await entity({ maintActive: true });
    const error = await reason(publishStudioInitiative(db, director, organization.id, { draft: raffle({ ticketSubtype: 'EVENT', rafflePrizeCount: null, raffleNoticeConfirmed: false, ticketPriceCents: 100, ticketMax: 10 }), expectedGoalCents: 1000 }));
    expect(error.detail).toContain('MAINT_EXCEEDS_TAKINGS');
  });

  it('descartar un borrador lo cancela y libera su sitio; uno publicado o ajeno no se descarta', async () => {
    const { organization, director } = await entity();
    const other = await entity();
    const draft = await saveStudioDraft(db, director, organization.id, budget());
    await expect(discardStudioDraft(db, other.director, organization.id, draft.initiativeId)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(discardStudioDraft(db, other.director, other.organization.id, draft.initiativeId)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await discardStudioDraft(db, director, organization.id, draft.initiativeId);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: draft.initiativeId } })).status).toBe('CANCELLED');
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'studio.draft_discarded' } })).toBe(1);
    expect((await reason(discardStudioDraft(db, director, organization.id, draft.initiativeId))).reason).toBe('NOT_EDITABLE');
    const published = await publishStudioInitiative(db, director, organization.id, { draft: budget(), expectedGoalCents: 587_400 });
    expect((await reason(discardStudioDraft(db, director, organization.id, published.initiativeId))).reason).toBe('NOT_EDITABLE');
    // Un borrador cancelado ya no cuenta para el tope y no se puede editar.
    expect((await reason(saveStudioDraft(db, director, organization.id, budget({ initiativeId: draft.initiativeId })))).reason).toBe('NOT_EDITABLE');
  });
});
