import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getEnv } from '@/config/env';
import { assertSeedAllowed, databaseTargetsOf } from '@/seed/seed-guard';

/**
 * Reinicio de la base (`npm run db:reset`): borra todo, aplica las migraciones y vuelve a cargar la semilla. Es destructivo,
 * así que pasa por la misma guardia que la semilla antes de lanzar `prisma migrate reset`. `prisma migrate reset` actúa sobre
 * `DIRECT_URL` si está definida (ver `prisma.config.ts`), por eso la guardia comprueba las dos direcciones.
 */
function main() {
  const env = getEnv();
  assertSeedAllowed({
    nodeEnv: env.NODE_ENV,
    demoMode: env.NEXT_PUBLIC_DEMO_MODE === 'true',
    paycometMode: env.PAYCOMET_MODE,
    databaseUrls: databaseTargetsOf(env)
  });
  const prismaCli = resolve('node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'reset', '--force'], { stdio: 'inherit' });
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
