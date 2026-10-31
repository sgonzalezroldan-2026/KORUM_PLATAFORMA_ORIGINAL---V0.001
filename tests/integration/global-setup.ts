import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { DEFAULT_TEST_DATABASE_URL, TEST_SCHEMA, withSchema } from './test-schema';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Contraseña oculta para los mensajes de error. */
const redact = (url: string) => url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

/**
 * Prepara la base de pruebas una vez por ejecución: borra y recrea el esquema `korum_test` y aplica todas las migraciones
 * (incluidos los triggers de inmutabilidad). Por seguridad, fuera de la CI solo acepta bases en este ordenador.
 */
export default async function setup(project: TestProject) {
  // `||` y no `??`: una variable vacía (como en la plantilla .env.example) cuenta como no indicada.
  const baseUrl = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  const { hostname } = new URL(baseUrl);
  if (!process.env.CI && !LOCAL_HOSTS.has(hostname)) {
    throw new Error(`Las pruebas de integración solo se ejecutan contra una base local (recibido ${redact(baseUrl)}).`);
  }

  const client = new pg.Client({ connectionString: baseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `No hay base de datos de pruebas en ${redact(baseUrl)}. Arranca la local con «npm run db:dev» o indica TEST_DATABASE_URL.\n${(error as Error).message}`
    );
  }
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  } finally {
    await client.end();
  }

  const schemaUrl = withSchema(baseUrl, TEST_SCHEMA);
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: schemaUrl, DIRECT_URL: schemaUrl },
      stdio: 'pipe'
    });
  } catch (error) {
    const output = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`Fallo al aplicar las migraciones en el esquema ${TEST_SCHEMA}:\n${output.stdout?.toString() ?? ''}${output.stderr?.toString() ?? ''}`);
  }

  await reserveSeedIdentifiers(baseUrl);
  await resetSearchPath(baseUrl);
  project.provide('testDatabaseUrl', baseUrl);
}

/**
 * La semilla usa identificadores fijos (iniciativas 1–8, comercios, ideas). Las altas de las pruebas empiezan más arriba para no chocar
 * con ellos, sea cual sea el orden en que se ejecuten los archivos.
 */
async function reserveSeedIdentifiers(connectionString: string) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    for (const table of ['Initiative', 'Sponsor', 'Idea']) {
      await client.query(`ALTER SEQUENCE "${TEST_SCHEMA}"."${table}_id_seq" RESTART WITH 100000`);
    }
  } finally {
    await client.end();
  }
}

/**
 * La CLI de Prisma fija el `search_path` del esquema que migra. La base local de `npm run db:dev` (PGlite) es un único
 * proceso que comparte ese ajuste entre todas las conexiones, y se quedaría pegado haciendo que una migración posterior
 * de `public` viera las tablas de `korum_test`. En un PostgreSQL real no ocurre; restablecerlo es inocuo.
 */
async function resetSearchPath(connectionString: string) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.query('RESET search_path');
  } finally {
    await client.end();
  }
}
