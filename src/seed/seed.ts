import { IdempotencyConflictError } from '@/core/finance/ledger.service';
import type { KorumPrismaClient } from '@/lib/prisma';
import { planAllFunding } from './funding-plan';
import { resetSequences, seedInitiatives, seedOrganizations, seedPlatformConfig, seedSponsors } from './seed-base';
import { seedFunding, type SeedSecrets } from './seed-funding';
import { seedIdeas, seedInvoices, seedPayouts } from './seed-governance';
import { loadSeedData } from './seed-types';
import { verifySeed, type SeedReport } from './seed-verify';

export interface SeedOptions extends SeedSecrets {
  /** Esquema de PostgreSQL donde están las tablas (`public` por defecto; las pruebas usan `korum_test`). */
  schema?: string;
  log?: (message: string) => void;
}

/**
 * Siembra la base de datos con los datos de demostración de `src/mocks/seed_data.json`: reglas globales, 4 entidades con
 * sus firmantes, 8 iniciativas con todos sus cobros y asientos, comercios, pases QR, liquidaciones, facturas, ideas y
 * soporte. Es determinista e idempotente (se puede ejecutar varias veces) y termina conciliando el libro mayor con la
 * semilla al céntimo: si algo no cuadra, lanza `SeedReconciliationError`.
 */
export async function seedDatabase(db: KorumPrismaClient, options: SeedOptions): Promise<SeedReport> {
  const log = options.log ?? (() => undefined);
  const seed = loadSeedData();
  const plans = planAllFunding(seed);

  log('Reglas globales, usuarios y entidades…');
  await seedPlatformConfig(db, seed);
  await seedOrganizations(db, seed);
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
  const payoutIds = await seedPayouts(db, seed, options);
  await seedInvoices(db, seed, payoutIds, options.keyring);
  await seedIdeas(db, seed, options);
  await resetSequences(db, options.schema ?? 'public');
  log('Conciliando el libro mayor con la semilla…');
  return verifySeed(db, seed);
}
