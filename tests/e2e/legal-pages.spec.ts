import { expect, test } from '@playwright/test';
import { withE2eDb } from './auth-support';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 5.10a · `QA-LEG01`, `QA-LEG02` y `QA-SEO04`: los textos legales publicados se leen en su página pública en los tres idiomas (en catalán y en inglés,
 * el castellano con su aviso mientras no estén traducidos), con su versión, su huella y su archivo; el pie los enlaza; el alta y el acceso enseñan su primera
 * capa; y la aceptación del alta queda registrada con su versión.
 */

const PAGES = [
  { path: '/aviso-legal', document: 'aviso-legal', title: 'Aviso legal' },
  { path: '/condiciones', document: 'terminos', title: 'Condiciones de uso de KORUM' },
  { path: '/condiciones/entradas-y-vales', document: 'condiciones-entradas-y-vales', title: 'Condiciones de entradas y vales' },
  { path: '/condiciones/aportacion-mensual', document: 'condiciones-aportacion-mensual', title: 'Condiciones de la aportación mensual (Mi Hucha)' },
  { path: '/condiciones/entidades', document: 'condiciones-entidades', title: 'Condiciones para entidades' },
  { path: '/condiciones/comercios', document: 'condiciones-comercios', title: 'Condiciones para comercios' },
  { path: '/contrato-de-encargo', document: 'contrato-de-encargo', title: 'Contrato de encargo del tratamiento' },
  { path: '/privacidad', document: 'privacidad', title: 'Política de privacidad' },
  { path: '/cookies', document: 'cookies', title: 'Política de cookies' }
] as const;

test.describe('QA-LEG01 · páginas públicas de los textos legales', () => {
  for (const page of PAGES) {
    test(`${page.path}: el texto vigente con su versión y su huella, sin marcas ni notas internas`, async ({ page: browser }) => {
      const errors = trackConsoleErrors(browser);
      const response = await browser.goto(page.path);
      expect(response?.status()).toBe(200);
      const article = browser.getByTestId('legal-page');
      await expect(article).toHaveAttribute('data-document', page.document);
      await expect(browser.getByRole('heading', { level: 1, name: page.title })).toBeVisible();
      await expect(browser.getByTestId('legal-version')).toContainText(/Versión \d{4}-\d{2}-\d{2} · publicada el/);
      await expect(browser.getByTestId('legal-hash')).toHaveText(/^[0-9a-f]{64}$/);
      const text = await article.innerText();
      // Las marcas se sustituyen (por el dato o por «dato pendiente») y las notas del recuadro no se publican.
      expect(text).not.toContain('[[');
      expect(text).not.toContain('Las notas de este recuadro');
      await expect(browser.getByTestId('legal-fallback')).toHaveCount(0);
      await expectNoHorizontalOverflow(browser);
      await expectNoMissingTranslations(browser);
      await expectNoSeriousA11yViolations(browser);
      expect(errors).toEqual([]);
    });
  }

  test('los enlaces entre textos llevan a sus páginas; la tabla de plazos, que es interna, no se enlaza; un tipo de condiciones que no existe da 404', async ({ page }) => {
    await page.goto('/aviso-legal');
    const content = page.getByTestId('legal-page');
    await content.getByRole('link', { name: 'condiciones para entidades' }).click();
    await expect(page).toHaveURL(/\/condiciones\/entidades$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Condiciones para entidades' })).toBeVisible();
    await page.goto('/privacidad');
    await expect(page.locator('a[href*="tabla-de-plazos"]')).toHaveCount(0);
    expect((await page.goto('/condiciones/inexistente'))?.status()).toBe(404);
  });

  // El contrato de encargo: ninguna otra prueba lo publica en catalán o en inglés (la de ajustes de la consola publica las cookies en inglés).
  test('en catalán y en inglés, mientras no hay traducción, se enseña el castellano con su aviso y marcado como castellano', async ({ page }) => {
    for (const [prefix, notice] of [['/ca', 'Aquest text encara no està traduït al català'], ['/en', 'This text has not been translated into English yet']] as const) {
      const errors = trackConsoleErrors(page);
      expect((await page.goto(`${prefix}/contrato-de-encargo`))?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', prefix.slice(1));
      await expect(page.getByTestId('legal-fallback')).toContainText(notice);
      await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'es');
      // Los enlaces del texto se quedan en el idioma de la página.
      await expect(page.getByTestId('legal-page').locator(`a[href^="${prefix}/privacidad"]`).first()).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      expect(errors).toEqual([]);
    }
  });

  test('el archivo de versiones: la vigente se puede pedir por su número, sin indexarse; una que no existe da 404', async ({ page }) => {
    await page.goto('/cookies');
    const version = await page.getByTestId('legal-page').getAttribute('data-version');
    await expect(page.getByTestId('legal-versions').getByText('vigente')).toBeVisible();
    expect((await page.goto(`/cookies?version=${version}`))?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(1);
    expect((await page.goto('/cookies?version=2001-01-01'))?.status()).toBe(404);
  });

  test('el pie de todas las páginas públicas enlaza los cuatro textos que lee cualquier persona', async ({ page }) => {
    await page.goto('/');
    const legal = page.getByTestId('footer-legal');
    for (const [name, path] of [['Aviso legal', '/aviso-legal'], ['Condiciones de uso', '/condiciones'], ['Privacidad', '/privacidad'], ['Cookies', '/cookies']] as const) {
      await expect(legal.getByRole('link', { name, exact: true })).toHaveAttribute('href', path);
    }
  });
});

test.describe('QA-LEG02 · primera capa y aceptación', () => {
  test('la pantalla de acceso dice que al entrar por primera vez se aceptan las condiciones, con sus datos en un desplegable cerrado', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/login');
    const layer = page.getByTestId('login-first-layer');
    // Los enlaces dicen además, solo para lectores de pantalla, que se abren en otra pestaña.
    expect((await layer.locator('p').first().textContent())?.replaceAll(' (se abre en otra pestaña)', '')).toContain('Al entrar por primera vez creas tu cuenta y aceptas las condiciones.');
    await expect(layer.getByRole('link', { name: /condiciones/ })).toHaveAttribute('href', '/condiciones');
    await expect(layer.getByRole('link', { name: /condiciones/ })).toHaveAttribute('target', '_blank');
    await expect(layer.getByText('Quién los trata:')).toBeHidden();
    await layer.getByText('Tus datos').click();
    await expect(layer.getByText('Quién los trata:')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('el alta enseña la línea junto al botón y registra quién aceptó las condiciones para entidades y el contrato de encargo, con su versión', async ({ page, isMobile }) => {
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const rows = await withE2eDb(async (db) => {
      const result = await db.query<{ document: string; locale: string; version: string; source: string; email: string }>(
        `SELECT a."document", a."locale"::text AS "locale", a."version", a."source", u."email"
           FROM "LegalAcceptance" a JOIN "Organization" o ON o."id" = a."organizationId" JOIN "User" u ON u."id" = a."userId"
          WHERE o."slug" = $1 ORDER BY a."document"`,
        [entity.slug]
      );
      return result.rows;
    });
    expect(rows.map((row) => [row.document, row.locale, row.source, row.email.toLowerCase()])).toEqual([
      ['condiciones-entidades', 'es', 'alta', entity.director.toLowerCase()],
      ['contrato-de-encargo', 'es', 'alta', entity.director.toLowerCase()]
    ]);
    for (const row of rows) expect(row.version).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

});

test.describe('QA-SEO04 · lo que ve un buscador', () => {
  test('en el entorno de pruebas, que se sirve como producción (SEARCH_INDEXING=allow), robots.txt tiene sus reglas y las páginas no llevan noindex', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(await robots.text()).toContain('Sitemap:');
    const home = await request.get('/');
    expect(home.headers()['x-robots-tag']).toBeUndefined();
  });
});
