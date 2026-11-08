import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { totpCode } from '../support/totp';
import { codeTo, emailTo, uniqueEmail } from './auth-support';

/**
 * Apoyo de las pruebas del panel: da de alta una entidad nueva por la interfaz (3 pasos), verifica el email y activa el TOTP, como haría quien
 * dirige un centro, y deja la sesión abierta en `/panel/{slug}` con el segundo factor superado. Los códigos se leen de `.email-preview/`.
 */

const server = expect.configure({ timeout: 30_000 });

export interface RegisteredEntity {
  slug: string;
  name: string;
  director: string;
  cosigner: string;
  password: string;
  totpSecret: string;
  /** Momento del alta (ms): la invitación de la cofirma se busca desde aquí. */
  registeredAt: number;
}

export async function registerEntityAndEnterPanel(page: Page, isMobile: boolean): Promise<RegisteredEntity> {
  const suffix = `${isMobile ? 'm' : 'd'}${Date.now().toString(36)}`;
  const director = uniqueEmail('direccion');
  const cosigner = uniqueEmail('afa');
  const password = 'una-contraseña-muy-larga';
  const name = `CEIP Panel ${suffix}`;
  // Cada alta desde su propia red de prueba: el alta admite 5 por IP y hora (`REGISTRATION_RULE`) y la E2E completa da de alta más entidades.
  const octet = () => 1 + Math.floor(Math.random() * 250);
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` });
  await page.goto('/registro-comunidad');
  await page.getByLabel('Nombre público').fill(name);
  await page.getByLabel('Provincia').selectOption('08');
  await page.getByLabel('Municipio').fill('Sabadell');
  await page.getByLabel('Código postal').fill('08201');
  await page.getByLabel('Razón social del titular').fill(`AFA CEIP Panel ${suffix}`);
  await page.getByLabel('Forma jurídica').selectOption('PARENTS_ASSOCIATION');
  await page.getByRole('button', { name: 'Continuar' }).click();

  const signer = (index: number) => page.locator('fieldset').nth(index);
  await expect(page.getByRole('heading', { level: 2, name: 'Las dos personas firmantes' })).toBeFocused();
  await signer(0).getByLabel('Nombre y apellidos').fill('Carla Puig');
  await signer(0).getByLabel('Email').fill(director);
  await signer(0).getByLabel('Teléfono').fill('600 111 222');
  await signer(0).getByLabel('Contraseña', { exact: true }).fill(password);
  await signer(0).getByLabel('Repite la contraseña').fill(password);
  await signer(1).getByLabel('Nombre y apellidos').fill('Marta Soler');
  await signer(1).getByLabel('Email').fill(cosigner);
  await signer(1).getByLabel('Teléfono').fill('600 333 444');
  await page.getByRole('button', { name: 'Continuar' }).click();

  await page.getByLabel(/Declaro que represento/).check();
  const since = Date.now();
  await page.getByRole('button', { name: 'Dar de alta' }).click();
  await server(page.getByRole('heading', { name: `¡${name} ya está en KORUM!` })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Código de 6 dígitos').fill(await codeTo(director, since));
  await page.getByRole('button', { name: 'Verificar y continuar' }).click();
  await server(page.getByRole('heading', { level: 1, name: 'Activa la verificación en dos pasos' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Tu contraseña').fill(password);
  await page.getByRole('button', { name: 'Empezar' }).click();
  await server(page.getByRole('img', { name: 'Código QR para añadir KORUM a tu app de verificación' })).toBeVisible();
  const totpSecret = (await page.locator('code').first().innerText()).trim();
  await page.getByLabel('He guardado los códigos de respaldo').check();
  await page.getByLabel('Primer código de la app').fill(totpCode(totpSecret));
  await page.getByRole('button', { name: 'Activar y continuar' }).click();

  const slug = `ceip-panel-${suffix}`;
  await expect(page).toHaveURL(new RegExp(`/panel/${slug}$`), { timeout: 30_000 });
  return { slug, name, director, cosigner, password, totpSecret, registeredAt: since };
}

/**
 * La segunda persona firmante (cofirma) abre su invitación en otro navegador, crea su contraseña y activa su TOTP, como en `auth-rbac`. Queda
 * con la sesión abierta en `/panel/{slug}` y el segundo factor superado.
 */
export async function activateCosigner(browser: Browser, entity: RegisteredEntity, viewport: { width: number; height: number } | null): Promise<{ context: BrowserContext; page: Page; totpSecret: string }> {
  const invitation = await emailTo(entity.cosigner, entity.registeredAt);
  const link = /https?:\/\/\S+\/invitacion#t=\S+/.exec(invitation)?.[0];
  expect(link).toBeTruthy();
  const context = await browser.newContext({ viewport: viewport ?? undefined });
  const page = await context.newPage();
  await page.goto(new URL(link!).pathname + new URL(link!).hash);
  await page.getByLabel('Crea tu contraseña').fill(entity.password);
  await page.getByLabel('Repite la contraseña').fill(entity.password);
  await page.getByRole('button', { name: 'Crear contraseña y continuar' }).click();
  await server(page.getByRole('heading', { level: 1, name: 'Activa la verificación en dos pasos' })).toBeVisible();
  await page.getByLabel('Tu contraseña').fill(entity.password);
  await page.getByRole('button', { name: 'Empezar' }).click();
  await server(page.getByRole('img', { name: 'Código QR para añadir KORUM a tu app de verificación' })).toBeVisible();
  const totpSecret = (await page.locator('code').first().innerText()).trim();
  await page.getByLabel('He guardado los códigos de respaldo').check();
  await page.getByLabel('Primer código de la app').fill(totpCode(totpSecret));
  await page.getByRole('button', { name: 'Activar y continuar' }).click();
  await server(page).toHaveURL(new RegExp(`/panel/${entity.slug}$`));
  return { context, page, totpSecret };
}
