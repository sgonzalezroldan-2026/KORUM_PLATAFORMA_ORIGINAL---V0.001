import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

const HOME = [
  { path: '/', lang: 'es', title: 'Donde las buenas ideas de tu colegio o club suman y se hacen realidad.' },
  { path: '/ca', lang: 'ca', title: 'On les bones idees de la teva escola o club sumen i es fan realitat.' },
  { path: '/en', lang: 'en', title: 'Where your school or club’s good ideas add up and come true.' }
] as const;

test.describe('QA-C05 · idiomas operativos', () => {
  for (const { path, lang, title } of HOME) {
    test(`la portada ${path} se sirve en ${lang}, sin errores, sin desbordes y accesible`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);

      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      await expect(page).toHaveTitle(/KORUM/);
      await expectNoMissingTranslations(page);
      await expectNoHorizontalOverflow(page);
      await expectNoSeriousA11yViolations(page);
      expect(errors).toEqual([]);
    });
  }

  test('la portada declara sus alternativas de idioma (hreflang) y su canónica', async ({ page }) => {
    await page.goto('/ca');
    const hreflangs = await page.locator('link[rel="alternate"][hreflang]').evaluateAll((links) =>
      links.map((link) => `${link.getAttribute('hreflang')}=${new URL((link as HTMLLinkElement).href).pathname}`)
    );
    expect(hreflangs).toEqual(expect.arrayContaining(['es=/', 'ca=/ca', 'en=/en', 'x-default=/']));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/ca$/);
  });

  test('el selector cambia de idioma conservando la ruta', async ({ page }) => {
    await page.goto('/dev/ui');
    const switcher = page.getByRole('navigation', { name: 'Idioma' });
    await switcher.getByRole('link', { name: 'CA, Català' }).click();
    await expect(page).toHaveURL(/\/ca\/dev\/ui$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ca');

    await page.getByRole('navigation', { name: 'Idioma' }).getByRole('link', { name: 'EN, English' }).click();
    await expect(page).toHaveURL(/\/en\/dev\/ui$/);
    await expect(page.getByRole('navigation', { name: 'Language' })).toBeVisible();

    await page.getByRole('navigation', { name: 'Language' }).getByRole('link', { name: 'ES, Castellano' }).click();
    await expect(page).toHaveURL(/\/dev\/ui$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  });

  test('el idioma activo se marca con aria-current y cada enlace declara su idioma', async ({ page }) => {
    await page.goto('/en');
    const switcher = page.getByRole('navigation', { name: 'Language', exact: true });
    await expect(switcher.getByRole('link', { name: 'EN, English' })).toHaveAttribute('aria-current', 'true');
    await expect(switcher.getByRole('link', { name: 'CA, Català' })).toHaveAttribute('lang', 'ca');
    await expect(switcher.getByRole('link', { name: 'ES, Castellano' })).toHaveAttribute('hreflang', 'es');
  });

  test('una ruta desconocida muestra el 404 en el idioma de la URL, con código 404 y accesible', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const response = await page.goto('/ca/esta-pagina-no-existe');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'No trobem aquesta pàgina' })).toBeVisible();
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);

    await page.getByRole('link', { name: 'Tornar a l\'inici' }).click();
    await expect(page).toHaveURL(/\/ca$/);
    expect(errors.filter((message) => !message.includes('404'))).toEqual([]);
  });

  test('el enlace «Saltar al contenido» es el primer elemento enfocable y lleva al contenido', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Saltar al contenido' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#contenido$/);
  });

  test('las cabeceras de seguridad básicas están presentes', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
