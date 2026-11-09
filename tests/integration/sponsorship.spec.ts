import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPaymentSimulator, verifyCheckoutResult } from '@/core/checkout/checkout-rules';
import { getRaisedFromLedger } from '@/core/finance/ledger.service';
import { sortSponsorsByLevel } from '@/core/sponsors/sponsorship-rules';
import { openSponsorTaxId } from '@/core/tax/tax-id-vault';
import type { KorumPrismaClient } from '@/lib/prisma';
import { findSponsorableInitiative, getSponsorshipContext, getSponsorshipDocuments, getSponsorshipResult, listFriendlySponsors } from '@/repositories/sponsorship.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { settleSimulatedPayment } from '@/services/checkout/payment-simulator';
import { startSponsorship, type SponsorshipStart } from '@/services/checkout/sponsorship.service';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { refundContribution } from '@/services/payments/payment-reversals';
import type { PaymentProvider } from '@/services/payments/payment-provider';
import { createInitiative, createOrganization, createTestClient, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/**
 * QA-F05 · Patrocinio de comercios contra PostgreSQL real: el patrocinio y su cobro pendientes, el nivel validado en servidor, el asiento con el 100 %
 * íntegro más el fee y el IVA encima, la factura del fee, la bolsa Matching 2x, el cobro tardío que se devuelve entero y el directorio público que solo
 * enseña lo aprobado y vigente, sin importes.
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const ISSUER = 'A58818501';
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-patrocinios' };
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let ipSequence = 0;
const createdOrganizations: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: createdOrganizations }, status: 'PENDING' } });
  await db.$disconnect();
});

// Rango propio (172.20.x.x): el límite de intentos agrupa por subred y comparte la base con `family-checkout.spec.ts` (10.x.x.x), cuyas pruebas
// de límite se romperían si estas gastaran sus contadores.
const freshIp = () => {
  ipSequence += 1;
  // Cada llamada, una subred /24 distinta (el tercer octeto cambia): así los intentos de una prueba no cuentan para otra.
  return `172.${20 + (Math.floor(ipSequence / 250) % 10)}.${ipSequence % 250}.9`;
};
const deps = (provider: PaymentProvider = mock) => ({ db, provider, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET });
const invoicing = { issuerTaxId: ISSUER, issuerName: 'KORUM Pruebas, S.L.', keyring: TEST_KEYRING };

async function setup(initiative: Parameters<typeof createInitiative>[2] = {}, organization: Parameters<typeof createOrganization>[1] = {}) {
  const org = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', vertical: 'SCHOOL', ...organization });
  createdOrganizations.push(org.id);
  const init = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, ...initiative });
  return { org, init };
}

const sponsorship = (orgSlug: string, initiativeId: number, extra: Record<string, unknown> = {}) => ({
  orgSlug,
  initiativeId,
  locale: 'es',
  method: 'BIZUM',
  tierCents: 25_000,
  matchingPool: false,
  businessName: 'Panadería La Espiga',
  taxId: 'B-12345674',
  contactPerson: 'Marta López',
  phone: '600 11 22 33',
  email: 'Marta@LaEspiga.example',
  sector: 'Panadería',
  promo: '10 % en pan',
  promoCode: 'cervantes10',
  autoRenew: true,
  ...extra
});

function orderOf(result: SponsorshipStart): string {
  expect(result.status).toBe('REDIRECT');
  if (result.status !== 'REDIRECT') throw new Error('sin redirección');
  return new URL(result.url, 'http://localhost').searchParams.get('pedido') ?? '';
}

async function settle(orgSlug: string, initiativeId: number, order: string, options: { approve?: boolean; withInvoicing?: boolean } = {}) {
  return settleSimulatedPayment(
    db,
    mock,
    { orgSlug, initiativeId, order, signature: signPaymentSimulator(TEST_HMAC_SECRET, order), approve: options.approve ?? true },
    { hmacSecret: TEST_HMAC_SECRET, qrSecret: QR_SECRET, invoicing: options.withInvoicing === false ? undefined : invoicing }
  );
}

describe('QA-F05 · inicio del patrocinio', () => {
  it('crea el comercio y su cobro pendientes con el fee y el IVA encima, el CIF cifrado y el nivel que elige la entidad', async () => {
    const { org, init } = await setup();
    const result = await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() });
    expect(result.status).toBe('REDIRECT');
    if (result.status !== 'REDIRECT') return;
    expect(result.url).toMatch(new RegExp(`^/${org.slug}/iniciativas/${init.id}/aportar/simulador\\?pedido=KS[0-9A-F]{16}&sig=[0-9a-f]{64}$`));

    const order = orderOf(result);
    const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: true } });
    expect(contribution).toMatchObject({ type: 'SPONSORSHIP', status: 'PENDING', amountCents: 25_000, totalChargedCents: 29_538, guaranteeContributionCents: 0, guestEmail: 'marta@laespiga.example', paymentMethod: 'BIZUM' });
    expect(contribution.sponsor).toMatchObject({ status: 'PENDING', categoryLevel: 'PLATA', tierRank: 2, amountCents: 25_000, feeGeneratedCents: 3_750, isMatchingPool: false, code: 'CERVANTES10', paidAt: null, autoRenew: true });
    // El CIF no se guarda en claro y solo se abre con el contexto de su entidad.
    expect(contribution.sponsor?.cifEnc).not.toContain('B12345674');
    expect(openSponsorTaxId(TEST_KEYRING, { organizationId: org.id, cifEnc: contribution.sponsor?.cifEnc ?? '', cifKeyVersion: contribution.sponsor?.cifKeyVersion ?? null })).toBe('B12345674');
    expect(mock.calls.at(-1)).toEqual({ operation: 'hosted', order, amountCents: 29_538 });
    // Todavía no se ha movido dinero: ni asiento ni avance.
    expect(await db.ledgerJournal.count({ where: { contributionId: contribution.id } })).toBe(0);
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true } })).toEqual({ raisedCents: 0 });
  });

  it('asigna ORO, PLATA o BRONCE según el nivel elegido', async () => {
    const { org, init } = await setup();
    const levels: Array<[number, string]> = [[50_000, 'ORO'], [25_000, 'PLATA'], [10_000, 'BRONCE']];
    for (const [tierCents, expected] of levels) {
      const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id, { tierCents }), { session: null, ip: freshIp() }));
      const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: true } });
      expect(row.sponsor?.categoryLevel).toBe(expected);
    }
  });

  it('respeta las condiciones propias de la entidad: sus niveles y su fee', async () => {
    const { org, init } = await setup({}, { sponsorTiersCents: [5_000, 12_000, 30_000], sponsorFeeBps: 1_000 });
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id, { tierCents: 12_000 }), { session: null, ip: freshIp() }));
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    // 120,00 € + 10 % (12,00 €) + 21 % de IVA sobre el fee (2,52 €).
    expect(row.totalChargedCents).toBe(12_000 + 1_200 + 252);
    expect(await startSponsorship(deps(), sponsorship(org.slug, init.id, { tierCents: 25_000 }), { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'tier' });
  });

  it('rechaza un importe que no es uno de los niveles, un CIF inválido y datos mal formados, sin crear nada', async () => {
    const { org, init } = await setup();
    const before = await db.sponsor.count({ where: { organizationId: org.id } });
    expect(await startSponsorship(deps(), sponsorship(org.slug, init.id, { tierCents: 26_000 }), { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'tier' });
    expect(await startSponsorship(deps(), sponsorship(org.slug, init.id, { taxId: 'B12345679' }), { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'taxId' });
    expect(await startSponsorship(deps(), sponsorship(org.slug, init.id, { email: 'sin-arroba' }), { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'email' });
    expect(await startSponsorship(deps(), 'basura', { session: null, ip: freshIp() })).toMatchObject({ status: 'INVALID' });
    expect(await db.sponsor.count({ where: { organizationId: org.id } })).toBe(before);
  });

  it('no admite patrocinios en una campaña cerrada, de taquilla o de otra entidad', async () => {
    const { org, init } = await setup({ status: 'GOAL_REACHED' });
    expect(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() })).toEqual({ status: 'CLOSED' });
    const tickets = await setup({ format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 50 });
    expect(await startSponsorship(deps(), sponsorship(tickets.org.slug, tickets.init.id), { session: null, ip: freshIp() })).toEqual({ status: 'CLOSED' });
    const other = await setup();
    // La iniciativa de una entidad con el `orgSlug` de otra responde igual que una inexistente.
    expect(await startSponsorship(deps(), sponsorship(org.slug, other.init.id), { session: null, ip: freshIp() })).toEqual({ status: 'CLOSED' });
    expect(await db.sponsor.count({ where: { organizationId: { in: [org.id, tickets.org.id] } } })).toBe(0);
  });

  it('la bolsa Matching 2x solo admite un comercio por iniciativa', async () => {
    const { org, init } = await setup();
    const first = await startSponsorship(deps(), sponsorship(org.slug, init.id, { matchingPool: true }), { session: null, ip: freshIp() });
    expect(first.status).toBe('REDIRECT');
    expect(await startSponsorship(deps(), sponsorship(org.slug, init.id, { matchingPool: true }), { session: null, ip: freshIp() })).toEqual({ status: 'INVALID', field: 'matching' });
    // Un patrocinio directo sigue siendo posible.
    expect((await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() })).status).toBe('REDIRECT');
    expect((await getSponsorshipContext(db, org.slug, init.id)).matchingPoolTaken).toBe(true);
  });

  it('sin página de pago fiable no se cobra nada: el cobro queda fallido y el comercio sin pagar', async () => {
    const { org, init } = await setup();
    const broken = new MockPaycometProvider({ secrets });
    broken.startHostedPayment = async () => {
      throw new (await import('@/services/payments/payment-provider')).PaymentProviderError('caído', 'DOWN');
    };
    expect(await startSponsorship(deps(broken), sponsorship(org.slug, init.id), { session: null, ip: freshIp() })).toEqual({ status: 'UNAVAILABLE' });
    const row = await db.contribution.findFirstOrThrow({ where: { organizationId: org.id }, include: { sponsor: true } });
    expect(row.status).toBe('FAILED');
    expect(row.sponsor?.paidAt).toBeNull();
  });

  it('limita los inicios por red como el checkout de familias', async () => {
    const { org, init } = await setup();
    const ip = freshIp();
    let limited = false;
    for (let attempt = 0; attempt < 32 && !limited; attempt += 1) {
      limited = (await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip })).status === 'RATE_LIMITED';
    }
    expect(limited).toBe(true);
  });
});

describe('QA-F05 · cobro confirmado', () => {
  it('asienta el 100 % del nivel en la hucha, el fee y el IVA como ingresos de KORUM, y emite la factura del fee', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    expect(await settle(org.slug, init.id, order)).toBe('SETTLED');

    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: { include: { invoices: true } }, ledgerJournals: { include: { entries: true } } } });
    expect(row.status).toBe('COMPLETED');
    const payin = row.ledgerJournals.find((journal) => journal.kind === 'PAYIN_SPONSOR');
    expect(payin?.entries.map((entry) => [entry.account, entry.direction, entry.amountCents]).sort()).toEqual(
      [
        ['INITIATIVE_ESCROW', 'CREDIT', 25_000],
        ['KORUM_REVENUE_SPONSOR_FEE', 'CREDIT', 3_750],
        ['PSP_CLEARING', 'DEBIT', 29_538],
        ['TAX_PAYABLE_VAT', 'CREDIT', 788]
      ].sort()
    );
    // El patrocinio sigue pendiente de que el centro lo apruebe: ni se muestra ni se activa por haber pagado.
    expect(row.sponsor).toMatchObject({ status: 'PENDING' });
    expect(row.sponsor?.paidAt).toBeInstanceOf(Date);
    expect(row.sponsor?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);

    // La hucha y el recuento ("💛 aportaciones") suben con el importe íntegro, no con el fee.
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true, firstPayinAt: true } })).toMatchObject({ raisedCents: 25_000, totalContributions: 1 });
    expect(await getRaisedFromLedger(db, init.id)).toBe(25_000);

    // Factura de KORUM por el fee: base 37,50 €, IVA 7,88 €, total 45,38 €, enlazada al comercio y con su NIF cifrado con el número de factura.
    expect(row.sponsor?.invoices).toHaveLength(1);
    const invoice = row.sponsor?.invoices[0];
    expect(invoice).toMatchObject({ baseAmountCents: 3_750, taxRateBps: 2_100, taxAmountCents: 788, totalAmountCents: 4_538, issuerTaxId: ISSUER, verifactuStatus: 'PENDING', organizationId: org.id });
    expect(invoice?.recipientTaxIdEnc).not.toContain('B12345674');
  });

  it('confirmar dos veces la misma notificación no duplica el asiento, el avance ni la factura', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    await settle(org.slug, init.id, order);
    expect(await settle(org.slug, init.id, order)).toBe('NOT_PENDING');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true } })).toEqual({ raisedCents: 25_000, totalContributions: 1 });
    expect(await db.invoice.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('un pago rechazado no mueve dinero ni emite factura', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    expect(await settle(org.slug, init.id, order, { approve: false })).toBe('SETTLED');
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: true } });
    expect(row.status).toBe('FAILED');
    expect(row.sponsor?.paidAt).toBeNull();
    expect(await db.ledgerJournal.count({ where: { contributionId: row.id } })).toBe(0);
    expect(await db.invoice.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it('sin NIF emisor no se asienta un fee que no se pueda facturar: la notificación falla y se puede reintentar', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    expect(await settle(org.slug, init.id, order, { withInvoicing: false })).toBe('INVALID');
    const pending = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(pending.status).toBe('PENDING');
    expect(await db.ledgerJournal.count({ where: { contributionId: pending.id } })).toBe(0);
    // Con el NIF configurado, la misma notificación se procesa.
    expect(await settle(org.slug, init.id, order)).toBe('SETTLED');
    expect((await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } })).status).toBe('COMPLETED');
  });

  it('la bolsa Matching 2x queda en el pasivo del comercio sin sumar a lo recaudado ni activar la bolsa hasta que el centro lo apruebe', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id, { matchingPool: true }), { session: null, ip: freshIp() }));
    await settle(org.slug, init.id, order);
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: true, ledgerJournals: { include: { entries: true } } } });
    const payin = row.ledgerJournals.find((journal) => journal.kind === 'PAYIN_SPONSOR');
    expect(payin?.entries.find((entry) => entry.account === 'MATCHING_POOL')).toMatchObject({ direction: 'CREDIT', amountCents: 25_000, sponsorId: row.sponsor?.id, initiativeId: init.id });
    expect(payin?.entries.find((entry) => entry.account === 'INITIATIVE_ESCROW')).toBeUndefined();
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true, matchingPoolTotalCents: true, matchingPoolRemainingCents: true } })).toEqual({
      raisedCents: 0,
      totalContributions: 1,
      matchingPoolTotalCents: 0,
      matchingPoolRemainingCents: 0
    });
  });

  it('un patrocinio que completa la meta pasa la iniciativa a GOAL_REACHED', async () => {
    const { org, init } = await setup({ goalCents: 25_000 });
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    await settle(org.slug, init.id, order);
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { status: true, raisedCents: true } })).toEqual({ status: 'GOAL_REACHED', raisedCents: 25_000 });
  });

  it('un cobro que llega con la campaña ya cerrada se devuelve entero: sin avance, sin factura y con el comercio como devuelto', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    await db.initiative.update({ where: { id: init.id }, data: { status: 'CLOSED' } });
    await settle(org.slug, init.id, order);

    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: true } });
    expect(row.status).toBe('REFUND_PENDING');
    expect(row.sponsor?.status).toBe('REFUNDED');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true } })).toEqual({ raisedCents: 0, totalContributions: 0 });
    expect(await db.invoice.count({ where: { organizationId: org.id } })).toBe(0);

    // La tarea de devoluciones lo recoge y devuelve el total cobrado (nivel + fee + IVA) al medio de pago original.
    const refunded = await refundContribution(db, mock, row.id, '10.0.0.1');
    expect(refunded.outcome).toBe('REFUNDED');
    expect((await db.contribution.findUniqueOrThrow({ where: { id: row.id } })).refundedCents).toBe(29_538);
    expect(await getRaisedFromLedger(db, init.id)).toBe(0);
  });
});

describe('QA-F05 · directorio y documentos', () => {
  async function approvedSponsor(organizationId: string, initiativeId: number, overrides: Record<string, unknown> = {}) {
    return db.sponsor.create({
      data: {
        organizationId,
        initiativeId,
        name: 'Comercio de pruebas',
        contactPerson: 'Persona',
        phone: '600000000',
        email: 'contacto@comercio.example',
        sector: 'Tienda',
        categoryLevel: 'PLATA',
        tierRank: 2,
        tierLabel: 'Patrocinio',
        amountCents: 25_000,
        feeGeneratedCents: 3_750,
        promo: 'Ventaja',
        code: 'CODIGO',
        status: 'APPROVED',
        expiresAt: new Date(Date.now() + 200 * 86_400_000),
        ...overrides
      }
    });
  }

  it('el directorio solo enseña comercios aprobados y vigentes de esa entidad, ordenados ORO > PLATA > BRONCE y sin importes', async () => {
    const { org, init } = await setup();
    const other = await setup();
    await approvedSponsor(org.id, init.id, { name: 'Bronce', categoryLevel: 'BRONCE', tierRank: 1 });
    await approvedSponsor(org.id, init.id, { name: 'Oro', categoryLevel: 'ORO', tierRank: 3 });
    await approvedSponsor(org.id, init.id, { name: 'Plata' });
    await approvedSponsor(org.id, init.id, { name: 'Pendiente', status: 'PENDING' });
    await approvedSponsor(org.id, init.id, { name: 'Rechazado', status: 'REJECTED' });
    await approvedSponsor(org.id, init.id, { name: 'Caducado', expiresAt: new Date(Date.now() - 86_400_000) });
    await approvedSponsor(other.org.id, other.init.id, { name: 'De otra entidad' });

    const list = await listFriendlySponsors(db, org.slug, new Date());
    expect(sortSponsorsByLevel(list).map((sponsor) => sponsor.name)).toEqual(['Oro', 'Plata', 'Bronce']);
    expect(list.map((sponsor) => sponsor.name)).toEqual(['Oro', 'Plata', 'Bronce']);
    for (const sponsor of list) {
      expect(Object.keys(sponsor).sort()).toEqual(['categoryLevel', 'code', 'id', 'logoFile', 'name', 'promo', 'sector', 'tierRank']);
    }
    expect(await listFriendlySponsors(db, 'no-existe', new Date())).toEqual([]);
  });

  it('propone para colaborar la iniciativa de presupuesto que antes cierra', async () => {
    const { org } = await setup({ closesAt: new Date(Date.now() + 40 * 86_400_000) });
    const sooner = await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, closesAt: new Date(Date.now() + 10 * 86_400_000) });
    await createInitiative(db, org.id, { status: 'FUNDRAISING', format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 10, closesAt: new Date(Date.now() + 2 * 86_400_000) });
    expect((await findSponsorableInitiative(db, org.slug, new Date()))?.id).toBe(sooner.id);
    const empty = await createOrganization(db);
    createdOrganizations.push(empty.id);
    expect(await findSponsorableInitiative(db, empty.slug, new Date())).toBeNull();
  });

  it('los documentos solo se leen con el pedido y la entidad correctos, y llevan la factura del fee', async () => {
    const { org, init } = await setup();
    const other = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    // Antes del cobro no hay nada que descargar.
    expect(await getSponsorshipDocuments(db, org.slug, order)).toBeNull();
    await settle(org.slug, init.id, order);

    const documents = await getSponsorshipDocuments(db, org.slug, order);
    expect(documents).toMatchObject({ amountCents: 25_000, totalChargedCents: 29_538, status: 'COMPLETED', organization: { legalName: org.legalName } });
    expect(documents?.sponsor?.invoices[0]).toMatchObject({ baseAmountCents: 3_750, totalAmountCents: 4_538 });
    expect(await getSponsorshipDocuments(db, other.org.slug, order)).toBeNull();
    // El enlace de vuelta del pago firma el pedido; un pedido ajeno no sirve con otra firma.
    expect(verifyCheckoutResult(TEST_HMAC_SECRET, order, 'a'.repeat(64))).toBe(false);
    const result = await getSponsorshipResult(db, org.slug, init.id, order);
    expect(result).toMatchObject({ status: 'COMPLETED', amountCents: 25_000, sponsor: { name: 'Panadería La Espiga', categoryLevel: 'PLATA' } });
    expect(await getSponsorshipResult(db, other.org.slug, init.id, order)).toBeNull();
  });

  it('la lectura del patrocinio de una iniciativa de otra entidad responde como una inexistente', async () => {
    const { org } = await setup();
    const other = await setup();
    await expect(getSponsorshipContext(db, org.slug, other.init.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('QA-F05 · bolsa Matching 2x: nadie la ocupa sin pagar', () => {
  it('un comercio que abandonó el pago hace horas no bloquea la bolsa; uno que está pagando ahora, sí', async () => {
    const { org, init } = await setup();
    await db.sponsor.create({
      data: { organizationId: org.id, initiativeId: init.id, name: 'Abandonado', contactPerson: 'X', phone: '600000000', email: 'x@comercio.example', sector: '', categoryLevel: 'PLATA', tierRank: 2, tierLabel: 'Patrocinio', amountCents: 25_000, feeGeneratedCents: 3_750, promo: '', code: '', isMatchingPool: true, status: 'PENDING', expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(Date.now() - 2 * 3_600_000) }
    });
    expect((await getSponsorshipContext(db, org.slug, init.id)).matchingPoolTaken).toBe(false);
    expect((await startSponsorship(deps(), sponsorship(org.slug, init.id, { matchingPool: true }), { session: null, ip: freshIp() })).status).toBe('REDIRECT');
    expect((await getSponsorshipContext(db, org.slug, init.id)).matchingPoolTaken).toBe(true);
  });

  it('dos comercios que piden la bolsa a la vez: solo uno la consigue', async () => {
    const { org, init } = await setup();
    const results = await Promise.all([1, 2, 3].map(() => startSponsorship(deps(), sponsorship(org.slug, init.id, { matchingPool: true }), { session: null, ip: freshIp() })));
    expect(results.filter((result) => result.status === 'REDIRECT')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'INVALID')).toHaveLength(2);
    expect(await db.sponsor.count({ where: { initiativeId: init.id, isMatchingPool: true } })).toBe(1);
  });
});

describe('QA-F05 · reversiones y concurrencia de un patrocinio', () => {
  const webhook = (notification: { rawBody: string; contentType: string }) => handlePaymentWebhook(db, mock, notification.rawBody, notification.contentType, new Date(), { qrSecret: QR_SECRET, invoicing });

  it('dos notificaciones del mismo cobro a la vez dejan un solo asiento, un solo avance y una sola factura', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    await Promise.all([settle(org.slug, init.id, order), settle(org.slug, init.id, order), settle(org.slug, init.id, order)]);
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(await db.ledgerJournal.count({ where: { contributionId: row.id, kind: 'PAYIN_SPONSOR' } })).toBe(1);
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true } })).toEqual({ raisedCents: 25_000, totalContributions: 1 });
    expect(await db.invoice.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('un contracargo en la hucha resta lo recaudado, devuelve la campaña a FUNDRAISING y retira al comercio', async () => {
    const { org, init } = await setup({ goalCents: 25_000 });
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    await settle(org.slug, init.id, order);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: init.id } })).status).toBe('GOAL_REACHED');

    expect((await webhook(mock.buildNotification({ kind: 'CHARGEBACK', order, amountCents: 29_538 }))).outcome).toBe('PROCESSED');
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: true } });
    expect(row.status).toBe('CHARGEBACK');
    expect(row.sponsor?.status).toBe('REFUNDED');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { status: true, raisedCents: true, totalContributions: true } })).toEqual({ status: 'FUNDRAISING', raisedCents: 0, totalContributions: 0 });
    expect(await getRaisedFromLedger(db, init.id)).toBe(0);
  });

  it('un contracargo de un patrocinio con bolsa no resta nada a lo recaudado, que nunca sumó', async () => {
    const { org, init } = await setup();
    const direct = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    const pool = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id, { matchingPool: true, tierCents: 10_000 }), { session: null, ip: freshIp() }));
    await settle(org.slug, init.id, direct);
    await settle(org.slug, init.id, pool);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true } })).raisedCents).toBe(25_000);

    const poolTotal = 10_000 + 1_500 + 315;
    expect((await webhook(mock.buildNotification({ kind: 'CHARGEBACK', order: pool, amountCents: poolTotal }))).outcome).toBe('PROCESSED');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true, totalContributions: true } })).toEqual({ raisedCents: 25_000, totalContributions: 1 });
    expect(await getRaisedFromLedger(db, init.id)).toBe(25_000);
  });

  it('una devolución confirmada por Paycomet resta lo recaudado y retira al comercio', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    await settle(org.slug, init.id, order);
    expect((await webhook(mock.buildNotification({ kind: 'REFUND', order, amountCents: 29_538 }))).outcome).toBe('PROCESSED');
    const row = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order }, include: { sponsor: true } });
    expect(row).toMatchObject({ status: 'REFUNDED', refundedCents: 29_538 });
    expect(row.sponsor?.status).toBe('REFUNDED');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: init.id }, select: { raisedCents: true } })).toEqual({ raisedCents: 0 });
  });

  it('un cobro tardío se devuelve aunque no haya NIF emisor: no necesita factura', async () => {
    const { org, init } = await setup();
    const order = orderOf(await startSponsorship(deps(), sponsorship(org.slug, init.id), { session: null, ip: freshIp() }));
    await db.initiative.update({ where: { id: init.id }, data: { status: 'CLOSED' } });
    expect(await settle(org.slug, init.id, order, { withInvoicing: false })).toBe('SETTLED');
    expect((await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } })).status).toBe('REFUND_PENDING');
  });
});
