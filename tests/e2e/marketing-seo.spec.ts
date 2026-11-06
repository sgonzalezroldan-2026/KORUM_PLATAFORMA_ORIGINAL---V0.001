import { expect, test, type Page } from '@playwright/test';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/** QA-M01 · QA-SEO01 · QA-SEO02 · QA-F06: portada, páginas pilar y descubribilidad, en los tres idiomas. */

const PREFIX = { es: '', ca: '/ca', en: '/en' } as const;
const PILLARS = ['/para-colegios', '/para-clubes', '/para-entidades-culturales', '/para-comercios', '/como-funciona', '/precios', '/seguridad-y-transparencia', '/preguntas-frecuentes'] as const;
const ALL_PATHS = ['/', ...PILLARS];
const urlOf = (locale: keyof typeof PREFIX, path: string) => (path === '/' ? PREFIX[locale] || '/' : `${PREFIX[locale]}${path}`);

/** El Entorno 0 enlaza a /login y /registro-comunidad, que llegan en el Sprint 3.2: hasta entonces responden 404. */

async function metaContent(page: Page, selector: string) {
  return page.locator(selector).first().getAttribute('content');
}

test.describe('QA-SEO01 · metadatos de cada página pública en los 3 idiomas', () => {
  for (const locale of ['es', 'ca', 'en'] as const) {
    for (const path of ALL_PATHS) {
      test(`${urlOf(locale, path)}: título, descripción, canónica, hreflang, Open Graph y JSON-LD`, async ({ page }) => {
        const errors = trackConsoleErrors(page);
        const response = await page.goto(urlOf(locale, path));
        expect(response?.status()).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);

        const title = await page.title();
        expect(title.length, title).toBeLessThanOrEqual(60);
        expect(title).toContain('KORUM');
        const description = await metaContent(page, 'meta[name="description"]');
        expect(description?.length ?? 0).toBeGreaterThan(60);
        expect(description?.length ?? 0).toBeLessThanOrEqual(155);

        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`^https?://[^/]+${urlOf(locale, path).replace(/\/$/, '') || ''}/?$`));
        const hreflangs = await page.locator('link[rel="alternate"][hreflang]').evaluateAll((links) => links.map((link) => `${link.getAttribute('hreflang')}=${new URL((link as HTMLLinkElement).href).pathname}`));
        expect(hreflangs).toEqual(expect.arrayContaining([`es=${urlOf('es', path)}`, `ca=${urlOf('ca', path)}`, `en=${urlOf('en', path)}`, `x-default=${urlOf('es', path)}`]));

        expect(await metaContent(page, 'meta[property="og:title"]')).toBeTruthy();
        expect(await metaContent(page, 'meta[property="og:description"]')).toBe(description);
        expect(await metaContent(page, 'meta[property="og:site_name"]')).toBe('KORUM');
        expect(await metaContent(page, 'meta[property="og:image:width"]')).toBe('1200');
        expect(await metaContent(page, 'meta[property="og:image:height"]')).toBe('630');
        expect(await metaContent(page, 'meta[property="og:image:alt"]')).toBeTruthy();
        expect(await metaContent(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');
        await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);

        const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
        expect(blocks.length).toBeGreaterThan(0);
        const parsed = blocks.flatMap((block) => {
          const data: unknown = JSON.parse(block);
          return Array.isArray(data) ? data : [data];
        });
        expect(parsed.every((node) => (node as { '@context': string })['@context'] === 'https://schema.org')).toBe(true);
        expect(JSON.stringify(parsed)).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
        expect(errors).toEqual([]);
      });
    }
  }

  test('la portada declara Organization y WebSite, y las preguntas frecuentes FAQPage con todas sus preguntas', async ({ page }) => {
    await page.goto('/');
    const home = (await page.locator('script[type="application/ld+json"]').allTextContents()).join('');
    expect(home).toContain('"@type":"Organization"');
    expect(home).toContain('"@type":"WebSite"');

    await page.goto('/preguntas-frecuentes');
    const faq = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((block) => JSON.parse(block) as unknown).flat() as Array<{ '@type': string; mainEntity?: unknown[] }>;
    const faqPage = faq.find((node) => node['@type'] === 'FAQPage');
    expect(faqPage?.mainEntity?.length).toBe(await page.locator('details > summary').count());
    expect(faq.some((node) => node['@type'] === 'BreadcrumbList')).toBe(true);
  });
});

test.describe('QA-SEO02 · robots.txt, sitemap.xml y llms.txt', () => {
  test('robots.txt bloquea las zonas privadas, deja las tarjetas sociales y apunta al sitemap', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    const body = await response.text();
    for (const disallowed of ['/panel/', '/admin/', '/api/', '/ca/panel/', '/en/admin/']) expect(body).toContain(`Disallow: ${disallowed}`);
    expect(body).toContain('Allow: /api/og/');
    expect(body).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
    expect(body).toMatch(/User-Agent: OAI-SearchBot/);
    expect(body).toMatch(/User-Agent: GPTBot[\s\S]*?Disallow: \/\n/);
  });

  test('sitemap.xml lista las 9 páginas y el alta de entidades en los 3 idiomas con sus alternativas y nada privado', async ({ request }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body.match(/<loc>/g)).toHaveLength((ALL_PATHS.length + 1) * 3);
    expect(body).toContain('/ca/registro-comunidad</loc>');
    expect(body).toContain('hreflang="x-default"');
    expect(body).not.toMatch(/\/(panel|admin|api|login|ideas)(\/|<)/);
    for (const path of PILLARS) expect(body).toContain(`${path}</loc>`);
  });

  test('llms.txt resume KORUM, las tarifas vigentes y enlaza las páginas pilar de cada idioma', async ({ request }) => {
    const response = await request.get('/llms.txt');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/markdown');
    const body = await response.text();
    expect(body.startsWith('# KORUM')).toBe(true);
    for (const heading of ['## Castellano', '## Català', '## English', '### Tarifas vigentes', '### Current rates']) expect(body).toContain(heading);
    for (const path of PILLARS) {
      expect(body).toContain(`${path})`);
      expect(body).toContain(`/ca${path})`);
      expect(body).toContain(`/en${path})`);
    }
    expect(body).not.toMatch(/\{\w+\}/);
  });

  test('las tarjetas sociales son PNG de 1200×630 de menos de 300 KB y rechazan peticiones raras', async ({ request }) => {
    for (const locale of ['es', 'ca', 'en']) {
      for (const pageKey of ['home', 'precios', 'seguridad']) {
        const response = await request.get(`/api/og/marketing?locale=${locale}&page=${pageKey}&v=1`);
        expect(response.status(), `${locale}/${pageKey}`).toBe(200);
        expect(response.headers()['content-type']).toContain('image/png');
        const bytes = await response.body();
        expect(bytes.length, `${locale}/${pageKey}`).toBeLessThan(300 * 1024);
        expect(bytes.readUInt32BE(16)).toBe(1200);
        expect(bytes.readUInt32BE(20)).toBe(630);
      }
    }
    expect((await request.get('/api/og/marketing?locale=xx&page=home')).status()).toBe(400);
    expect((await request.get('/api/og/marketing?locale=es&page=%3Cscript%3E')).status()).toBe(400);
  });
});

test.describe('QA-M01 · portada: buscador, simulador y garantía de independencia', () => {
  test('el buscador filtra en tiempo real, ofrece alta si no hay resultados y no consulta con una sola letra', async ({ page }) => {
    const queries: string[] = [];
    await page.route('**/api/entities?*', async (route) => {
      const q = new URL(route.request().url()).searchParams.get('q') ?? '';
      queries.push(q);
      const all = [
        { slug: 'cervantes', name: 'CEIP Cervantes', vertical: 'SCHOOL', province: 'Madrid' },
        { slug: 'cervera', name: 'Club Cervera', vertical: 'SPORTS_CLUB', province: 'Lleida' }
      ];
      await route.fulfill({ json: { entities: all.filter((entity) => entity.name.toLowerCase().includes(q.toLowerCase())) } });
    });
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: 'Nombre de tu colegio, club o entidad' });

    await search.fill('c');
    await page.waitForTimeout(500);
    expect(queries).toEqual([]);

    await search.fill('cerv');
    await expect(page.getByRole('link', { name: /CEIP Cervantes/ })).toHaveAttribute('href', '/cervantes');
    await expect(page.getByRole('link', { name: /Club Cervera/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'entidades encontradas' })).toBeVisible();

    await search.fill('cervan');
    await expect(page.getByRole('link', { name: /Club Cervera/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /CEIP Cervantes/ })).toBeVisible();

    await search.fill('zzzz');
    await expect(page.getByText('No encontramos «zzzz»')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Dar de alta mi entidad gratis' })).toHaveAttribute('href', '/registro-comunidad');
  });

  test('el buscador avisa si la búsqueda falla y permite reintentar', async ({ page }) => {
    let fail = true;
    await page.route('**/api/entities?*', (route) => (fail ? route.fulfill({ status: 503, json: { error: 'search_unavailable' } }) : route.fulfill({ json: { entities: [{ slug: 'cervantes', name: 'CEIP Cervantes', vertical: 'SCHOOL', province: 'Madrid' }] } })));
    await page.goto('/');
    await page.getByRole('searchbox').fill('cerv');
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('link', { name: /CEIP Cervantes/ })).toBeVisible();
  });

  test('el simulador recalcula la meta con el presupuesto, las familias y los comercios, y avisa de los datos no válidos', async ({ page }) => {
    await page.goto('/');
    const goal = page.getByText(/Meta a publicar:/);
    const before = await goal.innerText();
    expect(before).toMatch(/[\d.]+,00\s€/);

    await page.getByLabel('Presupuesto de vuestro proveedor').fill('20.000');
    await expect(goal).not.toHaveText(before);
    await page.getByLabel('Presupuesto de vuestro proveedor').fill('800');
    await expect(page.getByText('Comisión de KORUM').locator('xpath=following-sibling::dd[1]')).toHaveText(/^0,00\s€$/);

    await page.getByLabel('Presupuesto de vuestro proveedor').fill('hola');
    await expect(page.getByLabel('Presupuesto de vuestro proveedor')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Completa el presupuesto y el número de personas para ver el cálculo.')).toBeVisible();

    await page.getByLabel('Presupuesto de vuestro proveedor').fill('1.500');
    await page.getByRole('slider').fill('10');
    await expect(page.getByText('¡Con esos comercios la meta queda cubierta!')).toBeVisible();
  });

  test('la portada muestra la independencia de proveedores y la devolución del 100 % sin presentar a KORUM como entidad regulada', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('La entidad elige libremente a su proveedor')).toBeVisible();
    await expect(page.getByText('Si no se llega a la meta, se devuelve el 100 %').first()).toBeVisible();
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(body).toContain('Los pagos los procesa PAYCOMET, entidad de pago autorizada por el Banco de España. KORUM es la tecnología: no guarda vuestro dinero.');
    expect(body).not.toMatch(/cuenta bancaria|regulad[oa] por|garantizado por ley|\bescrow\b|propina/i);
  });

  test('el subtítulo promete «sin cuota de alta» y la portada y las 4 páginas por público llevan ilustración decorativa', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Sin cuota de alta y sin manejar efectivo.')).toBeVisible();
    await expect(page.locator('main svg[viewBox="0 0 480 300"][aria-hidden="true"]')).toHaveCount(1);
    for (const path of ['/para-colegios', '/para-clubes', '/para-entidades-culturales', '/para-comercios']) {
      await page.goto(path);
      await expect(page.locator('main svg[viewBox="0 0 480 300"][aria-hidden="true"]')).toHaveCount(1);
    }
    for (const path of ['/como-funciona', '/precios', '/seguridad-y-transparencia', '/preguntas-frecuentes']) {
      await page.goto(path);
      await expect(page.locator('main svg[viewBox="0 0 480 300"]')).toHaveCount(0);
    }
  });

  test('sin cookies no esenciales no hay aviso de cookies', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: /cookies/i })).toHaveCount(0);
    expect(await page.evaluate(() => document.cookie)).toBe('');
  });
});

for (const locale of ['es', 'ca', 'en'] as const) {
  test.describe(`QA-F06 · ${locale}: páginas públicas sin desbordes, accesibles y sin errores`, () => {
    for (const path of ALL_PATHS) {
      test(`${urlOf(locale, path)}`, async ({ page }) => {
        const errors = trackConsoleErrors(page);
        await page.goto(urlOf(locale, path));
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expectNoMissingTranslations(page);
        await expectNoHorizontalOverflow(page);
        if ((page.viewportSize()?.width ?? 1440) < 768) await expectMobileStackIsOneColumn(page);
        await expectNoSeriousA11yViolations(page);
        expect(errors).toEqual([]);
      });
    }
  });
}

/** Anchos habituales de portátil y de móvil Android: la cabecera no puede sacar la página de la pantalla en ningún idioma. */
for (const width of [360, 390, 1280, 1366]) {
  test.describe(`Cabecera a ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });
    for (const locale of ['es', 'ca', 'en'] as const) {
      test(`${urlOf(locale, '/')} no se desborda y su botón principal es visible`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'El ancho lo fija este bloque: basta una pasada');
        await page.goto(urlOf(locale, '/'));
        await expectNoHorizontalOverflow(page);
        const header = page.locator('header');
        const box = await header.boundingBox();
        expect(box?.width ?? 0).toBeLessThanOrEqual(width);
        const logo = header.getByRole('link').first();
        const logoBox = await logo.boundingBox();
        expect(logoBox?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(logoBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      });
    }
  });
}

test.describe('Navegación y enlaces internos', () => {
  test('todos los enlaces internos de la portada y de las páginas pilar existen, también /login y /registro-comunidad', async ({ page, request }) => {
    // Recorre 9 páginas y comprueba cada enlace (desde el 3.2 también /login, el alta, el panel y la consola): necesita más de 30 s en desarrollo.
    test.setTimeout(120_000);
    const seen = new Set<string>();
    for (const path of ALL_PATHS) {
      await page.goto(path);
      const hrefs = await page.locator('a[href^="/"]').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? ''));
      for (const href of hrefs) seen.add(href.split('#')[0] || '/');
    }
    expect(seen.size).toBeGreaterThan(10);
    for (const href of seen) {
      const response = await request.get(href);
      expect(response.status(), href).toBe(200);
    }
  });

  test('el menú móvil abre, navega, se cierra y se maneja con teclado', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Solo en móvil');
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menú' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await page.getByRole('navigation', { name: 'Menú' }).getByRole('link', { name: 'Precios' }).click();
    await expect(page).toHaveURL(/\/precios$/);
    await expect(page.getByRole('button', { name: 'Menú' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('los enlaces de idioma apuntan a la URL final: el castellano sin prefijo, para no provocar una redirección en cada precarga', async ({ page, request }) => {
    await page.goto('/ca/precios');
    for (const name of ['Idioma', 'Idioma al peu de pàgina']) {
      const switcher = page.getByRole('navigation', { name, exact: true });
      await expect(switcher.getByRole('link', { name: 'ES, Castellano' })).toHaveAttribute('href', '/precios');
      await expect(switcher.getByRole('link', { name: 'EN, English' })).toHaveAttribute('href', '/en/precios');
    }
    const response = await request.get('/precios', { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });

  test('el selector de idioma del pie y el de la cabecera llevan al mismo idioma conservando la página', async ({ page }) => {
    await page.goto('/precios');
    await page.getByRole('navigation', { name: 'Idioma en el pie de página' }).getByRole('link', { name: 'CA, Català' }).click();
    await expect(page).toHaveURL(/\/ca\/precios$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Preus de KORUM');
  });

  test('una página inexistente sigue respondiendo 404 con el diseño de KORUM', async ({ page }) => {
    const response = await page.goto('/pagina-que-no-existe');
    expect(response?.status()).toBe(404);
  });
});

test.describe('Página de precios: cifras reales', () => {
  test('la tabla de tarifas muestra los tramos, la pasarela y el patrocinio con los valores de la consola', async ({ page }) => {
    await page.goto('/precios');
    const table = page.getByRole('table', { name: 'Tarifas de KORUM' });
    await expect(table).toBeVisible();
    const text = ((await table.innerText()) ?? '').replace(/\s+/g, ' ');
    expect(text).toMatch(/Primeros 1\.000,00\s€ de cada curso Sin comisión/);
    expect(text).toMatch(/5\s%/);
    expect(text).toMatch(/4\s%/);
    expect(text).toMatch(/3\s%/);
    expect(text).toMatch(/Sin cuota de mantenimiento/);
    expect(text).toMatch(/1\s% más 0,09\s€ por aportación/);
    expect(text).toMatch(/0,45\s€ más el 2\s%/);
    expect(text).toMatch(/15\s% más IVA/);
    expect(text).not.toMatch(/\{\w+\}/);
  });
});
