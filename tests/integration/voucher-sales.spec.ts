import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPaymentSimulator } from '@/core/checkout/checkout-rules';
import { toDetailData, type InitiativeRow } from '@/core/public/view-model';
import { computeStudioBoard } from '@/core/studio/studio-board';
import { blankStudioDraft, defaultCloseOn, endOfDayInMadrid, TICKETING_CATEGORY, type StudioDraft } from '@/core/studio/studio-draft';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { getCheckoutResult } from '@/repositories/checkout.repository';
import { getPassForView, getPublicInitiative } from '@/repositories/public.repository';
import { loadStudioContext } from '@/repositories/studio.repository';
import type { SessionActor } from '@/repositories/tenant-guard';
import { startCheckout, type CheckoutStart } from '@/services/checkout/checkout.service';
import { settleSimulatedPayment } from '@/services/checkout/payment-simulator';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { publishStudioInitiative, saveStudioDraft, StudioError } from '@/services/panel/studio.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/**
 * Sprint 5.14b · La venta de vales de punta a punta contra PostgreSQL real (QA-VAL03): el Estudio la guarda y la publica con su validez, su tope o su objetivo
 * y su tarifa por compra; la ficha pública la lee; el pago reserva vales o, con la venta agotada, la aportación «sin producto»; el cobro confirmado deja en la
 * bandeja el email del pase (con el QR y los vales) o el recibo «sin producto», y la vuelta del pago y el pase se leen con sus datos de vales.
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-vales-5-14b-0123';
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-vales-5-14b' };
const DAY = 86_400_000;
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let ipSequence = 0;
const created: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
  await db.globalCategory.upsert({ where: { name: TICKETING_CATEGORY }, create: { name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT', sortOrder: 6 }, update: { rule: 'EXEMPT' } });
});

afterAll(async () => {
  // La tarea OUTBOX_DISPATCH de otro archivo envía lo pendiente del esquema compartido: los pases y recibos de este no deben quedarse en la bandeja.
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: created }, status: 'PENDING' } });
  await db.$disconnect();
});

const actorFor = (userId: string, organizationId: string, role: MemberRole): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor: true });
const freshIp = () => {
  ipSequence += 1;
  return `10.214.${ipSequence % 250}.9`;
};
const deps = () => ({ db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET });

/** Entidad verificada con tarifa propia de vales (0,45 € + 2 % por compra) y su persona firmante. */
async function entity(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, { kybStatus: 'VERIFIED', customRules: true, voucherFeeFixedCents: 45, voucherFeeBps: 200, paycometSplitId: uniqueId('split'), ...overrides });
  created.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
  return { organization, director: actorFor(director.id, organization.id, 'DIRECTOR') };
}

const closesOn = () => defaultCloseOn(new Date(), 20);
const sale = (overrides: Partial<StudioDraft> = {}): StudioDraft => ({
  ...blankStudioDraft('TICKETING', 'SCHOOL', closesOn(), 'VOUCHER'),
  title: 'Vales de la merienda solidaria',
  description: 'Cada vale vale por una merienda en el puesto del AFA.',
  ticketPriceCents: 200,
  ticketMax: 300,
  ...overrides
});

async function studioError(promise: Promise<unknown>): Promise<StudioError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(StudioError);
  return error as StudioError;
}

async function publish(organizationId: string, actor: SessionActor, draft: StudioDraft) {
  const board = computeStudioBoard(await loadStudioContext(db, organizationId), draft);
  return publishStudioInitiative(db, actor, organizationId, { draft, expectedGoalCents: board.goalCents });
}

describe('Estudio · guardar y publicar una venta de vales', () => {
  it('con tope: se guarda como venta de vales con su validez al final del día elegido, su meta y sin reto por curso', async () => {
    const { organization, director } = await entity();
    const draft = sale({ rewardEnabled: true, voucherNoProductEnabled: true });
    const { initiativeId, published } = await publish(organization.id, director, draft);
    expect(published).toBe(true);
    const row = await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } });
    expect(row).toMatchObject({
      status: 'FUNDRAISING',
      format: 'TICKETING',
      category: TICKETING_CATEGORY,
      ticketSubtype: 'VOUCHER',
      ticketPriceCents: 200,
      ticketMax: 300,
      ticketFeeMode: 'ADD',
      ticketVenue: null,
      voucherTargetCount: null,
      voucherNoProductEnabled: true,
      goalCents: 60_000,
      gatewayFeeCents: 0,
      rewardEnabled: false,
      plaqueEnabled: false
    });
    expect(row.voucherValidUntil?.toISOString()).toBe(endOfDayInMadrid(draft.voucherValidOn!)!.toISOString());
  });

  it('sin tope: guarda el objetivo orientativo, deja el tope vacío y nunca guarda «sin producto» (no se agota)', async () => {
    const { organization, director } = await entity();
    const { initiativeId } = await publish(organization.id, director, sale({ voucherCapped: false, voucherTargetCount: 150, voucherNoProductEnabled: true }));
    const row = await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } });
    expect(row).toMatchObject({ status: 'FUNDRAISING', ticketMax: null, voucherTargetCount: 150, voucherNoProductEnabled: false, goalCents: 30_000 });
  });

  it('un colegio con ánimo de lucro puede vender vales, pero «sin producto» no se guarda aunque llegue marcado (decisión 65)', async () => {
    const { organization, director } = await entity({ legalForm: 'SCHOOL_OWNER', centerOwnership: 'PRIVATE' });
    expect((await loadStudioContext(db, organization.id)).forProfitSchool).toBe(true);
    const { initiativeId, published } = await publish(organization.id, director, sale({ voucherNoProductEnabled: true }));
    expect(published).toBe(true);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } })).voucherNoProductEnabled).toBe(false);
  });

  it('no guarda una validez anterior al cierre ni publica una venta sin objetivo', async () => {
    const { organization, director } = await entity();
    const before = await studioError(saveStudioDraft(db, director, organization.id, sale({ voucherValidOn: '2020-01-01' })));
    expect(before).toMatchObject({ reason: 'PROBLEMS', detail: ['VALIDITY_BEFORE_CLOSE'] });
    const noTarget = await studioError(publish(organization.id, director, sale({ voucherCapped: false, voucherTargetCount: 0 })));
    expect(noTarget.reason).toBe('BLOCKED');
    expect(noTarget.detail).toContain('VOUCHER_TARGET_ZERO');
  });

  it('una venta publicada no se convierte en un evento: solo se cambia lo que no mueve dinero', async () => {
    const { organization, director } = await entity();
    const draft = sale();
    const { initiativeId } = await publish(organization.id, director, draft);
    const asEvent = await studioError(saveStudioDraft(db, director, organization.id, { ...draft, initiativeId, ticketSubtype: 'EVENT' }));
    expect(asEvent.reason).toBe('NOT_EDITABLE');
    await saveStudioDraft(db, director, organization.id, { ...draft, initiativeId, description: 'Ahora también con bebida.', ticketPriceCents: 1 });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiativeId } })).toMatchObject({ description: 'Ahora también con bebida.', ticketPriceCents: 200, ticketSubtype: 'VOUCHER' });
  });

  it('la meta usa la tarifa de los vales: si cambia mientras se edita una venta con gastos incluidos, no se publica otra cifra', async () => {
    const { organization, director } = await entity();
    const draft = sale({ ticketFeeMode: 'INC' });
    const board = computeStudioBoard(await loadStudioContext(db, organization.id), draft);
    expect(board.goalCents).toBe((200 - 49) * 300);
    await db.organization.update({ where: { id: organization.id }, data: { voucherFeeFixedCents: 60 } });
    const stale = await studioError(publishStudioInitiative(db, director, organization.id, { draft, expectedGoalCents: board.goalCents }));
    expect(stale.reason).toBe('STALE_BOARD');
  });
});

/** Venta de vales ya publicada para probar el pago (sin pasar por el Estudio). */
async function openSale(overrides: Parameters<typeof createInitiative>[2] = {}) {
  const { organization } = await entity();
  const initiative = await createInitiative(db, organization.id, {
    status: 'FUNDRAISING',
    format: 'TICKETING',
    category: TICKETING_CATEGORY,
    title: 'Vales de la cantina',
    ticketSubtype: 'VOUCHER',
    ticketPriceCents: 200,
    ticketMax: 10,
    ticketFeeMode: 'ADD',
    goalCents: 2_000,
    voucherValidUntil: new Date(Date.now() + 40 * DAY),
    closesAt: new Date(Date.now() + 20 * DAY),
    ...overrides
  });
  return { organization, initiative };
}

const voucherPayload = (orgSlug: string, initiativeId: number, quantity: number, mode: 'VOUCHERS' | 'NO_PRODUCT' = 'VOUCHERS') => ({
  kind: 'VOUCHER',
  orgSlug,
  initiativeId,
  locale: 'es',
  method: 'BIZUM',
  groupName: null,
  email: 'familia@vales.example',
  quantity,
  mode
});

function orderOf(result: CheckoutStart): string {
  expect(result.status).toBe('REDIRECT');
  if (result.status !== 'REDIRECT') throw new Error('sin redirección');
  return new URL(result.url, 'http://localhost').searchParams.get('pedido') ?? '';
}

const approve = (orgSlug: string, initiativeId: number, order: string) =>
  settleSimulatedPayment(db, mock, { orgSlug, initiativeId, order, signature: signPaymentSimulator(TEST_HMAC_SECRET, order), approve: true }, { hmacSecret: TEST_HMAC_SECRET, qrSecret: QR_SECRET });

describe('pago de vales', () => {
  it('compra 3 vales: retiene, cobra con la gestión por compra, emite un solo pase y deja su email en la bandeja', async () => {
    const { organization, initiative } = await openSale();
    const order = orderOf(await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 3), { session: null, ip: freshIp() }));
    expect(order).toMatch(/^KV[0-9A-F]{16}$/);
    const pending = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(pending).toMatchObject({ type: 'TICKET', status: 'PENDING', ticketQuantity: 3, voucherNoProduct: false, amountCents: 600, totalChargedCents: 657, guestEmail: 'familia@vales.example' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).ticketsHeld).toBe(3);

    expect(await approve(organization.slug, initiative.id, order)).toBe('SETTLED');
    const result = await getCheckoutResult(db, organization.slug, initiative.id, order);
    expect(result).toMatchObject({ status: 'COMPLETED', voucherNoProduct: false, ticketPass: { subtype: 'VOUCHER', revokedAt: null }, initiative: { ticketSubtype: 'VOUCHER', ticketsSold: 3, ticketMax: 10 } });
    const pass = result!.ticketPass!;
    const message = await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `voucher.pass:${pending.id}` } });
    expect(message).toMatchObject({ templateKey: 'voucher.pass', toAddress: 'familia@vales.example', payloadJson: { passUuid: pass.uuid, serialCode: pass.serialCode, quantity: 3 } });
    // Una compra de vales no lleva el recibo de una donación.
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `contribution.receipt:${pending.id}` } })).toBe(0);

    const view = await getPassForView(db, organization.slug, pass.uuid);
    expect(view).toMatchObject({ subtype: 'VOUCHER', quantity: 3, checkedInCount: 0, initiative: { title: 'Vales de la cantina' } });
    expect(view!.initiative.voucherValidUntil).toBeInstanceOf(Date);
    // El pase de otra entidad no se lee con el nombre de esta.
    expect(await getPassForView(db, 'otra-entidad-que-no-existe', pass.uuid)).toBeNull();
  });

  it('«sin producto» solo con la venta agotada: antes responde que la venta cambió; después cobra sin vales y deja su recibo sin certificado', async () => {
    const { organization, initiative } = await openSale({ ticketMax: 2, goalCents: 400, voucherNoProductEnabled: true });
    const early = await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 3, 'NO_PRODUCT'), { session: null, ip: freshIp() });
    expect(early).toEqual({ status: 'CHANGED' });

    expect(await approve(organization.slug, initiative.id, orderOf(await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 2), { session: null, ip: freshIp() })))).toBe('SETTLED');
    // Agotada: comprar más vales responde «agotado» con los que quedan.
    expect(await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 1), { session: null, ip: freshIp() })).toEqual({ status: 'SOLD_OUT', available: 0 });

    const order = orderOf(await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 3, 'NO_PRODUCT'), { session: null, ip: freshIp() }));
    const pending = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(pending).toMatchObject({ voucherNoProduct: true, ticketQuantity: null, ticketHoldUntil: null, amountCents: 600, totalChargedCents: 657 });
    expect(await approve(organization.slug, initiative.id, order)).toBe('SETTLED');
    const result = await getCheckoutResult(db, organization.slug, initiative.id, order);
    expect(result).toMatchObject({ status: 'COMPLETED', voucherNoProduct: true, ticketPass: null });
    const receipt = await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `voucher.noProductReceipt:${pending.id}` } });
    expect(receipt).toMatchObject({ templateKey: 'voucher.noProductReceipt', payloadJson: { equivalentVouchers: 3, amountCents: 600, feeCents: 57, guaranteeCents: 0, totalCents: 657, reference: order } });
    expect(await db.outboxMessage.count({ where: { idempotencyKey: { in: [`voucher.pass:${pending.id}`, `contribution.receipt:${pending.id}`] } } })).toBe(0);
  });

  it('en INC, el recibo «sin producto» se mide con lo cobrado por los vales y la gestión va dentro', async () => {
    const { organization, initiative } = await openSale({ ticketMax: 1, goalCents: 151, ticketFeeMode: 'INC', voucherNoProductEnabled: true, ticketsSold: 1 });
    const order = orderOf(await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 4, 'NO_PRODUCT'), { session: null, ip: freshIp() }));
    expect(await approve(organization.slug, initiative.id, order)).toBe('SETTLED');
    const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(contribution).toMatchObject({ amountCents: 800 - 61, totalChargedCents: 800 });
    const receipt = await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `voucher.noProductReceipt:${contribution.id}` } });
    expect(receipt.payloadJson).toMatchObject({ equivalentVouchers: 4, amountCents: 739, feeCents: 61, totalCents: 800 });
  });

  it('cada pago va por su camino: vales a un evento o entradas a una venta de vales no se cobran; pasada la validez, tampoco', async () => {
    const { organization, initiative } = await openSale();
    const event = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'TICKETING', category: TICKETING_CATEGORY, ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 10, ticketFeeMode: 'ADD', goalCents: 5_000 });
    expect(await startCheckout(deps(), voucherPayload(organization.slug, event.id, 1), { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'form' });
    const asTicket = { ...voucherPayload(organization.slug, initiative.id, 1), kind: 'TICKET', mode: undefined };
    expect(await startCheckout(deps(), asTicket, { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'form' });
    await db.initiative.update({ where: { id: initiative.id }, data: { voucherValidUntil: new Date(Date.now() - 1_000) } });
    expect(await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 1), { session: null, ip: freshIp() })).toEqual({ status: 'CLOSED' });
    expect(await startCheckout(deps(), voucherPayload(organization.slug, initiative.id, 51), { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'quantity' });
  });
});

describe('ficha pública', () => {
  it('lee la venta con su validez, su tarifa de vales y la forma jurídica, y la convierte en la tarjeta de vales', async () => {
    const { organization, initiative } = await openSale({ ticketsSold: 4, raisedCents: 800, totalContributions: 2 });
    const row = await getPublicInitiative(db, organization.slug, initiative.id);
    const { organization: context, ...rest } = row;
    expect(context).toMatchObject({ voucherFeeFixedCents: 45, voucherFeeBps: 200 });
    // Como `withPricingFacts` del portal: el repositorio solo devuelve iniciativas públicas, así que el estado es uno de los públicos.
    const detail = toDetailData({ ...rest, costMatCents: 0, costInstCents: 0, contingencyBps: 0, bracketFeeCents: 0, maintFeeCents: 0, quotaReservedAt: null } as InitiativeRow, context, new Date());
    expect(detail.ticket).toBeNull();
    expect(detail.card.voucher).toMatchObject({ capped: true, units: 10, available: 6, buyerOneCents: 249, noProduct: false });
    expect(detail.card.pct).toBe(40);
  });
});
