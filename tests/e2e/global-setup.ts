import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { E2E_SCHEMA, e2eBaseDatabaseUrl, e2eDatabaseUrl } from './e2e-database';
import { E2E_SERVER_ENV } from './e2e-env';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Recrea el esquema `korum_e2e`, aplica las migraciones y carga la semilla de demostración (las entidades `cervantes`, `san-jose`…). */
export default async function globalSetup() {
  const base = e2eBaseDatabaseUrl();
  if (!process.env.CI && !LOCAL_HOSTS.has(new URL(base).hostname)) throw new Error('Las pruebas de navegador solo usan una base de datos local.');
  const client = new pg.Client({ connectionString: base });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`No hay base de datos para las pruebas de navegador. Arranca la local con «npm run db:dev» o indica E2E_DATABASE_URL.\n${(error as Error).message}`);
  }
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${E2E_SCHEMA}"`);
  } finally {
    await client.end();
  }
  const require = createRequire(import.meta.url);
  const env = { ...process.env, ...E2E_SERVER_ENV, DATABASE_URL: e2eDatabaseUrl(), DIRECT_URL: e2eDatabaseUrl() };
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [require.resolve('tsx/cli'), 'prisma/seed.ts'], { env, stdio: 'pipe', timeout: 240_000 });
}
