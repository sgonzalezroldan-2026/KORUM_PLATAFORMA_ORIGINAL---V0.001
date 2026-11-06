/**
 * Base de datos de las pruebas de navegador: un esquema propio (`korum_e2e`) en la base de pruebas (la de la CI o la local de
 * `npm run db:dev`), recreado, migrado y sembrado en cada ejecución (`global-setup.ts`). Nunca toca `public` ni los datos de desarrollo.
 */
export const E2E_SCHEMA = 'korum_e2e';
const LOCAL_DEV_DATABASE = 'postgres://postgres:postgres@localhost:51214/template1?sslmode=disable';

export function e2eBaseDatabaseUrl(): string {
  return process.env.E2E_DATABASE_URL || process.env.TEST_DATABASE_URL || LOCAL_DEV_DATABASE;
}

/** Con la base local sin Docker (PGlite), una sola conexión: varias a la vez mezclan sus mensajes. Con PostgreSQL real, el pool normal. */
export function e2eDatabaseUrl(): string {
  const url = new URL(e2eBaseDatabaseUrl());
  url.searchParams.set('schema', E2E_SCHEMA);
  if (!process.env.E2E_DATABASE_URL && !process.env.TEST_DATABASE_URL) url.searchParams.set('connection_limit', '1');
  return url.toString();
}
