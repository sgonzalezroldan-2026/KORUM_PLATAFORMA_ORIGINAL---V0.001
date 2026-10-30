import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountBalance, getBalancesByAccount, getRaisedFromLedger } from '@/core/finance/ledger.service';
import { verifyPassSignature } from '@/core/ticketing/qr-signature';
import { seedDatabase } from '@/seed/seed';
import { loadSeedData } from '@/seed/seed-types';
import { SeedReconciliationError, verifySeed, type SeedReport } from '@/seed/seed-verify';
import type { KorumPrismaClient } from '@/lib/prisma';
import { createTestClient, TEST_SCHEMA } from './test-database';

const SECRETS = { hmacSecret: 'integration-data-hmac-secret-0123456789', qrSecret: 'integration-qr-hmac-secret-0123456789ab' };
const seed = loadSeedData();

let db: KorumPrismaClient;
let report: SeedReport;
let firstRunMs = 0;

beforeAll(async () => {
  db = createTestClient();
  const startedAt = Date.now();
  report = await seedDatabase(db, { ...SECRETS, schema: TEST_SCHEMA });
  firstRunMs = Date.now() - startedAt;
}, 600_000);

afterAll(async () => {
  await db.$disconnect();
});

describe('QA-C04 · semilla completa cuadrada al céntimo', () => {
  it('crea las 4 entidades con titular legal y 2 firmantes distintos', async () => {
    expect(report.organizations).toBe(4);
    const orgs = await db.organization.findMany({ where: { id: { in: seed.schools.map((school) => school.id) } }, include: { members: true } });
    for (const org of orgs) {
      expect(org.legalName).toBeTruthy();
      expect(org.kybStatus).toBe('VERIFIED');
      expect(org.quotaPeriod).toBe('2026-2027');
      const signers = org.members.filter((member) => member.role === 'DIRECTOR' || member.role === 'COSIGNER');
      expect(new Set(signers.map((member) => member.userId)).size).toBe(2);
    }
    expect(orgs.find((org) => org.id === 'CERVANTES')).toMatchObject({ legalForm: 'PARENTS_ASSOCIATION', centerOwnership: 'PUBLIC', ley49: true });
    expect(orgs.find((org) => org.id === 'CERVANTES')!.ley49VerifiedAt).not.toBeNull();
    expect(orgs.find((org) => org.id === 'MEDITERRANEO')!.ley49VerifiedAt).toBeNull();
  });

  it('crea 8 iniciativas, 5 comercios, 3 ideas con chat, facturas, soporte y el Super-Admin', async () => {
    expect(await db.initiative.count({ where: { id: { in: [1, 2, 3, 4, 5, 6, 7, 8] } } })).toBe(8);
    expect(await db.sponsor.count({ where: { id: { in: seed.sponsors.map((sponsor) => sponsor.id) } } })).toBe(5);
    expect(await db.idea.count({ where: { id: { in: [501, 502, 503] } } })).toBe(3);
    for (const ideaId of [501, 502, 503]) expect(await db.ideaMessage.count({ where: { ideaId } }), `chat de la idea ${ideaId}`).toBe(1);
    expect(await db.ideaSignatureAudit.count({ where: { ideaId: 502 } })).toBe(3);
    expect(await db.invoice.count({ where: { invoiceNumber: { in: ['FAC-2026-0014', 'FAC-2026-0019'] } } })).toBe(2);
    expect(await db.supportTicket.count({ where: { ticketCode: 'TCK-901' } })).toBe(1);
    expect(await db.user.count({ where: { isSuperadmin: true, id: 'user-superadmin' } })).toBe(1);
  });

  it('los saldos del libro mayor coinciden con raisedCents en las 8 iniciativas (0 céntimos de desviación)', async () => {
    for (const initiative of seed.initiatives) {
      expect(await getRaisedFromLedger(db, initiative.id), `iniciativa ${initiative.id}`).toBe(initiative.raisedCents);
    }
    expect(report.initiatives.map((item) => item.ledgerRaisedCents)).toEqual(seed.initiatives.map((initiative) => initiative.raisedCents));
    expect(report.ledgerDebitCents).toBe(report.ledgerCreditCents);
    expect(report.contributions).toBe(seed.initiatives.reduce((sum, initiative) => sum + initiative.totalContributions, 0));
  });

  it('la hucha de cada iniciativa tiene exactamente lo recaudado, salvo la ya liquidada que queda a cero', async () => {
    for (const initiative of seed.initiatives) {
      const balance = (await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: initiative.id })).balanceCents;
      expect(balance, `iniciativa ${initiative.id}`).toBe(initiative.status === 'CLOSED' ? 0 : initiative.raisedCents);
    }
  });

  it('la liquidación de la iniciativa 4 reparte la meta entre entidad, comisión y pasarela y se transfiere a la entidad', async () => {
    const orgBalances = Object.fromEntries((await getBalancesByAccount(db, { organizationId: 'CERVANTES' })).map((balance) => [balance.account, balance]));
    expect(orgBalances.ORG_PAYABLE).toMatchObject({ debitCents: 484_000, creditCents: 484_000, balanceCents: 0 });
    expect(orgBalances.KORUM_REVENUE_BRACKET!.balanceCents).toBe(19_200);
    expect(orgBalances.GATEWAY_FEES_RECOVERED!.balanceCents).toBe(6_500);
    const payout = await db.escrowPayout.findUniqueOrThrow({ where: { initiativeId: 4 }, include: { signatures: true } });
    expect(payout).toMatchObject({ status: 'EXECUTED', netPaidCents: 484_000, korumFeeSettledCents: 19_200, destinationType: 'ORGANIZATION', beneficiaryName: 'AFA CEIP Cervantes', beneficiaryIban: 'ES44 2100 0815 4202 0019 8891' });
    expect(payout.signatures.map((signature) => signature.signerRole).sort()).toEqual(['COSIGNER', 'DIRECTOR']);
    expect(new Set(payout.signatures.map((signature) => signature.signerUserId)).size).toBe(2);
    const transfer = await db.ledgerJournal.findUniqueOrThrow({ where: { idempotencyKey: 'seed:payout-4:split' } });
    expect(transfer.kind).toBe('SPLIT_PAYOUT_ORGANIZATION');
  });

  it('la liquidación de la iniciativa 3 espera la segunda firma y no mueve dinero todavía', async () => {
    const payout = await db.escrowPayout.findUniqueOrThrow({ where: { initiativeId: 3 }, include: { signatures: true } });
    expect(payout.status).toBe('PENDING_DOUBLE_CHECK');
    expect(payout.signatures.map((signature) => signature.signerRole)).toEqual(['DIRECTOR']);
    expect(await db.ledgerJournal.count({ where: { payoutId: payout.id } })).toBe(0);
  });

  it('la bolsa Matching 2x de la iniciativa 1 liberó 150 € y quedan 100 €', async () => {
    expect((await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: 1 })).balanceCents).toBe(10_000);
    const released = await db.contribution.aggregate({ where: { initiativeId: 1, type: 'MATCHING_FUND' }, _sum: { amountCents: true } });
    expect(released._sum.amountCents).toBe(15_000);
  });

  it('el patrocinio con fee suma íntegro a la hucha, el fee es ingreso de KORUM y el IVA queda aparte como deuda con Hacienda', async () => {
    const sponsorFee = await db.escrowLedgerEntry.aggregate({
      where: { account: 'KORUM_REVENUE_SPONSOR_FEE', direction: 'CREDIT', organizationId: 'SANJOSE' },
      _sum: { amountCents: true }
    });
    expect(sponsorFee._sum.amountCents).toBe(7_500);
    const vat = await db.escrowLedgerEntry.aggregate({ where: { account: 'TAX_PAYABLE_VAT', direction: 'CREDIT', organizationId: 'SANJOSE' }, _sum: { amountCents: true } });
    expect(vat._sum.amountCents).toBe(1_575);
    const sponsorship = await db.contribution.findFirstOrThrow({ where: { initiativeId: 5, type: 'SPONSORSHIP' } });
    expect(sponsorship).toMatchObject({ amountCents: 50_000, totalChargedCents: 59_075, guaranteeContributionCents: 0 });
    const escrow = await db.escrowLedgerEntry.aggregate({ where: { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', journal: { contributionId: sponsorship.id } }, _sum: { amountCents: true } });
    expect(escrow._sum.amountCents).toBe(50_000);
  });

  it('la taquilla vende 196 entradas con pases QR firmados que verifican y 0,55 € de gestión por entrada', async () => {
    const passes = await db.ticketPass.findMany({ where: { initiativeId: 2 } });
    expect(passes).toHaveLength(112);
    expect(passes.reduce((sum, pass) => sum + pass.quantity, 0)).toBe(196);
    expect(new Set(passes.map((pass) => pass.serialCode)).size).toBe(112);
    expect(passes.every((pass) => verifyPassSignature(SECRETS.qrSecret, pass.uuid, pass.qrHmacSignature))).toBe(true);
    expect(passes.every((pass) => pass.checkedInCount === 0)).toBe(true);
    const fee = await db.escrowLedgerEntry.aggregate({ where: { account: 'KORUM_REVENUE_TICKET_FEE', organizationId: 'CERVANTES' }, _sum: { amountCents: true } });
    expect(fee._sum.amountCents).toBe(196 * 55);
  });

  it('la aportación voluntaria va desmarcada por defecto: solo una parte la activa y es ingreso aparte', async () => {
    const donations = await db.contribution.count({ where: { initiativeId: 3, type: 'DONATION' } });
    const withGuarantee = await db.contribution.count({ where: { initiativeId: 3, type: 'DONATION', guaranteeContributionCents: { gt: 0 } } });
    expect(withGuarantee).toBeGreaterThan(0);
    expect(withGuarantee).toBeLessThan(donations);
    const revenue = await db.contribution.aggregate({ where: { initiativeId: 3 }, _sum: { guaranteeContributionCents: true } });
    const ledger = await db.escrowLedgerEntry.aggregate({ where: { account: 'KORUM_REVENUE_GUARANTEE', direction: 'CREDIT', organizationId: 'CERVANTES', journal: { initiativeId: 3 } }, _sum: { amountCents: true } });
    expect(ledger._sum.amountCents).toBe(revenue._sum.guaranteeContributionCents);
  });

  it('la semilla no inventa reservas de cupo y las campañas con cobros tienen la fecha de su primer cobro', async () => {
    const initiatives = await db.initiative.findMany({ where: { id: { in: seed.initiatives.map((initiative) => initiative.id) } } });
    for (const initiative of initiatives) {
      expect(initiative.quotaReservedAt, `iniciativa ${initiative.id}`).toBeNull();
      expect(initiative.quotaReservedExemptCents + initiative.quotaReservedMedalCents + initiative.quotaReservedMaintCents).toBe(0);
    }
    for (const initiative of initiatives.filter((candidate) => candidate.raisedCents > 0)) {
      expect(initiative.firstPayinAt, `iniciativa ${initiative.id}`).not.toBeNull();
    }
  });

  it('la bolsa Matching 2x se paga antes de la primera donación que libera su bonus', async () => {
    const pool = await db.ledgerJournal.findUniqueOrThrow({ where: { idempotencyKey: 'seed:i1-pool-1:payin' } });
    const firstRelease = await db.ledgerJournal.findFirstOrThrow({ where: { kind: 'MATCHING_RELEASE', initiativeId: 1 }, orderBy: { occurredAt: 'asc' } });
    expect(pool.occurredAt.getTime()).toBeLessThan(firstRelease.occurredAt.getTime());
  });

  it('la conciliación detecta un contador desviado y una iniciativa que ya no coincide con la semilla', async () => {
    const original = await db.initiative.findUniqueOrThrow({ where: { id: 3 }, select: { raisedCents: true } });
    try {
      await db.initiative.update({ where: { id: 3 }, data: { raisedCents: original.raisedCents + 100 } });
      const failure = await verifySeed(db, seed).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SeedReconciliationError);
      const problems = (failure as SeedReconciliationError).problems.join('\n');
      expect(problems).toMatch(/iniciativa 3: el libro suma/);
      expect(problems).toMatch(/iniciativa 3: la base .* no coincide con la semilla/);
    } finally {
      await db.initiative.update({ where: { id: 3 }, data: { raisedCents: original.raisedCents } });
    }
    await expect(verifySeed(db, seed)).resolves.toBeTruthy();
  });

  it('el IVA, lo pendiente de pagar a las entidades y la pasarela cuadran con la semilla (solo asientos seed:*)', async () => {
    const seeded = { journal: { idempotencyKey: { startsWith: 'seed:' } } };
    const total = async (account: 'TAX_PAYABLE_VAT' | 'ORG_PAYABLE' | 'PSP_CLEARING', direction: 'DEBIT' | 'CREDIT') =>
      (await db.escrowLedgerEntry.aggregate({ where: { account, direction, ...seeded }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
    const approvedFees = seed.sponsors.filter((sponsor) => sponsor.status === 'APPROVED').map((sponsor) => sponsor.feeGeneratedCents);
    expect(await total('TAX_PAYABLE_VAT', 'CREDIT')).toBe(approvedFees.reduce((sum, fee) => sum + Math.round((fee * 2_100) / 10_000), 0));
    expect(await total('ORG_PAYABLE', 'CREDIT')).toBe(await total('ORG_PAYABLE', 'DEBIT'));
    expect(await total('PSP_CLEARING', 'DEBIT')).toBeGreaterThanOrEqual(await total('PSP_CLEARING', 'CREDIT'));
  });

  it('ningún asiento ni apunte de una iniciativa está a nombre de otra entidad', async () => {
    const owner = new Map(seed.initiatives.map((initiative) => [initiative.id, initiative.organizationId]));
    const pairs = await db.escrowLedgerEntry.groupBy({ by: ['organizationId', 'initiativeId'], where: { initiativeId: { in: [...owner.keys()] }, journal: { idempotencyKey: { startsWith: 'seed:' } } } });
    expect(pairs.length).toBeGreaterThanOrEqual(seed.initiatives.length);
    for (const pair of pairs) expect(owner.get(pair.initiativeId!), `iniciativa ${pair.initiativeId}`).toBe(pair.organizationId);
  });

  it('volver a ejecutar la semilla no duplica nada y sigue cuadrando', async () => {
    const counts = async () => ({
      journals: await db.ledgerJournal.count(),
      entries: await db.escrowLedgerEntry.count(),
      contributions: await db.contribution.count(),
      ticketPasses: await db.ticketPass.count(),
      initiatives: await db.initiative.count(),
      courseProgress: await db.initiativeCourseProgress.count(),
      sponsors: await db.sponsor.count(),
      payouts: await db.escrowPayout.count(),
      signatures: await db.doubleCheckSignature.count(),
      invoices: await db.invoice.count(),
      ideas: await db.idea.count(),
      ideaMessages: await db.ideaMessage.count(),
      ideaAudits: await db.ideaSignatureAudit.count(),
      supportTickets: await db.supportTicket.count(),
      members: await db.organizationMember.count()
    });
    const before = await counts();
    const again = await seedDatabase(db, { ...SECRETS, schema: TEST_SCHEMA });
    expect(await counts()).toEqual(before);
    expect(again.contributions).toBe(report.contributions);
    await expect(verifySeed(db, seed)).resolves.toBeTruthy();
  }, 600_000);

  it('las altas posteriores a la semilla no chocan con los identificadores fijos de la semilla', async () => {
    const organization = await db.organization.findUniqueOrThrow({ where: { id: 'CERVANTES' } });
    const initiative = await db.initiative.create({
      data: {
        walletEscrowId: 'WLT-ESC-900',
        organizationId: organization.id,
        academicYear: '2026-2027',
        title: 'Alta posterior a la semilla',
        category: 'Patios y Deporte',
        stage: 'Primaria',
        closesAt: new Date('2026-12-01T00:00:00Z'),
        quarter: '2026-Q4',
        goalCents: 100_000,
        description: 'Comprueba la secuencia de identificadores'
      }
    });
    expect(initiative.id).toBeGreaterThan(8);
    const sponsor = await db.sponsor.create({
      data: { organizationId: organization.id, name: 'Nuevo', cif: 'B-00000000', contactPerson: 'x', phone: '0', email: 'n@x.test', sector: 's', tierLabel: 't', amountCents: 10_000, feeGeneratedCents: 1_500, promo: 'p', code: 'NUEVO', expiresAt: new Date('2027-01-01') }
    });
    expect(sponsor.id).toBeGreaterThan(5);
  });

  it('la primera ejecución cabe en el presupuesto de tiempo (la carga fila a fila tardaba más de 5 minutos)', () => {
    console.error(`[seed] primera ejecución: ${(firstRunMs / 1000).toFixed(1)} s · ${report.journals} asientos · ${report.contributions} aportaciones`);
    expect(firstRunMs).toBeLessThan(240_000);
  });
});
