import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyring } from '@/core/security/crypto';
import { exportModel182, Model182NotAllowedError, sealDonorTaxId } from '@/core/tax/model182.service';
import { validateTaxId } from '@/core/tax/tax-id';
import type { KorumPrismaClient } from '@/lib/prisma';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { issueInvoice, submitInvoice, submitPendingInvoices, verifyInvoiceChain } from '@/services/invoicing/invoice.service';
import { MockInvoicingProvider, rejectedByProvider, unknownOutcome } from '@/services/invoicing/mock-invoicing';
import { getInvoicingProvider } from '@/services/invoicing/provider-factory';
import { computeVerifactuHash } from '@/services/invoicing/verifactu-record';
import { createInitiative, createOrganization, createTestClient, uniqueId } from './test-database';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const HMAC_SECRET = 'secreto-de-integracion-de-los-nif-0123456789';
const KEYRING = createKeyring({ version: 1, key: ENCRYPTION_KEY });
const keys = { keyring: KEYRING, hmacSecret: HMAC_SECRET };
const ISSUER = 'B12345674';
let db: KorumPrismaClient;

beforeAll(async () => {
  db = createTestClient();
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
});

afterAll(async () => {
  await db.$disconnect();
});

const director = (organizationId: string): SessionActor => ({ kind: 'user', userId: uniqueId('user'), isSuperadmin: false, memberships: [{ organizationId, role: 'DIRECTOR' }] });
const request = (organizationId: string, fiscalYear = 2026) => ({ organizationId, fiscalYear, contactPhone: '934000000', contactName: 'García Pérez Ana' });

async function ley49Org(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, { ley49: true, ley49VerifiedAt: new Date('2025-01-01'), legalName: 'Fundación de Pruebas', ...overrides });
  const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
  return { organization, initiative };
}

type DonationOverrides = Partial<{ type: 'DONATION' | 'TICKET'; status: 'COMPLETED' | 'REFUNDED' | 'PENDING' | 'CHARGEBACK'; refundedCents: number; guarantee: number; fiscalYear: number; taxId: string | null; province: string | null; name: string | null; createdAt: Date }>;

function donation(organizationId: string, initiativeId: number, amountCents: number, overrides: DonationOverrides = {}) {
  const taxId = overrides.taxId === undefined ? '12345678Z' : overrides.taxId;
  const guarantee = overrides.guarantee ?? 0;
  return db.contribution.create({
    data: {
      organizationId,
      initiativeId,
      fiscalYear: overrides.fiscalYear ?? 2026,
      type: overrides.type ?? 'DONATION',
      amountCents,
      guaranteeContributionCents: guarantee,
      totalChargedCents: amountCents + guarantee,
      paymentMethod: 'CARD',
      paycometOrder: uniqueId('ORD'),
      status: overrides.status ?? 'COMPLETED',
      refundedCents: overrides.refundedCents ?? 0,
      donorFullName: overrides.name === undefined ? 'García López, María' : overrides.name,
      donorProvinceCode: overrides.province === undefined ? '08' : overrides.province,
      ...(taxId ? sealDonorTaxId(taxId, keys) : {}),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {})
    }
  });
}

/** El CIF es único en la tabla: cada entidad de prueba lleva uno válido y distinto, con su dígito de control calculado. */
let nextCif = 1_000_000;
function validCif(): string {
  nextCif += 1;
  for (const control of '0123456789') {
    const cif = `G${nextCif}${control}`;
    if (validateTaxId(cif).valid) return cif;
  }
  throw new Error('Sin dígito de control');
}
const orgWithCif = () => ley49Org({ cif: validCif() });

describe('QA-REG02 · exportación del Modelo 182', () => {
  it('solo donaciones completadas sin reembolso: 0 filas de entradas, y la aportación a KORUM no cuenta', async () => {
    const { organization, initiative } = await orgWithCif();
    await donation(organization.id, initiative.id, 2_500, { guarantee: 180 });
    await donation(organization.id, initiative.id, 1_500, { guarantee: 90 });
    await donation(organization.id, initiative.id, 10_000, { taxId: 'X1234567L', name: 'Pérez Ruiz, Luis', province: '28' });
    await donation(organization.id, initiative.id, 7_000, { type: 'TICKET', taxId: 'Y1234567X' });
    await donation(organization.id, initiative.id, 9_000, { status: 'REFUNDED', refundedCents: 9_000, taxId: 'Z1234567R' });
    await donation(organization.id, initiative.id, 9_000, { status: 'CHARGEBACK', taxId: 'Z1234567R' });
    await donation(organization.id, initiative.id, 9_000, { status: 'PENDING', taxId: 'Z1234567R' });

    const file = await exportModel182(db, KEYRING, director(organization.id), request(organization.id));
    expect(file.donorCount).toBe(2);
    expect(file.totalCents).toBe(14_000);
    expect(file.excluded).toEqual({ contributions: 0, amountCents: 0 });
    // La campaña sigue recaudando: se avisa de lo que aún podría devolverse.
    expect(file.unresolved).toEqual({ contributions: 3, amountCents: 14_000 });
    const lines = file.content.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]!.slice(144, 159)).toBe('000000000014000');
    const amounts = lines.slice(1).map((line) => Number(line.slice(83, 96)));
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(14_000);
    expect(file.content).not.toContain('Y1234567X');
    expect(file.content).not.toContain('Z1234567R');
    expect(file.content).toContain('12345678Z');
    expect(file.content).toContain('GARCIA LOPEZ MARIA');
  });

  it('agrupa por NIF, y quien no se puede declarar queda fuera y se informa', async () => {
    const { organization, initiative } = await orgWithCif();
    await donation(organization.id, initiative.id, 1_000);
    await donation(organization.id, initiative.id, 2_000);
    await donation(organization.id, initiative.id, 3_000, { taxId: null });
    await donation(organization.id, initiative.id, 4_000, { taxId: 'X1234567L', province: null });
    await donation(organization.id, initiative.id, 500, { taxId: 'Y1234567X', province: '77' });
    const file = await exportModel182(db, KEYRING, director(organization.id), request(organization.id));
    expect(file.donorCount).toBe(1);
    expect(file.totalCents).toBe(3_000);
    expect(file.excluded).toEqual({ contributions: 3, amountCents: 7_500 });
  });

  it('recurrencia por NIF, con los ejercicios anteriores de esa misma entidad', async () => {
    const { organization, initiative } = await orgWithCif();
    const other = await orgWithCif();
    await donation(organization.id, initiative.id, 1_000, { fiscalYear: 2024 });
    await donation(organization.id, initiative.id, 1_000, { fiscalYear: 2025 });
    await donation(organization.id, initiative.id, 1_000, { fiscalYear: 2026 });
    await donation(organization.id, initiative.id, 1_000, { fiscalYear: 2026, taxId: 'X1234567L' });
    await donation(organization.id, initiative.id, 1_000, { fiscalYear: 2024, taxId: 'X1234567L' });
    // Donar a otra entidad no hace recurrente en esta.
    await donation(other.organization.id, other.initiative.id, 1_000, { fiscalYear: 2025, taxId: 'X1234567L' });

    const file = await exportModel182(db, KEYRING, director(organization.id), request(organization.id));
    const byTaxId = new Map(file.content.trimEnd().split('\r\n').slice(1).map((line) => [line.slice(17, 26), line]));
    expect(byTaxId.get('12345678Z')!.slice(131, 132)).toBe('1');
    expect(byTaxId.get('X1234567L')!.slice(131, 132)).toBe('2');
  });

  it('una entidad sin verificar no puede exportar, y queda registrado', async () => {
    const pending = await ley49Org({ ley49VerifiedAt: null, cif: validCif() });
    await expect(exportModel182(db, KEYRING, director(pending.organization.id), request(pending.organization.id))).rejects.toBeInstanceOf(Model182NotAllowedError);
    expect(await db.auditLog.count({ where: { action: 'tax.model182_denied', organizationId: pending.organization.id } })).toBe(1);
    const none = await ley49Org({ ley49: false, ley49VerifiedAt: null });
    await expect(exportModel182(db, KEYRING, director(none.organization.id), request(none.organization.id))).rejects.toBeInstanceOf(Model182NotAllowedError);
  });

  it('otra entidad, un voluntario de portería o alguien sin sesión no pueden exportar', async () => {
    const { organization } = await orgWithCif();
    const other = await orgWithCif();
    await expect(exportModel182(db, KEYRING, director(other.organization.id), request(organization.id))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(exportModel182(db, KEYRING, { kind: 'anonymous' }, request(organization.id))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(exportModel182(db, KEYRING, { kind: 'gate', gateSessionId: 'x', organizationId: organization.id, initiativeId: 1 }, request(organization.id))).rejects.toBeInstanceOf(TenantAccessError);
  });

  it('el NIF se guarda cifrado y la auditoría solo lleva cifras', async () => {
    const { organization, initiative } = await orgWithCif();
    const row = await donation(organization.id, initiative.id, 1_000);
    expect(row.donorTaxIdEnc).not.toContain('12345678Z');
    expect(row.donorTaxIdHmac).not.toContain('12345678Z');
    await exportModel182(db, KEYRING, director(organization.id), request(organization.id));
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'tax.model182_exported', organizationId: organization.id } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('12345678Z');
    expect(audit.metadataJson).toMatchObject({ donorCount: 1, totalCents: 1_000 });
  });

  it('no se puede sellar un NIF no válido', () => {
    expect(() => sealDonorTaxId('12345678A', keys)).toThrow(RangeError);
  });

  it('una entidad sin CIF no puede presentar', async () => {
    const { organization } = await ley49Org();
    await expect(exportModel182(db, KEYRING, director(organization.id), request(organization.id))).rejects.toBeInstanceOf(Model182NotAllowedError);
  });

});

describe('QA-REG02 · facturas Veri*factu', () => {
  const base = (organizationId: string, baseAmountCents = 3_750) => ({ idempotencyKey: uniqueId('factura'), organizationId, issuerTaxId: ISSUER, recipientName: 'Comercio del Barrio SL', recipientTaxId: 'B12345674', keyring: KEYRING, concept: 'Fee de gestión publicitaria', baseAmountCents, taxRateBps: 2100 });

  it('números consecutivos, huella encadenada y QR', async () => {
    const organization = await createOrganization(db);
    const now = new Date('2031-03-01T10:00:00.500Z');
    const first = await issueInvoice(db, base(organization.id), now);
    const second = await issueInvoice(db, base(organization.id), new Date('2031-03-01T10:00:05Z'));
    const sequence = (number: string) => Number(number.split('-')[2]);
    expect(first.invoiceNumber).toMatch(/^FAC-2031-\d{4}$/);
    expect(sequence(second.invoiceNumber)).toBe(sequence(first.invoiceNumber) + 1);
    expect(second.prevVerifactuHash).toBe(first.verifactuHash);
    expect(first.verifactuHash).toMatch(/^[0-9A-F]{64}$/);
    expect(first).toMatchObject({ baseAmountCents: 3_750, taxAmountCents: 788, totalAmountCents: 4_538, verifactuStatus: 'PENDING', series: 'FAC' });
    expect(first.verifactuQrUrl).toContain(`numserie=${first.invoiceNumber}`);
    expect(first.verifactuQrUrl).toContain('importe=45.38');
    expect(first.verifactuQrUrl).toContain('fecha=01-03-2031');
  });

  it('a la vez: números distintos y sin huecos, y la cadena sigue intacta', async () => {
    const organization = await createOrganization(db);
    const when = new Date('2032-01-10T10:00:00Z');
    const invoices = await Promise.all(Array.from({ length: 5 }, () => issueInvoice(db, base(organization.id), when)));
    const numbers = invoices.map((invoice) => Number(invoice.invoiceNumber.split('-')[2])).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers[4]! - numbers[0]!).toBe(4);
    const check = await verifyInvoiceChain(db);
    for (const invoice of invoices) {
      expect(check.brokenLinks).not.toContain(invoice.invoiceNumber);
      expect(check.wrongHashes).not.toContain(invoice.invoiceNumber);
    }
  });

  it('la misma operación repetida da la misma factura', async () => {
    const organization = await createOrganization(db);
    const input = base(organization.id);
    const results = await Promise.all([issueInvoice(db, input), issueInvoice(db, input)]);
    expect(results[0].id).toBe(results[1].id);
    expect((await issueInvoice(db, input)).id).toBe(results[0].id);
  });

  it('el año nuevo reinicia la numeración, en hora de Madrid', async () => {
    const organization = await createOrganization(db);
    const invoice = await issueInvoice(db, base(organization.id), new Date('2040-12-31T23:30:00Z'));
    expect(invoice.invoiceNumber).toBe('FAC-2041-0001');
  });

  it('el registro enviado da la misma huella, y el proveedor la acepta una sola vez', async () => {
    const organization = await createOrganization(db);
    const provider = new MockInvoicingProvider();
    await submitPendingInvoices(db, provider);
    provider.registered.length = 0;
    const invoice = await issueInvoice(db, base(organization.id));
    expect(await submitInvoice(db, provider, invoice.id)).toBe('ACCEPTED');
    expect(computeVerifactuHash(provider.registered[0]!.record)).toBe(invoice.verifactuHash);
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ verifactuStatus: 'ACCEPTED', providerReference: `MOCK-${invoice.invoiceNumber}` });
    expect(await submitInvoice(db, provider, invoice.id)).toBe('ALREADY_SENT');
    expect(provider.registered).toHaveLength(1);
  });

  it('una huella que no cuadra se marca como aceptada con errores, igual que haría la AEAT', async () => {
    const organization = await createOrganization(db);
    await submitPendingInvoices(db, new MockInvoicingProvider());
    const invoice = await issueInvoice(db, base(organization.id));
    await db.invoice.update({ where: { id: invoice.id }, data: { totalAmountCents: invoice.totalAmountCents + 1 } });
    expect(await submitInvoice(db, new MockInvoicingProvider(), invoice.id)).toBe('ACCEPTED_WITH_ERRORS');
    await db.invoice.update({ where: { id: invoice.id }, data: { totalAmountCents: invoice.totalAmountCents } });
    expect(await db.auditLog.count({ where: { action: 'invoice.registration_issue', targetId: String(invoice.id) } })).toBe(1);
  });

  it('rechazo: se puede reintentar. Conexión cortada: no se reintenta a ciegas', async () => {
    const organization = await createOrganization(db);
    const provider = new MockInvoicingProvider();
    await submitPendingInvoices(db, provider);
    const rejected = await issueInvoice(db, base(organization.id));
    provider.failNext = rejectedByProvider();
    expect(await submitInvoice(db, provider, rejected.id)).toBe('RETRY_LATER');
    expect((await db.invoice.findUniqueOrThrow({ where: { id: rejected.id } })).verifactuStatus).toBe('PENDING');
    // Mientras la anterior siga pendiente, la siguiente espera: la cadena se registra en orden.
    const next = await issueInvoice(db, base(organization.id));
    expect(await submitInvoice(db, provider, next.id)).toBe('RETRY_LATER');
    expect((await db.invoice.findUniqueOrThrow({ where: { id: next.id } })).verifactuStatus).toBe('PENDING');
    expect(await submitPendingInvoices(db, provider)).toEqual({ submitted: 2, stoppedAt: null });

    const lost = await issueInvoice(db, base(organization.id));
    provider.failNext = unknownOutcome();
    expect(await submitInvoice(db, provider, lost.id)).toBe('UNKNOWN');
    expect((await db.invoice.findUniqueOrThrow({ where: { id: lost.id } })).verifactuStatus).toBe('SENT');
    expect(await submitInvoice(db, provider, lost.id)).toBe('ALREADY_SENT');
    // Resultado desconocido: la siguiente espera hasta que una persona lo compruebe.
    const afterLost = await issueInvoice(db, base(organization.id));
    expect(await submitInvoice(db, provider, afterLost.id)).toBe('RETRY_LATER');
    expect(await db.auditLog.count({ where: { action: 'invoice.registration_unknown', targetId: String(lost.id) } })).toBe(1);
  });

  it('retocar una factura se detecta', async () => {
    const organization = await createOrganization(db);
    const invoice = await issueInvoice(db, base(organization.id));
    await db.invoice.update({ where: { id: invoice.id }, data: { totalAmountCents: invoice.totalAmountCents + 100 } });
    expect((await verifyInvoiceChain(db)).wrongHashes).toContain(invoice.invoiceNumber);
    await db.invoice.update({ where: { id: invoice.id }, data: { totalAmountCents: invoice.totalAmountCents } });
    expect((await verifyInvoiceChain(db)).wrongHashes).not.toContain(invoice.invoiceNumber);
  });

  it('quien espera turno en Nochevieja no queda detrás con una fecha anterior', async () => {
    const organization = await createOrganization(db);
    const latest = await issueInvoice(db, base(organization.id));
    const late = await issueInvoice(db, base(organization.id), new Date(latest.issuedAt.getTime() - 86_400_000));
    expect(late.issuedAt.getTime()).toBe(latest.issuedAt.getTime());
    expect(late.prevVerifactuHash).toBe(latest.verifactuHash);
  });

  it('rechaza una base imposible', async () => {
    const organization = await createOrganization(db);
    await expect(issueInvoice(db, base(organization.id, 0))).rejects.toBeInstanceOf(RangeError);
    await expect(issueInvoice(db, base(organization.id, 12.5))).rejects.toBeInstanceOf(RangeError);
    await expect(issueInvoice(db, { ...base(organization.id), recipientTaxId: 'G-08451290' })).rejects.toBeInstanceOf(RangeError);
  });

  it('con cobros reales no se puede usar el simulador', () => {
    expect(() => getInvoicingProvider('live')).toThrow('proveedor homologado');
    expect(getInvoicingProvider('mock').name).toBe('mock');
  });
});
