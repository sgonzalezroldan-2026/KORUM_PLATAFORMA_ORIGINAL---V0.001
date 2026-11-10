import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance, getRaisedFromLedger, getTrialBalance } from '@/core/finance/ledger.service';
import type { JobDeps } from '@/core/jobs/job-types';
import { massRefundHandler } from '@/core/jobs/handlers/mass-refund';
import { computeSignatureHash, payoutTargetDigest } from '@/core/security/signature-hash';
import { ACTIVITY_FUND_DAY, SponsorReassignmentError } from '@/core/sponsors/sponsor-reassignment-rules';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { listFriendlySponsors } from '@/repositories/sponsorship.repository';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadRenewalOffer, startSponsorRenewal } from '@/services/checkout/sponsor-renewal.service';
import { startSponsorship } from '@/services/checkout/sponsorship.service';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { approvePayout } from '@/services/payments/split-transfer.service';
import { approveSponsor } from '@/services/sponsors/sponsor-moderation.service';
import { relocateSponsor } from '@/services/sponsors/sponsor-reassignment.service';
import { checkSponsorMoney } from '@/core/jobs/handlers/sponsor-money-checks';
import { inTransaction } from '@/lib/db';
import { assignPooledSponsor, saveSponsorRenewalRule, sendRenewalLink } from '@/services/sponsors/sponsor-renewal-panel.service';
import { expireCreditPools, queueRenewalLinks, sweepSponsorMoney } from '@/services/sponsors/sponsor-sweeps';
import { createInitiative, createOrganization, createTestClient, createUser, table, TEST_HMAC_SECRET, TEST_KEYRING, testJobDeps, uniqueId } from './test-database';

/**
 * Sprint 4.2d · Renovación de comercios amigos, reasignación de patrocinios y `CREDIT_POOL` contra PostgreSQL real (QA-S02): el patrocinio de una
 * campaña que fracasa va a otra según la regla de la entidad o, sin campañas, a la bolsa con su plazo; la liquidación de la campaña que lo recibe reparte
 * desde el cobro original; un contracargo o una devolución salen de donde esté el dinero; la bolsa vencida se devuelve entera con su rectificativa; y la
 * renovación anual se paga con un enlace y se coloca con la misma regla.
 */

const QR_SECRET = 'secreto-de-integracion-de-los-pases-qr-0123456789';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-reasignación' };
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

// Rango propio (172.60.x.x): el límite de intentos agrupa por subred /24 y la base se comparte con otras pruebas de checkout.
const freshIp = () => {
  ipSequence += 1;
  return `172.${60 + (Math.floor(ipSequence / 250) % 10)}.${ipSequence % 250}.9`;
};
const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>, overrides: Partial<Extract<SessionActor, { kind: 'user' }>> = {}): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true, ...overrides });

async function team(rule: 'SOONEST' | 'PROPORTIONAL' | 'MANUAL' = 'SOONEST') {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED', sponsorRenewalRule: rule });
  createdOrganizations.push(organization.id);
  const origin = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, title: 'Toldos para el patio' });
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, origin, directorActor: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]), cosignerActor: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }]) };
}

const campaign = (organizationId: string, title: string, closesInDays: number, goalCents = 1_000_000) =>
  createInitiative(db, organizationId, { status: 'FUNDRAISING', format: 'BUDGET', goalCents, title, closesAt: new Date(Date.now() + closesInDays * DAY) });

const deliver = (kind: 'PAYMENT' | 'CHARGEBACK' | 'REFUND', order: string, amountCents: number) => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents });
  return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: QR_SECRET, invoicing, documentsSecret: TEST_HMAC_SECRET });
};

/** Un comercio que patrocina y paga por el checkout; con `approve`, la entidad lo aprueba. */
async function paidSponsor(slug: string, initiativeId: number, approver: SessionActor | null, extra: { matchingPool?: boolean } = {}) {
  const result = await startSponsorship(
    { db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET },
    { orgSlug: slug, initiativeId, locale: 'es', method: 'CARD', tierCents: 25_000, matchingPool: extra.matchingPool ?? false, businessName: 'Librería El Faro', taxId: 'B-12345674', contactPerson: 'Rosa Gil', phone: '600 11 22 33', email: 'rosa@elfaro.example', sector: 'Librería', promo: '5 % en libros', promoCode: 'faro5', autoRenew: true },
    { session: null, ip: freshIp() }
  );
  if (result.status !== 'REDIRECT') throw new Error(`El patrocinio no arrancó: ${result.status}`);
  const order = new URL(result.url, 'http://localhost').searchParams.get('pedido')!;
  const contribution = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
  expect(await deliver('PAYMENT', order, contribution.totalChargedCents)).toMatchObject({ status: 200, outcome: 'PROCESSED' });
  const organizationId = contribution.organizationId;
  if (approver) await approveSponsor(db, approver, organizationId, { sponsorId: contribution.sponsorId! }, options);
  return { sponsorId: contribution.sponsorId!, contribution, order };
}

const sponsorOf = (id: number) => db.sponsor.findUniqueOrThrow({ where: { id } });
const initiativeOf = (id: number) => db.initiative.findUniqueOrThrow({ where: { id }, select: { raisedCents: true, totalContributions: true, status: true, firstPayinAt: true, matchingPoolTotalCents: true, matchingPoolRemainingCents: true } });
const poolOf = async (organizationId: string, sponsorId: number) => (await getAccountBalance(db, 'SPONSOR_CREDIT_POOL', { organizationId, sponsorId })).balanceCents;
const escrowOf = async (initiativeId: number) => (await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId })).balanceCents;
const linesOf = async (where: { contributionId: number; kind: 'CHARGEBACK' | 'ESCROW_REFUND_DONOR' }) => {
  const journal = await db.ledgerJournal.findFirstOrThrow({ where, orderBy: { id: 'asc' }, include: { entries: true } });
  return Object.fromEntries(journal.entries.map((entry) => [`${entry.direction}:${entry.account}${entry.initiativeId ? `:${entry.initiativeId}` : ''}`, entry.amountCents]));
};
const inTransactionRelocate = (sponsorId: number, now: Date) => inTransaction(db, (tx) => relocateSponsor(tx, sponsorId, now));
const fail = (initiativeId: number) => db.initiative.update({ where: { id: initiativeId }, data: { status: 'REFUNDING' } });

async function signedPayout(organization: { id: string; paycometSplitId: string | null }, initiativeId: number, netPaidCents: number) {
  const payout = await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId, destinationType: 'ORGANIZATION', beneficiaryName: 'AMPA', beneficiaryIban: 'ES0000000000000000000000', netPaidCents, korumFeeSettledCents: 0 } });
  for (const member of await db.organizationMember.findMany({ where: { organizationId: organization.id } })) {
    const signedAt = new Date(Date.now() - HOUR);
    const signatureHash = computeSignatureHash(TEST_HMAC_SECRET, { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', targetId: payout.id, targetDigest: payoutTargetDigest(TEST_HMAC_SECRET, payout, organization.paycometSplitId), signerUserId: member.userId, signerRole: member.role, membershipId: member.id, signedAt, otpVerifiedAt: signedAt });
    await db.doubleCheckSignature.create({ data: { organizationId: organization.id, targetType: 'ESCROW_PAYOUT', payoutId: payout.id, signerUserId: member.userId, signerRole: member.role, signatureHash, otpVerifiedAt: signedAt, signedAt } });
  }
  return payout;
}

describe('QA-S02 · sin campañas activas, el patrocinio va a la bolsa con su plazo', () => {
  it('la campaña fracasa: el dinero sale de su hucha a la bolsa del comercio, que sigue visible y recibe su aviso; la campaña se cierra sin dinero huérfano', async () => {
    const { organization, origin, directorActor } = await team();
    const { sponsorId, contribution } = await paidSponsor(organization.slug, origin.id, directorActor);
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 25_000, totalContributions: 1 });
    await fail(origin.id);

    const now = new Date();
    const deps: JobDeps = { paymentProvider: async () => mock, invoicingProvider: () => { throw new Error('no se usa'); }, refundOriginalIp: async () => '10.0.0.1', ...testJobDeps() };
    // El manejador directamente: la ejecución del hueco de 10 minutos puede haberla gastado otro archivo de pruebas que corre a la vez.
    await massRefundHandler({ db, now, batchSize: 500, deps });

    const sponsor = await sponsorOf(sponsorId);
    expect(sponsor).toMatchObject({ status: 'CREDIT_POOL', reassignedCents: 25_000 });
    expect(sponsor.creditPoolAt).not.toBeNull();
    expect(await poolOf(organization.id, sponsorId)).toBe(25_000);
    expect(await escrowOf(origin.id)).toBe(0);
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 0, totalContributions: 0, status: 'REFUNDED' });
    expect(await getRaisedFromLedger(db, origin.id)).toBe(0);
    // Sin dinero en la hucha al cerrar: ninguna alerta de dinero huérfano.
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `ESCROW_LEFTOVER:${origin.id}` } })).toBeNull();

    // Plazo: el máximo de la consola (60 días) desde que entra, sin pasar del día 70 desde el cobro (después pasa al Fondo de actividades, Sprint 4.2f).
    const notice = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.creditPool', organizationId: organization.id } });
    const deadline = new Date((notice.payloadJson as { deadline: string }).deadline).getTime();
    expect(deadline).toBe(Math.min(sponsor.creditPoolAt!.getTime() + 60 * DAY, contribution.createdAt.getTime() + ACTIVITY_FUND_DAY * DAY));
    expect(notice).toMatchObject({ toAddress: 'rosa@elfaro.example', payloadJson: { sponsorId, amountCents: 25_000, manual: false } });
    // Decisión del promotor: sigue visible en el directorio mientras espera.
    expect((await listFriendlySponsors(db, organization.slug, now)).map((row) => row.id)).toEqual([sponsorId]);
    // Repetir la tarea no mueve nada dos veces.
    expect(await sweepSponsorMoney(db, new Date(), 50)).toMatchObject({ errors: 0 });
    expect(await poolOf(organization.id, sponsorId)).toBe(25_000);
    expect(await db.ledgerJournal.count({ where: { contributionId: contribution.id, kind: 'CREDIT_POOL_TRANSFER' } })).toBe(1);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('un comercio que lleva 50 días cobrado solo espera hasta el día 70 desde su cobro (Sprint 4.2f)', async () => {
    const { organization, origin, directorActor } = await team();
    const { sponsorId, contribution } = await paidSponsor(organization.slug, origin.id, directorActor);
    await db.$executeRawUnsafe(`UPDATE ${table('Contribution')} SET "createdAt" = now() - interval '50 days' WHERE id = ${contribution.id}`);
    await db.sponsor.update({ where: { id: sponsorId }, data: { paidAt: new Date(Date.now() - 50 * DAY) } });
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    const notice = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.creditPool', organizationId: organization.id } });
    // El plazo cuenta desde el cobro (la fecha más prudente, la misma que usa la liquidación para la ventana de 90 días).
    const charged = (await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).createdAt;
    expect(new Date((notice.payloadJson as { deadline: string }).deadline).getTime()).toBe(charged.getTime() + ACTIVITY_FUND_DAY * DAY);
  });
});

describe('Reasignación según la regla de la entidad', () => {
  it('SOONEST: va entera a la campaña que cierra antes, que llega a su meta; su liquidación reparte desde el cobro original del comercio', async () => {
    const { organization, origin, directorActor } = await team('SOONEST');
    const soon = await campaign(organization.id, 'Biblioteca de aula', 20, 25_000);
    const later = await campaign(organization.id, 'Huerto escolar', 40);
    const { sponsorId, contribution } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    expect(await sweepSponsorMoney(db, new Date(), 50)).toMatchObject({ placed: 1, errors: 0 });

    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'APPROVED', creditPoolAt: null, reassignedCents: 25_000 });
    expect(await initiativeOf(soon.id)).toMatchObject({ raisedCents: 25_000, totalContributions: 1, status: 'GOAL_REACHED' });
    expect((await initiativeOf(soon.id)).firstPayinAt?.getTime()).toBe(contribution.createdAt.getTime());
    expect(await initiativeOf(later.id)).toMatchObject({ raisedCents: 0 });
    expect(await db.sponsorAllocation.findMany({ where: { sponsorId }, select: { initiativeId: true, contributionId: true, amountCents: true, withdrawnAt: true } })).toEqual([{ initiativeId: soon.id, contributionId: contribution.id, amountCents: 25_000, withdrawnAt: null }]);
    expect(await escrowOf(soon.id)).toBe(25_000);
    expect(await getRaisedFromLedger(db, soon.id)).toBe(25_000);
    expect(await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.reassigned', organizationId: organization.id } })).toMatchObject({ payloadJson: { sponsorId, amountCents: 25_000, titles: ['Biblioteca de aula'], more: 0 } });
    expect(await db.outboxMessage.count({ where: { templateKey: 'initiative.goalReached', organizationId: organization.id } })).toBe(2);

    // Heredado del 4.2b, punto 1: la liquidación de la campaña que lo recibe reparte desde el cobro del comercio.
    const payout = await signedPayout(organization, soon.id, 25_000);
    expect(await approvePayout(db, payout.id, TEST_HMAC_SECRET)).toMatchObject({ approved: true, splits: 1 });
    expect(await db.escrowPayoutSplit.findMany({ where: { payoutId: payout.id }, select: { contributionId: true, amountCents: true } })).toEqual([{ contributionId: contribution.id, amountCents: 25_000 }]);

    // Contracargo tras liquidar la campaña que lo recibió: el nivel ya salió (lo asume KORUM) y el fee y su IVA se deshacen como en un cobro en la hucha.
    expect(await deliver('CHARGEBACK', contribution.paycometOrder!, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect(await linesOf({ contributionId: contribution.id, kind: 'CHARGEBACK' })).toEqual({
      'DEBIT:CHARGEBACK_LOSSES': 25_000,
      'DEBIT:KORUM_REVENUE_SPONSOR_FEE': 3_750,
      'DEBIT:TAX_PAYABLE_VAT': 788,
      'CREDIT:PSP_CLEARING': contribution.totalChargedCents
    });
    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'REFUNDED' });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('PROPORTIONAL: reparte por lo que le falta a cada campaña, al céntimo; un contracargo sale de cada una de ellas, no de la original', async () => {
    const { organization, origin, directorActor } = await team('PROPORTIONAL');
    const big = await campaign(organization.id, 'Pizarras digitales', 20, 30_000);
    const small = await campaign(organization.id, 'Balones nuevos', 25, 10_000);
    const { sponsorId, contribution } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);

    const allocations = await db.sponsorAllocation.findMany({ where: { sponsorId }, orderBy: { initiativeId: 'asc' }, select: { initiativeId: true, amountCents: true } });
    expect(allocations).toEqual([
      { initiativeId: big.id, amountCents: 18_750 },
      { initiativeId: small.id, amountCents: 6_250 }
    ]);
    expect(await initiativeOf(big.id)).toMatchObject({ raisedCents: 18_750, totalContributions: 1, status: 'FUNDRAISING' });
    expect(await initiativeOf(small.id)).toMatchObject({ raisedCents: 6_250, status: 'FUNDRAISING' });

    expect(await deliver('CHARGEBACK', contribution.paycometOrder!, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect(await linesOf({ contributionId: contribution.id, kind: 'CHARGEBACK' })).toEqual({
      [`DEBIT:INITIATIVE_ESCROW:${big.id}`]: 18_750,
      [`DEBIT:INITIATIVE_ESCROW:${small.id}`]: 6_250,
      'DEBIT:KORUM_REVENUE_SPONSOR_FEE': 3_750,
      'DEBIT:TAX_PAYABLE_VAT': 788,
      'CREDIT:PSP_CLEARING': contribution.totalChargedCents
    });
    expect(await initiativeOf(big.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect(await initiativeOf(small.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect(await db.sponsorAllocation.count({ where: { sponsorId, withdrawnAt: null } })).toBe(0);
    expect(await getRaisedFromLedger(db, big.id)).toBe(0);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('una campaña que recibió dinero y también fracasa lo devuelve a la bolsa y se coloca en otra; una que cierra fuera de la ventana del cobro no lo recibe', async () => {
    const { organization, origin, directorActor } = await team('SOONEST');
    const first = await campaign(organization.id, 'Excursión de fin de curso', 10);
    const second = await campaign(organization.id, 'Material de laboratorio', 30);
    await campaign(organization.id, 'Fuera de la ventana', 90);
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    expect(await initiativeOf(first.id)).toMatchObject({ raisedCents: 25_000 });

    await fail(first.id);
    await sweepSponsorMoney(db, new Date(), 50);
    expect(await initiativeOf(first.id)).toMatchObject({ raisedCents: 0, totalContributions: 0 });
    expect(await initiativeOf(second.id)).toMatchObject({ raisedCents: 25_000, totalContributions: 1 });
    expect(await db.sponsorAllocation.findMany({ where: { sponsorId }, orderBy: { id: 'asc' }, select: { initiativeId: true, withdrawnAt: true } })).toMatchObject([
      { initiativeId: first.id, withdrawnAt: expect.any(Date) },
      { initiativeId: second.id, withdrawnAt: null }
    ]);

    await fail(second.id);
    await sweepSponsorMoney(db, new Date(), 50);
    // La única campaña que queda cierra después del día 85 desde el cobro: no puede recibirlo y el dinero espera en la bolsa.
    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'CREDIT_POOL' });
    expect(await poolOf(organization.id, sponsorId)).toBe(25_000);
  });
});

describe('Regla MANUAL y decisiones del panel', () => {
  it('espera en la bolsa; solo las firmas con segundo factor la llevan a una campaña elegible de su entidad', async () => {
    const { organization, origin, directorActor, cosignerActor } = await team('MANUAL');
    const target = await campaign(organization.id, 'Gradas del polideportivo', 20);
    const outside = await campaign(organization.id, 'Demasiado tarde', 90);
    const other = await team();
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'CREDIT_POOL' });
    expect(await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.creditPool', organizationId: organization.id } })).toMatchObject({ payloadJson: { manual: true } });

    const payload = { sponsorId, initiativeId: target.id };
    await expect(assignPooledSponsor(db, { ...cosignerActor, secondFactor: false } as SessionActor, organization.id, payload)).rejects.toThrow(TenantAccessError);
    await expect(assignPooledSponsor(db, other.directorActor, organization.id, payload)).rejects.toThrow(TenantAccessError);
    await expect(assignPooledSponsor(db, other.directorActor, other.organization.id, payload)).rejects.toThrow(ResourceNotFoundError);
    const superadmin = await createUser(db, { isSuperadmin: true, twoFactorEnabled: true });
    await expect(assignPooledSponsor(db, actorFor(superadmin.id, [], { isSuperadmin: true }), organization.id, payload)).rejects.toThrow(TenantAccessError);
    // Una campaña de otra entidad responde como una que no existe y queda en la auditoría (auditoría de seguridad del 4.2d, B1).
    await expect(assignPooledSponsor(db, cosignerActor, organization.id, { sponsorId, initiativeId: other.origin.id })).rejects.toThrow(ResourceNotFoundError);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, targetType: 'Initiative', targetId: String(other.origin.id) } })).toBeGreaterThanOrEqual(1);
    await expect(assignPooledSponsor(db, cosignerActor, organization.id, { sponsorId, initiativeId: outside.id })).rejects.toMatchObject({ reason: 'TARGET_NOT_ELIGIBLE' });
    expect(await poolOf(organization.id, sponsorId)).toBe(25_000);

    expect(await assignPooledSponsor(db, cosignerActor, organization.id, payload)).toEqual({ title: 'Gradas del polideportivo' });
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 25_000 });
    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'APPROVED', creditPoolAt: null });
    await expect(assignPooledSponsor(db, directorActor, organization.id, payload)).rejects.toMatchObject({ reason: 'POOL_CHANGED' });
    expect(await db.auditLog.count({ where: { action: 'sponsor.pool_assigned', organizationId: organization.id } })).toBe(1);
  });

  it('cambiar la regla de MANUAL a SOONEST coloca al momento lo que esperaba; otra entidad no la puede cambiar', async () => {
    const { organization, origin, directorActor } = await team('MANUAL');
    const target = await campaign(organization.id, 'Cortinas del gimnasio', 20);
    const other = await team();
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    await expect(saveSponsorRenewalRule(db, other.directorActor, organization.id, { rule: 'SOONEST' })).rejects.toThrow(TenantAccessError);
    await expect(saveSponsorRenewalRule(db, directorActor, organization.id, { rule: 'CUALQUIERA' })).rejects.toThrow(SponsorReassignmentError);
    expect(await saveSponsorRenewalRule(db, directorActor, organization.id, { rule: 'SOONEST' })).toEqual({ placed: 1 });
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 25_000 });
    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'APPROVED' });
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { sponsorRenewalRule: true } })).toEqual({ sponsorRenewalRule: 'SOONEST' });
  });
});

describe('Bolsa vencida (decisión del promotor, 2026-11-10: no se devuelve al comercio)', () => {
  it('al vencer no se devuelve nada ni se rectifica: pasa al Fondo de actividades de la entidad, ya no se coloca en ninguna campaña y el comercio sigue visible', async () => {
    const { organization, origin, directorActor } = await team();
    const { sponsorId, contribution } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    // La tarea recorre todas las entidades de la base de pruebas: se mira este comercio.
    await expireCreditPools(db, new Date(Date.now() + 59 * DAY), 500);
    expect(await db.activityFundDeposit.count({ where: { sponsorId } })).toBe(0);

    const later = new Date(Date.now() + 61 * DAY);
    expect((await expireCreditPools(db, later, 500)).expired).toBeGreaterThanOrEqual(1);
    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'APPROVED', creditPoolAt: null, reassignedCents: 25_000 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).toMatchObject({ status: 'COMPLETED' });
    expect(await db.invoice.count({ where: { sponsorId, invoiceType: 'R1' } })).toBe(0);
    expect(await poolOf(organization.id, sponsorId)).toBe(0);
    expect((await getAccountBalance(db, 'ORG_ACTIVITY_FUND', { organizationId: organization.id, sponsorId })).balanceCents).toBe(25_000);
    expect(await db.activityFundDeposit.findFirstOrThrow({ where: { sponsorId } })).toMatchObject({ amountCents: 25_000, contributionId: contribution.id });
    expect(await db.outboxMessage.count({ where: { templateKey: 'sponsor.toEntityFund', organizationId: organization.id } })).toBe(1);
    expect(await db.outboxMessage.count({ where: { templateKey: 'activityFund.received', organizationId: organization.id } })).toBe(2);
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `CREDIT_POOL_EXPIRED:${sponsorId}` } })).toBeNull();
    // Ya es de la entidad: una campaña nueva no la recibe, y repetir la tarea no mueve nada dos veces.
    const fresh = await createInitiative(db, organization.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 1_000_000, title: 'Demasiado tarde', closesAt: new Date(later.getTime() + 5 * DAY) });
    await expect(inTransactionRelocate(sponsorId, later)).resolves.toMatchObject({ kind: 'NOTHING' });
    await expireCreditPools(db, later, 500);
    expect(await db.activityFundDeposit.count({ where: { sponsorId } })).toBe(1);
    expect(await initiativeOf(fresh.id)).toMatchObject({ raisedCents: 0 });
    expect((await getTrialBalance(db)).balanced).toBe(true);
    expect((await listFriendlySponsors(db, organization.slug, new Date())).map((row) => row.id)).toEqual([sponsorId]);
  });
});

describe('Bolsa Matching 2x en una campaña que ya no recauda (heredado del 4.2b, punto 2)', () => {
  it('aprobarla en una campaña que ya llegó a su meta no la activa, y la bolsa entera se reasigna', async () => {
    const { organization, origin, directorActor } = await team();
    const target = await campaign(organization.id, 'Mochilas solidarias', 20);
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, null, { matchingPool: true });
    await db.initiative.update({ where: { id: origin.id }, data: { status: 'GOAL_REACHED' } });
    expect(await approveSponsor(db, directorActor, organization.id, { sponsorId }, options)).toEqual({ matching: false });
    expect(await initiativeOf(origin.id)).toMatchObject({ matchingPoolTotalCents: 0, matchingPoolRemainingCents: 0 });
    // La campaña ya no recauda: la bolsa entera se reasigna en la siguiente pasada, sin esperar a liquidar.
    await sweepSponsorMoney(db, new Date(), 50);
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: origin.id, sponsorId })).balanceCents).toBe(0);
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 25_000 });
    expect(await sponsorOf(sponsorId)).toMatchObject({ status: 'APPROVED', reassignedCents: 25_000 });
  });

  it('lo que sobra de una bolsa en parte liberada se reasigna; un contracargo después sale de la campaña nueva y lo ya liquidado es pérdida', async () => {
    const { organization, origin, directorActor } = await team();
    const target = await campaign(organization.id, 'Proyector del salón', 20);
    const { sponsorId, contribution } = await paidSponsor(organization.slug, origin.id, directorActor, { matchingPool: true });
    const donation = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: origin.id, fiscalYear: 2026, type: 'DONATION', amountCents: 10_000, totalChargedCents: 10_000, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING' } });
    expect(await deliver('PAYMENT', donation.paycometOrder!, 10_000)).toMatchObject({ outcome: 'PROCESSED' });
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 20_000, matchingPoolRemainingCents: 15_000 });

    await db.initiative.update({ where: { id: origin.id }, data: { status: 'GOAL_REACHED' } });
    await db.escrowPayout.create({ data: { organizationId: organization.id, initiativeId: origin.id, destinationType: 'ORGANIZATION', beneficiaryName: 'AMPA', beneficiaryIban: 'ES0000000000000000000000', netPaidCents: 20_000, korumFeeSettledCents: 0, status: 'APPROVED' } });
    await sweepSponsorMoney(db, new Date(), 50);
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 15_000 });
    expect(await initiativeOf(origin.id)).toMatchObject({ matchingPoolRemainingCents: 0, raisedCents: 20_000 });
    expect(await sponsorOf(sponsorId)).toMatchObject({ reassignedCents: 15_000, status: 'APPROVED' });

    expect(await deliver('CHARGEBACK', contribution.paycometOrder!, contribution.totalChargedCents)).toMatchObject({ status: 200 });
    expect(await linesOf({ contributionId: contribution.id, kind: 'CHARGEBACK' })).toEqual({
      [`DEBIT:INITIATIVE_ESCROW:${target.id}`]: 15_000,
      'DEBIT:CHARGEBACK_LOSSES': 10_000,
      'DEBIT:KORUM_REVENUE_SPONSOR_FEE': 3_750,
      'DEBIT:TAX_PAYABLE_VAT': 788,
      'CREDIT:PSP_CLEARING': contribution.totalChargedCents
    });
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 0 });
    // La campaña de origen ya liquidada no cambia: lo que duplicó ya salió.
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 20_000 });
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });
});

describe('Liquidaciones con dinero reasignado (auditoría financiera del 4.2d, B1)', () => {
  it('el origen y la campaña que recibe el sobrante de la bolsa Matching se liquidan sin repartir el mismo cobro por encima de lo cobrado', async () => {
    const { organization, origin, directorActor } = await team();
    await db.initiative.update({ where: { id: origin.id }, data: { goalCents: 20_000 } });
    const target = await campaign(organization.id, 'Proyector del salón', 20, 15_000);
    const { sponsorId, contribution } = await paidSponsor(organization.slug, origin.id, directorActor, { matchingPool: true });
    const donation = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: origin.id, fiscalYear: 2026, type: 'DONATION', amountCents: 10_000, totalChargedCents: 10_000, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING' } });
    expect(await deliver('PAYMENT', donation.paycometOrder!, 10_000)).toMatchObject({ outcome: 'PROCESSED' });
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 20_000, status: 'GOAL_REACHED', matchingPoolRemainingCents: 15_000 });

    // Al dejar de recaudar, el sobrante (15.000) va a la otra campaña, que llega a su meta.
    await sweepSponsorMoney(db, new Date(), 50);
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 15_000, status: 'GOAL_REACHED' });

    const originPayout = await signedPayout(organization, origin.id, 20_000);
    expect(await approvePayout(db, originPayout.id, TEST_HMAC_SECRET)).toMatchObject({ approved: true });
    const targetPayout = await signedPayout(organization, target.id, 15_000);
    expect(await approvePayout(db, targetPayout.id, TEST_HMAC_SECRET)).toMatchObject({ approved: true });

    const fromSponsorCharge = await db.escrowPayoutSplit.aggregate({ where: { contributionId: contribution.id }, _sum: { amountCents: true } });
    expect(fromSponsorCharge._sum.amountCents ?? 0).toBeLessThanOrEqual(contribution.totalChargedCents);
    const targetSplits = await db.escrowPayoutSplit.findMany({ where: { payoutId: targetPayout.id }, select: { contributionId: true, amountCents: true } });
    expect(targetSplits).toEqual([{ contributionId: contribution.id, amountCents: 15_000 }]);
    // La conciliación diaria no ve ningún cobro repartido de más ni bolsas descuadradas en este comercio.
    await checkSponsorMoney(db, new Date());
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `RECONCILIATION_MISMATCH:SPLIT:${contribution.id}` } })).toBeNull();
    expect(await db.opsAlert.findUnique({ where: { dedupeKey: `RECONCILIATION_MISMATCH:SPONSOR:${sponsorId}` } })).toBeNull();
  });

  it('sobrante movido al llegar a la meta y después un contracargo de la donación duplicada: el bonus sigue al comercio y el 💛 no baja en bucle (auditoría financiera, N1)', async () => {
    const { organization, origin, directorActor } = await team();
    await db.initiative.update({ where: { id: origin.id }, data: { goalCents: 20_000 } });
    const target = await campaign(organization.id, 'Telescopio del aula', 20);
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor, { matchingPool: true });
    const donation = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: origin.id, fiscalYear: 2026, type: 'DONATION', amountCents: 10_000, totalChargedCents: 10_000, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING' } });
    expect(await deliver('PAYMENT', donation.paycometOrder!, 10_000)).toMatchObject({ outcome: 'PROCESSED' });
    await sweepSponsorMoney(db, new Date(), 50);
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 15_000 });

    // El banco retira la donación duplicada: la campaña vuelve a recaudar y el bonus (10.000) va a la bolsa del comercio, no a una bolsa apagada.
    expect(await deliver('CHARGEBACK', donation.paycometOrder!, 10_000)).toMatchObject({ status: 200 });
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 0, status: 'FUNDRAISING' });
    expect(await sponsorOf(sponsorId)).toMatchObject({ reassignedCents: 25_000, status: 'CREDIT_POOL' });
    expect(await poolOf(organization.id, sponsorId)).toBe(10_000);
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: origin.id, sponsorId })).balanceCents).toBe(0);

    // Antes de fracasar, el comercio sigue contando en el 💛 de su campaña (la donación ya se deshizo).
    expect((await initiativeOf(origin.id)).totalContributions).toBe(1);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    const after = await initiativeOf(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    expect((await initiativeOf(origin.id)).totalContributions).toBe(after.totalContributions);
    // Al fracasar deja de contar, una sola vez, y su bolsa se apaga (heredado del 4.2d, punto 8, Sprint 4.2f).
    expect(after).toMatchObject({ totalContributions: 0, matchingPoolTotalCents: 0 });
    expect(await escrowOf(origin.id)).toBe(0);
    expect(await initiativeOf(target.id)).toMatchObject({ raisedCents: 25_000 });
    expect(await poolOf(organization.id, sponsorId)).toBe(0);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('las bolsas vencidas no se atascan con lotes llenos: con un lote de 1, todas pasan al Fondo (auditoría financiera N2)', async () => {
    const ids: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      const { organization, origin, directorActor } = await team();
      const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
      await fail(origin.id);
      await sweepSponsorMoney(db, new Date(), 50);
      ids.push(sponsorId);
    }
    const later = new Date(Date.now() + 61 * DAY);
    for (let run = 0; run < 400; run += 1) {
      if ((await expireCreditPools(db, later, 1)).expired === 0) break;
    }
    for (const id of ids) expect(await db.activityFundDeposit.count({ where: { sponsorId: id } })).toBe(1);
  });

  it('la conciliación avisa si la bolsa de un comercio devuelto aún tiene dinero', async () => {
    const { organization, origin, directorActor } = await team();
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    await db.sponsor.update({ where: { id: sponsorId }, data: { status: 'REFUNDED', creditPoolAt: null } });
    await checkSponsorMoney(db, new Date());
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `RECONCILIATION_MISMATCH:SPONSOR:${sponsorId}` } })).toMatchObject({ status: 'OPEN', detailJson: { kind: 'SPONSOR_MONEY_MISMATCH', poolCents: 25_000 } });
    await db.sponsor.update({ where: { id: sponsorId }, data: { status: 'CREDIT_POOL', creditPoolAt: new Date() } });
    await checkSponsorMoney(db, new Date());
    expect((await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `RECONCILIATION_MISMATCH:SPONSOR:${sponsorId}` } })).status).toBe('RESOLVED');
  });

  it('el barrido no se atasca con comercios ya movidos: con un lote de 1 encuentra al nuevo de una campaña fallida (auditoría financiera, I3)', async () => {
    const { organization, origin, directorActor } = await team();
    await campaign(organization.id, 'Destino', 20);
    for (let index = 0; index < 2; index += 1) {
      const moved = await paidSponsor(organization.slug, origin.id, directorActor);
      expect(moved.sponsorId).toBeGreaterThan(0);
    }
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    const second = await team();
    const { sponsorId } = await paidSponsor(second.organization.slug, second.origin.id, second.directorActor);
    await fail(second.origin.id);
    await sweepSponsorMoney(db, new Date(), 1);
    expect(await sponsorOf(sponsorId)).toMatchObject({ reassignedCents: 25_000 });
  });
});

describe('Renovación anual con enlace de pago', () => {
  it('el enlace firmado lleva a pagar, el cobro entra en la bolsa y se coloca con la regla; el distintivo sigue al anterior sin perder días', async () => {
    const { organization, origin, directorActor } = await team('SOONEST');
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    const previousExpiry = new Date(Date.now() - DAY);
    await db.sponsor.update({ where: { id: sponsorId }, data: { expiresAt: previousExpiry } });

    expect(await queueRenewalLinks(db, new Date(), 500, TEST_HMAC_SECRET)).toBeGreaterThanOrEqual(1);
    const link = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.renewalLink', organizationId: organization.id } });
    const token = (link.payloadJson as { token: string }).token;
    expect(await loadRenewalOffer(db, TEST_HMAC_SECRET, organization.slug, token)).toMatchObject({ status: 'OK', amountCents: 25_000, feeCents: 3_750, vatCents: 788, totalCents: 29_538, rule: 'SOONEST' });
    expect(await loadRenewalOffer(db, TEST_HMAC_SECRET, organization.slug, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`)).toEqual({ status: 'INVALID' });
    expect(await loadRenewalOffer(db, TEST_HMAC_SECRET, (await createOrganization(db)).slug, token)).toEqual({ status: 'INVALID' });

    const start = await startSponsorRenewal({ db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { orgSlug: organization.slug, token, method: 'BIZUM', locale: 'ca' }, { session: null, ip: freshIp() });
    expect(start.status).toBe('REDIRECT');
    const order = new URL((start as { url: string }).url, 'http://localhost').searchParams.get('pedido')!;
    expect(order).toMatch(/^KR[0-9A-F]{16}$/);
    const renewalCharge = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(renewalCharge).toMatchObject({ type: 'SPONSORSHIP', initiativeId: origin.id, amountCents: 25_000, totalChargedCents: 29_538, status: 'PENDING' });
    expect(await deliver('PAYMENT', order, renewalCharge.totalChargedCents)).toMatchObject({ outcome: 'PROCESSED' });

    const renewal = await sponsorOf(renewalCharge.sponsorId!);
    expect(renewal).toMatchObject({ renewedFromId: sponsorId, status: 'APPROVED', reassignedCents: 25_000, isMatchingPool: false, creditPoolAt: null });
    expect(renewal.expiresAt.getTime()).toBeGreaterThan(Date.now() + 360 * DAY);
    // Sin otra campaña, va a la que estaba recaudando (la original, que sigue activa) por su asignación, no por el cobro.
    expect(await initiativeOf(origin.id)).toMatchObject({ raisedCents: 50_000, totalContributions: 2 });
    expect(await db.sponsorAllocation.findMany({ where: { sponsorId: renewal.id }, select: { initiativeId: true, amountCents: true } })).toEqual([{ initiativeId: origin.id, amountCents: 25_000 }]);
    expect(await sponsorOf(sponsorId)).toMatchObject({ autoRenew: false });
    expect(await db.invoice.findFirstOrThrow({ where: { sponsorId: renewal.id } })).toMatchObject({ invoiceType: 'F1', concept: expect.stringContaining('Renovación anual') });
    const renewed = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.renewed', organizationId: organization.id } });
    expect(renewed).toMatchObject({ locale: 'ca', toAddress: 'rosa@elfaro.example', payloadJson: { sponsorId: renewal.id, placed: ['Toldos para el patio'], order } });
    // El mismo enlace ya no sirve, y el directorio enseña al comercio una sola vez.
    expect(await loadRenewalOffer(db, TEST_HMAC_SECRET, organization.slug, token)).toEqual({ status: 'RENEWED' });
    expect((await listFriendlySponsors(db, organization.slug, new Date())).map((row) => row.id)).toEqual([renewal.id]);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('dos pedidos del mismo enlace pagados (dos pestañas, a la vez): no se devuelve nada (Sprint 4.2f); el segundo renueva el año siguiente, con su factura y su dinero a las campañas', async () => {
    const { organization, origin, directorActor } = await team('SOONEST');
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    await db.sponsor.update({ where: { id: sponsorId }, data: { expiresAt: new Date(Date.now() - DAY) } });
    const { messageId } = await sendRenewalLink(db, directorActor, organization.id, { sponsorId }, TEST_HMAC_SECRET);
    const token = ((await db.outboxMessage.findUniqueOrThrow({ where: { id: messageId! } })).payloadJson as { token: string }).token;
    const begin = async () => {
      const start = await startSponsorRenewal({ db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { orgSlug: organization.slug, token, method: 'CARD', locale: 'es' }, { session: null, ip: freshIp() });
      const order = new URL((start as { url: string }).url, 'http://localhost').searchParams.get('pedido')!;
      return db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    };
    const first = await begin();
    const second = await begin();
    // Abrir un segundo pago da por abandonado el primero sin pagar…
    expect((await db.contribution.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('FAILED');
    const raisedBefore = (await initiativeOf(origin.id)).raisedCents;
    // …y si Paycomet acaba cobrando los dos, a la vez, los dos cuentan: el segundo renueva el año que sigue al primero.
    const results = await Promise.all([deliver('PAYMENT', first.paycometOrder!, first.totalChargedCents), deliver('PAYMENT', second.paycometOrder!, second.totalChargedCents)]);
    expect(results.every((result) => result.status === 200)).toBe(true);

    const year1 = await db.sponsor.findMany({ where: { renewedFromId: sponsorId, paidAt: { not: null } }, include: { contribution: true, invoices: true } });
    expect(year1).toHaveLength(1);
    const year2 = await db.sponsor.findMany({ where: { renewedFromId: year1[0]!.id, paidAt: { not: null } }, include: { contribution: true, invoices: true } });
    expect(year2).toHaveLength(1);
    for (const row of [...year1, ...year2]) {
      expect(row.contribution?.status).toBe('COMPLETED');
      expect(row.invoices).toHaveLength(1);
    }
    expect(await db.auditLog.count({ where: { action: 'sponsor.renewal_chained', targetId: String(year2[0]!.id) } })).toBe(1);
    // El comercio sabe que pagó dos veces y que el segundo pago renueva el año siguiente (auditoría de seguridad y legal del 4.2f, I2).
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `sponsor.renewed:${year2[0]!.id}` } })).payloadJson).toMatchObject({ chained: true });
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: `sponsor.renewed:${year1[0]!.id}` } })).payloadJson).toMatchObject({ chained: false });
    // Sin días perdidos: el segundo año empieza cuando acaba el primero.
    expect(year2[0]!.expiresAt.getTime()).toBeGreaterThan(year1[0]!.expiresAt.getTime());
    // La campaña recibe las dos renovaciones.
    expect((await initiativeOf(origin.id)).raisedCents).toBe(raisedBefore + 50_000);
    // El directorio enseña al comercio una sola vez (el año en vigor).
    expect((await listFriendlySponsors(db, organization.slug, new Date())).filter((row) => row.id !== sponsorId)).toHaveLength(1);
    expect((await getTrialBalance(db)).balanced).toBe(true);
  });

  it('el panel reenvía el enlace solo en el plazo de la renovación; sin campañas activas, la renovación espera en la bolsa', async () => {
    const { organization, origin, directorActor } = await team('PROPORTIONAL');
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    await expect(sendRenewalLink(db, directorActor, organization.id, { sponsorId }, TEST_HMAC_SECRET)).rejects.toMatchObject({ reason: 'RENEWAL_NOT_OPEN' });
    await db.sponsor.update({ where: { id: sponsorId }, data: { expiresAt: new Date(Date.now() + 10 * DAY) } });
    const { messageId } = await sendRenewalLink(db, directorActor, organization.id, { sponsorId }, TEST_HMAC_SECRET);
    expect(messageId).not.toBeNull();
    const token = ((await db.outboxMessage.findUniqueOrThrow({ where: { id: messageId! } })).payloadJson as { token: string }).token;

    await db.initiative.update({ where: { id: origin.id }, data: { status: 'CLOSED' } });
    const start = await startSponsorRenewal({ db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { orgSlug: organization.slug, token, method: 'CARD', locale: 'es' }, { session: null, ip: freshIp() });
    const order = new URL((start as { url: string }).url, 'http://localhost').searchParams.get('pedido')!;
    const charge = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(await deliver('PAYMENT', order, charge.totalChargedCents)).toMatchObject({ outcome: 'PROCESSED' });
    const renewal = await sponsorOf(charge.sponsorId!);
    expect(renewal).toMatchObject({ status: 'CREDIT_POOL' });
    expect(await poolOf(organization.id, renewal.id)).toBe(25_000);
    expect(await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'sponsor.renewed', organizationId: organization.id } })).toMatchObject({ payloadJson: { manual: false, poolDeadline: expect.any(String) } });
    // Una campaña nueva: la tarea la coloca con la regla.
    const fresh = await campaign(organization.id, 'Taquillas del vestuario', 20);
    await sweepSponsorMoney(db, new Date(), 50);
    expect(await initiativeOf(fresh.id)).toMatchObject({ raisedCents: 25_000 });
  });
});

describe('Defensas en la base de datos', () => {
  it('una asignación no se borra ni cambia de importe, y un comercio en la bolsa necesita su fecha de entrada', async () => {
    const { organization, origin, directorActor } = await team();
    await campaign(organization.id, 'Destino', 20);
    const { sponsorId } = await paidSponsor(organization.slug, origin.id, directorActor);
    await fail(origin.id);
    await sweepSponsorMoney(db, new Date(), 50);
    const allocation = await db.sponsorAllocation.findFirstOrThrow({ where: { sponsorId } });
    await expect(db.$executeRawUnsafe(`UPDATE ${table('SponsorAllocation')} SET "amountCents" = 1 WHERE id = ${allocation.id}`)).rejects.toThrow(/solo se cierra/);
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('SponsorAllocation')} WHERE id = ${allocation.id}`)).rejects.toThrow(/no se borra/);
    await expect(db.sponsor.update({ where: { id: sponsorId }, data: { status: 'CREDIT_POOL' } })).rejects.toThrow();
  });
});
