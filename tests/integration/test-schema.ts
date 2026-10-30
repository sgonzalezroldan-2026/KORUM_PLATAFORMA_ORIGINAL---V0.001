/** Esquema exclusivo de las pruebas. Se borra y se recrea en cada ejecución. */
export const TEST_SCHEMA = 'korum_test';

/** Base local de `npm run db:dev` (Prisma Postgres local, sin Docker). */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:51214/template1?sslmode=disable';

export function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}
