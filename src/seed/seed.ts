import { IdempotencyConflictError } from '@/core/finance/ledger.service';
import type { KorumPrismaClient } from '@/lib/prisma';
import { planAllFunding } from './funding-plan';
import { resetSequences, seedInitiatives, seedOrganizations, seedPlatformConfig, seedSponsors } from './seed-base';
import { persistSeedClock, resolveSeedClock, seedDay, shiftFundingPlans, shiftSeedData, type SeedClock } from './seed-clock';
import { seedFunding, type SeedSecrets } from './seed-funding';
import { seedIdeas, seedInvoices, seedPayouts } from './seed-governance';
import { loadSeedData } from './seed-types';
import { verifySeed, type SeedReport } from './seed-verify';
import { seedLegalTexts } from './legal-texts';

export interface SeedOptions extends SeedSecrets {
  /** Esquema de PostgreSQL donde están las tablas (`public` por defecto; las pruebas usan `korum_test`). */
  schema?: string;
  log?: (message: string) => void;
  /**
   * Momento de la carga (por defecto, ahora): las fechas de la semilla se desplazan para que su «hoy» sea este día (Sprint 5.7). Si la base
   * ya tiene la semilla, se conserva el desplazamiento con el que se sembró.
   */
  now?: Date;
}

export interface SeedRunReport extends SeedReport {
  /** Reloj con el que quedaron las fechas de la semilla. */
  clock: SeedClock;
  /** `true` si la base ya estaba sembrada y se ha conservado su desplazamiento de fechas. */
  reusedClock: boolean;
}

/**
 * Siembra la base de datos con los datos de demostración de `src/mocks/seed_data.json`: reglas globales, 4 entidades con
 * sus firmantes, 8 iniciativas con todos sus cobros y asientos, comercios, pases QR, liquidaciones, facturas, ideas y
 * soporte. Sus fechas se calculan respecto al día de la carga (`seed-clock`). Es determinista e idempotente (se puede ejecutar
 * varias veces, también otro día) y termina conciliando el libro mayor con la semilla al céntimo: si algo no cuadra, lanza
 * `SeedReconciliationError`.
 */
export async function seedDatabase(db: KorumPrismaClient, options: SeedOptions): Promise<SeedRunReport> {
  const log = options.log ?? (() => undefined);
  const reference = loadSeedData();
  const { clock, reused } = await resolveSeedClock(db, reference, options.now ?? new Date());
  await persistSeedClock(db, clock);
  const seed = shiftSeedData(reference, clock);
  const plans = shiftFundingPlans(planAllFunding(reference), clock);
  log(
    reused
      ? `La base ya tenía la semilla del ${seedDay(clock)}: se conservan sus fechas (para fechas de hoy, npm run db:reset).`
      : `Fechas de la semilla respecto al ${seedDay(clock)} (curso ${clock.academicYear}).`
  );

  log('Reglas globales, usuarios y entidades…');
  await seedPlatformConfig(db, seed);
  // Textos legales de docs/legal (Sprint 5.10a): sin ellos no hay páginas legales ni se puede dar de alta una entidad.
  await seedLegalTexts(db, clock.now);
  await seedOrganizations(db, seed, clock);
  log('Iniciativas y comercios…');
  await seedInitiatives(db, seed, plans);
  await seedSponsors(db, seed, plans, options.keyring);
  log('Cobros, pases QR y libro mayor…');
  try {
    await seedFunding(db, seed, plans, options, options.schema ?? 'public', log);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw new Error(`${error.message} La base conserva una versión anterior de la semilla: reiníciala con npm run db:reset (solo en bases locales o de demostración).`, { cause: error });
    }
    throw error;
  }
  log('Liquidaciones, facturas, ideas y soporte…');
  const payoutIds = await seedPayouts(db, seed, options, clock.now);
  await seedInvoices(db, seed, payoutIds, options.keyring);
  await seedIdeas(db, seed, options, clock.now);
  await resetSequences(db, options.schema ?? 'public');
  log('Conciliando el libro mayor con la semilla…');
  return { ...(await verifySeed(db, seed, { seedNow: clock.now })), clock, reusedClock: reused };
}
