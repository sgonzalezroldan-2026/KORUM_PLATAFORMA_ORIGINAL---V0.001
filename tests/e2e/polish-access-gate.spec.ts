import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 5.5b · QA-X02 en los formularios de acceso y la portería: el foco no salta al cambiar de modo en `/login`, el alta con varios errores tiene un solo
 * resumen anunciado y lleva el foco al primer campo con error, la página 403 ofrece volver al panel propio o cerrar sesión, la portería tiene selector de
 * idioma, la declaración de accesibilidad está en el pie y en los tres idiomas, y la votación sin enlace deja pedirlo otra vez sin revelar quién donó.
 */

const server = expect.configure({ timeout: 30_000 });

test.describe('QA-X02 · formularios de acceso', () => {
  test('en /login, cambiar de modo deja el foco en el botón pulsado (no salta al título)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/login');
    const password = page.getByRole('button', { name: 'Firmantes y equipo' });
    await password.click();
    await expect(password).toHaveAttribute('aria-pressed', 'true');
    await expect(password).toBeFocused();
    await expect(page.getByLabel('Contraseña', { exact: true })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('el alta con varios errores anuncia un solo resumen y lleva el foco al primer campo con error', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/registro-comunidad');
    await page.getByRole('button', { name: 'Continuar' }).click();
    // En el contenido (fuera quedan la zona vacía de notificaciones y el anunciador de rutas de Next): un solo aviso, el resumen.
    const alerts = page.locator('#contenido').getByRole('alert');
    await expect(alerts).toHaveCount(1);
    await expect(alerts).toContainText(/Revisa los \d+ campos marcados/);
    const name = page.getByLabel('Nombre público');
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(/.+/);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });
});

test.describe('403 con salida', () => {
  test('quien firma y entra en la consola ve «Ir a mi panel», «Entrar con otra cuenta» y «Cerrar sesión»; «Ir a mi panel» le lleva al suyo', async ({ page, isMobile }) => {
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const errors = trackConsoleErrors(page);
    const response = await page.goto('/admin');
    expect(response?.status()).toBe(403);
    await expect(page.getByRole('heading', { level: 1, name: 'No tienes acceso a esta página' })).toBeVisible();
    // Título propio (WCAG 2.4.2): no el de la página pedida («Consola · KORUM»).
    await expect(page).toHaveTitle('No tienes acceso a esta página · KORUM');
    await expect(page.getByRole('link', { name: 'Entrar con otra cuenta' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    await page.getByRole('link', { name: 'Ir a mi panel' }).click();
    await server(page).toHaveURL(new RegExp(`/panel/${entity.slug}$`));
    expect(errors.filter((message) => !/403/.test(message))).toEqual([]);
  });
});

test.describe('Portería con selector de idioma (Regla 03 §7)', () => {
  test('la entrada de la portería se puede pasar a catalán e inglés y sigue siendo accesible sobre su fondo oscuro', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/panel/cervantes/porteria');
    const languages = page.getByRole('navigation', { name: /^(Idioma|Language)$/ });
    await expect(languages).toBeVisible();
    await languages.getByRole('link', { name: /CA, Català/ }).click();
    await server(page).toHaveURL(/\/ca\/panel\/cervantes\/porteria$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ca');
    await expectNoMissingTranslations(page);
    await page.getByRole('navigation', { name: /^(Idioma|Language)$/ }).getByRole('link', { name: /EN, English/ }).click();
    await server(page).toHaveURL(/\/en\/panel\/cervantes\/porteria$/);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });
});

test.describe('Declaración de accesibilidad (EXPERIENCIA §7)', () => {
  for (const [prefix, title] of [['', 'Declaración de accesibilidad'], ['/ca', 'Declaració d’accessibilitat'], ['/en', 'Accessibility statement']] as const) {
    test(`${prefix || '/'}: enlazada desde el pie y con su canal para comunicar problemas`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await page.goto(prefix || '/');
      await page.locator('footer').getByRole('link', { name: /Accesibilidad|Accessibilitat|Accessibility/ }).click();
      await server(page).toHaveURL(new RegExp(`${prefix}/accesibilidad$`));
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${prefix}/accesibilidad$`));
      // El canal: el buzón de la consola o, sin él, la ayuda de la entidad.
      await expect(page.getByTestId('a11y-contact-email').or(page.getByTestId('a11y-contact-fallback'))).toBeVisible();
      await expectNoMissingTranslations(page);
      await expectNoSeriousA11yViolations(page);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('«Reenviarme mi enlace de voto» (heredado del 4.4b)', () => {
  test('sin enlace se puede pedir con el email; la respuesta no dice si ese email donó', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // Su propia red de prueba: el tope por red es de 20 cada 15 minutos.
    const octet = () => 1 + Math.floor(Math.random() * 250);
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` });
    await page.goto('/cervantes/votacion');
    await expect(page.getByRole('heading', { level: 1, name: 'Votación de la campaña' })).toBeVisible();
    const email = page.getByLabel('Tu email');
    await email.fill('sin-arroba');
    await page.getByRole('button', { name: 'Enviarme el enlace' }).click();
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await email.fill(`nadie-${Date.now()}@familias.example`);
    await page.getByRole('button', { name: 'Enviarme el enlace' }).click();
    const sent = page.getByTestId('resize-link-sent');
    await server(sent).toBeVisible();
    await expect(sent).toBeFocused();
    await expect(sent).toContainText('Si ese email aportó');
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });
});
