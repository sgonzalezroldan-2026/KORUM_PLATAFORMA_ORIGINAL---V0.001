import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { academicYearFor } from '@/core/finance/academic-year';
import { campaignExpiryHandler } from '@/core/jobs/handlers/campaign-expiry';
import { quotaRenewalHandler } from '@/core/jobs/handlers/quota-renewal';
import type { JobContext } from '@/core/jobs/job-types';
import { createPrismaClient, type KorumPrismaClient } from '@/lib/prisma';
import { seedDatabase, type SeedRunReport } from '@/seed/seed';
import { SEED_CLOCK_SETTING, SEED_REFERENCE_NOW, shiftSeedData } from '@/seed/seed-clock';
import { loadSeedData } from '@/seed/seed-types';
import { verifySeed } from '@/seed/seed-verify';
import { TEST_KEYRING, testJobDeps } from './test-database';
import { withSchema } from './test-schema';

/**
 * QA-C04 · Sprint 5.7: la semilla cuadra con el libro mayor al céntimo sembrada con el reloj adelantado 60 días, en un esquema propio y
 * recién migrado (el de las demás pruebas ya está sembrado con la fecha de hoy y conservaría esas fechas). Sus campañas siguen recaudando
 * ese día: el vencimiento diario y la renovación de cupos de ese día no las tocan, y volver a sembrar días después no cambia nada.
 */

const CLOCK_SCHEMA = 'korum_seed_clock';
const DAY = 86_400_000;
const SECRETS = { hmacSecret: 'integration-data-hmac-secret-0123456789', qrSecret: 'integration-qr-hmac-secret-0123456789ab', keyring: TEST_KEYRING };
const reference = loadSeedData();
/** El día de la carga: 60 días después de hoy, sea cuando sea hoy. */
const loadedAt = new Date(Date.now() + 60 * DAY);

let db: KorumPrismaClient;
let report: SeedRunReport;

async function sql(baseUrl: string, statements: string[]) {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  const baseUrl = inject('testDatabaseUrl');
  await sql(baseUrl, [`DROP SCHEMA IF EXISTS "${CLOCK_SCHEMA}" CASCADE`, `CREATE SCHEMA "${CLOCK_SCHEMA}"`]);
  const schemaUrl = withSchema(baseUrl, CLOCK_SCHEMA);
  execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: schemaUrl, DIRECT_URL: schemaUrl }, stdio: 'pipe' });
  // Igual que `global-setup.ts`: con la base local de `npm run db:dev` el `search_path` de la migración quedaría pegado.
  await sql(baseUrl, ['RESET search_path']);
  db = createPrismaClient({ connectionString: baseUrl, schema: CLOCK_SCHEMA, ...(process.env.TEST_DATABASE_URL ? {} : { maxConnections: 1 }) });
  report = await seedDatabase(db, { ...SECRETS, schema: CLOCK_SCHEMA, now: loadedAt });
}, 600_000);

afterAll(async () => {
  await db?.$disconnect();
  await sql(inject('testDatabaseUrl'), [`DROP SCHEMA IF EXISTS "${CLOCK_SCHEMA}" CASCADE`]);
});

const jobContext = (now: Date): JobContext => ({ db, now, batchSize: 50, deps: { ...testJobDeps() } as unknown as JobContext['deps'] });

describe('QA-C04 · semilla sembrada con el reloj adelantado 60 días', () => {
  it('toma el día de la carga como su «hoy» y cuadra con el libro mayor al céntimo', async () => {
    expect(report.reusedClock).toBe(false);
    // La primera carga guarda su reloj antes de escribir nada más: una carga cortada a medias se repite con las mismas fechas.
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: SEED_CLOCK_SETTING } })).valueJson).toMatchObject({ offsetDays: report.clock.offsetDays, courseOffset: report.clock.courseOffset });
    expect(report.clock.offsetDays).toBe(Math.floor((loadedAt.getTime() - SEED_REFERENCE_NOW.getTime()) / DAY));
    expect(report.clock.academicYear).toBe(academicYearFor(loadedAt));
    expect(report.ledgerDebitCents).toBe(report.ledgerCreditCents);
    expect(report.initiatives.map((initiative) => initiative.ledgerRaisedCents)).toEqual(reference.initiatives.map((initiative) => initiative.raisedCents));
    expect(report.contributions).toBe(reference.initiatives.reduce((sum, initiative) => sum + initiative.totalContributions, 0));
  });

  it('las campañas que recaudan cierran en el futuro de ese día; cobros, asientos, firmas y pases son anteriores', async () => {
    const seed = shiftSeedData(reference, report.clock);
    const stored = await db.initiative.findMany({ where: { id: { in: seed.initiatives.map((initiative) => initiative.id) } }, orderBy: { id: 'asc' } });
    for (const initiative of seed.initiatives) {
      const row = stored.find((candidate) => candidate.id === initiative.id)!;
      expect(row.closesAt.toISOString(), `iniciativa ${initiative.id}`).toBe(initiative.closesAt);
      expect(row.academicYear).toBe(initiative.academicYear);
      expect(row.quarter).toBe(initiative.quarter);
      expect(row.createdAt.getTime()).toBeLessThan(loadedAt.getTime());
      if (initiative.status === 'FUNDRAISING') expect(row.closesAt.getTime(), `iniciativa ${initiative.id}`).toBeGreaterThan(loadedAt.getTime());
    }
    // Todo lo que la semilla da por ocurrido es anterior al día de la carga (nada firmado, cobrado ni escrito «en el futuro»).
    const past: Array<[string, Promise<{ _max: Record<string, Date | null> }>]> = [
      ['aportaciones', db.contribution.aggregate({ _max: { createdAt: true } })],
      ['asientos', db.ledgerJournal.aggregate({ _max: { occurredAt: true } })],
      ['pases', db.ticketPass.aggregate({ _max: { createdAt: true } })],
      ['firmas', db.doubleCheckSignature.aggregate({ _max: { signedAt: true } })],
      ['liquidaciones', db.escrowPayout.aggregate({ _max: { createdAt: true } })],
      ['liquidaciones ejecutadas', db.escrowPayout.aggregate({ _max: { executedAt: true } })],
      ['facturas', db.invoice.aggregate({ _max: { issuedAt: true } })],
      ['ideas', db.idea.aggregate({ _max: { createdAt: true } })],
      ['auditoría de las ideas', db.ideaSignatureAudit.aggregate({ _max: { createdAt: true } })],
      ['chat de las ideas', db.ideaMessage.aggregate({ _max: { createdAt: true } })],
      ['cobros de comercios', db.sponsor.aggregate({ _max: { paidAt: true } })],
      ['soporte', db.supportTicket.aggregate({ _max: { createdAt: true } })],
      ['revisión de las entidades', db.organization.aggregate({ _max: { kybReviewedAt: true } })]
    ];
    for (const [label, rows] of past) {
      const latest = Object.values((await rows)._max)[0];
      expect(latest, label).toBeInstanceOf(Date);
      expect(latest!.getTime(), label).toBeLessThanOrEqual(loadedAt.getTime());
    }
    // El ejercicio fiscal de cada aportación es el de su fecha en hora de España, como en un cobro real (`spanishFiscalYear`).
    const contributions = await db.contribution.findMany({ select: { createdAt: true, fiscalYear: true } });
    expect(contributions.filter((row) => row.fiscalYear !== spanishFiscalYear(row.createdAt))).toEqual([]);
    const organizations = await db.organization.findMany({ select: { quotaPeriod: true } });
    expect(organizations.map((organization) => organization.quotaPeriod)).toEqual(Array(reference.schools.length).fill(academicYearFor(loadedAt)));
    for (const invoice of seed.invoices) expect((await db.invoice.findUniqueOrThrow({ where: { invoiceNumber: invoice.invoiceNumber } })).issuedAt.toISOString()).toBe(invoice.issuedAt);
  });

  it('el vencimiento diario y la renovación de cupos de ese día no tocan la semilla, que sigue cuadrando', async () => {
    const statuses = async () => (await db.initiative.findMany({ select: { id: true, status: true }, orderBy: { id: 'asc' } })).map(({ id, status }) => `${id}:${status}`);
    const before = await statuses();
    const quotas = () => db.organization.findMany({ select: { id: true, quotaPeriod: true, exemptRemainingCents: true, medalGrantAvailableCents: true, maintPaidCents: true }, orderBy: { id: 'asc' } });
    const quotasBefore = await quotas();
    // En el mismo instante de la carga: una hora después podría ser ya el 22 de agosto y la renovación de cupos tocaría la semilla con razón.
    await campaignExpiryHandler(jobContext(loadedAt));
    await quotaRenewalHandler(jobContext(loadedAt));
    expect(await statuses()).toEqual(before);
    expect(await quotas()).toEqual(quotasBefore);
    await expect(verifySeed(db, reference)).resolves.toBeTruthy();
  });

  it('volver a sembrar tres días después conserva las fechas de la primera carga y no duplica nada', async () => {
    const counts = async () => ({
      journals: await db.ledgerJournal.count(),
      entries: await db.escrowLedgerEntry.count(),
      contributions: await db.contribution.count(),
      ticketPasses: await db.ticketPass.count(),
      signatures: await db.doubleCheckSignature.count(),
      invoices: await db.invoice.count(),
      ideaAudits: await db.ideaSignatureAudit.count(),
      ideaMessages: await db.ideaMessage.count()
    });
    const before = await counts();
    const closesBefore = (await db.initiative.findMany({ select: { closesAt: true }, orderBy: { id: 'asc' } })).map((row) => row.closesAt.toISOString());
    const again = await seedDatabase(db, { ...SECRETS, schema: CLOCK_SCHEMA, now: new Date(loadedAt.getTime() + 3 * DAY) });
    expect(again.reusedClock).toBe(true);
    expect(again.clock).toEqual(report.clock);
    expect(await counts()).toEqual(before);
    expect((await db.initiative.findMany({ select: { closesAt: true }, orderBy: { id: 'asc' } })).map((row) => row.closesAt.toISOString())).toEqual(closesBefore);
  }, 600_000);
});
