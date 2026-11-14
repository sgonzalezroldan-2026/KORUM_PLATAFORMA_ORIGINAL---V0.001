import { expect, test, type Page } from '@playwright/test';
import { signPass, signPassView } from '../../src/core/ticketing/qr-signature';
import { withE2eDb } from './auth-support';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F01 · QA-F02 · QA-F03 · QA-F06 · QA-SEO03 · Entorno 1: portada de la entidad, ficha de iniciativa, tarjeta para WhatsApp, compartir,
 * pase del invitado, metadatos y sitemap. Datos de la semilla: CEIP Cervantes (`cervantes`) tiene 2 iniciativas `FUNDRAISING` (1 campaña y
 * 2 taquilla), 1 `GOAL_REACHED` (3) y 1 `CLOSED` (4); la 5 es de otra entidad.
 */

const PREFIX = { es: '', ca: '/ca', en: '/en' } as const;
type L = keyof typeof PREFIX;

const portal = (locale: L = 'es') => `${PREFIX[locale]}/cervantes`;
const initiative = (id: number, locale: L = 'es') => `${PREFIX[locale]}/cervantes/iniciativas/${id}`;

/** Contenido de una etiqueta `<meta>` o `null` si no existe (sin esperar a que aparezca). */
async function meta(page: Page, selector: string) {
  const tag = page.locator(selector).first();
  return (await tag.count()) === 0 ? null : tag.getAttribute('content');
}

async function jsonLd(page: Page): Promise<Array<Record<string, unknown>>> {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.flatMap((block) => {
    const parsed = JSON.parse(block) as Record<string, unknown> | Array<Record<string, unknown>>;
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

/** Ancho y alto de un PNG leídos de su cabecera IHDR. */
function pngSize(bytes: Buffer) {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test.describe('QA-F01 · portada de la entidad', () => {
  test('cabecera con el nombre como único h1, barra de impacto y solo las iniciativas en recaudación', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const response = await page.goto(portal());
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('CEIP Cervantes');
    await expect(page.locator('#school-hero-header')).toBeVisible();
    await expect(page.locator('#school-hero-header')).toContainText('El dinero queda retenido en Paycomet hasta lograr la meta');
    await expect(page.locator('#school-hero-header')).toContainText('Devolución del 100 % si una iniciativa no logra su meta');
    await expect(page.locator('#school-hero-header')).toContainText(/mejoras? lograda/);

    // Solo FUNDRAISING: la 3 (conseguida) y la 4 (cerrada) no están; la 5 es de otra entidad.
    const cards = page.getByTestId('initiative-card');
    await expect(cards).toHaveCount(2);
    await expect(page.locator('[data-initiative-id="1"]')).toBeVisible();
    await expect(page.locator('[data-initiative-id="2"]')).toBeVisible();
    await expect(page.locator('[data-initiative-id="3"], [data-initiative-id="4"], [data-initiative-id="5"]')).toHaveCount(0);

    // «💛 X aportaciones» bajo la barra de progreso, con la barra accesible.
    await expect(page.locator('[data-initiative-id="1"]')).toContainText(/\d+ aportaciones/);
    await expect(page.locator('[data-initiative-id="1"]').getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^\d+$/);
    await expect(page.locator('[data-initiative-id="2"]')).toContainText('disponibles');

    // Mi Hucha según el modo por defecto (aportación mensual) y sin saldo guardado.
    const hucha = page.getByRole('link', { name: /Mi Hucha/ });
    await expect(hucha).toBeVisible();
    await expect(hucha).toContainText('Aportación mensual');
    // Abre Mi Hucha con el alta de la aportación mensual a esta entidad (Sprint 3.8).
    await expect(hucha).toHaveAttribute('href', '/mi-hucha?entidad=cervantes');

    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('los filtros están ocultos al cargar, se despliegan con Filtrar, cuentan los activos y se limpian', async ({ page }) => {
    await page.goto(portal());
    const bar = page.getByTestId('family-filters-bar');
    const toggle = page.getByRole('button', { name: /Filtrar/ });
    await expect(bar).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(bar).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await page.getByLabel('Fecha y avance').selectOption('TICKETING');
    await expect(page.getByTestId('initiative-card')).toHaveCount(1);
    await expect(page.locator('[data-initiative-id="2"]')).toBeVisible();
    await expect(toggle).toContainText('1');
    await expect(page.getByRole('status')).toContainText('1 iniciativa');

    await page.getByLabel('Etapa').selectOption('Primaria');
    await expect(page.getByTestId('initiative-card')).toHaveCount(0);
    await expect(page.getByText('No hay iniciativas con estos filtros')).toBeVisible();
    await expect(toggle).toContainText('2');

    await page.getByRole('button', { name: 'Ver todas las iniciativas abiertas' }).click();
    await expect(page.getByTestId('initiative-card')).toHaveCount(2);
    await expect(toggle).not.toContainText(/\d/);

    // Cerrar el panel no pierde los filtros ya aplicados ni rompe el estado.
    await toggle.click();
    await expect(bar).toBeHidden();
  });

  test('en móvil todo va en una sola columna y no se sale de 430 px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Comprobación específica del viewport móvil.');
    await page.goto(portal());
    await expect(page.getByTestId('initiative-card').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectMobileStackIsOneColumn(page);
    const columns = await page.locator('#family-campaigns-grid').evaluate((grid) => new Set([...grid.children].map((child) => Math.round(child.getBoundingClientRect().left))).size);
    expect(columns).toBe(1);
  });

  for (const locale of ['ca', 'en'] as const) {
    test(`${portal(locale)}: sin claves sin traducir, con idioma en la URL y accesible`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      expect((await page.goto(portal(locale)))?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('CEIP Cervantes');
      // El texto de la entidad está en su idioma de contenidos: si no es el de la página, se marca para lectores de pantalla y traductores.
      const contentLocale = await withE2eDb(async (client) => (await client.query<{ contentLocale: string }>(`SELECT "contentLocale"::text FROM "Organization" WHERE slug = 'cervantes'`)).rows[0]?.contentLocale);
      const heading = page.getByRole('heading', { level: 1 });
      if (contentLocale === locale) await expect(heading).not.toHaveAttribute('lang', /.+/);
      else await expect(heading).toHaveAttribute('lang', contentLocale ?? '');
      await expect(page.getByTestId('initiative-card')).toHaveCount(2);
      await expectNoMissingTranslations(page);
      await expectNoHorizontalOverflow(page);
      await expectNoSeriousA11yViolations(page);
      expect(errors).toEqual([]);
    });
  }

  test('una URL que no es de ninguna entidad responde 404 de verdad, también en catalán e inglés', async ({ request }) => {
    for (const path of ['/no-existe-esta-entidad', '/ca/no-existe-esta-entidad', '/en/no-existe-esta-entidad', '/cervantes/iniciativas/999999', '/cervantes/iniciativas/abc']) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });
});

test.describe('QA-F03 · ficha de la iniciativa', () => {
  test('hucha de la iniciativa y fecha límite, sin barra de 6 estados; las 4 líneas suman exactamente la meta', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    expect((await page.goto(initiative(1)))?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Climatización Sostenible/);
    await expect(page.getByTestId('wallet-escrow-id')).toHaveText(/^WLT-ESC-/);
    await expect(page.getByText('Fecha límite')).toBeVisible();
    // La barra de 6 estados es del panel de la entidad, no de la ficha pública.
    for (const step of ['Presupuestación', 'Firma', 'Liquidación']) await expect(page.locator('#fview-detail')).not.toContainText(step);

    const breakdown = page.getByTestId('public-breakdown');
    await expect(breakdown).toBeVisible();
    const cents = await breakdown.locator('dd [data-cents]').evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-cents'))));
    expect(cents).toHaveLength(5);
    const [provider, install, contingency, gateway, total] = cents as [number, number, number, number, number];
    expect(provider + install + contingency + gateway).toBe(total);
    expect(gateway).toBeGreaterThanOrEqual(0);
    // La meta que anuncia la ficha es la misma que el total del desglose.
    await expect(page.locator('#fview-detail')).toContainText('Meta:');
    const goalCents = Number((await page.getByTestId('public-breakdown').locator('dd [data-cents]').last().getAttribute('data-cents')) ?? 0);
    expect(goalCents).toBe(total);

    // Pie oficial de transparencia, tal cual (Regla 03 §3).
    await expect(breakdown).toContainText('Transparencia total: el importe total ya incluye el coste de la pasarela de pago, el servicio de la plataforma, la gestión y la devolución del 100% si la iniciativa no se consigue, para que al centro le quede exactamente lo necesario para pagar los costes reales.');
    for (const line of ['Presupuesto de proveedor y equipamiento', 'Instalación y adecuación técnica', 'Reserva de mantenimiento, riesgos y contingencia', 'Pasarela de pago, plataforma, gestión y garantía de devolución']) {
      await expect(breakdown).toContainText(line);
    }
    // Sin vocabulario que Regla 03 §4 prohíbe en público.
    await expect(page.locator('#fview-detail')).not.toContainText(/escrow|banco|propina/i);

    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('placa y reto por curso son independientes y el reto se cuenta solo en positivo', async ({ page }) => {
    await page.goto(initiative(1));
    await expect(page.getByText('Incluye placa conmemorativa de agradecimiento')).toBeVisible();
    const challenge = page.getByTestId('course-challenge');
    await expect(challenge).toBeVisible();
    await expect(challenge).toContainText(/Reto colectivo: desbloqueamos «/);
    await expect(challenge.locator('[data-group="3-primaria"]')).toContainText('3º de Primaria ya suma 33 familias · reto: 35');
    await expect(challenge.locator('[data-group="3-primaria"]')).toContainText('Solo faltan 2 familias');
    // Nada de señalar a nadie ni de comparar: sin «faltan las aportaciones de», sin importes por curso, sin clasificaciones.
    await expect(challenge).not.toContainText(/ranking|último|peor|menos familias|€/i);
    // El orden es el de los cursos de la entidad, no el del avance: 1º va antes que 3º aunque tenga menos familias.
    const order = await challenge.locator('li').evaluateAll((items) => items.map((item) => item.getAttribute('data-group')));
    expect(order.indexOf('infantil-5-anos-i5')).toBeLessThan(order.indexOf('1-primaria'));
    expect(order.indexOf('1-primaria')).toBeLessThan(order.indexOf('3-primaria'));
    expect(order.indexOf('3-primaria')).toBeLessThan(order.indexOf('4-primaria'));
  });

  test('en móvil la ficha se apila en una sola columna', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Comprobación específica del viewport móvil.');
    await page.goto(initiative(1));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectMobileStackIsOneColumn(page);
  });

  test('taquilla: aforo, gastos de gestión digital y datos estructurados de evento', async ({ page }) => {
    await page.goto(initiative(2));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Gran Fiesta de Primavera/);
    await expect(page.getByText('Información de taquilla digital')).toBeVisible();
    await expect(page.getByText('Gastos de gestión digital')).toBeVisible();
    await expect(page.getByTestId('public-breakdown')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Comprar entradas/ })).toBeVisible();

    const events = (await jsonLd(page)).filter((node) => node['@type'] === 'Event');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: expect.stringContaining('Gran Fiesta'), eventStatus: 'https://schema.org/EventScheduled', offers: { '@type': 'Offer', priceCurrency: 'EUR', price: '5.55' } });
  });

  test('una iniciativa conseguida o cerrada se puede ver, pero ya no admite aportaciones', async ({ page }) => {
    for (const id of [3, 4]) {
      expect((await page.goto(initiative(id)))?.status(), `iniciativa ${id}`).toBe(200);
      await expect(page.getByRole('link', { name: /Aportar|Comprar/ })).toHaveCount(0);
    }
    await page.goto(initiative(3));
    await expect(page.locator('#fview-detail')).toContainText('100 % conseguido');
  });

  test('el aislamiento entre entidades: la iniciativa 5 es de San José y no se abre desde Cervantes', async ({ request }) => {
    expect((await request.get('/cervantes/iniciativas/5')).status()).toBe(404);
    expect((await request.get('/san-jose/iniciativas/5')).status()).toBe(200);
  });
});

test.describe('Compartir', () => {
  test('el diálogo ofrece WhatsApp, email y copiar; el grupo cambia el enlace pero no el mensaje; Escape cierra y devuelve el foco', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await page.goto(initiative(1));
    const trigger = page.getByRole('button', { name: 'Compartir', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: /Compartir en KORUM/ });
    await expect(dialog).toBeVisible();

    const whatsapp = dialog.getByRole('link', { name: /WhatsApp/ });
    await expect(whatsapp).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent((await whatsapp.getAttribute('href')) ?? '')).toContain('/cervantes/iniciativas/1');
    await expect(dialog.getByRole('link', { name: /Email/ })).toHaveAttribute('href', /^mailto:\?subject=/);

    await dialog.getByLabel('Compartir con tu grupo').selectOption('3-primaria');
    await expect(dialog.getByText(/iniciativas\/1\?grupo=3-primaria/)).toBeVisible();
    expect(decodeURIComponent((await whatsapp.getAttribute('href')) ?? '')).toContain('?grupo=3-primaria');

    if (testInfo.project.name === 'desktop') {
      await dialog.getByRole('button', { name: 'Copiar enlace' }).click();
      await expect(page.getByText('Enlace copiado')).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('desde el listado, cada tarjeta comparte su propia iniciativa', async ({ page }) => {
    await page.goto(portal());
    await page.locator('[data-initiative-id="2"]').getByRole('button', { name: /Compartir/ }).click();
    const dialog = page.getByRole('dialog', { name: /Compartir en KORUM/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Gran Fiesta de Primavera/).first()).toBeVisible();
    await expect(dialog.getByText(/iniciativas\/2/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('QA-F02 · tarjeta para WhatsApp', () => {
  test('PNG de 1200×630 de menos de 300 KB con el avance real, también por curso', async ({ request }) => {
    const plain = await request.get('/api/og/initiative/1?locale=es&v=1');
    expect(plain.status()).toBe(200);
    expect(plain.headers()['content-type']).toContain('image/png');
    const bytes = await plain.body();
    expect(bytes.length).toBeLessThan(300 * 1024);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });

    const group = await request.get('/api/og/initiative/1?locale=es&grupo=3-primaria&v=1');
    expect(group.status()).toBe(200);
    const groupBytes = await group.body();
    expect(groupBytes.length).toBeLessThan(300 * 1024);
    expect(pngSize(groupBytes)).toEqual({ width: 1200, height: 630 });
    // El reto del curso se dibuja: la imagen es distinta de la general.
    expect(groupBytes.equals(bytes)).toBe(false);
    // Un grupo que no existe da la imagen general, sin dibujar el texto de la URL.
    const unknown = await request.get('/api/og/initiative/1?locale=es&grupo=%3Cscript%3E&v=1');
    expect(unknown.status()).toBe(200);
    expect((await unknown.body()).equals(bytes)).toBe(true);
  });

  test('en los tres idiomas y para una iniciativa conseguida o de taquilla', async ({ request }) => {
    for (const [id, locale] of [[1, 'ca'], [1, 'en'], [2, 'es'], [3, 'es']] as const) {
      const response = await request.get(`/api/og/initiative/${id}?locale=${locale}`);
      expect(response.status(), `${id}/${locale}`).toBe(200);
      const bytes = await response.body();
      expect(bytes.length).toBeLessThan(300 * 1024);
      expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    }
  });

  test('rechaza lo que no es una iniciativa pública y no dibuja idiomas inventados', async ({ request }) => {
    for (const path of ['/api/og/initiative/999999', '/api/og/initiative/abc', '/api/og/initiative/0', '/api/og/initiative/-1']) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
    expect((await request.get('/api/og/initiative/1?locale=zz')).status()).toBe(200);
  });

  test('la ficha anuncia su tarjeta versionada y la del curso solo cambia la imagen, no la canónica', async ({ page }) => {
    await page.goto(initiative(1));
    const image = await meta(page, 'meta[property="og:image"]');
    expect(image).toMatch(/\/api\/og\/initiative\/1\?locale=es&v=\d+$/);
    expect(await meta(page, 'meta[property="og:image:width"]')).toBe('1200');
    expect(await meta(page, 'meta[property="og:image:height"]')).toBe('630');
    expect(await meta(page, 'meta[property="og:image:alt"]')).toMatch(/% conseguido/);
    expect(await meta(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');

    await page.goto(`${initiative(1)}?grupo=3-primaria`);
    expect(await meta(page, 'meta[property="og:image"]')).toMatch(/\/api\/og\/initiative\/1\?locale=es&v=\d+&grupo=3-primaria$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/cervantes\/iniciativas\/1$/);
    await page.goto(`${initiative(1)}?grupo=%3Cscript%3E`);
    expect(await meta(page, 'meta[property="og:image"]')).not.toContain('grupo=');
  });
});

test.describe('QA-SEO03 · metadatos, datos estructurados e indexación', () => {
  test('la portada y la ficha cumplen la skill de SEO en los tres idiomas', async ({ page }) => {
    for (const locale of ['es', 'ca', 'en'] as const) {
      for (const path of [portal(locale), initiative(1, locale)]) {
        await page.goto(path);
        const title = await page.title();
        expect(title.length, title).toBeLessThanOrEqual(60);
        expect(title).toContain('KORUM');
        const description = await meta(page, 'meta[name="description"]');
        expect(description?.length ?? 0, `${path}: ${description}`).toBeGreaterThan(40);
        expect(description?.length ?? 0).toBeLessThanOrEqual(155);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        const base = path.replace(/^\/(ca|en)/, '');
        const alternates = await page.locator('link[rel="alternate"][hreflang]').evaluateAll((links) => links.map((link) => `${link.getAttribute('hreflang')}=${new URL((link as HTMLLinkElement).href).pathname}`));
        expect(alternates).toEqual(expect.arrayContaining([`es=${base}`, `ca=/ca${base}`, `en=/en${base}`, `x-default=${base}`]));
        expect(await meta(page, 'meta[name="robots"]')).toBeNull();
        expect(await meta(page, 'meta[property="og:site_name"]')).toBe('KORUM');
      }
    }
  });

  test('JSON-LD: entidad educativa con su localidad, migas de pan y nada de personas ni correos', async ({ page }) => {
    await page.goto(portal());
    const nodes = await jsonLd(page);
    const types = nodes.map((node) => node['@type']);
    expect(types).toEqual(expect.arrayContaining(['EducationalOrganization', 'BreadcrumbList']));
    const entity = nodes.find((node) => node['@type'] === 'EducationalOrganization') as Record<string, unknown>;
    expect(entity).toMatchObject({ name: 'CEIP Cervantes', address: { '@type': 'PostalAddress', addressCountry: 'ES' } });
    const serialized = JSON.stringify(nodes);
    expect(serialized).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}|iban|donor|email|telephone/i);
  });

  test('el club deportivo se describe como organización deportiva', async ({ page }) => {
    await page.goto('/basket-valles');
    const nodes = await jsonLd(page);
    expect(nodes.map((node) => node['@type'])).toContain('SportsOrganization');
  });

  test('el sitemap lista las portadas y las iniciativas públicas con alternativas, y nada de ideas, aportar, cuenta ni entradas', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    for (const prefix of ['', '/ca', '/en']) {
      expect(body).toContain(`${prefix}/cervantes</loc>`);
      for (const id of [1, 2, 3, 4]) expect(body).toContain(`${prefix}/cervantes/iniciativas/${id}</loc>`);
    }
    expect(body).toContain('hreflang="ca"');
    expect(body).not.toMatch(/\/(ideas|aportar|mi-cuenta|mi-hucha|entrada)(\/|<)/);
  });

  test('si la entidad desactiva publicIndexing, sus páginas pasan a noindex y salen del sitemap', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Modifica una entidad de la semilla: solo un proyecto a la vez.');
    const slug = 'ies-mediterraneo';
    const toggle = (value: boolean) => withE2eDb((client) => client.query('UPDATE "Organization" SET "publicIndexing" = $1 WHERE slug = $2', [value, slug]));
    try {
      expect(await (await request.get('/sitemap.xml')).text()).toContain(`/${slug}</loc>`);
      await toggle(false);
      // La portada se regenera cada minuto: la ficha es dinámica y lo refleja al momento; el sitemap, siempre.
      expect(await (await request.get('/sitemap.xml')).text()).not.toContain(`/${slug}`);
      await page.goto(`/${slug}/iniciativas/8`);
      expect(await meta(page, 'meta[name="robots"]')).toContain('noindex');
    } finally {
      await toggle(true);
    }
    expect(await (await request.get('/sitemap.xml')).text()).toContain(`/${slug}</loc>`);
  });
});

test.describe('Pase del invitado: /[orgSlug]/entrada/[passUuid]?sig=…', () => {
  async function aPass() {
    return withE2eDb(async (client) => {
      const result = await client.query<{ uuid: string; serialCode: string }>(
        `SELECT p.uuid, p."serialCode" FROM "TicketPass" p JOIN "Initiative" i ON i.id = p."initiativeId" JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = 'cervantes' AND p."revokedAt" IS NULL LIMIT 1`
      );
      return result.rows[0];
    });
  }
  const secret = E2E_SERVER_ENV.QR_HMAC_SECRET ?? '';

  test('con la firma de visualización muestra el QR de la puerta y el código; no es indexable', async ({ page }) => {
    const pass = await aPass();
    test.skip(!pass, 'La semilla no tiene ningún pase.');
    const errors = trackConsoleErrors(page);
    expect((await page.goto(`/cervantes/entrada/${pass!.uuid}?sig=${signPassView(secret, pass!.uuid)}`))?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Tu entrada/);
    await expect(page.getByRole('img', { name: 'Código QR para entrar' }).locator('svg')).toBeVisible();
    await expect(page.getByText(pass!.serialCode)).toBeVisible();
    expect(await meta(page, 'meta[name="robots"]')).toContain('noindex');
    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('sin firma, con la firma de la puerta, con otra entidad o con un código inventado no se enseña nada', async ({ page }) => {
    const pass = await aPass();
    test.skip(!pass, 'La semilla no tiene ningún pase.');
    const attempts = [
      `/cervantes/entrada/${pass!.uuid}`,
      // La firma del QR de la puerta no vale para ver el pase (otro dominio de firma).
      `/cervantes/entrada/${pass!.uuid}?sig=${signPass(secret, pass!.uuid)}`,
      `/cervantes/entrada/${pass!.uuid}?sig=invalida`,
      `/san-jose/entrada/${pass!.uuid}?sig=${signPassView(secret, pass!.uuid)}`,
      `/cervantes/entrada/00000000-0000-4000-8000-000000000000?sig=${signPassView(secret, '00000000-0000-4000-8000-000000000000')}`,
      '/cervantes/entrada/no-es-un-uuid?sig=x'
    ];
    for (const attempt of attempts) {
      await page.goto(attempt);
      await expect(page.getByRole('heading', { level: 1 }), attempt).toHaveText('No podemos abrir esta entrada');
      await expect(page.getByRole('img', { name: 'Código QR para entrar' })).toHaveCount(0);
      await expect(page.getByText(pass!.serialCode)).toHaveCount(0);
    }
  });
});

test('la barra de demostración lleva a la portada de la entidad de demostración', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Familias' }).first().click();
  await expect(page).toHaveURL(/\/cervantes$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('CEIP Cervantes');
});
