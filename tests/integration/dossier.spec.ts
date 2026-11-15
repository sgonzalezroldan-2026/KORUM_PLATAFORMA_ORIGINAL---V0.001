import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { parseAuditQuery } from '@/core/audit/audit-query';
import type { DossierData, DossierRequest } from '@/core/dossier/dossier-model';
import { buildDossierLines } from '@/core/dossier/dossier-pdf';
import { getAccountBalance, postJournal } from '@/core/finance/ledger.service';
import { selfBoostLines } from '@/core/finance/payment-journals';
import { formatCents } from '@/core/finance/money';
import { returnSelfBoostToKorum } from '@/core/finance/self-boost-return';
import { completeSignature } from '@/core/security/double-check.service';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { DOSSIER_RULE } from '@/lib/rate-limit-rules';
import { getEntityAudit } from '@/repositories/audit.repository';
import { DossierRateLimitError, downloadDossier, listEntityDossierOptions, resolveDossier } from '@/repositories/dossier.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { executeSelfBoost } from '@/services/admin/self-boost.service';
import { ENTITY_EMAIL_PREFIXES, ENTITY_EMAIL_TEMPLATES } from '@/services/dossier/dossier-loaders';
import { loadDossier } from '@/services/dossier/dossier.service';
import { settleSignedCampaignPayout } from '@/services/payments/campaign-payout-settlement';
import { startSponsorship } from '@/services/checkout/sponsorship.service';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import { refundContribution } from '@/services/payments/payment-reversals';
import { requestCampaignPayout } from '@/services/payouts/campaign-payout.service';
import { approveSponsor } from '@/services/sponsors/sponsor-moderation.service';
import { catalogDossierTexts } from '../support/dossier-texts';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId, verifiedSuperadmin } from './test-database';

/**
 * Sprint 5.8b · QA-SEC13 · expediente exportable contra PostgreSQL real. Una campaña hace su ciclo entero con los servicios de verdad (dos donaciones por
 * el aviso firmado de Paycomet, un Auto-Impulso, la liquidación al proveedor con sus dos firmas y sus envíos) y después se piden sus expedientes:
 *
 * - **las cifras cuadran al céntimo con el libro mayor** (lo recaudado, lo cobrado y lo devuelto de cada aportación, lo aprobado y lo enviado de la liquidación);
 * - **no lleva datos personales de más:** ni emails, ni el identificador de la cuenta, ni el IBAN ni el CIF del proveedor, ni el nombre de quien ya no firma;
 * - **la entidad solo ve lo suyo:** sus movimientos sumados por tipo para toda la campaña, sin números internos y sin que se note el Auto-Impulso, tampoco cuando KORUM lo recupera;
 * - **una entidad no puede descargar el de otra**, ni el de una aportación; cada descarga queda en la auditoría y cada cuenta tiene su tope por hora.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-expedientes' };
const IBAN = 'ES91 2100 0418 4502 0005 1332';
const PROVIDER_TAX_ID = 'B12345674';
const IP = '10.0.0.1';
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
const created: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  mock = new MockPaycometProvider({ secrets });
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: created }, status: 'PENDING' } });
  await db.$disconnect();
});

type UserActor = Extract<SessionActor, { kind: 'user' }>;
const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>, secondFactor = true): UserActor => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor });
const korum = async (secondFactor = true): Promise<UserActor> => ({ kind: 'user', userId: (await createUser(db, { isSuperadmin: true, twoFactorEnabled: true, name: 'Equipo KORUM' })).id, isSuperadmin: true, memberships: [], secondFactor });

async function team(name: string) {
  const organization = await createOrganization(db, { name, legalName: `Asociación ${name}`, paycometSplitId: uniqueId('split'), kybStatus: 'VERIFIED' });
  created.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true, name: `Dirección de ${name}` });
  const cosigner = await createUser(db, { twoFactorEnabled: true, name: `Cofirma de ${name}` });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, director: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]), cosigner: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }]), directorName: director.name, cosignerName: cosigner.name };
}

let chargeSequence = 0;
async function paid(organizationId: string, initiativeId: number, amountCents: number, guaranteeCents = 0, userId: string | null = null) {
  chargeSequence += 1;
  const contribution = await db.contribution.create({
    data: {
      organizationId, initiativeId, fiscalYear: 2026, type: 'DONATION', amountCents, guaranteeContributionCents: guaranteeCents, totalChargedCents: amountCents + guaranteeCents, paymentMethod: 'BIZUM',
      paycometOrder: uniqueId('ORD'), status: 'PENDING', createdAt: new Date(Date.now() - (1_000 - chargeSequence) * 60_000),
      ...(userId ? { userId } : { guestEmail: `${uniqueId('familia')}@pruebas.example` })
    }
  });
  const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: contribution.paycometOrder!, amountCents: contribution.totalChargedCents });
  expect(await handlePaymentWebhook(db, mock, rawBody, contentType)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

async function linkFor(userId: string) {
  const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId }, orderBy: { id: 'desc' } });
  return message.payloadJson as { token: string; otp: string };
}

/** Entidad con sus dos firmantes y una campaña de presupuesto recaudando. */
async function openCampaign(name: string, goalCents: number, overrides: Parameters<typeof createInitiative>[2] = {}) {
  const context = await team(name);
  const initiative = await createInitiative(db, context.organization.id, { status: 'FUNDRAISING', format: 'BUDGET', goalCents, title: 'Toldos para el patio 🌞', ...overrides });
  return { ...context, initiative };
}

/**
 * Campaña de presupuesto con meta de 30,00 €: dos donaciones de 10,00 € (la primera con 1,80 € de aportación voluntaria), un Auto-Impulso de 10,00 € y la
 * liquidación al proveedor (27,00 € netos: 2,00 € de tramo y 1,00 € de pasarela), firmada por las dos personas y enviada.
 */
async function settledCampaign(name: string) {
  const context = await openCampaign(name, 3_000, { costMatCents: 2_000, costInstCents: 500, contingencyBps: 1_000, bracketFeeCents: 200, gatewayFeeCents: 100 });
  const { initiative } = context;
  const organizationId = context.organization.id;
  const first = await paid(organizationId, initiative.id, 1_000, 180);
  const second = await paid(organizationId, initiative.id, 1_000);
  const { actor: verified } = await verifiedSuperadmin(db);
  const boost = await executeSelfBoost(db, verified, { initiativeId: initiative.id, expectedAmountCents: 1_000, publiclyDisclosed: false, acceptLoss: true });
  const invoice = await db.fileAsset.create({
    data: { bucket: 'korum-private', objectKey: `tests/${uniqueId('factura')}.pdf`, visibility: 'PRIVATE', purpose: 'PROVIDER_INVOICE', mimeType: 'application/pdf', sizeBytes: 2_000, sha256: uniqueId('sha').padEnd(64, '0').slice(0, 64), organizationId }
  });
  const { payoutId } = await requestCampaignPayout(db, { secret: TEST_HMAC_SECRET, keyring: TEST_KEYRING, providerPayoutAvailable: true }, context.director, organizationId, {
    destination: 'PROVIDER', initiativeId: initiative.id, invoiceFileId: invoice.id, providerName: 'Toldos Mediterráneo, S.L.', providerTaxId: PROVIDER_TAX_ID, iban: IBAN
  });
  expect(await completeSignature(db, TEST_HMAC_SECRET, context.director, await linkFor(context.director.userId))).toMatchObject({ status: 'SIGNED', complete: false });
  expect(await completeSignature(db, TEST_HMAC_SECRET, context.cosigner, await linkFor(context.cosigner.userId))).toMatchObject({ status: 'SIGNED', complete: true });
  expect(await settleSignedCampaignPayout(db, async () => mock, payoutId, { secret: TEST_HMAC_SECRET, keyring: TEST_KEYRING })).toEqual({ status: 'EXECUTED' });
  return { ...context, first, second, boostId: boost.contributionId, payoutId };
}

const initiativeOf = (id: number): DossierRequest => ({ kind: 'initiative', ref: { by: 'id', id } });
const payoutOf = (id: number): DossierRequest => ({ kind: 'payout', ref: { by: 'id', id } });
const contributionOf = (id: number): DossierRequest => ({ kind: 'contribution', ref: { by: 'id', id } });
const CONSOLE = { scope: 'console' } as const;
const entity = (organizationId: string) => ({ scope: 'entity', organizationId }) as const;

const textOf = (data: DossierData, locale: 'es' | 'ca' | 'en' = 'es') =>
  buildDossierLines(data, catalogDossierTexts(locale), locale)
    .map((line) => line.text)
    .join('\n')
    .replace(/\s+/g, ' ');
const money = (cents: number) => formatCents(cents, 'es').replace(/\s+/g, ' ');
const allMatch = (data: DossierData) => data.checks.length > 0 && data.checks.every((check) => check.recordCents === check.ledgerCents);
const downloads = (organizationId: string) => db.auditLog.findMany({ where: { action: 'dossier.downloaded', organizationId }, orderBy: { id: 'asc' } });
const contributionDossier = async (data: DossierData | null) => {
  if (!data || data.kind !== 'contribution') throw new Error('se esperaba el expediente de una aportación');
  return data;
};
/** Lo que entra menos lo que sale de una cuenta en los movimientos del expediente de una entidad. */
const netOf = (data: DossierData, account: string) => data.ledger.movements.filter((movement) => movement.account === account).reduce((sum, movement) => sum + (movement.direction === 'CREDIT' ? movement.totalCents : -movement.totalCents), 0);

describe('QA-SEC13 · expediente desde la consola: todo lo registrado, cuadrado con el libro mayor y sin datos personales', () => {
  it('campaña: asientos enteros, firmas, cambios de estado con su motivo, emails y las cifras iguales a las del libro mayor', async () => {
    const context = await settledCampaign('Colegio Expediente Consola');
    const admin = await korum();
    const data = (await downloadDossier(db, admin, CONSOLE, initiativeOf(context.initiative.id)))!;
    expect(data).toMatchObject({ kind: 'initiative', scope: 'console', reference: `EXP-C-${context.initiative.id}`, entity: { name: 'Colegio Expediente Consola' } });

    // Cifras de la ficha = cifras reconstruidas desde los apuntes (y de verdad contra el saldo de la hucha: tras liquidar, 0).
    expect(data.checks).toEqual([
      { key: 'raised', recordCents: 3_000, ledgerCents: 3_000 },
      { key: 'payoutNet', recordCents: 2_700, ledgerCents: 2_700 },
      { key: 'payoutSent', recordCents: 2_700, ledgerCents: 2_700 }
    ]);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { organizationId: context.organization.id, initiativeId: context.initiative.id })).balanceCents).toBe(0);
    expect(data.initiative).toMatchObject({ goalCents: 3_000, raisedCents: 3_000, status: 'CLOSED', breakdown: { line1Cents: 2_000, line2Cents: 500, line3Cents: 250, line4Cents: 250 }, sponsorAllocations: { count: 0, totalCents: 0 } });
    expect(data.initiative.contributions).toEqual([
      { type: 'DONATION', status: 'COMPLETED', count: 2, totalCents: 2_000 },
      { type: 'SELF_BOOST', status: 'COMPLETED', count: 1, totalCents: 1_000 }
    ]);

    // El libro mayor, entero y cuadrado asiento a asiento.
    expect(data.ledger.unbalanced).toBe(0);
    expect(data.ledger.movements).toEqual([]);
    expect(data.ledger.totalJournals).toBe(data.ledger.journals.length);
    const kinds = data.ledger.journals.map((journal) => journal.kind);
    expect(kinds.filter((kind) => kind === 'PAYIN_DONATION')).toHaveLength(2);
    expect(kinds).toEqual(expect.arrayContaining(['SELF_BOOST_INJECTION', 'PAYOUT_APPROVAL', 'SPLIT_PAYOUT_PROVIDER']));
    for (const journal of data.ledger.journals) expect(journal.entries.reduce((sum, entry) => sum + (entry.direction === 'DEBIT' ? entry.amountCents : -entry.amountCents), 0)).toBe(0);
    expect(data.ledger.journals.find((journal) => journal.kind === 'PAYIN_DONATION')?.reference).toBe(context.first.paycometOrder);

    expect(data.signatures.map((signature) => [signature.target, signature.role, signature.name, signature.otpVerified])).toEqual([
      ['ESCROW_PAYOUT', 'DIRECTOR', context.directorName, true],
      ['ESCROW_PAYOUT', 'COSIGNER', context.cosignerName, true]
    ]);
    expect(data.audit.flatMap((row) => (row.statusChange ? [`${row.statusChange.to}:${row.statusChange.reason}`] : []))).toEqual(['GOAL_REACHED:GOAL_REACHED', 'CLOSED:PAYOUT_SENT']);
    // La liquidación: lo que salió de la hucha es lo enviado al proyecto, la comisión y la pasarela; y sus envíos, del cobro más antiguo al más reciente.
    expect(data.payout).toMatchObject({ id: context.payoutId, status: 'EXECUTED', netPaidCents: 2_700, korumFeeSettledCents: 200, escrowOutCents: 3_000, iban: { last4: '1332' }, hasProviderInvoice: true });
    expect(data.payout!.splitSummary).toEqual([{ status: 'DONE', count: data.payout!.totalSplits, totalCents: 2_700 }]);
    expect(data.payout!.splits.map((split) => split.contributionId)).toEqual([...data.payout!.splits.map((split) => split.contributionId)].sort((a, b) => a - b));
    expect(data.payout!.splits.reduce((sum, split) => sum + split.amountCents, 0)).toBe(2_700);
    expect(data.emails.length).toBeGreaterThan(0);

    // En los tres idiomas, con sus importes; y sin un solo dato personal de más.
    for (const locale of ['es', 'ca', 'en'] as const) expect(textOf(data, locale)).toContain(context.initiative.walletEscrowId);
    const text = textOf(data);
    for (const cents of [3_000, 2_700, 2_000, 500, 250, 200, 100]) expect(text).toContain(money(cents));
    expect(text).toContain('Coste de la pasarela incluido en la meta: 1,00 €');
    expect(text).not.toContain('NO COINCIDE');
    expect(text).toContain('Toldos para el patio');
    const everything = `${JSON.stringify(data)}\n${text}`;
    expect(everything).not.toMatch(/@pruebas\.example|ES91|21000418|B12345674/);
    expect(everything).not.toContain(context.first.guestEmail!);

    // La descarga queda anotada a nombre de quien la hizo.
    const logged = await downloads(context.organization.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actorUserId: admin.userId, targetType: 'Initiative', targetId: String(context.initiative.id), metadataJson: { kind: 'initiative', scope: 'console', initiativeId: context.initiative.id } });
  });

  it('su registro de actividad es solo el de esa entidad: ni las descargas anteriores, ni las consultas de KORUM, ni los intentos de otra entidad sobre ese número', async () => {
    const context = await settledCampaign('Colegio Expediente Registro');
    const other = await team('Club Curioso');
    const admin = await korum();
    await downloadDossier(db, admin, CONSOLE, initiativeOf(context.initiative.id));
    await downloadDossier(db, admin, CONSOLE, payoutOf(context.payoutId));
    // Otra entidad prueba el número de esta campaña y el de su liquidación: queda anotado en SU registro, no en este expediente.
    expect(await downloadDossier(db, other.director, entity(other.organization.id), initiativeOf(context.initiative.id))).toBeNull();
    expect(await downloadDossier(db, other.director, entity(other.organization.id), payoutOf(context.payoutId))).toBeNull();

    for (const request of [initiativeOf(context.initiative.id), payoutOf(context.payoutId)]) {
      const data = (await downloadDossier(db, admin, CONSOLE, request))!;
      const actions = data.audit.map((row) => row.action);
      expect(actions.length).toBeGreaterThan(0);
      for (const hidden of ['dossier.downloaded', 'superadmin.access', 'tenant.resource_outside_tenant', 'tenant.resource_not_found']) expect(actions, hidden).not.toContain(hidden);
      expect(JSON.stringify(data.audit)).not.toMatch(/Equipo KORUM|Club Curioso/);
    }
  });

  it('aportación (por su número o por su pedido de Paycomet): el cobro, su aviso firmado, sus asientos y su reparto, sin decir de quién es', async () => {
    const context = await settledCampaign('Colegio Expediente Aportación');
    const admin = await korum();
    const data = await contributionDossier(await downloadDossier(db, admin, CONSOLE, contributionOf(context.first.id)));
    expect(data.reference).toBe(`EXP-A-${context.first.id}`);
    expect(data.contribution).toMatchObject({ type: 'DONATION', status: 'COMPLETED', method: 'BIZUM', payer: { kind: 'guest' }, amountCents: 1_000, guaranteeCents: 180, totalChargedCents: 1_180, order: context.first.paycometOrder, wantsTaxCertificate: false });
    expect(data.contribution.authCode).toBeTruthy();
    expect(data.checks).toEqual([{ key: 'charged', recordCents: 1_180, ledgerCents: 1_180 }]);
    expect(data.contribution.notifications).toHaveLength(1);
    expect(data.contribution.notifications[0]).toMatchObject({ transactionType: '1', response: 'OK', amountCents: 1_180, status: 'PROCESSED' });
    expect(data.contribution.splits).toEqual([expect.objectContaining({ source: 'campaign', payoutId: context.payoutId, status: 'DONE' })]);
    expect(data.ledger.unbalanced).toBe(0);
    const payin = data.ledger.journals.find((journal) => journal.kind === 'PAYIN_DONATION')!;
    expect(payin.entries).toEqual(expect.arrayContaining([{ account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 1_180 }, { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 1_000 }, { account: 'KORUM_REVENUE_GUARANTEE', direction: 'CREDIT', amountCents: 180 }]));
    expect(data.emails.map((group) => group.templateKey)).toContain('contribution.receipt');
    const text = textOf(data);
    expect(text).toContain(money(1_180));
    expect(text).toContain('Quién paga: una persona invitada, sin cuenta');
    expect(text).toContain('· cobro · aceptado · 11,80 € · procesado');
    expect(text).toContain('- Recibo de una aportación · ');
    expect(`${JSON.stringify(data)}\n${text}`).not.toContain('@');

    // Por su pedido de Paycomet, que es lo que trae un contracargo: el mismo expediente.
    const byOrder = (await downloadDossier(db, admin, CONSOLE, { kind: 'contribution', ref: { by: 'order', order: context.first.paycometOrder! } }))!;
    expect(byOrder.reference).toBe(data.reference);

    // El Auto-Impulso también cuadra: lo paga KORUM y no pasa por la pasarela.
    const boost = await contributionDossier(await downloadDossier(db, admin, CONSOLE, contributionOf(context.boostId)));
    expect(boost.contribution).toMatchObject({ type: 'SELF_BOOST', payer: { kind: 'korum' }, method: 'PLATFORM' });
    expect(boost.checks).toEqual([{ key: 'charged', recordCents: 1_000, ledgerCents: 1_000 }]);
    expect(await downloads(context.organization.id)).toHaveLength(3);
  });

  it('de una cuenta registrada no lleva ni su identificador; una devolución cuadra con lo que salió de Paycomet', async () => {
    const context = await openCampaign('Colegio Expediente Devolución', 100_000);
    const family = await createUser(db, { name: 'Marta Familia Expediente' });
    const donation = await paid(context.organization.id, context.initiative.id, 2_500, 180, family.id);
    const admin = await korum();
    const before = await contributionDossier(await downloadDossier(db, admin, CONSOLE, contributionOf(donation.id)));
    expect(before.contribution.payer).toEqual({ kind: 'account' });
    expect(`${JSON.stringify(before)}\n${textOf(before)}`).not.toMatch(new RegExp(`${family.id}|Marta Familia|@`));
    expect(textOf(before)).toContain('Devuelto: no se ha devuelto nada');

    await db.initiative.update({ where: { id: context.initiative.id }, data: { status: 'REFUNDING' } });
    expect(await refundContribution(db, mock, donation.id, IP)).toMatchObject({ refunded: true });
    const after = await contributionDossier(await downloadDossier(db, admin, CONSOLE, contributionOf(donation.id)));
    expect(after.contribution).toMatchObject({ status: 'REFUNDED', refundedCents: 2_680 });
    expect(after.checks).toEqual([
      { key: 'charged', recordCents: 2_680, ledgerCents: 2_680 },
      { key: 'refunded', recordCents: 2_680, ledgerCents: 2_680 }
    ]);
    expect(after.ledger.journals.map((journal) => journal.kind)).toEqual(expect.arrayContaining(['PAYIN_DONATION', 'ESCROW_REFUND_DONOR']));
    expect(textOf(after)).toContain('Importe devuelto: ficha 26,80 € · libro mayor 26,80 € · COINCIDE');

    // Suprimida la cuenta, el expediente lo dice sin más.
    await db.user.update({ where: { id: family.id }, data: { gdprAnonymizedAt: new Date() } });
    expect((await contributionDossier(await downloadDossier(db, admin, CONSOLE, contributionOf(donation.id)))).contribution.payer).toEqual({ kind: 'erasedAccount' });
  });

  it('una donación que liberó bolsa Matching 2x trae también esa liberación', async () => {
    const context = await openCampaign('Colegio Expediente Matching', 100_000, { matchingPoolTotalCents: 4_000, matchingPoolRemainingCents: 4_000 });
    const organizationId = context.organization.id;
    const sponsor = await db.sponsor.create({
      data: { organizationId, initiativeId: context.initiative.id, name: 'Papelería Nube', cifEnc: null, contactPerson: 'Persona', phone: '600000000', email: `${uniqueId('comercio')}@pruebas.example`, sector: 'Comercio', categoryLevel: 'PLATA', tierRank: 2, tierLabel: 'Plata', amountCents: 4_000, feeGeneratedCents: 600, isMatchingPool: true, promo: 'x', code: uniqueId('C'), status: 'APPROVED', expiresAt: new Date(Date.now() + 200 * 86_400_000) }
    });
    await db.ledgerJournal.create({
      data: {
        idempotencyKey: uniqueId('pool'), kind: 'PAYIN_SPONSOR', description: 'Bolsa', organizationId, initiativeId: context.initiative.id,
        entries: { create: [{ account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 4_000, organizationId }, { account: 'MATCHING_POOL', direction: 'CREDIT', amountCents: 4_000, organizationId, initiativeId: context.initiative.id, sponsorId: sponsor.id }] }
      }
    });
    await db.contribution.create({ data: { organizationId, initiativeId: context.initiative.id, sponsorId: sponsor.id, fiscalYear: 2026, type: 'SPONSORSHIP', amountCents: 4_000, totalChargedCents: 4_726, paymentMethod: 'CARD', paycometOrder: uniqueId('KS'), status: 'COMPLETED' } });
    const donation = await paid(organizationId, context.initiative.id, 2_500);
    // En la tabla de aportaciones de la campaña, la bolsa no cuenta dos veces: lo cobrado al comercio va aparte (entra al emparejar) y lo que sí está
    // en la hucha (las líneas cobradas, sin la bolsa ni lo trasladado, más lo traído de otra campaña) suma exactamente lo recaudado.
    const campaign = (await downloadDossier(db, await korum(), CONSOLE, initiativeOf(context.initiative.id)))!;
    expect(campaign.initiative.raisedCents).toBe(5_000);
    expect(campaign.initiative.contributions).toEqual(expect.arrayContaining([{ type: 'SPONSORSHIP', status: 'POOL', count: 1, totalCents: 4_000 }]));
    expect(campaign.initiative.contributions.map((group) => group.type)).not.toContain('MATCHING_FUND');
    const inEscrow = campaign.initiative.contributions.filter((group) => group.status === 'COMPLETED').reduce((sum, group) => sum + group.totalCents, 0) + campaign.initiative.matchingAddedCents + campaign.initiative.sponsorAllocations.totalCents;
    expect(inEscrow).toBe(campaign.initiative.raisedCents);
    expect(campaign.checks).toEqual([{ key: 'raised', recordCents: 5_000, ledgerCents: 5_000 }]);
    expect(textOf(campaign)).toContain('cobrada aquí como bolsa Matching 2x');
    // En la consola, la misma línea del libro mayor y, debajo, las liberaciones por estado con su número, como detalle que no suma.
    expect(campaign.initiative.matchingAddedCents).toBe(2_500);
    expect(campaign.initiative.matchingDetail).toEqual([{ status: 'COMPLETED', count: 1, totalCents: 2_500 }]);
    expect(textOf(campaign)).toContain('Lo que ha añadido la bolsa Matching 2x de un comercio: 25,00 € Detalle, que no suma (ya está en la línea anterior): 1 liberación · cobrada · 25,00 €');
    // Para la entidad, la bolsa sale solo con lo que ha añadido: sin su número, que restado del de donaciones diría cuántas quedaron sin emparejar.
    const forEntity = (await downloadDossier(db, context.director, entity(organizationId), initiativeOf(context.initiative.id)))!;
    expect(forEntity.initiative.contributions.map((group) => group.type)).not.toContain('MATCHING_FUND');
    expect(forEntity.initiative.matchingAddedCents).toBe(2_500);
    expect(forEntity.initiative.matchingDetail).toEqual([]);
    expect(textOf(forEntity)).not.toMatch(/Detalle, que no suma|liberaci(ón|ones) ·/);
    expect(forEntity.ledger.movements.find((movement) => movement.kind === 'MATCHING_RELEASE')).toMatchObject({ from: null, to: null, count: null, totalCents: 2_500 });
    expect(forEntity.ledger.movements[forEntity.ledger.movements.length - 1]!.kind).toBe('MATCHING_RELEASE');
    expect(textOf(forEntity)).toContain('- En toda la campaña · Matching 2x: dinero de un comercio que se suma a la campaña · Entra · Hucha de la iniciativa · 25,00 €');
    expect(textOf(forEntity)).toContain('Lo que ha añadido la bolsa Matching 2x de un comercio: 25,00 €');
    const completed = forEntity.initiative.contributions.filter((group) => group.status === 'COMPLETED').reduce((sum, group) => sum + group.totalCents, 0);
    expect(completed + forEntity.initiative.matchingAddedCents + forEntity.initiative.sponsorAllocations.totalCents).toBe(forEntity.initiative.raisedCents);
    // Si el sobrante de la bolsa se traslada, se dice; y si se traslada entera, ya no es una bolsa que espera donaciones.
    const statusOfPool = async () => (await downloadDossier(db, await korum(), CONSOLE, initiativeOf(context.initiative.id)))!.initiative.contributions.find((group) => group.type === 'SPONSORSHIP')!.status;
    await db.sponsor.update({ where: { id: sponsor.id }, data: { reassignedCents: 1_500 } });
    expect(await statusOfPool()).toBe('POOL_PARTLY_MOVED');
    await db.sponsor.update({ where: { id: sponsor.id }, data: { reassignedCents: 4_000 } });
    expect(await statusOfPool()).toBe('MOVED');
    await db.sponsor.update({ where: { id: sponsor.id }, data: { reassignedCents: 0 } });
    const data = await contributionDossier(await downloadDossier(db, await korum(), CONSOLE, contributionOf(donation.id)));
    expect(data.contribution.matchedBonusCents).toBe(2_500);
    const release = data.ledger.journals.find((journal) => journal.kind === 'MATCHING_RELEASE');
    expect(release?.entries).toEqual(expect.arrayContaining([{ account: 'MATCHING_POOL', direction: 'DEBIT', amountCents: 2_500 }, { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 2_500 }]));
    expect(data.ledger.unbalanced).toBe(0);
    expect(data.checks).toEqual([{ key: 'charged', recordCents: 2_500, ledgerCents: 2_500 }]);
    // Lo que añadió la bolsa no lo paga «una persona invitada»: es dinero del comercio.
    const poolRow = await db.contribution.findFirstOrThrow({ where: { initiativeId: context.initiative.id, type: 'MATCHING_FUND' } });
    const added = await contributionDossier(await downloadDossier(db, await korum(), CONSOLE, contributionOf(poolRow.id)));
    expect(added.contribution.payer).toEqual({ kind: 'matching' });
    expect(textOf(added)).toContain('la bolsa Matching 2x de un comercio (cobrada antes con su patrocinio)');
    expect(textOf(added)).not.toContain('persona invitada');
  });

  it('un contracargo al comercio de la bolsa con la campaña ya liquidada no descuadra la tabla de la entidad: la línea de la bolsa sale del libro mayor', async () => {
    // Meta de 30,00 €; bolsa de 250,00 €; una donación de 15,00 € libera 15,00 € y completa la meta.
    const context = await openCampaign('Colegio Expediente Bolsa Contracargo', 3_000);
    const organizationId = context.organization.id;
    const initiativeId = context.initiative.id;
    const invoicing = { issuerTaxId: 'A58818501', issuerName: 'KORUM Pruebas, S.L.', keyring: TEST_KEYRING };
    const deliver = (kind: 'PAYMENT' | 'CHARGEBACK', order: string, amountCents: number) => {
      const { rawBody, contentType } = mock.buildNotification({ kind, order, amountCents });
      return handlePaymentWebhook(db, mock, rawBody, contentType, new Date(), { qrSecret: 'secreto-de-integracion-de-los-pases-qr-0123456789', invoicing });
    };
    const started = await startSponsorship(
      { db, provider: mock, keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET },
      { orgSlug: context.organization.slug, initiativeId, locale: 'es', method: 'CARD', tierCents: 25_000, matchingPool: true, businessName: 'Papelería Nube', taxId: 'B-12345674', contactPerson: 'Marta López', phone: '600 11 22 33', email: 'marta@nube.example', sector: 'Papelería', promo: '10 % en libretas', promoCode: 'nube10', autoRenew: false },
      { session: null, ip: '172.61.7.9' }
    );
    if (started.status !== 'REDIRECT') throw new Error(`El patrocinio no arrancó: ${started.status}`);
    const order = new URL(started.url, 'http://localhost').searchParams.get('pedido')!;
    const charge = await db.contribution.findUniqueOrThrow({ where: { paycometOrder: order } });
    expect(await deliver('PAYMENT', order, charge.totalChargedCents)).toMatchObject({ status: 200, outcome: 'PROCESSED' });
    await approveSponsor(db, context.director, organizationId, { sponsorId: charge.sponsorId! }, { hmacSecret: TEST_HMAC_SECRET });
    await paid(organizationId, initiativeId, 1_500);

    const figures = async () => {
      const data = (await downloadDossier(db, context.director, entity(organizationId), initiativeOf(initiativeId)))!;
      const charged = data.initiative.contributions.filter((group) => group.status === 'COMPLETED').reduce((sum, group) => sum + group.totalCents, 0);
      return { raised: data.initiative.raisedCents, pool: data.initiative.matchingAddedCents, lines: charged + data.initiative.matchingAddedCents + data.initiative.sponsorAllocations.totalCents, match: allMatch(data) };
    };
    const consoleFigures = async () => {
      const data = (await downloadDossier(db, await korum(), CONSOLE, initiativeOf(initiativeId)))!;
      const charged = data.initiative.contributions.filter((group) => group.status === 'COMPLETED').reduce((sum, group) => sum + group.totalCents, 0);
      return { raised: data.initiative.raisedCents, lines: charged + data.initiative.matchingAddedCents + data.initiative.sponsorAllocations.totalCents, detail: data.initiative.matchingDetail, match: allMatch(data) };
    };
    expect(await consoleFigures()).toEqual({ raised: 3_000, lines: 3_000, detail: [{ status: 'COMPLETED', count: 1, totalCents: 1_500 }], match: true });
    expect(await figures()).toEqual({ raised: 3_000, pool: 1_500, lines: 3_000, match: true });

    // Liquidada (basta una liquidación aprobada: el dinero ya no está en la hucha) y después le llega el contracargo al comercio.
    await db.escrowPayout.create({ data: { organizationId, initiativeId, destinationType: 'ORGANIZATION', beneficiaryName: 'AMPA', netPaidCents: 3_000, korumFeeSettledCents: 0, status: 'APPROVED' } });
    expect(await deliver('CHARGEBACK', order, charge.totalChargedCents)).toMatchObject({ status: 200 });
    // Sus liberaciones quedan sin respaldo, pero ese dinero ya se envió (lo asume KORUM): lo recaudado no baja y la tabla sigue sumándolo.
    expect(await db.contribution.count({ where: { initiativeId, type: 'MATCHING_FUND', status: 'COMPLETED' } })).toBe(0);
    expect(await figures()).toEqual({ raised: 3_000, pool: 1_500, lines: 3_000, match: true });
    // También en la consola: la línea de la bolsa sigue sumando, y el detalle dice que sus liberaciones quedaron como devueltas.
    expect(await consoleFigures()).toEqual({ raised: 3_000, lines: 3_000, detail: [{ status: 'REFUNDED', count: 1, totalCents: 1_500 }], match: true });
  });

  it('una donación contracargada y otra devuelta con la campaña ya liquidada siguen en lo recaudado, y la tabla lo dice en líneas propias: sigue sumando en los dos expedientes', async () => {
    const context = await settledCampaign('Colegio Expediente Contracargo Tardío');
    const organizationId = context.organization.id;
    const { rawBody, contentType } = mock.buildNotification({ kind: 'CHARGEBACK', order: context.first.paycometOrder!, amountCents: 1_180 });
    expect(await handlePaymentWebhook(db, mock, rawBody, contentType)).toMatchObject({ status: 200 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: context.first.id }, select: { status: true } })).toEqual({ status: 'CHARGEBACK' });
    // Y la otra donación se devuelve desde el panel de Paycomet, también después de liquidar.
    const refund = mock.buildNotification({ kind: 'REFUND', order: context.second.paycometOrder!, amountCents: 1_000 });
    expect(await handlePaymentWebhook(db, mock, refund.rawBody, refund.contentType)).toMatchObject({ status: 200 });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: context.second.id }, select: { status: true } })).toEqual({ status: 'REFUNDED' });
    const counted = (data: DossierData) => data.initiative.contributions.filter((group) => group.status === 'COMPLETED' || group.status.endsWith('_AFTER_PAYOUT')).reduce((sum, group) => sum + group.totalCents, 0) + data.initiative.matchingAddedCents + data.initiative.sponsorAllocations.totalCents;

    const forConsole = (await downloadDossier(db, await korum(), CONSOLE, initiativeOf(context.initiative.id)))!;
    expect(forConsole.initiative.raisedCents).toBe(3_000);
    expect(allMatch(forConsole)).toBe(true);
    expect(forConsole.initiative.contributions).toEqual([
      { type: 'DONATION', status: 'CHARGEBACK_AFTER_PAYOUT', count: 1, totalCents: 1_000 },
      { type: 'DONATION', status: 'REFUNDED_AFTER_PAYOUT', count: 1, totalCents: 1_000 },
      { type: 'SELF_BOOST', status: 'COMPLETED', count: 1, totalCents: 1_000 }
    ]);
    expect(counted(forConsole)).toBe(3_000);
    expect(textOf(forConsole)).toContain('devolución forzosa (contracargo) después de liquidar; la asumió KORUM y sigue en lo recaudado');
    expect(textOf(forConsole)).toContain('devuelta después de liquidar; la asumió KORUM y sigue en lo recaudado');

    const forEntity = (await downloadDossier(db, context.director, entity(organizationId), initiativeOf(context.initiative.id)))!;
    expect(forEntity.initiative.contributions).toEqual([
      { type: 'DONATION', status: 'CHARGEBACK_AFTER_PAYOUT', count: 1, totalCents: 1_000 },
      { type: 'DONATION', status: 'COMPLETED', count: 1, totalCents: 1_000 },
      { type: 'DONATION', status: 'REFUNDED_AFTER_PAYOUT', count: 1, totalCents: 1_000 }
    ]);
    expect(counted(forEntity)).toBe(forEntity.initiative.raisedCents);
    expect(allMatch(forEntity)).toBe(true);
  });

  it('liquidación: lo aprobado y lo enviado coinciden con sus asientos; del IBAN del proveedor, solo el final; y nada del Fondo de actividades con su mismo número', async () => {
    const context = await settledCampaign('Colegio Expediente Liquidación');
    const organizationId = context.organization.id;
    // Un aviso y un registro de una liquidación del Fondo de actividades (otra tabla) que lleva el mismo número.
    await db.outboxMessage.create({ data: { idempotencyKey: uniqueId('fund-paid'), templateKey: 'activityFund.paid', toAddress: `${uniqueId('firma')}@pruebas.example`, organizationId, payloadJson: { payoutId: context.payoutId }, status: 'SENT', sentAt: new Date() } });
    await db.auditLog.create({ data: { actorType: 'SYSTEM', organizationId, action: 'activity_fund.payout_approved', targetType: 'ActivityFundPayout', targetId: String(context.payoutId), metadataJson: { payoutId: context.payoutId } } });

    const data = (await downloadDossier(db, await korum(), CONSOLE, payoutOf(context.payoutId)))!;
    expect(data).toMatchObject({ kind: 'payout', reference: `EXP-L-${context.payoutId}` });
    expect(data.checks).toEqual([
      { key: 'payoutNet', recordCents: 2_700, ledgerCents: 2_700 },
      { key: 'payoutSent', recordCents: 2_700, ledgerCents: 2_700 }
    ]);
    expect(data.ledger.journals.every((journal) => ['PAYOUT_APPROVAL', 'SPLIT_PAYOUT_PROVIDER'].includes(journal.kind))).toBe(true);
    expect(data.ledger.unbalanced).toBe(0);
    expect(data.signatures).toHaveLength(2);
    expect(data.audit.map((row) => row.action)).toEqual(expect.arrayContaining(['payout.requested', 'payout.approved']));
    expect(data.audit.map((row) => row.action)).not.toContain('activity_fund.payout_approved');
    expect(data.emails.map((group) => group.templateKey)).not.toContain('activityFund.paid');
    expect(data.emails.every((group) => group.templateKey.startsWith('payout.'))).toBe(true);
    const text = textOf(data);
    expect(text).toContain('termina en 1332');
    expect(text).toContain('Toldos Mediterráneo, S.L.');
    expect(text).toContain('Total que salió de la hucha (suma de las tres cifras anteriores): 30,00 €');
    expect(`${JSON.stringify(data)}\n${text}`).not.toMatch(/ES91|21000418450200051332|B12345674/);
  });

  it('un patrocinio cobrado aquí cuyo dinero ya no está en la hucha no cuenta como cobrado; el que llega de otra campaña sí aparece; y unas cifras que no cuadran se dicen', async () => {
    const context = await openCampaign('Colegio Expediente Comercios', 100_000);
    const organizationId = context.organization.id;
    const destination = await createInitiative(db, organizationId, { status: 'FUNDRAISING', format: 'BUDGET', goalCents: 100_000, costMatCents: 200_000, title: 'Campaña que recibe' });
    const sponsor = await db.sponsor.create({
      data: { organizationId, initiativeId: context.initiative.id, name: 'Panadería La Espiga', contactPerson: 'Pruebas', phone: '600000000', email: `${uniqueId('comercio')}@pruebas.example`, sector: 'Panadería', tierLabel: 'Oro', amountCents: 25_000, feeGeneratedCents: 3_750, reassignedCents: 25_000, promo: '', code: uniqueId('SP'), status: 'APPROVED', expiresAt: new Date(Date.now() + 86_400_000) }
    });
    const charge = await db.contribution.create({ data: { organizationId, initiativeId: context.initiative.id, sponsorId: sponsor.id, fiscalYear: 2026, type: 'SPONSORSHIP', amountCents: 25_000, totalChargedCents: 29_538, paymentMethod: 'CARD', paycometOrder: uniqueId('KS'), status: 'COMPLETED' } });
    await db.sponsorAllocation.create({ data: { organizationId, sponsorId: sponsor.id, contributionId: charge.id, initiativeId: destination.id, amountCents: 25_000 } });
    const admin = await korum();
    const origin = (await downloadDossier(db, admin, CONSOLE, initiativeOf(context.initiative.id)))!;
    expect(origin.initiative.contributions).toEqual([{ type: 'SPONSORSHIP', status: 'MOVED', count: 1, totalCents: 25_000 }]);
    expect(origin.initiative.sponsorAllocations).toEqual({ count: 0, totalCents: 0 });
    const received = (await downloadDossier(db, admin, CONSOLE, initiativeOf(destination.id)))!;
    expect(received.initiative.contributions).toEqual([]);
    expect(received.initiative.sponsorAllocations).toEqual({ count: 1, totalCents: 25_000 });
    expect(textOf(received)).toContain('Patrocinios colocados en esta campaña desde la bolsa de cada comercio: 1 comercio · 250,00 €');
    // El coste guardado (2.000 €) supera la meta (1.000 €): no hay desglose que enseñar, y se dice.
    expect(received.initiative.breakdown).toBe('mismatch');
    expect(textOf(received)).toContain('no cuadran con su meta');
  });

  it('solo el Super-Admin con su segundo factor; lo que no existe no es un expediente', async () => {
    const context = await settledCampaign('Colegio Expediente Guardia');
    await expect(downloadDossier(db, context.director, CONSOLE, initiativeOf(context.initiative.id))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(downloadDossier(db, await korum(false), CONSOLE, initiativeOf(context.initiative.id))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(downloadDossier(db, { kind: 'anonymous' }, CONSOLE, initiativeOf(context.initiative.id))).rejects.toBeInstanceOf(TenantAccessError);
    expect(await downloadDossier(db, await korum(), CONSOLE, initiativeOf(2_000_000_000))).toBeNull();
    expect(await downloadDossier(db, await korum(), CONSOLE, { kind: 'contribution', ref: { by: 'order', order: 'NO-EXISTE-0001' } })).toBeNull();
    expect(await downloads(context.organization.id)).toHaveLength(0);
    expect(await db.auditLog.count({ where: { action: 'tenant.access_denied', actorUserId: context.director.userId, metadataJson: { path: ['attempted'], equals: 'console.dossier' } } })).toBe(1);
  });
});

describe('QA-SEC13 · expediente desde el panel: solo lo de la entidad', () => {
  it('ve lo que entra y sale de su hucha sumado por tipo para toda la campaña, sin números internos y sin que se note el Auto-Impulso; las cifras cuadran', async () => {
    const context = await settledCampaign('Colegio Expediente Panel');
    const organizationId = context.organization.id;
    // KORUM consulta antes: esa descarga no debe aparecer en lo que ve la entidad.
    const admin = await korum();
    await downloadDossier(db, admin, CONSOLE, initiativeOf(context.initiative.id));
    const data = (await downloadDossier(db, context.director, entity(organizationId), initiativeOf(context.initiative.id)))!;

    expect(data.scope).toBe('entity');
    expect(allMatch(data)).toBe(true);
    expect(data.checks.map((check) => check.key)).toEqual(['raised', 'payoutNet', 'payoutSent']);
    // De los emails, solo los de la entidad, sus firmantes y los comercios: los recibos de las familias no entran (su número delataría el Auto-Impulso).
    expect(await db.outboxMessage.count({ where: { organizationId, templateKey: 'contribution.receipt' } })).toBe(2);
    expect(data.emails.length).toBeGreaterThan(0);
    for (const group of data.emails) expect(ENTITY_EMAIL_TEMPLATES.includes(group.templateKey) || ENTITY_EMAIL_PREFIXES.some((prefix) => group.templateKey.startsWith(prefix)), group.templateKey).toBe(true);
    expect(data.emails.map((group) => group.templateKey)).not.toContain('contribution.receipt');
    // Las aportaciones, solo en totales; el Auto-Impulso suma como una donación más.
    expect(data.initiative.contributions).toEqual([{ type: 'DONATION', status: 'COMPLETED', count: 3, totalCents: 3_000 }]);

    // Solo sus dos cuentas y por tipo: ni asientos, ni números, ni pedidos, ni la hora o el importe de cada cobro.
    expect(data.ledger.journals).toEqual([]);
    expect([...new Set(data.ledger.movements.map((movement) => movement.account))].sort()).toEqual(['INITIATIVE_ESCROW', 'ORG_PAYABLE']);
    expect(data.ledger.movements.map((movement) => movement.kind)).not.toContain('SELF_BOOST_INJECTION');
    const payins = data.ledger.movements.filter((movement) => movement.kind === 'PAYIN_DONATION');
    expect(payins.reduce((sum, movement) => sum + (movement.count ?? 0), 0)).toBe(3);
    expect(payins.reduce((sum, movement) => sum + movement.totalCents, 0)).toBe(3_000);
    expect(data.ledger.movements.every((movement) => movement.from !== null && movement.to !== null && /^\d{4}-\d{2}-\d{2}$/.test(movement.from) && movement.from <= movement.to)).toBe(true);
    // Los cobros, en una sola fila para toda la campaña: ninguna aportación con su importe, ni restando filas.
    expect(payins).toHaveLength(1);
    expect(payins[0]).toMatchObject({ count: 3, totalCents: 3_000, direction: 'CREDIT', account: 'INITIATIVE_ESCROW' });
    expect(data.ledger.totalJournals).toBe(data.ledger.movements.reduce((sum, movement) => sum + (movement.count ?? 0), 0));
    expect(data.ledger.movementsOmitted).toBe(false);
    expect(data.initiative.matchingAddedCents).toBe(0);
    // Lo que entró en la hucha menos lo que salió: 0 tras liquidar. Y lo que se le debía, enviado entero.
    expect(netOf(data, 'INITIATIVE_ESCROW')).toBe(0);
    expect(netOf(data, 'ORG_PAYABLE')).toBe(0);
    // De los envíos, cuántos y cuánto: nunca cobro a cobro.
    expect(data.payout).toMatchObject({ splits: [], escrowOutCents: 3_000 });
    expect(data.payout!.splitSummary).toEqual([{ status: 'DONE', count: data.payout!.totalSplits, totalCents: 2_700 }]);

    // El registro de actividad es el de su panel: ni el Auto-Impulso, ni las consultas de KORUM, ni la descarga que hizo KORUM.
    const actions = data.audit.map((row) => row.action);
    for (const hidden of ['selfboost.executed', 'superadmin.access', 'dossier.downloaded']) expect(actions).not.toContain(hidden);

    const text = textOf(data);
    expect(text).not.toMatch(/Auto-Impulso|Debe ·|Haber ·|Asiento|pedido ORD|cobrada el|Recibo de una aportación/);
    // El primer cobro, solo con su día: ninguna hora ligada a una aportación.
    expect(text).toMatch(/Primer cobro: \d{1,2} de [a-z]+ de \d{4} Cerrada el/);
    expect(text).toContain('Las aportaciones son anónimas para la entidad');
    expect(text).toContain('Coste de la pasarela incluido en la meta: 1,00 €');
    const everything = `${JSON.stringify(data)}\n${text}`;
    expect(everything).not.toMatch(/@pruebas\.example|ES91|B12345674/);
    for (const internal of [context.first.paycometOrder!, context.second.paycometOrder!, `"contributionId"`]) expect(everything).not.toContain(internal);

    // Su descarga queda anotada y ella sí la ve en su registro; la de KORUM, no.
    const logged = await downloads(organizationId);
    expect(logged.map((row) => row.actorUserId)).toEqual([admin.userId, context.director.userId]);
    const registry = await getEntityAudit(db, context.director, organizationId, parseAuditQuery({ accion: 'dossier.downloaded' }, { allowUnclassified: false }));
    expect(registry.page.rows).toHaveLength(1);
    expect(registry.page.rows[0]).toMatchObject({ action: 'dossier.downloaded', actor: { kind: 'member', name: context.directorName } });

    // La liquidación también cuadra; y la siguiente descarga ya trae las anteriores de la entidad en su registro, con el nombre de quien firma.
    const again = (await downloadDossier(db, context.cosigner, entity(organizationId), payoutOf(context.payoutId)))!;
    expect(again.kind).toBe('payout');
    expect(allMatch(again)).toBe(true);
    expect(netOf(again, 'ORG_PAYABLE')).toBe(0);
    const third = (await downloadDossier(db, context.director, entity(organizationId), initiativeOf(context.initiative.id)))!;
    expect(third.audit.filter((row) => row.action === 'dossier.downloaded').map((row) => row.actor)).toEqual([
      { kind: 'member', name: context.directorName, role: 'DIRECTOR', roleLabel: null },
      { kind: 'member', name: context.cosignerName, role: 'COSIGNER', roleLabel: null }
    ]);
  });

  it('cuando KORUM recupera su Auto-Impulso tampoco se nota: es una devolución más, no «la corrección de un cobro»', async () => {
    const context = await openCampaign('Colegio Expediente Recuperado', 2_000);
    const organizationId = context.organization.id;
    await paid(organizationId, context.initiative.id, 1_000);
    const { actor: verified } = await verifiedSuperadmin(db);
    await executeSelfBoost(db, verified, { initiativeId: context.initiative.id, expectedAmountCents: 1_000, publiclyDisclosed: false, acceptLoss: true });
    // Lo que hace el vencimiento de una campaña que un contracargo reabrió: el Auto-Impulso vuelve a KORUM con un contra-asiento.
    expect(await db.$transaction((tx) => returnSelfBoostToKorum(tx, context.initiative.id, new Date()))).toBe(1_000);

    const forEntity = (await downloadDossier(db, context.director, entity(organizationId), initiativeOf(context.initiative.id)))!;
    expect(forEntity.ledger.movements.map((movement) => movement.kind).sort()).toEqual(['ESCROW_REFUND_DONOR', 'PAYIN_DONATION']);
    expect(forEntity.ledger.movements.find((movement) => movement.kind === 'PAYIN_DONATION')).toMatchObject({ count: 2, totalCents: 2_000, direction: 'CREDIT' });
    expect(forEntity.ledger.movements.find((movement) => movement.kind === 'ESCROW_REFUND_DONOR')).toMatchObject({ count: 1, totalCents: 1_000, direction: 'DEBIT' });
    expect(forEntity.initiative.contributions).toEqual([
      { type: 'DONATION', status: 'COMPLETED', count: 1, totalCents: 1_000 },
      { type: 'DONATION', status: 'REFUNDED', count: 1, totalCents: 1_000 }
    ]);
    expect(forEntity.checks).toEqual([{ key: 'raised', recordCents: 1_000, ledgerCents: 1_000 }]);
    expect(netOf(forEntity, 'INITIATIVE_ESCROW')).toBe(1_000);
    expect(`${JSON.stringify(forEntity)}\n${textOf(forEntity)}`).not.toMatch(/REVERSAL|SELF_BOOST|Auto-Impulso|Corrección de un asiento/);

    // La consola sí lo ve tal como es.
    const forConsole = (await downloadDossier(db, await korum(), CONSOLE, initiativeOf(context.initiative.id)))!;
    const reversal = forConsole.ledger.journals.find((journal) => journal.kind === 'REVERSAL')!;
    expect(forConsole.ledger.journals.find((journal) => journal.id === reversal.reversesId)?.kind).toBe('SELF_BOOST_INJECTION');
    expect(forConsole.checks).toEqual([{ key: 'raised', recordCents: 1_000, ledgerCents: 1_000 }]);
  });

  it('en su registro, una aportación sale sin su número interno; en el de la consola, con él', async () => {
    const context = await openCampaign('Colegio Expediente Contracargo', 100_000);
    const donation = await paid(context.organization.id, context.initiative.id, 2_500);
    await db.auditLog.create({ data: { actorType: 'WEBHOOK', organizationId: context.organization.id, action: 'payment.chargeback', targetType: 'Contribution', targetId: String(donation.id), metadataJson: { mode: 'ESCROW', amountCents: 2_500, initiativeId: context.initiative.id } } });
    const rowOf = (data: DossierData) => data.audit.find((row) => row.action === 'payment.chargeback')!;
    const forEntity = (await downloadDossier(db, context.director, entity(context.organization.id), initiativeOf(context.initiative.id)))!;
    expect(rowOf(forEntity).target).toEqual({ type: 'Contribution', id: null, name: null });
    const forConsole = (await downloadDossier(db, await korum(), CONSOLE, initiativeOf(context.initiative.id)))!;
    expect(rowOf(forConsole).target).toEqual({ type: 'Contribution', id: null, name: null });
    // El número de la aportación está en el expediente de la consola de esa aportación, no en el registro de actividad (que se pinta como lo ve la entidad).
    expect((await contributionDossier(await downloadDossier(db, await korum(), CONSOLE, contributionOf(donation.id)))).contribution.id).toBe(donation.id);
    // Y en su panel, igual: el número ya no se enseña.
    const registry = await getEntityAudit(db, context.director, context.organization.id, parseAuditQuery({ accion: 'payment.chargeback' }, { allowUnclassified: false }));
    expect(registry.page.rows.map((row) => row.target)).toEqual([{ type: 'Contribution', id: null, name: null }]);
  });

  it('de las firmas, solo el nombre de quien firma hoy por la entidad; la consola conserva el de quien firmó', async () => {
    const context = await settledCampaign('Colegio Expediente Relevo');
    await db.organizationMember.deleteMany({ where: { organizationId: context.organization.id, role: 'COSIGNER' } });
    const forEntity = (await downloadDossier(db, context.director, entity(context.organization.id), payoutOf(context.payoutId)))!;
    expect(forEntity.signatures.map((signature) => [signature.role, signature.name])).toEqual([['DIRECTOR', context.directorName], ['COSIGNER', null]]);
    expect(textOf(forEntity)).toContain('una persona que ya no firma por la entidad');
    expect(JSON.stringify(forEntity)).not.toContain(context.cosignerName);
    const forConsole = (await downloadDossier(db, await korum(), CONSOLE, payoutOf(context.payoutId)))!;
    expect(forConsole.signatures.map((signature) => signature.name)).toEqual([context.directorName, context.cosignerName]);
    // En el registro de actividad, tampoco la consola nombra a quien ya no firma.
    expect(JSON.stringify(forConsole.audit)).not.toContain(context.cosignerName);
  });

  it('una entidad no puede descargar el de otra: responde igual que si no existiera, y queda anotado', async () => {
    const mine = await settledCampaign('Colegio Expediente Propio');
    const theirs = await settledCampaign('Club Expediente Ajeno');
    const access = entity(mine.organization.id);

    for (const request of [initiativeOf(theirs.initiative.id), payoutOf(theirs.payoutId)]) {
      expect(await resolveDossier(db, mine.director, access, request)).toBeNull();
      expect(await downloadDossier(db, mine.director, access, request)).toBeNull();
    }
    expect(await downloadDossier(db, mine.director, access, initiativeOf(2_000_000_001))).toBeNull();
    expect(await downloadDossier(db, mine.director, access, payoutOf(2_000_000_001))).toBeNull();

    const probes = await db.auditLog.findMany({ where: { organizationId: mine.organization.id, actorUserId: mine.director.userId, action: { in: ['tenant.resource_outside_tenant', 'tenant.resource_not_found'] } }, orderBy: { id: 'asc' } });
    expect(probes.filter((row) => row.action === 'tenant.resource_outside_tenant')).toHaveLength(4);
    expect(probes.filter((row) => row.action === 'tenant.resource_not_found')).toHaveLength(2);
    expect(probes.filter((row) => row.action === 'tenant.resource_outside_tenant').every((row) => (row.metadataJson as { ownerOrganizationId?: string }).ownerOrganizationId === theirs.organization.id)).toBe(true);

    // Con la entidad ajena en la petición: no es miembro. Y nada de lo ajeno ha quedado descargado.
    await expect(downloadDossier(db, mine.director, entity(theirs.organization.id), initiativeOf(theirs.initiative.id))).rejects.toBeInstanceOf(TenantAccessError);
    expect(await downloads(theirs.organization.id)).toHaveLength(0);
    expect(await downloads(mine.organization.id)).toHaveLength(0);
    // Lo que puede elegir en su panel es solo lo suyo.
    expect(await listEntityDossierOptions(db, mine.organization.id)).toEqual([{ initiativeId: mine.initiative.id, title: mine.initiative.title, payoutId: mine.payoutId }]);
  });

  it('el de una aportación no existe para la entidad; y sin segundo factor, sin cargo de firma, sin sesión o siendo de KORUM no se descarga nada por aquí', async () => {
    const context = await settledCampaign('Colegio Expediente Reglas');
    const organizationId = context.organization.id;
    const access = entity(organizationId);
    expect(await downloadDossier(db, context.director, access, contributionOf(context.first.id))).toBeNull();
    expect(await downloadDossier(db, context.director, access, { kind: 'contribution', ref: { by: 'order', order: context.first.paycometOrder! } })).toBeNull();
    const denied = await db.auditLog.findMany({ where: { organizationId, action: 'api.panel_dossier_denied', actorUserId: context.director.userId } });
    expect(denied.map((row) => [row.targetType, row.targetId, (row.metadataJson as { reason?: string }).reason])).toEqual([['Organization', organizationId, 'KIND_NOT_ALLOWED'], ['Organization', organizationId, 'KIND_NOT_ALLOWED']]);

    const gatekeeper = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId, userId: gatekeeper.id, role: 'GATEKEEPER' } });
    // El equipo de KORUM tiene la consola: por la puerta de la entidad no entra.
    for (const actor of [{ ...context.director, secondFactor: false }, actorFor(gatekeeper.id, [{ organizationId, role: 'GATEKEEPER' }]), actorFor((await createUser(db)).id, []), await korum(), { kind: 'anonymous' } as const]) {
      await expect(downloadDossier(db, actor, access, initiativeOf(context.initiative.id))).rejects.toBeInstanceOf(TenantAccessError);
    }
    expect(await downloads(organizationId)).toHaveLength(0);
    const rejections = await db.auditLog.findMany({ where: { organizationId, action: 'tenant.access_denied', metadataJson: { path: ['attempted'], equals: 'dossier.read' } } });
    expect(rejections).toHaveLength(5);
    expect(rejections.every((row) => row.targetType === 'Organization' && row.targetId === organizationId)).toBe(true);
  });

  it('en una taquilla o rifa el Auto-Impulso cuenta como una entrada más: allí no hay donaciones y «una donación» solo podría ser de KORUM', async () => {
    const context = await team('Club Expediente Taquilla');
    const organizationId = context.organization.id;
    const event = await createInitiative(db, organizationId, { status: 'FUNDRAISING', format: 'TICKETING', goalCents: 2_000, raisedCents: 1_000, totalContributions: 1, ticketSubtype: 'EVENT', ticketPriceCents: 500, ticketMax: 4, ticketFeeMode: 'ADD', title: 'Fiesta de fin de curso' });
    const scope = { organizationId, initiativeId: event.id };
    const boost = await db.contribution.create({ data: { ...scope, fiscalYear: 2026, type: 'SELF_BOOST', amountCents: 1_000, totalChargedCents: 1_000, publiclyDisclosed: false, paymentMethod: 'PLATFORM', paycometOrder: uniqueId('KB'), status: 'COMPLETED' } });
    await postJournal(db, { ...scope, idempotencyKey: uniqueId('selfboost'), kind: 'SELF_BOOST_INJECTION', description: 'Auto-Impulso de KORUM', contributionId: boost.id, occurredAt: new Date(), createdById: 'test', lines: selfBoostLines(scope, 1_000) });

    const forEntity = (await downloadDossier(db, context.director, entity(organizationId), initiativeOf(event.id)))!;
    expect(forEntity.initiative.contributions).toEqual([{ type: 'TICKET', status: 'COMPLETED', count: 1, totalCents: 1_000 }]);
    expect(forEntity.ledger.movements.map((movement) => movement.kind)).toEqual(['PAYIN_TICKET']);
    expect(forEntity.checks).toEqual([{ key: 'raised', recordCents: 1_000, ledgerCents: 1_000 }]);
    expect(`${JSON.stringify(forEntity)}\n${textOf(forEntity)}`).not.toMatch(/SELF_BOOST|DONATION|Auto-Impulso|Cobro de una donación|Donación ·/);
    // La consola lo ve como es.
    const forConsole = (await downloadDossier(db, await korum(), CONSOLE, initiativeOf(event.id)))!;
    expect(forConsole.initiative.contributions).toEqual([{ type: 'SELF_BOOST', status: 'COMPLETED', count: 1, totalCents: 1_000 }]);
    expect(forConsole.ledger.journals.map((journal) => journal.kind)).toEqual(['SELF_BOOST_INJECTION']);
  });

  it('las consultas del expediente van una detrás de otra dentro de su transacción: nunca dos en vuelo en la misma conexión', async () => {
    const context = await settledCampaign('Colegio Expediente Secuencia');
    const organizationId = context.organization.id;
    const family = await createUser(db, { name: 'Familia Secuencia' });
    const donation = await db.contribution.update({ where: { id: context.first.id }, data: { userId: family.id } });
    // Se cuenta en la propia conexión de PostgreSQL: así se ven también las consultas que Prisma lanza por su cuenta (dos relaciones de una misma consulta).
    const inFlight = new Map<object, number>();
    const state = { max: 0, total: 0 };
    const original = pg.Client.prototype.query;
    const counted = function (this: object, ...args: unknown[]): unknown {
      const now = (inFlight.get(this) ?? 0) + 1;
      inFlight.set(this, now);
      state.max = Math.max(state.max, now);
      state.total += 1;
      const done = () => {
        inFlight.set(this, (inFlight.get(this) ?? 1) - 1);
      };
      const result = (original as unknown as (...values: unknown[]) => unknown).apply(this, args);
      if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).finally === 'function') return (result as Promise<unknown>).finally(done);
      done();
      return result;
    };
    const subjects = [
      { kind: 'initiative' as const, id: context.initiative.id },
      { kind: 'payout' as const, id: context.payoutId },
      { kind: 'contribution' as const, id: donation.id }
    ];
    pg.Client.prototype.query = counted as never;
    try {
      for (const scope of ['console', 'entity'] as const) {
        for (const subject of subjects) {
          state.max = 0;
          state.total = 0;
          const data = await db.$transaction((tx) => loadDossier(tx as never, scope, { ...subject, organizationId, initiativeId: context.initiative.id, initiativeTitle: context.initiative.title }, new Date()), { isolationLevel: 'RepeatableRead' });
          expect(data.reference).toMatch(/^EXP-[ACL]-\d+$/);
          expect(state.total, `${scope} ${subject.kind}`).toBeGreaterThan(5);
          expect(state.max, `${scope} ${subject.kind}: consultas a la vez en una conexión`).toBe(1);
        }
      }
    } finally {
      pg.Client.prototype.query = original;
    }
  });

  it('cada cuenta tiene un tope de peticiones por hora: pasado, ni se lee ni se anota nada más', async () => {
    const context = await openCampaign('Colegio Expediente Tope', 100_000);
    const access = entity(context.organization.id);
    for (let attempt = 0; attempt < DOSSIER_RULE.limit; attempt += 1) expect(await resolveDossier(db, context.director, access, initiativeOf(context.initiative.id))).not.toBeNull();
    const before = await db.auditLog.count({ where: { actorUserId: context.director.userId } });
    await expect(resolveDossier(db, context.director, access, initiativeOf(context.initiative.id))).rejects.toBeInstanceOf(DossierRateLimitError);
    // Tampoco un intento sobre algo ajeno deja ya su fila: el tope va antes de anotar.
    await expect(downloadDossier(db, context.director, access, initiativeOf(2_000_000_002))).rejects.toBeInstanceOf(DossierRateLimitError);
    await expect(downloadDossier(db, context.director, CONSOLE, initiativeOf(context.initiative.id))).rejects.toBeInstanceOf(DossierRateLimitError);
    expect(await db.auditLog.count({ where: { actorUserId: context.director.userId } })).toBe(before);
    // Es por cuenta: la otra firmante sigue pudiendo.
    expect(await downloadDossier(db, context.cosigner, access, initiativeOf(context.initiative.id))).not.toBeNull();
  });
});
