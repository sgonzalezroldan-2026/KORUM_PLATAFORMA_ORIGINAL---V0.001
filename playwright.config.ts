import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${PORT}`;

// Entorno de pruebas: valores falsos pero válidos para que el servidor arranque sin tocar el .env.local de nadie.
const testEnv = {
  DATABASE_URL: 'postgresql://korum:korum@localhost:5432/korum',
  BETTER_AUTH_SECRET: 'e2e-better-auth-secret-0123456789abcdef',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATA_HMAC_SECRET: 'e2e-data-hmac-secret-0123456789abcdef',
  QR_HMAC_SECRET: 'e2e-qr-hmac-secret-0123456789abcdefgh',
  CRON_SECRET: 'e2e-cron-secret-0123456789abcdefghij',
  PAYCOMET_MODE: 'mock',
  NEXT_PUBLIC_DEMO_MODE: 'true',
  NEXT_PUBLIC_APP_URL: baseURL,
  NEXT_TELEMETRY_DISABLED: '1'
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
    }
  ],
  webServer: {
    // En CI se prueba la compilación de producción (`npm run build` antes); en local, el servidor de desarrollo.
    command: process.env.CI ? `npx next start -p ${PORT}` : `npx next dev -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: testEnv
  }
});
