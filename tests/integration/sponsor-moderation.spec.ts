import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyCheckoutResult } from '@/core/checkout/checkout-rules';
import { getAccountBalance, getRaisedFromLedger } from '@/core/finance/ledger.service';
import { purgeUnpaidSponsors } from '@/core/privacy/retention-purge';
import { computeSignatureHash, payoutDigestFor } from '@/core/security/signature-hash';
import { SponsorModerationError } from '@/core/sponsors/sponsor-moderation-rules';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { countPendingApprovals } from '@/repositories/sponsor-moderation.repository';
import { listFriendlySponsors } from '@/repositories/sponsorship.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { startSponsorship } from '@/services/checkout/sponsorship.service';
import { RectificationNotAllowedError, rectifyInvoice, verifyInvoiceChain } from '@/services/invoicing/invoice.service';
import { loadSponsorModeration } from '@/services/panel/sponsor-moderation-data';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { executePendingRefund } from '@/services/payments/payment-reversals';
import { approvePayout, PayoutNotAllowedError } from '@/services/payments/split-transfer.service';
import { approveSponsor, rejectSponsor } from '@/services/sponsors/sponsor-moderation.service';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { publishSponsorLogo, SponsorLogoRejectedError } from '@/services/storage/sponsor-logo.service';
import { containsText, jpegWithExif, SECRET_MARKERS } from './image-fixtures';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/**
 * Sprint 4.2b · Moderación de comercios amigos contra PostgreSQL real (QA-S02): aprobar activa el distintivo y, si la eligió, la bolsa Matching 2x en la
 * misma transacción; no admitir devuelve el 100 % (nivel, fee e IVA) reflejando el asiento del cobro y rectifica la factura del fee; una bolsa ya
 * aprobada y en parte liberada se deshace sin dejar la cuenta en negativo; la liquidación espera a que no quede ningún comercio cobrado sin revisar;
 * y los comercios que nunca pagaron se purgan a los 30 días.
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-moderación-comercios' };
const invoicing = { issuerTaxId: 'A58818501', issuerName: 'KORUM Pruebas, S.L.', keyring: TEST_KEYRING };
const options = { hmacSecret: TEST_HMAC_SECRET };
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

// Rango propio (172.40.x.x): el límite de intentos agrupa por subred /24 y la base se comparte con otras pruebas de checkout.
const freshIp = () => {
  ipSequence += 1;
  return `172.${40 + (Math.floor(ipSequence / 250) % 10)}.${ipSequence % 250}.9`;
};
const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>, overrides: Partial<Extract<SessionActor, { kind: 'user' }>> = {}): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true, ...overrides });

async function team(initiative: Parameters<typeof createInitiative>[2] = {}) {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
  createdOrganizations.push(organization.id);
  const init = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, ...initiative });
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER', roleLabel: 'Presidencia del AMPA' }] });
  return { organization, init, director, cosigner, directorActor: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]), cosignerActor: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }]) };
}

const deliver = (kind: 'PAYMENT' | 'CHARGEBACK' | 'REFUND', order: string, amountCents: number) => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET, invoicing });
};

/** Un comercio que patrocina por el checkout y paga: queda `PENDING` y cobrado, con su asiento y su factura del fee. */
async function paidSponsor(orgSlug: string, initiativeId: number, extra: { matchingPool?: boolean; tierCents?: number; name?: string } = {}) {
  const result = await startSponsorship(
    { db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET },
    {
      orgSlug,
      initiativeId,
      locale: 'ca',
      method: 'CARD',
      tierCents: extra.tierCents ?? 25_000,
      matchingPool: extra.matchingPool ?? false,
      businessName: extra.name ?? 'Panadería La Espiga',
      taxId: 'B-12345674',
      contactPerson: 'Marta López',
      phone: '600 11 22 33',
      email: 'marta@laespiga.example',
      sector: 'Panadería',
      promo: '10 % en pan',
      promoCode: 'espiga10',
      autoRenew: true
    },
    { session: null, ip: freshIp() }
  );
  if (result.status !== 'REDIRECT') throw new Error(`El patrocinio no arrancó: ${result.status}`);
  const order = new URL(result.url, 'http://localhost').searchParams.get('pedido')!;
  const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
  expect(await deliver('PAYMENT', order, contribution.totalChargedCents)).toMatchObject({ status: 200, outcome: 'PROCESSED' });
  const sponsor = await db.sponsor.findUniqueOrThrow({ where: { id: contribution.sponsorId! } });
  return { sponsor, contribution, order };
}

async function paidDonation(organizationId: string, initiativeId: number, amountCents: number) {
  const contribution = await db.contribution.create({ data: { organizationId, initiativeId, fiscalYear: 2026, type: 'DONATION', amountCents, totalChargedCents: amountCents, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING' } });
  expect(await deliver('PAYMENT', contribution.paycometOrder!, amountCents)).toMatchObject({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

const initiativeOf = (id: number) => db.initiative.findUniqueOrThrow({ where: { id }, select: { raisedCents: true, totalContributions: true, status: true, matchingPoolTotalCents: true, matchingPoolRemainingCents: true, matchingSponsorName: true } });

describe('Aprobar un comercio cobrado', () => {
  it('lo publica 12 meses desde hoy, le envía la bienvenida con el enlace firmado de sus documentos y lo deja en la auditoría', async () => {
    const { organization, init, cosignerActor } = await team();
    const { sponsor, order } = await paidSponsor(organization.slug, init.id);
    expect(await listFriendlySponsors(db, organization.slug, new Date())).toEqual([]);
    expect(await countPendingApprovals(db, cosignerActor, organization.id)).toBe(1);

    const now = new Date();
    expect(await approveSponsor(db, cosignerActor, organization.id, { sponsorId: sponsor.id }, options, now)).toEqual({ matching: false });
    const stored = await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } });
    expect(stored.status).toBe('APPROVED');
    expect(stored.expiresAt.getUTCFullYear()).toBe(now.getUTCFullYear() + 1);
    expect((await listFriendlySponsors(db, organization.slug, new Date())).map((row) => row.name)).toEqual(['Panadería La Espiga']);
    expect(await countPendingApprovals(db, cosignerActor, organization.id)).toBe(0);

    const welcome = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.welcome', organizationId: organization.id } });
    expect(welcome).toMatchObject({ locale: 'ca', toAddress: 'marta@laespiga.example', idempotencyKey: `sponsor.welcome:${sponsor.id}` });
    const payload = welcome.payloadJson as { order: string; sig: string; level: string };
    expect(payload).toMatchObject({ order, level: 'PLATA' });
    expect(verifyCheckoutResult(TEST_HMAC_SECRET, payload.order, payload.sig)).toBe(true);
    expect(await db.auditLog.findFirst({ where: { action: 'sponsor.approved', targetId: String(sponsor.id) } })).toMatchObject({ actorUserId: cosignerActor.kind === 'user' ? cosignerActor.userId : null });

    // Otra persona firmante que lo intenta después ve que ya no está pendiente.
    await expect(approveSponsor(db, cosignerActor, organization.id, { sponsorId: sponsor.id }, options)).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
  });

  it('activa la bolsa Matching 2x en la misma transacción y la siguiente donación ya se duplica', async () => {
    const { organization, init, directorActor } = await team();
    const { sponsor } = await paidSponsor(organization.slug, init.id, { matchingPool: true });
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 0, matchingPoolTotalCents: 0 });
    // Sin aprobar, la bolsa no existe: la donación cuenta sola y no falla.
    await paidDonation(organization.id, init.id, 2_000);
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 2_000 });

    expect(await approveSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id }, options)).toEqual({ matching: true });
    expect(await initiativeOf(init.id)).toMatchObject({ matchingPoolTotalCents: 25_000, matchingPoolRemainingCents: 25_000, matchingSponsorName: 'Panadería La Espiga' });
    await paidDonation(organization.id, init.id, 3_000);
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 2_000 + 3_000 * 2, matchingPoolRemainingCents: 22_000 });
    expect(await getRaisedFromLedger(db, init.id)).toBe(8_000);
  });

  it('no aprueba un comercio sin cobro ni uno de otra entidad; tampoco sin segundo factor ni como Super-Admin', async () => {
    const { organization, init, directorActor } = await team();
    const other = await team();
    const { sponsor } = await paidSponsor(other.organization.slug, other.init.id);
    // De otra entidad: igual que si no existiera.
    await expect(approveSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id }, options)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(approveSponsor(db, actorFor(other.director.id, [{ organizationId: other.organization.id, role: 'DIRECTOR' }], { secondFactor: false }), other.organization.id, { sponsorId: sponsor.id }, options)).rejects.toBeInstanceOf(TenantAccessError);
    const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await expect(approveSponsor(db, actorFor(superadmin.id, [], { isSuperadmin: true }), other.organization.id, { sponsorId: sponsor.id }, options)).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } })).status).toBe('PENDING');

    const unpaid = await startSponsorship({ db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { orgSlug: organization.slug, initiativeId: init.id, locale: 'es', method: 'BIZUM', tierCents: 25_000, matchingPool: false, businessName: 'Librería Sin Pagar', taxId: 'B-12345674', contactPerson: 'Ana', phone: '600 11 22 33', email: 'ana@libreria.example', sector: '', promo: '', promoCode: '', autoRenew: false }, { session: null, ip: freshIp() });
    expect(unpaid.status).toBe('REDIRECT');
    const unpaidSponsor = await db.sponsor.findFirstOrThrow({ where: { organizationId: organization.id, name: 'Librería Sin Pagar' } });
    await expect(approveSponsor(db, directorActor, organization.id, { sponsorId: unpaidSponsor.id }, options)).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
    // La bandeja solo enseña los cobrados, sin CIF.
    const view = await loadSponsorModeration(db, directorActor, organization.id);
    expect(view.open).toEqual([]);
    await expect(approveSponsor(db, directorActor, organization.id, { sponsorId: 'x' }, options)).rejects.toBeInstanceOf(SponsorModerationError);
  });
});

describe('No admitir a un comercio cobrado', () => {
  it('devuelve el 100 % reflejando el cobro, rectifica la factura del fee en la cadena Veri*factu y avisa al comercio con el motivo', async () => {
    const { organization, init, directorActor } = await team();
    const { sponsor, contribution } = await paidSponsor(organization.slug, init.id);
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 25_000, totalContributions: 1 });
    const { contributionId } = await rejectSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id, reason: 'Ya tenemos una panadería en esta campaña.' }, { ...options, invoicing });
    expect(contributionId).toBe(contribution.id);

    expect(await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id }, select: { status: true } })).toEqual({ status: 'REJECTED' });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id }, select: { status: true } })).toEqual({ status: 'REFUND_PENDING' });
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect(await getRaisedFromLedger(db, init.id)).toBe(0);
    const approval = await db.ledgerJournal.findFirstOrThrow({ where: { contributionId: contribution.id, idempotencyKey: `payment:refund-approval:${contribution.id}` }, include: { entries: true } });
    const amounts = Object.fromEntries(approval.entries.map((entry) => [`${entry.direction}:${entry.account}`, entry.amountCents]));
    expect(amounts).toEqual({ 'DEBIT:INITIATIVE_ESCROW': 25_000, 'DEBIT:KORUM_REVENUE_SPONSOR_FEE': 3_750, 'DEBIT:TAX_PAYABLE_VAT': 788, 'CREDIT:REFUNDS_PAYABLE': 29_538 });

    const invoices = await db.invoice.findMany({ where: { sponsorId: sponsor.id }, orderBy: { id: 'asc' } });
    expect(invoices).toHaveLength(2);
    expect(invoices[1]).toMatchObject({ invoiceType: 'R1', series: 'REC', rectifiesInvoiceId: invoices[0]!.id, baseAmountCents: -3_750, taxAmountCents: -788, totalAmountCents: -4_538, recipientName: 'Panadería La Espiga' });
    expect(invoices[1]!.invoiceNumber).toMatch(/^REC-\d{4}-\d{4}$/);
    expect(invoices[0]!.totalAmountCents + invoices[1]!.totalAmountCents).toBe(0);
    // La rectificativa encadena con la factura anterior y su huella sale de sus propios datos. (La cadena entera de la base de pruebas puede tener otros
    // comienzos: la semilla de demostración inserta las suyas cuando le toca.)
    const previous = await db.invoice.findFirstOrThrow({ where: { id: { lt: invoices[1]!.id } }, orderBy: { id: 'desc' }, select: { verifactuHash: true } });
    expect(invoices[1]!.prevVerifactuHash).toBe(previous.verifactuHash);
    const chain = await verifyInvoiceChain(db);
    expect(chain.brokenLinks).not.toContain(invoices[1]!.invoiceNumber);
    expect(chain.wrongHashes).toEqual([]);

    const email = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.rejected', organizationId: organization.id } });
    expect(email.payloadJson).toMatchObject({ reason: 'Ya tenemos una panadería en esta campaña.', refundCents: 29_538, rectified: true });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'sponsor.rejected', targetId: String(sponsor.id) } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('panadería');

    // La devolución sale al momento (la acción la lanza desde `after()`) y termina en `REFUNDED`.
    expect(await executePendingRefund(db, mock, contribution.id, '10.0.0.1')).toMatchObject({ outcome: 'REFUNDED' });
    expect(mock.calls.filter((call) => call.operation === 'refund' && call.order === contribution.paycometOrder)).toHaveLength(1);
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id }, select: { status: true, refundedCents: true } })).toEqual({ status: 'REFUNDED', refundedCents: 29_538 });
  });

  it('sin los datos del emisor no se rechaza (no quedaría una factura cobrada sin rectificar) y nada cambia', async () => {
    const { organization, init, directorActor } = await team();
    const { sponsor } = await paidSponsor(organization.slug, init.id);
    await expect(rejectSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id, reason: 'Motivo suficientemente largo.' }, { ...options, invoicing: undefined })).rejects.toMatchObject({ reason: 'INVOICING_UNAVAILABLE' });
    expect(await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id }, select: { status: true } })).toEqual({ status: 'PENDING' });
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 25_000 });
    await expect(rejectSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id, reason: 'corto' }, { ...options, invoicing })).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
  });

  it('una bolsa Matching 2x sin aprobar se devuelve entera desde la bolsa, sin tocar lo recaudado', async () => {
    const { organization, init, directorActor } = await team();
    await paidDonation(organization.id, init.id, 4_000);
    const { sponsor } = await paidSponsor(organization.slug, init.id, { matchingPool: true });
    await rejectSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id, reason: 'No encaja con esta campaña.' }, { ...options, invoicing });
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 4_000, matchingPoolTotalCents: 0 });
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: init.id, sponsorId: sponsor.id })).balanceCents).toBe(0);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: init.id })).balanceCents).toBe(4_000);
  });
});

describe('Deshacer una bolsa Matching 2x aprobada y en parte liberada (heredado del Sprint 3.5, punto 8)', () => {
  it('el contracargo carga en la bolsa solo lo que queda y lo liberado sale de la hucha; la bolsa se apaga y las donaciones siguientes no fallan', async () => {
    const { organization, init, directorActor } = await team();
    const { sponsor, order, contribution } = await paidSponsor(organization.slug, init.id, { matchingPool: true });
    await approveSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id }, options);
    const matched = await paidDonation(organization.id, init.id, 10_000);
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 20_000, matchingPoolRemainingCents: 15_000 });

    expect(await deliver('CHARGEBACK', order, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: init.id, sponsorId: sponsor.id })).balanceCents).toBe(0);
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 10_000, matchingPoolTotalCents: 0, matchingPoolRemainingCents: 0, matchingSponsorName: null });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: init.id })).balanceCents).toBe(10_000);
    expect(await getRaisedFromLedger(db, init.id)).toBe(10_000);

    // Una donación posterior ya no busca la bolsa: suma sola y Paycomet no tiene que reintentar.
    await paidDonation(organization.id, init.id, 1_000);
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 11_000 });

    // Devolver la donación que se emparejó no resta dos veces el bonus (ya salió con el contracargo del comercio).
    expect(await deliver('REFUND', matched.paycometOrder!, 10_000)).toMatchObject({ status: 200 });
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 1_000 });
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: init.id })).balanceCents).toBe(1_000);
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: init.id, sponsorId: sponsor.id })).balanceCents).toBe(0);
  });
});

describe('Liquidación con comercios sin revisar (heredado del Sprint 3.5, punto 9)', () => {
  it('no se aprueba mientras quede un comercio cobrado sin aprobar ni rechazar; aprobado, sí', async () => {
    const { organization, init, directorActor } = await team({ goalCents: 25_000, bracketFeeCents: 0, maintFeeCents: 0, gatewayFeeCents: 0 });
    const { sponsor } = await paidSponsor(organization.slug, init.id);
    expect(await initiativeOf(init.id)).toMatchObject({ status: 'GOAL_REACHED', raisedCents: 25_000 });
    const payout = await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId: init.id, destinationType: 'ORGANIZATION', beneficiaryName: 'AMPA', netPaidCents: 25_000, korumFeeSettledCents: 0 } });
    const members = await db.organizationMember.findMany({ where: { organizationId: organization.id } });
    for (const member of members) {
      const signedAt = new Date(Date.now() - HOUR);
      const signatureHash = computeSignatureHash(TEST_HMAC_SECRET, { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: payoutDigestFor(TEST_HMAC_SECRET, { ...payout, providerInvoiceFile: null }, organization.paycometSplitId), signerUserId: member.userId, signerRole: member.role, membershipId: member.id, signedAt, otpVerifiedAt: signedAt });
      await db.doubleCheckSignature.create({ data: { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: member.userId, signerRole: member.role, signatureHash, otpVerifiedAt: signedAt, signedAt } });
    }
    await expect(approvePayout(db, payout.id, TEST_HMAC_SECRET)).rejects.toThrow(PayoutNotAllowedError);
    await expect(approvePayout(db, payout.id, TEST_HMAC_SECRET)).rejects.toThrow(/sin aprobar ni rechazar/);
    expect((await db.escrowPayout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('PENDING_DOUBLE_CHECK');

    await approveSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id }, options);
    expect(await approvePayout(db, payout.id, TEST_HMAC_SECRET)).toMatchObject({ approved: true });
    // Ya liquidada, no se puede rechazar a un comercio desde el panel.
    await expect(rejectSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id, reason: 'Motivo suficientemente largo.' }, { ...options, invoicing })).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
  });
});

describe('Purga de comercios que nunca pagaron (heredado del Sprint 3.5, punto 6)', () => {
  it('borra a los 30 días el comercio sin cobro y su cobro fallido; nunca a uno cobrado ni a uno reciente', async () => {
    const { organization, init } = await team();
    const { sponsor: paid } = await paidSponsor(organization.slug, init.id);
    const start = { db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET };
    const input = (name: string) => ({ orgSlug: organization.slug, initiativeId: init.id, locale: 'es', method: 'BIZUM', tierCents: 10_000, matchingPool: false, businessName: name, taxId: 'B-12345674', contactPerson: 'Ana', phone: '600 11 22 33', email: 'ana@libreria.example', sector: '', promo: '', promoCode: '', autoRenew: false });
    await startSponsorship(start, input('Abandonado Viejo'), { session: null, ip: freshIp() });
    await startSponsorship(start, input('Abandonado Reciente'), { session: null, ip: freshIp() });
    const old = await db.sponsor.findFirstOrThrow({ where: { organizationId: organization.id, name: 'Abandonado Viejo' }, include: { contribution: true } });
    await db.contribution.update({ where: { id: old.contribution!.id }, data: { status: 'FAILED' } });
    await db.sponsor.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 31 * DAY) } });

    expect(await purgeUnpaidSponsors(db, new Date(), 500)).toBeGreaterThanOrEqual(1);
    expect(await db.sponsor.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.contribution.findUnique({ where: { id: old.contribution!.id } })).toBeNull();
    expect(await db.sponsor.count({ where: { organizationId: organization.id, name: 'Abandonado Reciente' } })).toBe(1);
    expect(await db.sponsor.findUnique({ where: { id: paid.id } })).not.toBeNull();
  });
});

describe('Más caminos de devolución de un comercio (auditoría financiera del 4.2b)', () => {
  it('orden inverso: primero se devuelve la donación emparejada (el bonus vuelve a la bolsa) y después el comercio entero', async () => {
    const { organization, init, directorActor } = await team();
    const { sponsor, order, contribution } = await paidSponsor(organization.slug, init.id, { matchingPool: true });
    await approveSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id }, options);
    const matched = await paidDonation(organization.id, init.id, 5_000);
    expect(await deliver('REFUND', matched.paycometOrder!, 5_000)).toMatchObject({ status: 200 });
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 0, matchingPoolRemainingCents: 25_000 });
    expect(await deliver('REFUND', order, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: init.id, sponsorId: sponsor.id })).balanceCents).toBe(0);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: init.id })).balanceCents).toBe(0);
    expect(await getRaisedFromLedger(db, init.id)).toBe(0);
    expect(await initiativeOf(init.id)).toMatchObject({ raisedCents: 0, matchingPoolTotalCents: 0 });
  });

  it('una devolución hecha desde el panel de Paycomet también rectifica la factura del fee', async () => {
    const { organization, init } = await team();
    const { sponsor, order, contribution } = await paidSponsor(organization.slug, init.id);
    expect(await deliver('REFUND', order, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    const invoices = await db.invoice.findMany({ where: { sponsorId: sponsor.id }, orderBy: { id: 'asc' } });
    expect(invoices.map((invoice) => invoice.invoiceType)).toEqual(['F1', 'R1']);
    expect(invoices[1]).toMatchObject({ totalAmountCents: -4_538, issuerName: 'KORUM Pruebas, S.L.' });
  });

  it('contracargo con la iniciativa ya liquidada: el sobrante de la bolsa sale de la bolsa y solo el resto es pérdida; la factura queda en la consola', async () => {
    const { organization, init, directorActor } = await team();
    const { sponsor, order, contribution } = await paidSponsor(organization.slug, init.id, { matchingPool: true });
    await approveSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id }, options);
    await paidDonation(organization.id, init.id, 5_000);
    // Liquidada (aprobada): basta con que exista una liquidación aprobada para que el dinero ya no esté en la hucha.
    await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId: init.id, destinationType: 'ORGANIZATION', beneficiaryName: 'AMPA', netPaidCents: 10_000, korumFeeSettledCents: 0, status: 'APPROVED' } });
    expect(await deliver('CHARGEBACK', order, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    const journal = await db.ledgerJournal.findFirstOrThrow({ where: { contributionId: contribution.id, kind: 'CHARGEBACK' }, include: { entries: true } });
    const amounts = Object.fromEntries(journal.entries.map((entry) => [`${entry.direction}:${entry.account}`, entry.amountCents]));
    expect(amounts).toEqual({ 'DEBIT:MATCHING_POOL': 20_000, 'DEBIT:CHARGEBACK_LOSSES': contribution.totalChargedCents - 20_000, 'CREDIT:PSP_CLEARING': contribution.totalChargedCents });
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: init.id, sponsorId: sponsor.id })).balanceCents).toBe(0);
    expect(await initiativeOf(init.id)).toMatchObject({ matchingPoolTotalCents: 0, matchingPoolRemainingCents: 0, matchingSponsorName: null });
    const invoice = await db.invoice.findFirstOrThrow({ where: { sponsorId: sponsor.id, invoiceType: 'F1' } });
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `INVOICE_RECTIFY_PENDING:${invoice.id}` } })).toMatchObject({ type: 'INVOICE_RECTIFY_PENDING', status: 'OPEN' });
    // La liberación que quedó sin respaldo ya no cuenta como aportación viva.
    expect(await db.contribution.count({ where: { initiativeId: init.id, type: 'MATCHING_FUND', status: 'COMPLETED' } })).toBe(0);
  });

  it('aprobar y no admitir a la vez el mismo comercio: solo gana una decisión', async () => {
    const { organization, init, directorActor, cosignerActor } = await team();
    const { sponsor } = await paidSponsor(organization.slug, init.id);
    const results = await Promise.allSettled([
      approveSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id }, options),
      rejectSponsor(db, cosignerActor, organization.id, { sponsorId: sponsor.id, reason: 'Motivo suficientemente largo.' }, { ...options, invoicing })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ reason: 'WRONG_STATUS' });
    expect(['APPROVED', 'REJECTED']).toContain((await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } })).status);
  });

  it('una factura se rectifica una sola vez, una rectificativa no se rectifica y otro NIF emisor no la puede rectificar', async () => {
    const { organization, init } = await team();
    const { sponsor } = await paidSponsor(organization.slug, init.id);
    const original = await db.invoice.findFirstOrThrow({ where: { sponsorId: sponsor.id, invoiceType: 'F1' } });
    await expect(rectifyInvoice(db, { invoiceId: original.id, issuerTaxId: 'B12345674', keyring: TEST_KEYRING, concept: 'Prueba' })).rejects.toBeInstanceOf(RectificationNotAllowedError);
    const first = await rectifyInvoice(db, { invoiceId: original.id, issuerTaxId: invoicing.issuerTaxId, keyring: TEST_KEYRING, concept: 'Prueba' });
    const again = await rectifyInvoice(db, { invoiceId: original.id, issuerTaxId: invoicing.issuerTaxId, keyring: TEST_KEYRING, concept: 'Prueba' });
    expect(again.id).toBe(first.id);
    await expect(rectifyInvoice(db, { invoiceId: first.id, issuerTaxId: invoicing.issuerTaxId, keyring: TEST_KEYRING, concept: 'Prueba' })).rejects.toThrow(/no es una factura completa/);
    expect(first).toMatchObject({ issuerTaxId: original.issuerTaxId, issuerName: 'KORUM Pruebas, S.L.' });
  });
});

describe('Logotipo del comercio (heredado del Sprint 3.5, punto 7)', () => {
  it('se publica sin metadatos, sustituye al anterior y queda en la auditoría; no admitir al comercio lo retira', async () => {
    const storage = new MemoryStorage();
    const { organization, init, directorActor, director } = await team();
    const { sponsor } = await paidSponsor(organization.slug, init.id);
    const upload = (bytes = jpegWithExif(6)) => publishSponsorLogo(db, storage, directorActor, { organizationId: organization.id, sponsorId: sponsor.id, bytes, declaredMimeType: 'image/jpeg', fileName: 'logo.jpg' });
    const first = await upload();
    const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } });
    expect(asset).toMatchObject({ visibility: 'PUBLIC', purpose: 'SPONSOR_LOGO', organizationId: organization.id, uploadedById: director.id });
    const stored = storage.readPublic(asset.bucket, asset.objectKey)!;
    for (const marker of SECRET_MARKERS) expect(containsText(stored.body, marker)).toBe(false);
    expect(await db.auditLog.findFirst({ where: { action: 'sponsor.logo_published', targetId: String(sponsor.id) } })).not.toBeNull();

    const second = await upload();
    expect((await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } })).logoFileId).toBe(second.fileId);
    expect((await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } })).deletedAt).not.toBeNull();
    expect(storage.has(asset.bucket, asset.objectKey)).toBe(false);

    const { retiredLogo } = await rejectSponsor(db, directorActor, organization.id, { sponsorId: sponsor.id, reason: 'Motivo suficientemente largo.' }, { ...options, invoicing });
    expect(retiredLogo).not.toBeNull();
    expect((await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } })).logoFileId).toBeNull();
    expect((await db.fileAsset.findUniqueOrThrow({ where: { id: second.fileId } })).deletedAt).not.toBeNull();
    await expect(upload()).rejects.toMatchObject({ reason: 'SPONSOR_NOT_ACTIVE' });
  });

  it('solo quien firma por esa entidad, con segundo factor; nunca el Super-Admin ni otra entidad; una imagen ilegible no se publica', async () => {
    const storage = new MemoryStorage();
    const { organization, init, director } = await team();
    const other = await team();
    const { sponsor } = await paidSponsor(organization.slug, init.id);
    const input = { organizationId: organization.id, sponsorId: sponsor.id, bytes: jpegWithExif(6), declaredMimeType: 'image/jpeg', fileName: 'logo.jpg' };
    await expect(publishSponsorLogo(db, storage, actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }], { secondFactor: false }), input)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(publishSponsorLogo(db, storage, other.directorActor, input)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(publishSponsorLogo(db, storage, other.directorActor, { ...input, organizationId: other.organization.id })).rejects.toBeInstanceOf(ResourceNotFoundError);
    const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await expect(publishSponsorLogo(db, storage, actorFor(superadmin.id, [], { isSuperadmin: true }), input)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(publishSponsorLogo(db, storage, actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]), { ...input, bytes: Uint8Array.from(Buffer.from('%PDF-1.7 documento')), declaredMimeType: 'application/pdf', fileName: 'x.pdf' })).rejects.toBeInstanceOf(SponsorLogoRejectedError);
    expect((await db.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } })).logoFileId).toBeNull();
  });
});
