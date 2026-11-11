import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance, getTrialBalance } from '@/core/finance/ledger.service';
import { CampaignPayoutError } from '@/core/payouts/campaign-payout-rules';
import { openProviderBeneficiary, sealProviderBeneficiary } from '@/core/payouts/payout-beneficiary-vault';
import { createKeyring } from '@/core/security/crypto';
import { completeSignature } from '@/core/security/double-check.service';
import { rotateEncryptedData } from '@/core/security/key-rotation';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadCampaignPayouts } from '@/services/panel/campaign-payouts-data';
import { replanBlockedSplits, resumeCampaignPayouts, settleSignedCampaignPayout } from '@/services/payments/campaign-payout-settlement';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';
import { handlePaymentWebhook } from '@/services/payments/paycomet-webhook.service';
import type { PaymentProvider } from '@/services/payments/payment-provider';
import { approvePayout, executeApprovedPayout } from '@/services/payments/split-transfer.service';
import { requestCampaignPayout, requestPayoutSignature } from '@/services/payouts/campaign-payout.service';
import { openPayoutInvoice, uploadPayoutInvoice } from '@/services/payouts/payout-invoice.service';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/**
 * Sprint 4.4a · Liquidación de una campaña conseguida contra PostgreSQL real (QA-S03): pedirla exige la meta, la factura del proveedor y quien firma; las
 * dos firmas la aprueban y PAYCOMET reparte cobro a cobro; la campaña se cierra y se avisa. También: el IBAN del proveedor cifrado y atado a lo firmado,
 * cambiarla mientras espera, un cobro o un contracargo que descuadran las cifras, la replanificación de repartos bloqueados, la tarea diaria, el aislamiento,
 * las defensas de la base y la rotación de claves.
 */

const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-integración-liquidaciones' };
const SECRET = TEST_HMAC_SECRET;
const IBAN = 'ES91 2100 0418 4502 0005 1332';
const OTHER_IBAN = 'ES79 2100 0813 6101 2345 6789';
let db: KorumPrismaClient;
let mock: MockPaycometProvider;
const storage = new MemoryStorage();
const ROLLBACK = new Error('deshacer la rotación: la base de pruebas se comparte');
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

const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>, secondFactor = true): Extract<SessionActor, { kind: 'user' }> => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor });
const deps = (providerPayoutAvailable = true) => ({ secret: SECRET, keyring: TEST_KEYRING, providerPayoutAvailable });
const settleDeps = { secret: SECRET, keyring: TEST_KEYRING };
const asProvider = (provider: PaymentProvider) => async () => provider;

async function team(kybStatus: 'VERIFIED' | 'SUBMITTED' = 'VERIFIED') {
  const organization = await createOrganization(db, { paycometSplitId: uniqueId('split'), kybStatus });
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

let chargeSequence = 0;
async function paid(organizationId: string, initiativeId: number, amountCents: number, guaranteeCents = 0) {
  chargeSequence += 1;
  const contribution = await db.contribution.create({
    data: {
      organizationId,
      initiativeId,
      fiscalYear: 2026,
      type: 'DONATION',
      amountCents,
      guaranteeContributionCents: guaranteeCents,
      totalChargedCents: amountCents + guaranteeCents,
      paymentMethod: 'BIZUM',
      paycometOrder: uniqueId('ORD'),
      status: 'PENDING',
      guestEmail: `${uniqueId('familia')}@pruebas.example`,
      // Uno detrás de otro: el reparto empieza por el cobro más antiguo.
      createdAt: new Date(Date.now() - (1_000 - chargeSequence) * 60_000)
    }
  });
  expect(await deliver('PAYMENT', contribution.paycometOrder!, contribution.totalChargedCents)).toEqual({ status: 200, outcome: 'PROCESSED' });
  return contribution;
}

/** Campaña de presupuesto lograda: meta = suma de lo donado, comisión de tramo 200 y pasarela 100. */
async function reached(organizationId: string, charges: Array<[number, number?]> = [[1_000], [1_000], [1_000]], format: 'BUDGET' | 'TICKETING' = 'BUDGET') {
  const goalCents = charges.reduce((sum, [amount]) => sum + amount, 0);
  const initiative = await createInitiative(db, organizationId, { status: 'FUNDRAISING', format, goalCents, bracketFeeCents: 200, gatewayFeeCents: 100 });
  const contributions = [];
  for (const [amount, guarantee] of charges) contributions.push(await paid(organizationId, initiative.id, amount, guarantee ?? 0));
  expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('GOAL_REACHED');
  return { initiative, contributions };
}

async function invoiceOf(organizationId: string, extra: { deletedAt?: Date; purpose?: 'PROVIDER_INVOICE' | 'KYB_DOCUMENT' } = {}) {
  return db.fileAsset.create({
    data: { bucket: 'korum-private', objectKey: `tests/${uniqueId('factura')}.pdf`, visibility: 'PRIVATE', purpose: extra.purpose ?? 'PROVIDER_INVOICE', mimeType: 'application/pdf', sizeBytes: 2_000, sha256: uniqueId('sha').padEnd(64, '0').slice(0, 64), organizationId, deletedAt: extra.deletedAt ?? null }
  });
}

async function linkFor(userId: string) {
  const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'doubleCheck.pending', userId }, orderBy: { id: 'desc' } });
  return message.payloadJson as { token: string; otp: string };
}

/** Las dos personas firman con su enlace y su código (la de dirección ya lo tiene al pedirla; la otra lo recibe al firmar la primera). */
async function signBoth(context: Awaited<ReturnType<typeof team>>) {
  expect(await completeSignature(db, SECRET, context.director, await linkFor(context.director.userId))).toMatchObject({ status: 'SIGNED', complete: false });
  expect(await completeSignature(db, SECRET, context.cosigner, await linkFor(context.cosigner.userId))).toMatchObject({ status: 'SIGNED', complete: true, target: { targetType: 'ESCROW_PAYOUT' } });
}

const organizationRequest = (initiativeId: number, invoiceFileId: string | null) => ({ destination: 'ORGANIZATION' as const, initiativeId, invoiceFileId });
const providerRequest = (initiativeId: number, invoiceFileId: string, iban = IBAN) => ({ destination: 'PROVIDER' as const, initiativeId, invoiceFileId, providerName: 'Toldos Mediterráneo, S.L.', providerTaxId: 'B12345674', iban });

describe('QA-S03 · pedir la liquidación exige meta, factura y quien firma', () => {
  it('rechaza lo que no se puede liquidar, con su motivo', async () => {
    const context = await team();
    const { organization, director } = context;
    const fundraising = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const invoice = await invoiceOf(organization.id);
    await expect(requestCampaignPayout(db, deps(), director, organization.id, organizationRequest(fundraising.id, invoice.id))).rejects.toMatchObject({ reason: 'NOT_READY' });

    const { initiative } = await reached(organization.id);
    await expect(requestCampaignPayout(db, deps(), director, organization.id, organizationRequest(initiative.id, null))).rejects.toMatchObject({ reason: 'INVOICE_REQUIRED' });
    const foreign = await invoiceOf((await team()).organization.id);
    await expect(requestCampaignPayout(db, deps(), director, organization.id, organizationRequest(initiative.id, foreign.id))).rejects.toMatchObject({ reason: 'INVOICE_INVALID' });
    await expect(requestCampaignPayout(db, deps(), director, organization.id, organizationRequest(initiative.id, (await invoiceOf(organization.id, { deletedAt: new Date() })).id))).rejects.toMatchObject({ reason: 'INVOICE_INVALID' });
    await expect(requestCampaignPayout(db, deps(), director, organization.id, organizationRequest(initiative.id, (await invoiceOf(organization.id, { purpose: 'KYB_DOCUMENT' })).id))).rejects.toMatchObject({ reason: 'INVOICE_INVALID' });
    await expect(requestCampaignPayout(db, deps(false), director, organization.id, providerRequest(initiative.id, invoice.id))).rejects.toMatchObject({ reason: 'PROVIDER_PAYOUT_UNAVAILABLE' });
    await expect(requestCampaignPayout(db, deps(), director, organization.id, providerRequest(initiative.id, invoice.id, 'ES91 2100 0418 4502 0005 1333'))).rejects.toMatchObject({ reason: 'INVALID_IBAN' });
    await expect(requestCampaignPayout(db, deps(), director, organization.id, { ...providerRequest(initiative.id, invoice.id), providerTaxId: 'B12345670' })).rejects.toMatchObject({ reason: 'INVALID_TAX_ID' });
    await expect(requestCampaignPayout(db, deps(), director, organization.id, { ...organizationRequest(initiative.id, invoice.id), extra: 1 })).rejects.toMatchObject({ reason: 'INVALID_INPUT' });

    // Sin el segundo factor, de otra entidad o el Super-Admin: nadie más la pide.
    await expect(requestCampaignPayout(db, deps(), { ...director, secondFactor: false }, organization.id, organizationRequest(initiative.id, invoice.id))).rejects.toBeInstanceOf(TenantAccessError);
    const other = await team();
    await expect(requestCampaignPayout(db, deps(), other.director, other.organization.id, organizationRequest(initiative.id, invoice.id))).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(await db.auditLog.count({ where: { organizationId: other.organization.id, actorUserId: other.director.userId, metadataJson: { path: ['ownerOrganizationId'], equals: organization.id } } })).toBeGreaterThan(0);
    expect(await db.escrowPayout.count({ where: { initiativeId: initiative.id } })).toBe(0);
  });

  it('a un proveedor: el IBAN y el CIF se guardan cifrados (solo los 4 últimos dígitos en claro) y nunca van a la auditoría', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const invoice = await invoiceOf(context.organization.id);
    const result = await requestCampaignPayout(db, deps(), context.director, context.organization.id, providerRequest(initiative.id, invoice.id));
    expect(result).toMatchObject({ netPaidCents: 2_700, updated: false });
    const payout = await db.escrowPayout.findUniqueOrThrow({ where: { id: result.payoutId } });
    expect(payout).toMatchObject({ destinationType: 'PROVIDER', beneficiaryName: 'Toldos Mediterráneo, S.L.', beneficiaryIbanLast4: '1332', korumFeeSettledCents: 200, providerInvoiceFileId: invoice.id, requestedById: context.director.userId });
    expect(JSON.stringify(payout)).not.toMatch(/ES9121000418|B12345674/);
    expect(openProviderBeneficiary(TEST_KEYRING, { ...payout, beneficiaryIbanEnc: payout.beneficiaryIbanEnc!, providerCifEnc: payout.providerCifEnc! })).toEqual({ iban: 'ES9121000418450200051332', taxId: 'B12345674' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'payout.requested', targetId: String(payout.id) } });
    expect(JSON.stringify(audit.metadataJson)).not.toMatch(/ES91|1332|B1234/);
    // El enlace de firma ya está en la bandeja de quien la pide.
    expect(await db.outboxMessage.count({ where: { templateKey: 'doubleCheck.pending', userId: context.director.userId } })).toBe(1);
  });
});

describe('QA-S03 · de extremo a extremo: firman las dos personas, PAYCOMET reparte y la campaña se cierra', () => {
  it('a la cuenta de la entidad: aprueba, reparte hasta el neto exacto, cierra la campaña y avisa a quien firma', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'EXECUTED' });
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'EXECUTED' });

    expect(await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'EXECUTED', destinationSplitId: context.organization.paycometSplitId });
    const closed = await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } });
    expect(closed).toMatchObject({ status: 'CLOSED', stepIndex: 6 });
    expect(closed.closedAt).not.toBeNull();
    const splits = await db.escrowPayoutSplit.findMany({ where: { payoutId } });
    expect(splits.reduce((sum, split) => sum + split.amountCents, 0)).toBe(2_700);
    expect(splits.every((split) => split.status === 'DONE')).toBe(true);
    expect((await getAccountBalance(db, 'INITIATIVE_ESCROW', { organizationId: context.organization.id, initiativeId: initiative.id })).balanceCents).toBe(0);
    expect((await getAccountBalance(db, 'ORG_PAYABLE', { organizationId: context.organization.id })).balanceCents).toBe(0);
    expect(await db.ledgerJournal.count({ where: { payoutId, kind: 'PAYOUT_APPROVAL' } })).toBe(1);
    expect(await db.outboxMessage.count({ where: { templateKey: 'payout.executed', organizationId: context.organization.id } })).toBe(2);
    // «¡Lo hemos conseguido!» a quienes donaron quedó pendiente al llegar a la meta.
    expect(await db.supporterBroadcast.count({ where: { initiativeId: initiative.id, templateKey: 'initiative.goalReachedSupporter' } })).toBe(1);
    const trial = await getTrialBalance(db);
    expect(trial.debitCents).toBe(trial.creditCents);
  });

  it('al proveedor (simulado): la cuenta sale del IBAN firmado; cambiarlo a escondidas en la base no paga a otra cuenta', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, providerRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    const original = await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId } });
    // Otro IBAN cifrado en su sitio (la base lo deja, es solo cifrado): su huella ya no es la firmada.
    const swapped = sealProviderBeneficiary(TEST_KEYRING, initiative.id, { iban: OTHER_IBAN.replace(/\s/g, ''), taxId: 'B12345674' });
    await db.escrowPayout.update({ where: { id: payoutId }, data: { beneficiaryIbanEnc: swapped.beneficiaryIbanEnc, providerCifEnc: swapped.providerCifEnc } });
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'NOT_APPROVED', reason: 'SIGNATURES' });
    await db.escrowPayout.update({ where: { id: payoutId }, data: { beneficiaryIbanEnc: original.beneficiaryIbanEnc, providerCifEnc: original.providerCifEnc } });

    // Un proveedor de pagos que aún no sabe pagar a terceros (el adaptador real, pendiente de Paycomet) no lo aprueba.
    const withoutProviderPayout = new Proxy(mock, { get: (target, key) => (key === 'providerPayoutAccount' ? undefined : Reflect.get(target, key, target)) });
    expect(await settleSignedCampaignPayout(db, asProvider(withoutProviderPayout), payoutId, settleDeps)).toEqual({ status: 'NOT_APPROVED', reason: 'PROVIDER_UNAVAILABLE' });

    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'EXECUTED' });
    expect((await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId } })).destinationSplitId).toMatch(/^MOCK-PRV-/);
  });
});

describe('Cambiar la liquidación y cifras que dejan de cuadrar', () => {
  it('cambiarla mientras espera: la firma que había deja de valer y los enlaces abiertos se anulan', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await completeSignature(db, SECRET, context.director, await linkFor(context.director.userId));
    const cosignerLink = await linkFor(context.cosigner.userId);
    let view = await loadCampaignPayouts(db, SECRET, context.director, context.organization.id, { providerPayoutAvailable: true });
    expect(view.ready[0]?.pending).toMatchObject({ signed: 1, stale: false, invoiceValid: true });

    const changed = await requestCampaignPayout(db, deps(), context.cosigner, context.organization.id, providerRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    expect(changed.updated).toBe(true);
    expect(await completeSignature(db, SECRET, context.cosigner, cosignerLink)).toEqual({ status: 'INVALID_LINK' });
    view = await loadCampaignPayouts(db, SECRET, context.director, context.organization.id, { providerPayoutAvailable: true });
    expect(view.ready[0]?.pending).toMatchObject({ signed: 0, destinationType: 'PROVIDER', ibanLast4: '1332' });
    expect(await db.auditLog.count({ where: { action: 'payout.updated', targetId: String(changed.payoutId) } })).toBe(1);
    // La otra persona (dirección) recibe el aviso del cambio; quien lo hizo, no (auditoría de seguridad del 4.4a, I1).
    expect(await db.outboxMessage.count({ where: { templateKey: 'payout.changed', userId: context.director.userId } })).toBe(1);
    expect(await db.outboxMessage.count({ where: { templateKey: 'payout.changed', userId: context.cosigner.userId } })).toBe(0);
    expect(view.ready[0]?.pending).toMatchObject({ ibanBank: '2100', requestedBy: expect.any(String) });
  });

  it('una factura subida y sin adjuntar se guarda 30 días; adjuntada a la liquidación, 6 años (auditoría de seguridad del 4.4a, I2)', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n'));
    const upload = () => uploadPayoutInvoice(db, storage, context.director, { organizationId: context.organization.id, initiativeId: initiative.id, bytes: pdf, declaredMimeType: 'application/pdf', fileName: 'factura.pdf' });
    const attached = await upload();
    const orphan = await upload();
    const days = async (fileId: string) => ((await db.fileAsset.findUniqueOrThrow({ where: { id: fileId } })).retainUntil!.getTime() - Date.now()) / 86_400_000;
    expect(await days(orphan.fileId)).toBeLessThanOrEqual(30);
    await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, attached.fileId));
    expect(await days(attached.fileId)).toBeGreaterThan(5 * 365);
    expect(await days(orphan.fileId)).toBeLessThanOrEqual(30);
  });

  it('un cobro que llega antes de aprobar descuadra las cifras: se pide de nuevo, se vuelve a firmar y el excedente va íntegro a la entidad', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const invoice = await invoiceOf(context.organization.id);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, invoice.id));
    await signBoth(context);
    await paid(context.organization.id, initiative.id, 500);
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'NOT_APPROVED', reason: 'FIGURES_CHANGED' });
    const view = await loadCampaignPayouts(db, SECRET, context.director, context.organization.id, { providerPayoutAvailable: true });
    expect(view.ready[0]).toMatchObject({ netPaidCents: 3_200, pending: { stale: true, netPaidCents: 2_700 } });

    expect((await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, invoice.id))).netPaidCents).toBe(3_200);
    await signBoth(context);
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'EXECUTED' });
  });

  it('pedir el enlace propio solo vale para una liquidación que espera firmas de esta entidad', async () => {
    const context = await team();
    const other = await team();
    const { initiative } = await reached(context.organization.id);
    await expect(requestPayoutSignature(db, SECRET, context.director, context.organization.id, { initiativeId: initiative.id })).rejects.toMatchObject({ reason: 'WRONG_STATUS' });
    await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await expect(requestPayoutSignature(db, SECRET, context.cosigner, context.organization.id, { initiativeId: initiative.id })).resolves.toMatchObject({ signerRole: 'COSIGNER' });
    await expect(requestPayoutSignature(db, SECRET, other.director, other.organization.id, { initiativeId: initiative.id })).rejects.toBeInstanceOf(CampaignPayoutError);
  });
});

describe('Repartos bloqueados, tarea diaria y defensas', () => {
  it('un contracargo después de aprobar: su reparto se anula y se replanifica desde otro cobro; sin margen, alerta PAYOUT_BLOCKED', async () => {
    const context = await team();
    // 900 + 900 + 900 + (300 + 700 de aportación a KORUM): el neto 2.700 sale de los tres primeros; el cuarto tiene margen.
    const { initiative, contributions } = await reached(context.organization.id, [[900], [900], [900], [300, 700]]);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    expect(await approvePayout(db, payoutId, SECRET)).toMatchObject({ approved: true, splits: 3 });
    await deliver('CHARGEBACK', contributions[0]!.paycometOrder!, 900);
    expect((await executeApprovedPayout(db, mock, payoutId)).status).toBe('NEEDS_REVIEW');
    expect(await replanBlockedSplits(db, payoutId, new Date())).toEqual({ replanned: 3, blockedCents: 0 });
    expect((await executeApprovedPayout(db, mock, payoutId)).status).toBe('EXECUTED');
    const splits = await db.escrowPayoutSplit.findMany({ where: { payoutId }, orderBy: { id: 'asc' } });
    // Con un reparto bloqueado no se envía ninguno: se anulan los tres sin enviar y se vuelve a repartir todo desde los cobros que valen.
    expect(splits.map((split) => [split.contributionId, split.amountCents, split.status])).toEqual([
      [contributions[0]!.id, 900, 'CANCELLED'],
      [contributions[1]!.id, 900, 'CANCELLED'],
      [contributions[2]!.id, 900, 'CANCELLED'],
      [contributions[1]!.id, 900, 'DONE'],
      [contributions[2]!.id, 900, 'DONE'],
      [contributions[3]!.id, 900, 'DONE']
    ]);
    expect(await db.ledgerJournal.count({ where: { payoutId, kind: 'SPLIT_PAYOUT_ORGANIZATION' } })).toBe(3);
    expect((await db.initiative.findUniqueOrThrow({ where: { id: initiative.id } })).status).toBe('CLOSED');

    // Sin otro cobro con margen: no se anula nada y lo revisa el Super-Admin.
    const tight = await team();
    const short = await reached(tight.organization.id, [[900], [900], [900], [300]]);
    const second = await requestCampaignPayout(db, deps(), tight.director, tight.organization.id, organizationRequest(short.initiative.id, (await invoiceOf(tight.organization.id)).id));
    await signBoth(tight);
    await approvePayout(db, second.payoutId, SECRET);
    await deliver('CHARGEBACK', short.contributions[0]!.paycometOrder!, 900);
    expect((await executeApprovedPayout(db, mock, second.payoutId)).status).toBe('NEEDS_REVIEW');
    expect(await replanBlockedSplits(db, second.payoutId, new Date())).toEqual({ replanned: 0, blockedCents: 2_700 });
    expect(await db.escrowPayoutSplit.count({ where: { payoutId: second.payoutId, status: 'CANCELLED' } })).toBe(0);
    expect(await db.opsAlert.findUniqueOrThrow({ where: { dedupeKey: `PAYOUT_BLOCKED:${second.payoutId}` } })).toMatchObject({ type: 'PAYOUT_BLOCKED', severity: 'CRITICAL', status: 'OPEN' });
    const history = (await loadCampaignPayouts(db, SECRET, tight.director, tight.organization.id, { providerPayoutAvailable: true })).history;
    expect(history[0]).toMatchObject({ underReview: true, doneCents: 0 });
  });

  it('el margen de un cobro que ya tenía un reparto parcial también sirve al replanificar (auditoría financiera del 4.4a, I1)', async () => {
    const context = await team();
    // 1.000 + 1.000 + (1.000 + 1.000 de aportación a KORUM): el neto 2.700 se planifica 1.000 + 1.000 + 700; al tercero le quedan 1.300.
    const { initiative, contributions } = await reached(context.organization.id, [[1_000], [1_000], [1_000, 1_000]]);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    await approvePayout(db, payoutId, SECRET);
    await deliver('CHARGEBACK', contributions[0]!.paycometOrder!, 1_000);
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'EXECUTED' });
    const done = await db.escrowPayoutSplit.findMany({ where: { payoutId, status: 'DONE' }, orderBy: { id: 'asc' } });
    expect(done.map((split) => [split.contributionId, split.amountCents])).toEqual([
      [contributions[1]!.id, 1_000],
      [contributions[2]!.id, 1_700]
    ]);
    expect(await db.opsAlert.count({ where: { dedupeKey: `PAYOUT_BLOCKED:${payoutId}` } })).toBe(0);
  });

  it('a un proveedor, el asiento de cada reparto dice que va al proveedor (auditoría financiera del 4.4a, M1)', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, providerRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'EXECUTED' });
    expect(await db.ledgerJournal.count({ where: { payoutId, kind: 'SPLIT_PAYOUT_PROVIDER' } })).toBe(3);
    expect(await db.ledgerJournal.count({ where: { payoutId, kind: 'SPLIT_PAYOUT_ORGANIZATION' } })).toBe(0);
  });

  it('sin los documentos verificados no se aprueba al firmar; la tarea diaria la aprueba y la envía cuando ya lo están', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    await db.organization.update({ where: { id: context.organization.id }, data: { kybStatus: 'SUBMITTED' } });
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'NOT_APPROVED', reason: 'KYB_NOT_VERIFIED' });
    await db.organization.update({ where: { id: context.organization.id }, data: { kybStatus: 'VERIFIED' } });
    const resumed = await resumeCampaignPayouts(db, mock, settleDeps, new Date(), 500);
    expect(resumed.executed).toBeGreaterThanOrEqual(1);
    expect((await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId } })).status).toBe('EXECUTED');
  });

  it('la base protege lo firmado y lo hecho: no se cambia, no se borra, y un reparto solo se anula si no se pudo enviar', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, organizationRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    await approvePayout(db, payoutId, SECRET);
    await expect(db.escrowPayout.update({ where: { id: payoutId }, data: { netPaidCents: 2_600 } })).rejects.toThrow();
    await expect(db.escrowPayout.update({ where: { id: payoutId }, data: { status: 'PENDING_DOUBLE_CHECK' } })).rejects.toThrow();
    await expect(db.escrowPayout.delete({ where: { id: payoutId } })).rejects.toThrow();
    const split = await db.escrowPayoutSplit.findFirstOrThrow({ where: { payoutId } });
    await expect(db.escrowPayoutSplit.update({ where: { id: split.id }, data: { amountCents: split.amountCents + 1 } })).rejects.toThrow();
    // Un reparto solo se crea en una liquidación aprobada y desde un cobro de su iniciativa (M4).
    const foreign = await reached((await team()).organization.id);
    await expect(db.escrowPayoutSplit.create({ data: { payoutId, contributionId: foreign.contributions[0]!.id, amountCents: 1 } })).rejects.toThrow();
    // Un reparto hecho ya no se anula ni cambia.
    expect((await executeApprovedPayout(db, mock, payoutId)).status).toBe('EXECUTED');
    await expect(db.escrowPayoutSplit.update({ where: { id: split.id }, data: { status: 'CANCELLED' } })).rejects.toThrow();
    // Un pago al proveedor sin sus datos cifrados no se puede ni guardar.
    const bare = await createInitiative(db, context.organization.id, { status: 'GOAL_REACHED' });
    await expect(db.escrowPayout.create({ data: { organizationId: context.organization.id, initiativeId: bare.id, destinationType: 'PROVIDER', beneficiaryName: 'X', netPaidCents: 100, korumFeeSettledCents: 0 } })).rejects.toThrow();
  });

  it('la rotación de claves vuelve a cifrar el IBAN del proveedor también en una liquidación hecha, sin cambiar lo firmado', async () => {
    const context = await team();
    const { initiative } = await reached(context.organization.id);
    const { payoutId } = await requestCampaignPayout(db, deps(), context.director, context.organization.id, providerRequest(initiative.id, (await invoiceOf(context.organization.id)).id));
    await signBoth(context);
    expect(await settleSignedCampaignPayout(db, asProvider(mock), payoutId, settleDeps)).toEqual({ status: 'EXECUTED' });
    const before = await db.escrowPayout.findUniqueOrThrow({ where: { id: payoutId } });
    const rotated = createKeyring({ version: 2, key: Buffer.alloc(32, 7).toString('base64') }, [{ version: 1, key: TEST_KEYRING.keys.get(1)! }]);
    // Dentro de una transacción que se deshace: la rotación recorre toda la base, que comparten las demás pruebas.
    await expect(
      db.$transaction(
        async (tx) => {
          await rotateEncryptedData(tx, rotated, 500);
          const after = await tx.escrowPayout.findUniqueOrThrow({ where: { id: payoutId } });
          expect(after).toMatchObject({ beneficiaryKeyVersion: 2, beneficiaryDigest: before.beneficiaryDigest, status: 'EXECUTED' });
          expect(after.beneficiaryIbanEnc).not.toBe(before.beneficiaryIbanEnc);
          expect(openProviderBeneficiary(rotated, { ...after, beneficiaryIbanEnc: after.beneficiaryIbanEnc!, providerCifEnc: after.providerCifEnc! }).iban).toBe('ES9121000418450200051332');
          throw ROLLBACK;
        },
        { timeout: 180_000, maxWait: 30_000 }
      )
    ).rejects.toBe(ROLLBACK);
  });

  it('la factura solo la abren quienes firman en su entidad; la de otra entidad responde como si no existiera y queda registrada', async () => {
    const context = await team();
    const other = await team();
    const invoice = await invoiceOf(context.organization.id);
    await storage.put({ bucket: invoice.bucket, objectKey: invoice.objectKey, body: new Uint8Array([37, 80, 68, 70]), contentType: 'application/pdf' });
    await expect(openPayoutInvoice(db, storage, context.cosigner, context.organization.id, invoice.id)).resolves.toMatch(/./);
    expect(await db.auditLog.count({ where: { action: 'payout.invoice_opened', targetId: invoice.id } })).toBe(1);
    await expect(openPayoutInvoice(db, storage, other.director, other.organization.id, invoice.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(openPayoutInvoice(db, storage, { ...context.director, secondFactor: false }, context.organization.id, invoice.id)).rejects.toBeInstanceOf(TenantAccessError);
  });
});
