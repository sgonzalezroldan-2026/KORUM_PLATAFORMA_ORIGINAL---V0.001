import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_PORT, E2E_SERVER_ENV } from './tests/e2e/e2e-env';

const PORT = E2E_PORT;
const baseURL = E2E_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  // Base de datos propia de las pruebas (esquema korum_e2e), migrada y sembrada antes de arrancar.
  globalSetup: './tests/e2e/global-setup.ts',
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
    env: E2E_SERVER_ENV
  }
});
