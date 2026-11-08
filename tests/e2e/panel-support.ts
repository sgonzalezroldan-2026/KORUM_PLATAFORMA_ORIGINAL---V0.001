import { expect, type Page } from '@playwright/test';
import { totpCode } from '../support/totp';
import { codeIn, emailTo, uniqueEmail } from './auth-support';

/**
 * Apoyo de las pruebas del panel: da de alta una entidad nueva por la interfaz (3 pasos), verifica el email y activa el TOTP, como haría quien
 * dirige un centro, y deja la sesión abierta en `/panel/{slug}` con el segundo factor superado. Los códigos se leen de `.email-preview/`.
 */

const server = expect.configure({ timeout: 30_000 });

export interface RegisteredEntity {
  slug: string;
  name: string;
  director: string;
  password: string;
  totpSecret: string;
}

export async function registerEntityAndEnterPanel(page: Page, isMobile: boolean): Promise<RegisteredEntity> {
  const suffix = `${isMobile ? 'm' : 'd'}${Date.now().toString(36)}`;
  const director = uniqueEmail('direccion');
  const cosigner = uniqueEmail('afa');
  const password = 'una-contraseña-muy-larga';
  const name = `CEIP Panel ${suffix}`;
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
  await page.getByLabel('Código de 6 dígitos').fill(codeIn(await emailTo(director, since)));
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
  return { slug, name, director, password, totpSecret };
}
