import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Pruebas de integración contra PostgreSQL real (triggers, restricciones y concurrencia del libro mayor).
 * Base de datos: `TEST_DATABASE_URL`, o la local de `npm run db:dev` si no se indica. Solo se usa el esquema `korum_test`,
 * que se borra y se migra al empezar: nunca se toca `public`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    globalSetup: ['./tests/integration/global-setup.ts'],
    // Un único archivo a la vez: todos comparten la misma base de datos.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000
  }
});
