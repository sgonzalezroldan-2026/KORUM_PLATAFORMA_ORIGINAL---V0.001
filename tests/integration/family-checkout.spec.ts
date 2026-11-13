import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signPaymentSimulator, verifyCheckoutResult } from '@/core/checkout/checkout-rules';
import { createDonationIntent } from '@/core/checkout/donation-intent.service';
import { getRaisedFromLedger } from '@/core/finance/ledger.service';
import { hashIpSubnet } from '@/core/security/device-signals';
import { reserveUnits } from '@/lib/rate-limit';
import { CHECKOUT_RULE } from '@/lib/rate-limit-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { getCheckoutContext, getCheckoutResult } from '@/repositories/checkout.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { startCheckout, type CheckoutStart } from '@/services/checkout/checkout.service';
import { settleSimulatedPayment } from '@/services/checkout/payment-simulator';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import type { PaymentProvider } from '@/services/payments/payment-provider';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/**
 * QA-F04 · QA-F07 · QA-F10 · Checkout de familias contra PostgreSQL real: la aportación pendiente, el NIF cifrado, la reserva de aforo, el
 * simulador que entrega la misma notificación firmada que Paycomet y los casos en que no se cobra (cerrada, agotada, sin página de pago fiable).
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-checkout' };
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let ipSequence = 0;
/** Entidades de este archivo: al terminar se retiran de la bandeja de salida sus emails sin enviar (recibos y pases con QR). La tarea
 * OUTBOX_DISPATCH de `email-outbox.spec.ts` envía todo lo pendiente del esquema compartido, y estos mensajes la harían agotar su tiempo. */
const createdOrganizations: string[] = [];
async function newOrganization(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, overrides);
  createdOrganizations.push(organization.id);
  return organization;
}

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: createdOrganizations }, status: 'PENDING' } });
  await db.$disconnect();
});

/** Cada prueba sale por su propia red: el límite de intentos por IP no se mezcla entre pruebas. */
const freshIp = () => {
  ipSequence += 1;
  return `10.${Math.floor(ipSequence / 250) % 250}.${ipSequence % 250}.7`;
};
const deps = (provider: PaymentProvider = mock, now?: Date) => ({ db, provider, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET, now });
const guest = { session: null, ip: '10.200.0.1' };

async function schoolSetup(organization: Parameters<typeof createOrganization>[1] = {}, initiative: Parameters<typeof createInitiative>[2] = {}) {
  const org = await newOrganization({ paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', vertical: 'SCHOOL', fullIntegrityCheckCents: 180, ...organization });
  const init = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 100_000, rewardEnabled: true, ...initiative });
  return { org, init };
}

const donation = (orgSlug: string, initiativeId: number, extra: Record<string, unknown> = {}) => ({
  kind: 'DONATION',
  orgSlug,
  initiativeId,
  locale: 'es',
  method: 'BIZUM',
  groupName: null,
  email: 'madre@familia.example',
  amountCents: 2_500,
  guaranteeCents: 0,
  fiscal: null,
  ...extra
});

function orderOf(result: CheckoutStart): string {
  expect(result.status).toBe('REDIRECT');
  if (result.status !== 'REDIRECT') throw new Error('sin redirección');
  return new URL(result.url, 'http://localhost').searchParams.get('pedido') ?? '';
}

async function approve(orgSlug: string, initiativeId: number, order: string, yes = true) {
  return settleSimulatedPayment(db, mock, { orgSlug, initiativeId, order, signature: signPaymentSimulator(TEST_HMAC_SECRET, order), approve: yes }, { hmacSecret: TEST_HMAC_SECRET, qrSecret: QR_SECRET });
}

describe('QA-F04 · donación de invitado', () => {
  it('solo con el email: aportación pendiente sin aportación voluntaria y redirección al simulador firmado', async () => {
    const { org, init } = await schoolSetup();
    const result = await startCheckout(deps(), donation(org.slug, init.id), { ...guest, ip: freshIp() });
    expect(result.status).toBe('REDIRECT');
    if (result.status !== 'REDIRECT') return;
    expect(result.url).toMatch(new RegExp(`^/${org.slug}/iniciativas/${init.id}/aportar/simulador\\?pedido=KD[0-9A-F]{16}&sig=[0-9a-f]{64}$`));
    const order = orderOf(result);
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(row).toMatchObject({ status: 'PENDING', type: 'DONATION', amountCents: 2_500, guaranteeContributionCents: 0, totalChargedCents: 2_500, guestEmail: 'madre@familia.example', userId: null, donorTaxIdEnc: null, paymentMethod: 'BIZUM' });
    // El pedido no lleva ni el email ni nada de la persona.
    expect(order).not.toMatch(/madre|familia/i);
    expect(mock.calls.at(-1)).toEqual({ operation: 'hosted', order, amountCents: 2_500 });
  });

  it('el pago confirmado asienta la donación y la aportación voluntaria, sube el avance y crea el curso del reto', async () => {
    const { org, init } = await schoolSetup();
    const order = orderOf(await startCheckout(deps(), donation(org.slug, init.id, { guaranteeCents: 180, groupName: '3º de Primaria' }), { ...guest, ip: freshIp() }));
    expect(await approve(org.slug, init.id, order)).toBe('SETTLED');

    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { ledgerJournals: { include: { entries: true } } } });
    expect(row).toMatchObject({ status: 'COMPLETED', totalChargedCents: 2_680, groupName: '3º de Primaria' });
    const payin = row.ledgerJournals.find((journal) => journal.kind === 'PAYIN_DONATION');
    expect(payin?.entries.map((entry) => [entry.account, entry.direction, entry.amountCents]).sort()).toEqual(
      [
        ['INITIATIVE_ESCROW', 'CREDIT', 2_500],
        ['KORUM_REVENUE_GUARANTEE', 'CREDIT', 180],
        ['PSP_CLEARING', 'DEBIT', 2_680]
      ].sort()
    );
    const initiative = await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true } });
    expect(initiative).toEqual({ raisedCents: 2_500, totalContributions: 1 });
    expect(await getRaisedFromLedger(db, init.id)).toBe(2_500);
    expect(await db.initiativeCourseProgress.findUniqueOrThrow({ where: { initiativeId_groupName: { initiativeId: init.id, groupName: '3º de Primaria' } } })).toMatchObject({ familiesCount: 1 });
    expect(await db.outboxMessage.count({ where: { idempotencyKey: `contribution.receipt:${row.id}` } })).toBe(1);
    // Repetir la confirmación no acredita dos veces.
    expect(await approve(org.slug, init.id, order)).toBe('NOT_PENDING');
    expect((await db.initiative.findUniqueOrThrow({ where: { id: init.id } })).raisedCents).toBe(2_500);
  });

  it('un grupo que no es de la entidad, o con el reto desactivado, se guarda sin grupo', async () => {
    const { org, init } = await schoolSetup();
    const invented = orderOf(await startCheckout(deps(), donation(org.slug, init.id, { groupName: 'Mamá de Lucas 3ºB' }), { ...guest, ip: freshIp() }));
    expect((await db.contribution.findUniqueOrThrow({ where: { paycometOrder: invented } })).groupName).toBeNull();
    const noChallenge = await schoolSetup({}, { rewardEnabled: false });
    const off = orderOf(await startCheckout(deps(), donation(noChallenge.org.slug, noChallenge.init.id, { groupName: '3º de Primaria' }), { ...guest, ip: freshIp() }));
    expect((await db.contribution.findUniqueOrThrow({ where: { paycometOrder: off } })).groupName).toBeNull();
  });

  it('con sesión, el recibo va a la cuenta aunque el navegador envíe otro email', async () => {
    const { org, init } = await schoolSetup();
    const user = await createUser(db);
    const order = orderOf(await startCheckout(deps(), donation(org.slug, init.id, { email: 'otra@persona.example' }), { session: { userId: user.id, email: user.email }, ip: freshIp() }));
    expect(await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } })).toMatchObject({ userId: user.id, guestEmail: null, canonicalEmail: user.email });
  });

  it('sin sesión y sin email, o con importes fuera de rango, no se crea nada', async () => {
    const { org, init } = await schoolSetup();
    const before = await db.contribution.count({ where: { initiativeId: init.id } });
    expect(await startCheckout(deps(), donation(org.slug, init.id, { email: null }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'email' });
    expect(await startCheckout(deps(), donation(org.slug, init.id, { email: 'no-es-un-email' }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'email' });
    expect(await startCheckout(deps(), donation(org.slug, init.id, { amountCents: 99 }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'amount' });
    expect(await startCheckout(deps(), donation(org.slug, init.id, { amountCents: 25.5 }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'amount' });
    expect(await startCheckout(deps(), donation(org.slug, init.id, { guaranteeCents: 5_001 }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'amount' });
    expect(await db.contribution.count({ where: { initiativeId: init.id } })).toBe(before);
  });
});

describe('QA-F04 · NIF opcional solo con certificado posible', () => {
  const fiscal = { taxId: '12345678Z', fullName: 'García López, María', provinceCode: '08' };

  it('con Ley 49/2002 verificada el NIF se guarda cifrado, con su HMAC, el nombre del Modelo 182 y la provincia', async () => {
    const { org, init } = await schoolSetup({ ley49: true, ley49VerifiedAt: new Date() });
    const order = orderOf(await startCheckout(deps(), donation(org.slug, init.id, { fiscal }), { ...guest, ip: freshIp() }));
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(row.donorTaxIdEnc).toBeTruthy();
    expect(row.donorTaxIdEnc).not.toContain('12345678Z');
    expect(row.donorTaxIdHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row).toMatchObject({ donorFullName: 'GARCÍA LÓPEZ, MARÍA', donorProvinceCode: '08', isTaxDeductible: true, donorTaxIdKeyVersion: 1 });
  });

  it('un NIF con la letra mal o una provincia inventada se rechazan sin crear nada', async () => {
    const { org, init } = await schoolSetup({ ley49: true, ley49VerifiedAt: new Date() });
    expect(await startCheckout(deps(), donation(org.slug, init.id, { fiscal: { ...fiscal, taxId: '12345678A' } }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'taxId' });
    expect(await startCheckout(deps(), donation(org.slug, init.id, { fiscal: { ...fiscal, provinceCode: '99' } }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'fiscal' });
    expect(await db.contribution.count({ where: { initiativeId: init.id } })).toBe(0);
  });

  it('con Ley 49 declarada pero sin verificar (o sin Ley 49) no se acepta el NIF', async () => {
    const declared = await schoolSetup({ ley49: true, ley49VerifiedAt: null });
    expect(await startCheckout(deps(), donation(declared.org.slug, declared.init.id, { fiscal }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'fiscal' });
    const none = await schoolSetup({ ley49: false });
    expect(await startCheckout(deps(), donation(none.org.slug, none.init.id, { fiscal }), { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'fiscal' });
  });
});

describe('Solo se paga lo que está abierto, y solo en su entidad', () => {
  it('fuera de plazo (aunque siga en FUNDRAISING), lograda, de otra entidad o con el formato equivocado: no se cobra', async () => {
    const late = await schoolSetup({}, { closesAt: new Date(Date.now() - 60_000) });
    expect(await startCheckout(deps(), donation(late.org.slug, late.init.id), { ...guest, ip: freshIp() })).toEqual({ status: 'CLOSED' });
    const reached = await schoolSetup({}, { status: 'GOAL_REACHED' });
    expect(await startCheckout(deps(), donation(reached.org.slug, reached.init.id), { ...guest, ip: freshIp() })).toEqual({ status: 'CLOSED' });
    const other = await schoolSetup();
    const mine = await schoolSetup();
    expect(await startCheckout(deps(), donation(mine.org.slug, other.init.id), { ...guest, ip: freshIp() })).toEqual({ status: 'CLOSED' });
    expect(await startCheckout(deps(), { ...donation(mine.org.slug, mine.init.id), kind: 'TICKET', quantity: 1 }, { ...guest, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'form' });
    expect(await db.contribution.count({ where: { initiativeId: { in: [late.init.id, reached.init.id, other.init.id, mine.init.id] } } })).toBe(0);
  });

  it('las lecturas del checkout no ven iniciativas de otra entidad ni el resultado de un pedido ajeno', async () => {
    const a = await schoolSetup();
    const b = await schoolSetup();
    await expect(getCheckoutContext(db, a.org.slug, b.init.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    const order = orderOf(await startCheckout(deps(), donation(b.org.slug, b.init.id), { ...guest, ip: freshIp() }));
    expect(await getCheckoutResult(db, a.org.slug, b.init.id, order)).toBeNull();
    expect(await getCheckoutResult(db, b.org.slug, b.init.id, order)).toMatchObject({ status: 'PENDING', type: 'DONATION' });
    expect(Object.keys((await getCheckoutResult(db, b.org.slug, b.init.id, order)) ?? {})).not.toContain('guestEmail');
  });

  it('un pago iniciado después de la fecha límite se devuelve entero aunque la campaña aún figure como abierta', async () => {
    const { org, init } = await schoolSetup();
    const now = new Date();
    const intent = await createDonationIntent(db, { organizationId: org.id, initiativeId: init.id, amountCents: 2_000, guaranteeCents: 0, buyer: { guestEmail: 'tarde@familia.example' }, groupName: null, fiscal: null, method: 'BIZUM', locale: 'es' }, { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, now);
    // La tarea de vencimiento aún no ha pasado: sigue en FUNDRAISING, pero el plazo terminó antes de iniciar el pago.
    await db.initiative.update({ where: { id: init.id }, data: { closesAt: new Date(now.getTime() - 1_000) } });
    const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: intent.paycometOrder, amountCents: 2_000 });
    expect(await handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET })).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect((await db.contribution.findUniqueOrThrow({ where: { id: intent.contributionId } })).status).toBe('REFUND_PENDING');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true } })).toEqual({ raisedCents: 0, totalContributions: 0 });
  });
});

describe('QA-F07 · taquilla: aforo atómico y Gastos de gestión digital', () => {
  async function eventSetup() {
    const org = await newOrganization({ paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', ticketFeeFixedCents: 45, ticketFeeBps: 200 });
    const init = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 200, ticketsSold: 196, ticketFeeMode: 'ADD', goalCents: 100_000, raisedCents: 98_000 });
    return { org, init };
  }
  const tickets = (orgSlug: string, initiativeId: number, quantity: number) => ({ kind: 'TICKET', orgSlug, initiativeId, locale: 'es', method: 'CARD', groupName: null, email: 'padre@familia.example', quantity });

  it('retiene las plazas con el precio de la base, ofrece las que quedan si no caben y el pase sale al confirmar', async () => {
    const { org, init } = await eventSetup();
    const order = orderOf(await startCheckout(deps(), tickets(org.slug, init.id, 2), { ...guest, ip: freshIp() }));
    // 2 × (5,00 € + 0,45 € + 2 %) = 2 × 5,55 €.
    expect(await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } })).toMatchObject({ type: 'TICKET', amountCents: 1_000, totalChargedCents: 1_110, ticketQuantity: 2, paymentMethod: 'CARD' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: init.id } })).ticketsHeld).toBe(2);
    expect(await startCheckout(deps(), tickets(org.slug, init.id, 3), { ...guest, ip: freshIp() })).toEqual({ status: 'SOLD_OUT', available: 2 });

    expect(await approve(org.slug, init.id, order)).toBe('SETTLED');
    const pass = await db.ticketPass.findFirstOrThrow({ where: { contribution: { paycometOrder: order } } });
    expect(pass.quantity).toBe(2);
    expect(await db.outboxMessage.count({ where: { templateKey: 'ticket.pass', idempotencyKey: { startsWith: 'ticket.pass:' }, toAddress: 'padre@familia.example' } })).toBeGreaterThanOrEqual(1);
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { ticketsSold: true, ticketsHeld: true } })).toEqual({ ticketsSold: 198, ticketsHeld: 0 });
  });

  it('un pago rechazado deja la compra fallida y devuelve las plazas al aforo (QA-F10)', async () => {
    const { org, init } = await eventSetup();
    const order = orderOf(await startCheckout(deps(), tickets(org.slug, init.id, 4), { ...guest, ip: freshIp() }));
    expect(await approve(org.slug, init.id, order, false)).toBe('SETTLED');
    expect((await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } })).status).toBe('FAILED');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { ticketsSold: true, ticketsHeld: true } })).toEqual({ ticketsSold: 196, ticketsHeld: 0 });
  });
});

describe('Página de pago, simulador y límites', () => {
  it('con cobros reales solo se redirige a Paycomet: otra URL deja la compra fallida y devuelve las plazas', async () => {
    const org = await newOrganization({ paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    const init = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 50, ticketFeeMode: 'ADD', goalCents: 25_000 });
    const hosted = vi.fn();
    const provider = { mode: 'sandbox', name: 'paycomet', startHostedPayment: hosted } as unknown as PaymentProvider;
    const input = { kind: 'TICKET', orgSlug: org.slug, initiativeId: init.id, locale: 'ca', method: 'BIZUM', groupName: null, email: 'avi@familia.example', quantity: 3 };

    hosted.mockImplementationOnce(async ({ order }: { order: string }) => ({ order, challengeUrl: 'https://paycomet.com.evil.example/pay' }));
    expect(await startCheckout(deps(provider), input, { ...guest, ip: freshIp() })).toEqual({ status: 'UNAVAILABLE' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: init.id } })).ticketsHeld).toBe(0);
    expect(await db.contribution.findFirstOrThrow({ where: { initiativeId: init.id } })).toMatchObject({ status: 'FAILED' });

    hosted.mockImplementationOnce(async ({ order, urlOk, locale }: { order: string; urlOk: string; locale: string }) => {
      // La vuelta de Paycomet es la página de resultado firmada, en el idioma de la persona.
      const url = new URL(urlOk);
      expect(url.pathname).toBe(`/ca/${org.slug}/iniciativas/${init.id}/aportar/resultado`);
      expect(verifyCheckoutResult(TEST_HMAC_SECRET, url.searchParams.get('pedido') ?? '', url.searchParams.get('sig') ?? '')).toBe(true);
      expect(locale).toBe('ca');
      return { order, challengeUrl: 'https://api.paycomet.com/gateway/form/abc' };
    });
    expect(await startCheckout(deps(provider), input, { ...guest, ip: freshIp() })).toEqual({ status: 'REDIRECT', url: 'https://api.paycomet.com/gateway/form/abc' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: init.id } })).ticketsHeld).toBe(3);
  });

  it('el simulador exige su firma y no confirma un pedido de otra iniciativa', async () => {
    const { org, init } = await schoolSetup();
    const other = await schoolSetup();
    const order = orderOf(await startCheckout(deps(), donation(org.slug, init.id), { ...guest, ip: freshIp() }));
    expect(await settleSimulatedPayment(db, mock, { orgSlug: org.slug, initiativeId: init.id, order, signature: 'f'.repeat(64), approve: true }, { hmacSecret: TEST_HMAC_SECRET, qrSecret: QR_SECRET })).toBe('INVALID');
    expect(await approve(other.org.slug, other.init.id, order)).toBe('INVALID');
    expect((await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } })).status).toBe('PENDING');
  });

  it('una misma red no puede retener más de un cuarto del aforo (200 plazas → 50): limita plazas, no pedidos', async () => {
    const org = await newOrganization({ paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    const init = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 200, ticketFeeMode: 'ADD', goalCents: 100_000 });
    const ip = freshIp();
    const buy = (quantity: number, network = ip) => startCheckout(deps(), { kind: 'TICKET', orgSlug: org.slug, initiativeId: init.id, locale: 'es', method: 'BIZUM', groupName: null, email: 'red@familia.example', quantity }, { ...guest, ip: network });
    expect((await buy(20)).status).toBe('REDIRECT');
    expect((await buy(20)).status).toBe('REDIRECT');
    // 200 plazas → tope de 50 por red: 40 + 20 no caben; 40 + 10 sí.
    expect(await buy(20)).toEqual({ status: 'RATE_LIMITED' });
    expect((await buy(10)).status).toBe('REDIRECT');
    expect(await buy(1)).toEqual({ status: 'RATE_LIMITED' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: init.id } })).ticketsHeld).toBe(50);
    // Otra red sigue pudiendo comprar.
    expect((await buy(5, freshIp())).status).toBe('REDIRECT');
  });

  it('una compra que no llega a reservar (sin plazas) no gasta el cupo de plazas de la red', async () => {
    const org = await newOrganization({ paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
    const init = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 200, ticketsSold: 190, ticketFeeMode: 'ADD', goalCents: 100_000 });
    const ip = freshIp();
    const buy = (quantity: number) => startCheckout(deps(), { kind: 'TICKET', orgSlug: org.slug, initiativeId: init.id, locale: 'es', method: 'BIZUM', groupName: null, email: 'red@familia.example', quantity }, { ...guest, ip });
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await buy(20)).toEqual({ status: 'SOLD_OUT', available: 10 });
    expect((await buy(10)).status).toBe('REDIRECT');
  });

  it('una donación cuenta en el ejercicio del cobro: iniciada en Nochevieja y cobrada pasada la medianoche es del año nuevo', async () => {
    const { org, init } = await schoolSetup({}, { closesAt: new Date('2027-02-01T00:00:00Z') });
    const intent = await createDonationIntent(db, { organizationId: org.id, initiativeId: init.id, amountCents: 2_000, guaranteeCents: 0, buyer: { guestEmail: 'nochevieja@familia.example' }, groupName: null, fiscal: null, method: 'BIZUM', locale: 'es' }, { keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, new Date('2026-12-31T22:58:00Z'));
    expect((await db.contribution.findUniqueOrThrow({ where: { id: intent.contributionId } })).fiscalYear).toBe(2026);
    const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: intent.paycometOrder, amountCents: 2_000, bankDateTime: '20261231230300' });
    expect(await handlePaymentWebhook(db, mock, rawBody, contentType, new Date('2026-12-31T23:03:00Z'), { qrSecret: QR_SECRET })).toEqual({ status: 200, outcome: 'PROCESSED' });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: intent.contributionId } })).toMatchObject({ status: 'COMPLETED', fiscalYear: 2027 });
  });

  it('un acto con toda la comunidad en la misma wifi: 200 aportaciones seguidas desde una red se cobran todas (Sprint 5.4)', async () => {
    const { org, init } = await schoolSetup();
    const ip = freshIp();
    const statuses: string[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      const results = await Promise.all(Array.from({ length: 20 }, () => startCheckout(deps(), donation(org.slug, init.id), { ...guest, ip })));
      statuses.push(...results.map((result) => result.status));
    }
    expect(statuses).toHaveLength(200);
    expect(statuses.every((status) => status === 'REDIRECT')).toBe(true);
    expect(await db.contribution.count({ where: { initiativeId: init.id } })).toBe(200);
  });

  it('el freno contra automatismos sigue ahí: agotado el cupo de la red (600 en 15 minutos) se para sin crear aportaciones, y otra red no se ve afectada', async () => {
    const { org, init } = await schoolSetup();
    const ip = freshIp();
    const key = `${CHECKOUT_RULE.prefix}${hashIpSubnet(TEST_HMAC_SECRET, ip)}`;
    expect(CHECKOUT_RULE.limit).toBe(600);
    // Se consume de golpe todo el cupo menos un intento, en vez de hacer 599 pagos de verdad.
    expect(await reserveUnits(db, key, CHECKOUT_RULE, CHECKOUT_RULE.limit - 1, new Date())).toBe(true);
    expect((await startCheckout(deps(), donation(org.slug, init.id), { ...guest, ip })).status).toBe('REDIRECT');
    expect(await startCheckout(deps(), donation(org.slug, init.id), { ...guest, ip })).toEqual({ status: 'RATE_LIMITED' });
    expect(await db.contribution.count({ where: { initiativeId: init.id } })).toBe(1);
    expect((await startCheckout(deps(), donation(org.slug, init.id), { ...guest, ip: freshIp() })).status).toBe('REDIRECT');
  });
});
