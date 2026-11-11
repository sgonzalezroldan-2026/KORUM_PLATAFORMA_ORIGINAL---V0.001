import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance, getTrialBalance } from '@/core/finance/ledger.service';
import { reserveInitiativeQuotas } from '@/core/finance/quota-reservation';
import { calculatePublicBreakdown4Lines } from '@/core/finance/tco.service';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { massRefundHandler } from '@/core/jobs/handlers/mass-refund';
import type { JobDeps } from '@/core/jobs/job-types';
import { anonymizeOldResizeVotes } from '@/core/privacy/retention-purge';
import { secretsExpired } from '@/services/email/outbox-secrets';
import { signResizeVoteToken } from '@/core/resize/resize-rules';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { loadExpiredCampaigns } from '@/repositories/expired-campaigns.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { runSupporterBroadcasts } from '@/services/notifications/supporter-broadcast';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { requestCampaignPayout } from '@/services/payouts/campaign-payout.service';
import { closeDueResizePolls, closeResizePoll } from '@/services/resize/resize-close';
import { castResizeVote, loadResizeBallot } from '@/services/resize/resize-vote.service';
import { decideRefund, launchResizeVote } from '@/services/resize/expired-decision.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, table, testJobDeps, uniqueId } from './test-database';

/**
 * Sprint 4.4b · Campañas vencidas contra PostgreSQL real (QA-S03, la parte que vence sin llegar): la entidad decide (reembolsar o votar); la votación
 * vinculante con su enlace personal, una persona un voto y la devolución en el acto de quien la pide; el cierre con la meta nueva y las comisiones
 * proporcionales (o el reembolso si no hay proyecto); el reembolso masivo con los cupos devueltos; las defensas de la base y la conservación de los votos.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-redimensionamiento' };
const SECRET = TEST_HMAC_SECRET;
const DAY = 86_400_000;
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
let jobDeps: JobDeps;
const created: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  jobDeps = { paymentProvider: async () => mock, invoicingProvider: () => { throw new Error('sin facturación'); }, refundOriginalIp: async () => '10.0.0.1', ...testJobDeps() };
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: created }, status: 'PENDING' } });
  await db.$disconnect();
});

const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>, secondFactor = true): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor });
const ctx = (now: Date) => ({ db, now, batchSize: 50, deps: jobDeps });

async function team() {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
  created.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, director: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]), cosigner: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }]) };
}

const deliver = (kind: 'PAYMENT' | 'CHARGEBACK', order: string, amountCents: number) => {
  const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents });
  return handlePaymentWebhook(db, mock, rawBody, contentType);
};

async function donate(organizationId: string, initiativeId: number, amountCents: number, email = `${uniqueId('familia')}@pruebas.example`, guaranteeCents = 0) {
  const contribution = await db.contribution.create({
    data: { organizationId, initiativeId, fiscalYear: 2026, type: 'DONATION', amountCents, guaranteeContributionCents: guaranteeCents, totalChargedCents: amountCents + guaranteeCents, paymentMethod: 'BIZUM', paycometOrder: uniqueId('ORD'), status: 'PENDING', guestEmail: email, canonicalEmail: email }
  });
  expect(await deliver('PAYMENT', contribution.paycometOrder!, contribution.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

/**
 * Campaña de presupuesto de 200 € (120 € de proveedor + 40 € de instalación + 10 % de reserva + 10 € de tramo + 5 € de mantenimiento + 9 € de pasarela)
 * con sus cupos reservados, que vence con lo donado. Devuelve la iniciativa ya `EXPIRED`.
 */
async function expiredCampaign(organizationId: string, donations: Array<[number, string?, number?]>, overrides: Parameters<typeof createInitiative>[2] = {}) {
  const initiative = await createInitiative(db, organizationId, {
    status: 'FUNDRAISING',
    goalCents: 20_000,
    costMatCents: 12_000,
    costInstCents: 4_000,
    contingencyBps: 1_000,
    bracketFeeCents: 1_000,
    maintFeeCents: 500,
    gatewayFeeCents: 900,
    ...overrides
  });
  await reserveInitiativeQuotas(db, initiative.id);
  const contributions = [];
  for (const [amount, email, guarantee] of donations) contributions.push(await donate(organizationId, initiative.id, amount, email, guarantee ?? 0));
  await db.initiative.update({ where: { id: initiative.id }, data: { closesAt: new Date(Date.now() - 60_000) } });
  await campaignExpiryHandler(ctx(new Date()));
  expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('EXPIRED');
  return { initiative, contributions };
}

/** Reparte la votación por lotes y devuelve el enlace personal de cada persona (por su email). */
async function voteLinks(initiativeId: number, organizationId: string): Promise<Map<string, string>> {
  await runSupporterBroadcasts(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
  const messages = await db.outboxMessage.findMany({ where: { templateKey: 'initiative.resizePoll', organizationId, idempotencyKey: { startsWith: `initiative.resizePoll:${initiativeId}:` } } });
  return new Map(messages.map((message) => [message.toAddress, (message.payloadJson as { voteToken: string }).voteToken]));
}

const OPTIONS = ['Comprar 14 tablets con lo recaudado', 'Comprar 10 tablets y un armario cargador'];
const vote = (slug: string, token: string, choice: { kind: 'OPTION'; index: number } | { kind: 'REFUND' }) => castResizeVote(db, SECRET, { orgSlug: slug, token, choice }, { ip: '10.1.2.3' });

describe('QA-S03 · la entidad decide qué hacer con una campaña vencida', () => {
  it('solo una persona firmante con su segundo factor y de esa entidad; votar exige presupuesto, donaciones, margen y opciones distintas', async () => {
    const { organization, director } = await team();
    const { initiative } = await expiredCampaign(organization.id, [[5_000]]);
    const payload = { initiativeId: initiative.id, options: OPTIONS };
    await expect(launchResizeVote(db, { ...director, secondFactor: false }, organization.id, payload)).rejects.toBeInstanceOf(TenantAccessError);
    const family = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: family.id, role: 'FAMILY' } });
    await expect(decideRefund(db, actorFor(family.id, [{ organizationId: organization.id, role: 'FAMILY' }]), organization.id, { initiativeId: initiative.id })).rejects.toBeInstanceOf(TenantAccessError);
    const other = await team();
    await expect(decideRefund(db, other.director, other.organization.id, { initiativeId: initiative.id })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(await db.auditLog.count({ where: { organizationId: other.organization.id, metadataJson: { path: ['ownerOrganizationId'], equals: organization.id } } })).toBeGreaterThan(0);
    await expect(launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: ['Comprar 14 tablets', 'comprar  14 TABLETS'] })).rejects.toMatchObject({ reason: 'DUPLICATE_OPTIONS' });
    await expect(launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: ['Solo una opción posible'] })).rejects.toMatchObject({ reason: 'INVALID_INPUT' });

    const ticketing = await expiredCampaign(organization.id, [[2_000]], { format: 'TICKETING', ticketSubtype: 'EVENT', ticketPriceCents: 1_000, ticketMax: 100, ticketFeeMode: 'ADD', costMatCents: 0, costInstCents: 0 });
    await expect(launchResizeVote(db, director, organization.id, { initiativeId: ticketing.initiative.id, options: OPTIONS })).rejects.toMatchObject({ reason: 'NOT_BUDGET' });
    const late = await expiredCampaign(organization.id, [[2_000]]);
    await db.initiative.update({ where: { id: late.initiative.id }, data: { firstPayinAt: new Date(Date.now() - 80 * DAY) } });
    await expect(launchResizeVote(db, director, organization.id, { initiativeId: late.initiative.id, options: OPTIONS })).rejects.toMatchObject({ reason: 'WINDOW_TOO_SHORT' });
    expect(await db.resizePoll.count({ where: { initiativeId: { in: [initiative.id, ticketing.initiative.id, late.initiative.id] } } })).toBe(0);
  });

  it('reembolsar: REFUNDING, aviso a quien firma y a quien donó, MASS_REFUND devuelve el 100 % y devuelve los cupos', async () => {
    const { organization, director } = await team();
    const { initiative, contributions } = await expiredCampaign(organization.id, [[5_000, undefined, 300], [2_500]]);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).maintPaidCents).toBe(500);
    expect(await decideRefund(db, director, organization.id, { initiativeId: initiative.id })).toMatchObject({ status: 'REFUNDING' });
    await expect(decideRefund(db, director, organization.id, { initiativeId: initiative.id })).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
    expect(await db.outboxMessage.count({ where: { templateKey: 'initiative.expiredDecided', organizationId: organization.id } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: 'initiative.refund_decided', targetId: String(initiative.id), actorUserId: director.userId } })).toBe(1);

    await runSupporterBroadcasts(db, { now: new Date(), batchSize: 50, hmacSecret: SECRET });
    expect(await db.outboxMessage.count({ where: { templateKey: 'initiative.refundingSupporter', organizationId: organization.id } })).toBe(2);
    const view = await loadExpiredCampaigns(db, director, organization.id);
    expect(view.active.find((row) => row.id === initiative.id)?.refund).toEqual({ total: 2, done: 0, totalCents: 7_800, doneCents: 0 });

    await massRefundHandler(ctx(new Date()));
    for (const contribution of contributions) expect(await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } })).toMatchObject({ status: 'REFUNDED', refundedCents: contribution.totalChargedCents });
    const refunded = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(refunded).toMatchObject({ status: 'REFUNDED', raisedCents: 0 });
    expect(refunded.quotaReleasedAt).not.toBeNull();
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).maintPaidCents).toBe(0);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: initiative.id })).balanceCents).toBe(0);
    const history = (await loadExpiredCampaigns(db, director, organization.id)).history.find((row) => row.id === initiative.id);
    expect(history).toMatchObject({ status: 'REFUNDED', quotasReleased: true, refund: { total: 2, done: 2, doneCents: 7_800 } });
    await expect(loadExpiredCampaigns(db, (await team()).director, organization.id)).rejects.toBeInstanceOf(TenantAccessError);
  });
});

describe('QA-S03 · votación vinculante: una persona un voto, devolución en el acto y cierre con la meta nueva', () => {
  it('de extremo a extremo: votan, quien lo pide recupera el 100 %, gana un proyecto y la comisión baja en proporción', async () => {
    const { organization, director, cosigner } = await team();
    const repeat = `${uniqueId('repite')}@pruebas.example`;
    const asksBack = `${uniqueId('devolucion')}@pruebas.example`;
    const third = `${uniqueId('tercera')}@pruebas.example`;
    const silent = `${uniqueId('no-vota')}@pruebas.example`;
    const { initiative, contributions } = await expiredCampaign(organization.id, [[2_000, repeat], [2_000, repeat], [3_000, third], [2_000, asksBack, 200], [1_500, silent]]);
    const receipt = await launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: OPTIONS });
    expect(receipt.status).toBe('RESIZE_VOTING');
    const poll = await db.resizePoll.findUniqueOrThrow({ where: { initiativeId: initiative.id } });
    expect(poll).toMatchObject({ status: 'OPEN', originalGoalCents: 20_000, raisedAtLaunchCents: 10_500, createdById: director.userId });
    await expect(launchResizeVote(db, cosigner, organization.id, { initiativeId: initiative.id, options: OPTIONS })).rejects.toMatchObject({ reason: 'WRONG_STATUS' });

    // Una papeleta por persona, aunque donara dos veces.
    const links = await voteLinks(initiative.id, organization.id);
    expect([...links.keys()].sort()).toEqual([asksBack, repeat, silent, third].sort());
    const ballot = await loadResizeBallot(db, SECRET, organization.slug, links.get(asksBack)!);
    expect(ballot).toMatchObject({ status: 'OPEN', options: OPTIONS, refundableCents: 2_200, vote: null });

    // Enlaces que no valen: manipulado, de otra entidad, una opción que no existe.
    const tampered = `${links.get(third)!.slice(0, -1)}${links.get(third)!.endsWith('0') ? '1' : '0'}`;
    await expect(vote(organization.slug, tampered, { kind: 'OPTION', index: 0 })).rejects.toMatchObject({ reason: 'INVALID_LINK' });
    await expect(vote('otra-entidad', links.get(third)!, { kind: 'OPTION', index: 0 })).rejects.toMatchObject({ reason: 'INVALID_LINK' });
    await expect(vote(organization.slug, links.get(third)!, { kind: 'OPTION', index: 3 })).rejects.toMatchObject({ reason: 'INVALID_CHOICE' });

    expect(await vote(organization.slug, links.get(third)!, { kind: 'OPTION', index: 0 })).toEqual({ choice: { kind: 'OPTION', index: 0 }, refundedCents: 0 });
    await expect(vote(organization.slug, links.get(third)!, { kind: 'OPTION', index: 1 })).rejects.toMatchObject({ reason: 'ALREADY_VOTED' });
    expect(await vote(organization.slug, links.get(repeat)!, { kind: 'OPTION', index: 0 })).toMatchObject({ refundedCents: 0 });
    // Su otro enlace (la segunda donación) es la misma persona.
    const secondLink = signResizeVoteToken(SECRET, poll.id, contributions[1]!.id);
    await expect(vote(organization.slug, secondLink, { kind: 'OPTION', index: 1 })).rejects.toMatchObject({ reason: 'ALREADY_VOTED' });

    // Quien pide su devolución la tiene aprobada en el acto (con su aportación a KORUM) y deja de contar.
    expect(await vote(organization.slug, links.get(asksBack)!, { kind: 'REFUND' })).toEqual({ choice: { kind: 'REFUND' }, refundedCents: 2_200 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contributions[3]!.id } })).toMatchObject({ status: 'REFUND_PENDING' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).raisedCents).toBe(8_500);
    expect(await loadResizeBallot(db, SECRET, organization.slug, links.get(asksBack)!)).toMatchObject({ vote: { kind: 'REFUND' }, refundableCents: 0 });
    const during = (await loadExpiredCampaigns(db, director, organization.id)).active.find((row) => row.id === initiative.id);
    expect(during?.poll).toMatchObject({ votes: 3, refundVotes: 1, counts: null });

    // Antes de los 7 días no se cierra; después, sí, una sola vez.
    expect(await closeResizePoll(db, poll.id, new Date())).toBeNull();
    const after = new Date(poll.closesAt.getTime() + 60_000);
    expect((await closeDueResizePolls(db, after, 50)).resized).toBeGreaterThanOrEqual(1);
    expect(await closeResizePoll(db, poll.id, after)).toBeNull();
    await expect(vote(organization.slug, links.get(repeat)!, { kind: 'OPTION', index: 1 })).rejects.toMatchObject({ reason: 'CLOSED' });

    // Quien no votó recupera el 100 % al cerrarse (decisión del promotor, 2026-11-11): la propuesta se hace con lo de quienes votaron un proyecto.
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contributions[4]!.id } })).toMatchObject({ status: 'REFUND_PENDING' });
    // Meta nueva = lo que quedó (70 €); comisiones al 35 %, hacia abajo; el desglose público sigue sumando la meta.
    const resized = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(resized).toMatchObject({ status: 'GOAL_REACHED', stepIndex: 5, goalCents: 7_000, raisedCents: 7_000, bracketFeeCents: 350, maintFeeCents: 175, gatewayFeeCents: 315 });
    const lines = calculatePublicBreakdown4Lines(resized);
    expect(lines.line1ProviderCents + lines.line2InstallCents + lines.line3ContingencyCents + lines.line4EscrowAndGuaranteeCents).toBe(7_000);
    expect(lines.line4EscrowAndGuaranteeCents).toBeGreaterThanOrEqual(840);
    expect(await db.resizePoll.findUniqueOrThrow({ where: { id: poll.id } })).toMatchObject({ status: 'CLOSED_APPROVED', winningOptionIndex: 0, newGoalCents: 7_000, resultJson: { counts: [2, 0], refundVotes: 1, outcome: 'PROJECT', maintQuotaReleasedCents: 325 } });
    // El mantenimiento que ya no se cobra vuelve al cupo del curso.
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).maintPaidCents).toBe(175);
    expect(await db.outboxMessage.count({ where: { templateKey: 'initiative.resizeClosed', organizationId: organization.id } })).toBe(2);
    await runSupporterBroadcasts(db, { now: after, batchSize: 50, hmacSecret: SECRET });
    // El resultado, solo a quien sigue en la campaña (no a quien pidió su devolución ni a quien no votó).
    expect((await db.outboxMessage.findMany({ where: { templateKey: 'initiative.resizeResult', organizationId: organization.id } })).map((message) => message.toAddress).sort()).toEqual([repeat, third].sort());

    // La devolución pedida sale con MASS_REFUND; la liquidación paga lo recaudado menos las comisiones nuevas.
    await massRefundHandler(ctx(after));
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contributions[3]!.id } })).toMatchObject({ status: 'REFUNDED', refundedCents: 2_200 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: contributions[4]!.id } })).toMatchObject({ status: 'REFUNDED', refundedCents: 1_500 });
    const invoice = await db.fileAsset.create({ data: { bucket: 'korum-private', objectKey: `tests/${uniqueId('factura')}.pdf`, visibility: 'PRIVATE', purpose: 'PROVIDER_INVOICE', mimeType: 'application/pdf', sizeBytes: 2_000, sha256: 'a'.repeat(64), organizationId: organization.id } });
    const payout = await requestCampaignPayout(db, { secret: SECRET, keyring: TEST_KEYRING, providerPayoutAvailable: false }, director, organization.id, { destination: 'ORGANIZATION', initiativeId: initiative.id, invoiceFileId: invoice.id });
    expect(payout.netPaidCents).toBe(7_000 - 350 - 175 - 315);

    // Un cobro que llega después del cierre no engorda la campaña decidida: se devuelve (auditoría financiera, H2).
    const late = await donate(organization.id, initiative.id, 1_500);
    expect(await db.contribution.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ status: 'REFUND_PENDING' });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).raisedCents).toBe(7_000);

    // Un contracargo posterior no la devuelve a recaudar (la votación ya decidió): la meta y las comisiones bajan otra vez en proporción (H1).
    expect(await deliver('CHARGEBACK', contributions[2]!.paycometOrder!, 3_000)).toMatchObject({ status: 200 });
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'GOAL_REACHED', raisedCents: 4_000, goalCents: 4_000, bracketFeeCents: 200, maintFeeCents: 100, gatewayFeeCents: 180 });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).maintPaidCents).toBe(100);
    await expect(requestCampaignPayout(db, { secret: SECRET, keyring: TEST_KEYRING, providerPayoutAvailable: false }, director, organization.id, { destination: 'ORGANIZATION', initiativeId: initiative.id, invoiceFileId: invoice.id })).resolves.toMatchObject({ netPaidCents: 4_000 - 200 - 100 - 180, updated: true });
    const trial = await getTrialBalance(db);
    expect(trial.debitCents).toBe(trial.creditCents);
  });

  it('sin votos de proyecto o con empate se devuelve el 100 % a todas las personas', async () => {
    const { organization, director } = await team();
    const one = `${uniqueId('una')}@pruebas.example`;
    const two = `${uniqueId('dos')}@pruebas.example`;
    const tied = await expiredCampaign(organization.id, [[3_000, one], [3_000, two]]);
    await launchResizeVote(db, director, organization.id, { initiativeId: tied.initiative.id, options: OPTIONS });
    const links = await voteLinks(tied.initiative.id, organization.id);
    await vote(organization.slug, links.get(one)!, { kind: 'OPTION', index: 0 });
    await vote(organization.slug, links.get(two)!, { kind: 'OPTION', index: 1 });

    const silent = await expiredCampaign(organization.id, [[3_000]]);
    await launchResizeVote(db, director, organization.id, { initiativeId: silent.initiative.id, options: OPTIONS });

    const later = new Date(Date.now() + 8 * DAY);
    await campaignExpiryHandler(ctx(later));
    for (const [id, outcome] of [[tied.initiative.id, 'TIE'], [silent.initiative.id, 'NO_VOTES']] as const) {
      expect((await db.initiative.findUniqueOrThrow({ where: { id } })).status).toBe('REFUNDING');
      expect(await db.resizePoll.findUniqueOrThrow({ where: { initiativeId: id } })).toMatchObject({ status: 'CLOSED_REJECTED', winningOptionIndex: null, resultJson: { outcome } });
    }
    await massRefundHandler(ctx(later));
    expect((await db.initiative.findUniqueOrThrow({ where: { id: tied.initiative.id } })).status).toBe('REFUNDED');
    expect(await db.contribution.count({ where: { initiativeId: tied.initiative.id, status: 'REFUNDED' } })).toBe(2);
  });

  it('el enlace de la papeleta vale hasta el cierre en la bandeja (no una hora), y un voto contracargado deja de contar en el recuento', async () => {
    const { organization, director } = await team();
    const loud = `${uniqueId('contracargo')}@pruebas.example`;
    const silent = `${uniqueId('calla')}@pruebas.example`;
    const { initiative, contributions } = await expiredCampaign(organization.id, [[100, loud], [10_000, silent]]);
    await launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: OPTIONS });
    const poll = await db.resizePoll.findUniqueOrThrow({ where: { initiativeId: initiative.id } });
    const links = await voteLinks(initiative.id, organization.id);
    const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'initiative.resizePoll', toAddress: silent } });
    expect(secretsExpired({ ...message, createdAt: new Date(Date.now() - 20 * 3_600_000) }, new Date())).toBe(false);
    expect(secretsExpired(message, new Date(poll.closesAt.getTime() + 1_000))).toBe(true);

    await vote(organization.slug, links.get(loud)!, { kind: 'OPTION', index: 0 });
    expect(await deliver('CHARGEBACK', contributions[0]!.paycometOrder!, 100)).toMatchObject({ status: 200 });
    await closeResizePoll(db, poll.id, new Date(poll.closesAt.getTime() + 1_000));
    // El único voto era de quien ya no tiene dinero en la campaña: no decide por quien calló; se devuelve a todas las personas.
    expect(await db.resizePoll.findUniqueOrThrow({ where: { id: poll.id } })).toMatchObject({ status: 'CLOSED_REJECTED', resultJson: { outcome: 'NO_VOTES', counts: [0, 0] } });
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('REFUNDING');
  });

  it('un cierre que se queda sin tiempo tras el recuento sigue después: ya no se vota y el panel dice que se está devolviendo a quien no votó', async () => {
    const { organization, director } = await team();
    const voter = `${uniqueId('vota')}@pruebas.example`;
    const { initiative } = await expiredCampaign(organization.id, [[3_000, voter], [1_000], [1_000]]);
    await launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: OPTIONS });
    const poll = await db.resizePoll.findUniqueOrThrow({ where: { initiativeId: initiative.id } });
    const links = await voteLinks(initiative.id, organization.id);
    await vote(organization.slug, links.get(voter)!, { kind: 'OPTION', index: 1 });
    const after = new Date(poll.closesAt.getTime() + 1_000);
    expect(await closeResizePoll(db, poll.id, after, Date.now() - 1)).toBe('PENDING');
    expect(await db.resizePoll.findUniqueOrThrow({ where: { id: poll.id } })).toMatchObject({ status: 'OPEN', winningOptionIndex: 1 });
    const view = (await loadExpiredCampaigns(db, director, organization.id)).active.find((row) => row.id === initiative.id);
    expect(view?.poll).toMatchObject({ tallied: true, winner: OPTIONS[1], counts: [0, 1] });
    expect(await loadResizeBallot(db, SECRET, organization.slug, links.get(voter)!)).toMatchObject({ status: 'CLOSED', winner: OPTIONS[1] });
    expect(await closeResizePoll(db, poll.id, after)).toBe('PROJECT');
    expect(await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).toMatchObject({ status: 'GOAL_REACHED', goalCents: 3_000, raisedCents: 3_000 });
    expect(await db.contribution.count({ where: { initiativeId: initiative.id, status: 'REFUND_PENDING' } })).toBe(2);
    // La base no deja rehacer el recuento ni cambiar la opción ganadora.
    await expect(db.resizePoll.update({ where: { id: poll.id }, data: { winningOptionIndex: 0 } })).rejects.toThrow(/ya está cerrada/);
  });

  it('un voto y el cierre a la vez: o el voto cuenta en el recuento o se rechaza por cerrada, nunca entre medias', async () => {
    const { organization, director } = await team();
    const email = `${uniqueId('carrera')}@pruebas.example`;
    const { initiative } = await expiredCampaign(organization.id, [[4_000, email], [3_000]]);
    await launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: OPTIONS });
    const poll = await db.resizePoll.findUniqueOrThrow({ where: { initiativeId: initiative.id } });
    const links = await voteLinks(initiative.id, organization.id);
    const [voted, closed] = await Promise.allSettled([vote(organization.slug, links.get(email)!, { kind: 'OPTION', index: 1 }), closeResizePoll(db, poll.id, new Date(poll.closesAt.getTime() + 1_000))]);
    expect(closed.status).toBe('fulfilled');
    const final = await db.resizePoll.findUniqueOrThrow({ where: { id: poll.id } });
    const counted = (final.resultJson as { counts: number[] }).counts[1];
    if (voted.status === 'fulfilled') expect(counted).toBe(1);
    else {
      expect(voted.reason).toMatchObject({ reason: 'CLOSED' });
      expect(counted).toBe(0);
    }
  });
});

describe('Defensas de la base y conservación de los votos', () => {
  it('la votación y los votos no cambian ni se borran, y no se vota con la votación cerrada; el email del voto se anonimiza al año', async () => {
    const { organization, director } = await team();
    const email = `${uniqueId('defensa')}@pruebas.example`;
    const { initiative, contributions } = await expiredCampaign(organization.id, [[4_000, email], [1_000]]);
    await launchResizeVote(db, director, organization.id, { initiativeId: initiative.id, options: OPTIONS });
    const poll = await db.resizePoll.findUniqueOrThrow({ where: { initiativeId: initiative.id } });
    await vote(organization.slug, signResizeVoteToken(SECRET, poll.id, contributions[0]!.id), { kind: 'OPTION', index: 0 });
    const row = await db.resizeVote.findFirstOrThrow({ where: { pollId: poll.id } });

    await expect(db.resizeVote.update({ where: { id: row.id }, data: { optionIndex: 1 } })).rejects.toThrow(/no cambia/);
    await expect(db.resizeVote.delete({ where: { id: row.id } })).rejects.toThrow(/no se borra/);
    await expect(db.resizePoll.update({ where: { id: poll.id }, data: { optionsJson: ['Otra cosa distinta', 'Y otra más distinta'] } })).rejects.toThrow(/no cambian/);
    await expect(db.resizePoll.delete({ where: { id: poll.id } })).rejects.toThrow(/no se borra/);
    await expect(db.resizeVote.create({ data: { pollId: poll.id, canonicalEmail: 'otra@pruebas.example', contributionId: contributions[1]!.id, wantsRefund: true, optionIndex: 0 } })).rejects.toThrow(/ResizeVote_choice_valid|check/i);

    const closedAt = new Date(poll.closesAt.getTime() + 1_000);
    await closeResizePoll(db, poll.id, closedAt);
    await expect(db.resizeVote.create({ data: { pollId: poll.id, canonicalEmail: 'tarde@pruebas.example', contributionId: contributions[1]!.id, optionIndex: 0 } })).rejects.toThrow(/no casa con una votación abierta/);
    await expect(db.resizeVote.update({ where: { id: row.id }, data: { canonicalEmail: 'otra-persona@pruebas.example' } })).rejects.toThrow(/solo se anonimiza/);
    await expect(db.resizeVote.update({ where: { id: row.id }, data: { contributionId: null } })).rejects.toThrow(/ResizeVote_donation_or_anonymized|check/i);
    // Una votación solo nace de una campaña de presupuesto vencida, y no se vacía.
    const live = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    await expect(db.resizePoll.create({ data: { initiativeId: live.id, optionsJson: OPTIONS, closesAt: new Date(Date.now() + DAY), originalGoalCents: 1_000, raisedAtLaunchCents: 100 } })).rejects.toThrow(/campaña de presupuesto vencida/);
    await expect(db.$executeRawUnsafe(`TRUNCATE ${table('ResizeVote')}`)).rejects.toThrow(/no se vacían/);

    expect(await anonymizeOldResizeVotes(db, new Date(closedAt.getTime() + 300 * DAY), 50)).toBe(0);
    expect(await anonymizeOldResizeVotes(db, new Date(Date.now() + 400 * DAY), 50)).toBeGreaterThanOrEqual(1);
    const anonymous = await db.resizeVote.findUniqueOrThrow({ where: { id: row.id } });
    expect(anonymous.canonicalEmail).not.toContain('@');
    expect(anonymous.optionIndex).toBe(0);
    expect(anonymous.contributionId).toBeNull();
  });
});
