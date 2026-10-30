import { getEnv } from '@/config/env';
import { createPrismaClient } from '@/lib/prisma';
import { seedDatabase } from '@/seed/seed';
import { assertSeedAllowed } from '@/seed/seed-guard';

/**
 * Carga los datos de demostración (`npm run db:seed`). Es idempotente: se puede ejecutar varias veces. Solo se ejecuta contra
 * una base local o en el entorno de demostración (`NEXT_PUBLIC_DEMO_MODE=true`), y nunca con cobros reales (ver `seed-guard`).
 */
async function main() {
  const env = getEnv();
  assertSeedAllowed({
    nodeEnv: env.NODE_ENV,
    demoMode: env.NEXT_PUBLIC_DEMO_MODE === 'true',
    paycometMode: env.PAYCOMET_MODE,
    databaseUrls: [{ name: 'DATABASE_URL', url: env.DATABASE_URL }]
  });

  const schema = new URL(env.DATABASE_URL).searchParams.get('schema') ?? 'public';
  const db = createPrismaClient({ connectionString: env.DATABASE_URL, schema });
  const startedAt = Date.now();
  try {
    const report = await seedDatabase(db, { hmacSecret: env.DATA_HMAC_SECRET, qrSecret: env.QR_HMAC_SECRET, schema, log: (message) => console.log(message) });
    console.log(
      `\n✅ Semilla lista en ${((Date.now() - startedAt) / 1000).toFixed(1)} s: ${report.organizations} entidades, ${report.initiatives.length} iniciativas, ` +
        `${report.contributions} aportaciones, ${report.ticketPasses} pases QR y ${report.journals} asientos (debe = haber = ${report.ledgerDebitCents} céntimos).`
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
