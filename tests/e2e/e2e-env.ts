import { e2eDatabaseUrl } from './e2e-database';

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/**
 * Entorno del servidor de pruebas y de la semilla: secretos falsos pero válidos (el servidor arranca sin tocar el `.env.local` de nadie),
 * cobros simulados, modo demostración y la base de datos del esquema `korum_e2e`.
 */
export const E2E_SERVER_ENV: Record<string, string> = {
  DATABASE_URL: e2eDatabaseUrl(),
  BETTER_AUTH_SECRET: 'e2e-better-auth-secret-0123456789abcdef',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATA_HMAC_SECRET: 'e2e-data-hmac-secret-0123456789abcdef',
  QR_HMAC_SECRET: 'e2e-qr-hmac-secret-0123456789abcdefgh',
  CRON_SECRET: 'e2e-cron-secret-0123456789abcdefghij',
  PAYCOMET_MODE: 'mock',
  // NIF emisor de las facturas del fee de los patrocinios (Sprint 3.5): sin él, el cobro de un comercio no se asienta.
  VERIFACTU_ISSUER_NIF: 'A58818501',
  NEXT_PUBLIC_DEMO_MODE: 'true',
  NEXT_PUBLIC_APP_URL: E2E_BASE_URL,
  NEXT_TELEMETRY_DISABLED: '1',
  // Los emails de la vista previa se escriben en .email-preview/ también con la compilación de producción: las pruebas leen ahí los códigos.
  KORUM_EMAIL_PREVIEW_FILES: '1'
};
