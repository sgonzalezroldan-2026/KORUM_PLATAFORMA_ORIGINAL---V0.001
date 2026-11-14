import { randomUUID } from 'node:crypto';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { signCheckoutResult } from '../../src/core/checkout/checkout-rules';
import { withE2eDb } from './auth-support';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * Sprint 5.5 · pulido de lo público: QA-SEO01 en las subpáginas del portal con su tarjeta propia, la tarjeta social de la entidad, la vuelta del pago
 * con la campaña ya cerrada (heredado del 4.2f), QA-X02 (axe, teclado y traducciones en todas las rutas públicas en los 3 idiomas) y QA-X01 (presupuesto
 * de rendimiento en móvil medio con 4G, solo contra la compilación de producción). Las páginas de marketing y la portada y la ficha ya las recorren
 * `marketing-seo.spec.ts` y `family-catalog-detail.spec.ts`: aquí va lo que faltaba.
 */

const PREFIX = { es: '', ca: '/ca', en: '/en' } as const;
type L = keyof typeof PREFIX;
const LOCALES = ['es', 'ca', 'en'] as const;

async function meta(page: Page, selector: string) {
  const tag = page.locator(selector).first();
  return (await tag.count()) === 0 ? null : tag.getAttribute('content');
}

function pngSize(bytes: Buffer) {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Subpáginas del portal de Cervantes (la portada y la ficha ya tienen su prueba de metadatos). Las ideas nunca se indexan. */
const PORTAL_SUBPAGES = [
  { path: '/cervantes/logros', indexable: true },
  { path: '/cervantes/comercios', indexable: true },
  { path: '/cervantes/ayuda', indexable: true },
  { path: '/cervantes/ideas', indexable: false }
] as const;

test.describe('QA-SEO01 · subpáginas del portal en los 3 idiomas, con la tarjeta propia de la entidad', () => {
  for (const { path, indexable } of PORTAL_SUBPAGES) {
    test(`${path}: título, descripción, canónica, hreflang, Open Graph e indexación`, async ({ page }) => {
      for (const locale of LOCALES) {
        const url = `${PREFIX[locale]}${path}`;
        await page.goto(url);
        const title = await page.title();
        expect(title.length, `${url}: ${title}`).toBeLessThanOrEqual(60);
        expect(title).toContain('KORUM');
        const description = (await meta(page, 'meta[name="description"]')) ?? '';
        expect(description.length, `${url}: ${description}`).toBeGreaterThan(40);
        expect(description.length).toBeLessThanOrEqual(155);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
        // Absoluta; el origen es el de la compilación (en CI se compila sin NEXT_PUBLIC_APP_URL), así que se compara la ruta.
        expect(canonical ?? '').toMatch(/^https?:\/\//);
        expect(new URL(canonical ?? '').pathname).toBe(url);
        const alternates = await page.locator('link[rel="alternate"][hreflang]').evaluateAll((links) => links.map((link) => `${link.getAttribute('hreflang')}=${new URL((link as HTMLLinkElement).href).pathname}`));
        expect(alternates).toEqual(expect.arrayContaining([`es=${path}`, `ca=/ca${path}`, `en=/en${path}`, `x-default=${path}`]));
        // La tarjeta es la de la entidad (no la de marketing de KORUM), en el idioma de la página y versionada.
        const image = (await meta(page, 'meta[property="og:image"]')) ?? '';
        expect(image).toMatch(new RegExp(`/api/og/entity/cervantes\\?locale=${locale}&v=[0-9a-f]{12}$`));
        expect(await meta(page, 'meta[property="og:image:alt"]')).toContain('CEIP Cervantes');
        expect(await meta(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');
        const robots = await meta(page, 'meta[name="robots"]');
        if (indexable) expect(robots, url).toBeNull();
        else expect(robots, url).toContain('noindex');
      }
    });
  }

  test('la portada de la entidad también anuncia su tarjeta propia', async ({ page }) => {
    await page.goto('/cervantes');
    expect(await meta(page, 'meta[property="og:image"]')).toMatch(/\/api\/og\/entity\/cervantes\?locale=es&v=[0-9a-f]{12}$/);
    expect(await meta(page, 'meta[property="og:image:width"]')).toBe('1200');
    expect(await meta(page, 'meta[property="og:image:height"]')).toBe('630');
  });
});

test.describe('Tarjeta social de la entidad (heredado del 3.3)', () => {
  test('PNG de 1200×630 de menos de 300 KB en los tres idiomas y para cada vertical, con caché larga', async ({ request }) => {
    for (const slug of ['cervantes', 'basket-valles']) {
      for (const locale of LOCALES) {
        const response = await request.get(`/api/og/entity/${slug}?locale=${locale}&v=0123456789ab`);
        expect(response.status(), `${slug} ${locale}`).toBe(200);
        expect(response.headers()['content-type']).toContain('image/png');
        expect(response.headers()['cache-control']).toContain('s-maxage=86400');
        const body = await response.body();
        expect(body.byteLength).toBeLessThan(300 * 1024);
        expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
      }
    }
  });

  test('responde 404 a una entidad inexistente, a un identificador raro y a un idioma o una versión inventados', async ({ request }) => {
    for (const slug of ['no-existe-esta-entidad', 'CERVANTES', '..%2Fadmin', 'a'.repeat(70), '-cervantes']) {
      expect((await request.get(`/api/og/entity/${slug}?locale=es&v=0123456789ab`)).status(), slug).toBe(404);
    }
    // Cada variante inventada de la URL sería una imagen nueva en la caché del borde (auditoría de seguridad del 5.5a): no se dibuja.
    for (const query of ['locale=xx&v=0123456789ab', 'v=0123456789ab', 'locale=es', 'locale=es&v=1', 'locale=es&v=1730000000000', 'locale=es&v=0123456789AB']) {
      expect((await request.get(`/api/og/entity/cervantes?${query}`)).status(), query).toBe(404);
    }
  });
});

/**
 * Entidad y campaña propias de la prueba, ya cerradas: copiarlas de Cervantes en otra entidad deja intactos sus listados, su panel y su consola, que
 * leen otras pruebas. La entidad no se indexa, no tiene NIF ni cuenta de reparto y su hucha es única.
 */
async function closedCampaign(status: 'REFUNDING' | 'EXPIRED' | 'CLOSED'): Promise<{ slug: string; initiativeId: number; entity: string }> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `e2e-cierre-${suffix}`;
  const id = `E2E-CIERRE-${suffix.toUpperCase()}`;
  const entity = `Escuela Cierre ${suffix}`;
  return withE2eDb(async (db) => {
    const orgColumns = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Organization' AND column_name NOT IN ('id', 'slug', 'name', 'cif', 'walletId', 'paycometSplitId', 'publicIndexing')`
      )
    ).rows.map((row) => `"${row.column_name}"`);
    await db.query(
      `INSERT INTO "Organization" ("id", "slug", "name", "walletId", "publicIndexing", ${orgColumns.join(', ')}) SELECT $1, $2, $3, $4, false, ${orgColumns.join(', ')} FROM "Organization" WHERE "slug" = 'cervantes'`,
      [id, slug, entity, `WLT-E2E-${suffix}`]
    );
    const columns = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Initiative' AND column_name NOT IN ('id', 'walletEscrowId', 'gateCode', 'paycometEscrowOrderId', 'organizationId', 'status')`
      )
    ).rows.map((row) => `"${row.column_name}"`);
    const created = await db.query<{ id: number }>(
      `INSERT INTO "Initiative" ("walletEscrowId", "organizationId", "status", ${columns.join(', ')}) SELECT $1, $2, $3, ${columns.join(', ')} FROM "Initiative" WHERE "id" = 1 RETURNING "id"`,
      [`WLT-ESC-${suffix.toUpperCase()}`, id, status]
    );
    return { slug, initiativeId: created.rows[0]!.id, entity };
  });
}

/** Pedido de una familia invitada en esa campaña, con el estado indicado, y la URL firmada de su vuelta del pago (la que recibe al volver de Paycomet). */
async function resultUrl(campaign: { slug: string; initiativeId: number }, status: 'COMPLETED' | 'FAILED' | 'REFUND_PENDING', locale: L = 'es'): Promise<string> {
  // Mismo formato que un pedido real de donación (`KD` + 16 cifras hexadecimales): la página rechaza cualquier otro antes de mirar la firma.
  const order = `KD${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
  await withE2eDb((db) =>
    db.query(
      `INSERT INTO "Contribution" ("organizationId", "initiativeId", "guestEmail", "canonicalEmail", "fiscalYear", type, "amountCents", "totalChargedCents", "paymentMethod", status, "paycometOrder")
       SELECT "organizationId", id, 'cierre@familias.example', 'cierre@familias.example', 2026, 'DONATION', 2500, 2500, 'BIZUM', $2, $3 FROM "Initiative" WHERE id = $1`,
      [campaign.initiativeId, status, order]
    )
  );
  const signature = signCheckoutResult(E2E_SERVER_ENV.DATA_HMAC_SECRET ?? '', order);
  return `${PREFIX[locale]}/${campaign.slug}/iniciativas/${campaign.initiativeId}/aportar/resultado?pedido=${order}&sig=${signature}`;
}

test.describe('Vuelta del pago con la campaña ya cerrada (heredado del 4.2f)', () => {
  test('en una campaña que no llegó a la meta, la vuelta del pago dice que se devuelve el 100 % y lleva a la portada, no a un 404', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const campaign = await closedCampaign('REFUNDING');
    // La ficha ya no es pública…
    expect((await page.goto(`/${campaign.slug}/iniciativas/${campaign.initiativeId}`))?.status()).toBe(404);
    // Ese 404 lo provoca la prueba a propósito: los errores que cuentan son los de la vuelta del pago.
    errors.length = 0;
    // …pero su vuelta del pago sí se abre, con su texto y sin enlazar a la ficha.
    const response = await page.goto(await resultUrl(campaign, 'REFUND_PENDING'));
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Esta vez no ha sido posible' })).toBeVisible();
    await expect(page.getByTestId('result-notice')).toHaveAttribute('data-notice', 'failedCampaign');
    const toPortal = page.getByTestId('result-to-portal');
    await expect(toPortal).toHaveText(`Ir a la portada de ${campaign.entity}`);
    await expect(toPortal).toHaveAttribute('href', `/${campaign.slug}`);
    await expect(page.getByRole('link', { name: 'Volver a la iniciativa' })).toHaveCount(0);
    expect(await meta(page, 'meta[name="robots"]')).toContain('noindex');
    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('un pago rechazado con la campaña cerrada no ofrece «Probar otra vez» (el checkout ya no existe)', async ({ page }) => {
    const campaign = await closedCampaign('REFUNDING');
    for (const locale of LOCALES) {
      expect((await page.goto(await resultUrl(campaign, 'FAILED', locale)))?.status()).toBe(200);
      await expect(page.getByTestId('result-closed')).toBeVisible();
      await expect(page.locator('a[href*="/aportar?"]')).toHaveCount(0);
      await expectNoMissingTranslations(page);
    }
    await expect(page.getByTestId('result-closed')).toHaveText(/no longer accepting contributions/);
  });

  test('un pago confirmado en una campaña que se está devolviendo no dice «ya suma»: se le devolverá el 100 % (auditorías del 5.5a)', async ({ page }) => {
    const campaign = await closedCampaign('REFUNDING');
    expect((await page.goto(await resultUrl(campaign, 'COMPLETED')))?.status()).toBe(200);
    await expect(page.getByTestId('result-notice')).toHaveAttribute('data-notice', 'failedCampaign');
    await expect(page.getByTestId('checkout-celebration')).toHaveCount(0);
    await expect(page.getByText(/ya suma/)).toHaveCount(0);
  });

  test('un pago confirmado justo antes de que la campaña venciera explica que se decide (votar o devolver) y no invita a compartir', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const campaign = await closedCampaign('EXPIRED');
    for (const locale of LOCALES) {
      expect((await page.goto(await resultUrl(campaign, 'COMPLETED', locale)))?.status()).toBe(200);
      await expect(page.getByTestId('result-notice')).toHaveAttribute('data-notice', 'deciding');
      await expect(page.getByTestId('checkout-celebration')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Compartir|Compartir|Share/ })).toHaveCount(0);
      await expect(page.getByTestId('result-to-portal')).toBeVisible();
      await expectNoMissingTranslations(page);
    }
    await expect(page.getByRole('heading', { level: 1, name: 'The initiative ended without reaching its goal' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('un pago que llega con la campaña ya cerrada se devuelve «por llegar tarde», y la ficha cerrada sigue enlazada', async ({ page }) => {
    const campaign = await closedCampaign('CLOSED');
    expect((await page.goto(await resultUrl(campaign, 'REFUND_PENDING')))?.status()).toBe(200);
    await expect(page.getByTestId('result-notice')).toHaveAttribute('data-notice', 'returnedLate');
    await expect(page.getByRole('heading', { level: 1, name: 'Te devolvemos el 100 %' })).toBeVisible();
    await expect(page.getByText(/El pago llegó cuando la iniciativa ya no admitía más aportaciones/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver a la iniciativa' })).toHaveAttribute('href', `/${campaign.slug}/iniciativas/${campaign.initiativeId}`);
  });

  test('un enlace sin firma válida lleva a la portada de la entidad, que siempre existe', async ({ page }) => {
    await page.goto('/cervantes/iniciativas/1/aportar/resultado?pedido=KDNOEXISTE&sig=mala');
    await expect(page.getByRole('heading', { level: 1, name: 'No podemos abrir este resultado' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a la portada de la entidad' })).toHaveAttribute('href', '/cervantes');
  });
});

/** Rutas públicas sin sesión que no recorre ninguna otra prueba en los tres idiomas (la portada y las páginas pilar ya las recorre `marketing-seo`). */
const PUBLIC_ROUTES = ['/cervantes', '/cervantes/iniciativas/1', '/cervantes/iniciativas/2', '/cervantes/iniciativas/4', '/cervantes/logros', '/cervantes/comercios', '/cervantes/ayuda', '/cervantes/ideas', '/basket-valles', '/login', '/registro-comunidad', '/accesibilidad', '/cervantes/votacion'] as const;

for (const locale of LOCALES) {
  test.describe(`QA-X02 · ${locale}: rutas públicas accesibles, traducidas, en una columna en móvil y sin errores`, () => {
    for (const path of PUBLIC_ROUTES) {
      test(`${PREFIX[locale]}${path}`, async ({ page }) => {
        const errors = trackConsoleErrors(page);
        // Las fotos de Cervantes las suben y las quitan otras pruebas a la vez; la portada se guarda 60 s, así que puede pedir una foto recién
        // quitada (404). Solo se perdona ese caso: cualquier otro recurso que falle, o cualquier otro error, sigue contando.
        const missing: string[] = [];
        page.on('response', (response) => {
          if (response.status() >= 400) missing.push(new URL(response.url()).pathname);
        });
        expect((await page.goto(`${PREFIX[locale]}${path}`))?.status()).toBe(200);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expectNoMissingTranslations(page);
        await expectNoHorizontalOverflow(page);
        if ((page.viewportSize()?.width ?? 1440) < 768) await expectMobileStackIsOneColumn(page);
        await expectNoSeriousA11yViolations(page);
        expect(missing.filter((pathname) => !pathname.startsWith('/api/files/public/')), 'recursos que fallan').toEqual([]);
        const forgiven = missing.length > 0 ? errors.filter((message) => !/Failed to load resource: .* 404/.test(message)) : errors;
        expect(forgiven).toEqual([]);
      });
    }
  });
}

test.describe('QA-X02 · teclado', () => {
  for (const path of ['/', '/cervantes', '/cervantes/iniciativas/1', '/login']) {
    test(`${path}: el primer Tab enseña «Saltar al contenido» y lleva al contenido principal`, async ({ page }) => {
      await page.goto(path);
      await page.keyboard.press('Tab');
      const skip = page.locator('a[href="#contenido"]');
      await expect(skip).toBeFocused();
      await expect(skip).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#contenido$/);
      // El siguiente Tab ya cae dentro del contenido, no vuelve a la cabecera.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('#contenido') !== null)).toBe(true);
    });
  }

  test('la cabecera de marketing marca la página actual y sus enlaces miden al menos 44 × 44 px, también «Preus»', async ({ page, isMobile }) => {
    test.skip(isMobile, 'En móvil la navegación va en el menú desplegable (prueba siguiente).');
    await page.goto('/ca/precios');
    const nav = page.getByRole('navigation', { name: /principal/i });
    await expect(nav.getByRole('link', { name: 'Preus' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    for (const link of await nav.getByRole('link').all()) {
      const box = await link.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('el menú móvil marca la página actual y se cierra al pulsar fuera', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'El menú desplegable solo aparece por debajo de 1280 px.');
    await page.goto('/como-funciona');
    const toggle = page.getByRole('button', { name: 'Menú' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('navigation', { name: 'Menú' });
    await expect(menu.getByRole('link', { name: 'Cómo funciona' })).toHaveAttribute('aria-current', 'page');
    // Pulsar dentro del menú (en su fondo) no lo cierra; pulsar en el contenido, sí.
    await menu.click({ position: { x: 5, y: 5 } });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // El menú abierto cubre la parte de arriba de la página: se pulsa abajo del todo, en el contenido.
    const viewport = page.viewportSize() ?? { width: 430, height: 932 };
    await page.mouse.click(Math.round(viewport.width / 2), viewport.height - 20);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveCount(0);
  });

  test('el simulador dice cómo ha entendido un importe escrito con el otro separador', async ({ page }) => {
    await page.goto('/');
    const cost = page.getByLabel('Presupuesto de vuestro proveedor');
    await cost.fill('4.5');
    await expect(page.getByTestId('cost-read-as')).toHaveText(/^Lo leemos como 4,50\s€\.$/);
    await cost.fill('3500');
    await expect(page.getByTestId('cost-read-as')).toHaveText(/^Lo leemos como 3\.500,00\s€\.$/);
  });
});

/**
 * QA-X01 · presupuesto de rendimiento (skill de interfaz §5) en un móvil medio con 4G: CPU 4 veces más lenta y la red «4G lenta» de Lighthouse
 * (150 ms de latencia, 1,6 Mbit/s de bajada). Solo tiene sentido contra la compilación de producción (`CI=1`): el servidor de desarrollo sirve el
 * JavaScript sin minimizar y con las herramientas de desarrollo.
 */
const PERF_PAGES = ['/', '/cervantes', '/cervantes/iniciativas/1', '/para-colegios'] as const;
const JS_BUDGET_BYTES = 170 * 1024;

async function throttle(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  return cdp;
}

interface PerfRun {
  lcp: number;
  cls: number;
  inp: number;
  clicked: string;
  scripts: Array<{ name: string; bytes: number }>;
}

/** Una visita completa con el freno puesto: métricas de carga, JavaScript hasta `load` y la primera pulsación sobre el primer botón del contenido. */
async function measureVisit(page: Page, path: string): Promise<PerfRun> {
  await throttle(page);
  await page.addInitScript(() => {
    const store = { lcp: 0, cls: 0, inp: 0 };
    (window as unknown as { __korumPerf: typeof store }).__korumPerf = store;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!entry.hadRecentInput) store.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.inp = Math.max(store.inp, entry.duration);
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });
  await page.goto(path, { waitUntil: 'load' });
  // JavaScript **inicial**: lo que la página descarga hasta el evento `load`. Lo que llega después (las precargas de los enlaces visibles y lo que
  // abre una pulsación) no retrasa que la página se pueda usar y no cuenta en el presupuesto.
  const scripts = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const end = navigation?.loadEventEnd || performance.now();
    return (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((entry) => (entry.initiatorType === 'script' || /\.js(\?|$)/.test(entry.name)) && entry.startTime <= end)
      .map((entry) => ({ name: new URL(entry.name).pathname.split('/').pop() ?? entry.name, bytes: entry.encodedBodySize }));
  });
  // Reposo de la red con tope de 5 s: en una segunda pestaña, Next repite alguna precarga idéntica (la ficha enlaza dos veces a la portada) y Chrome
  // retiene la copia unos 30 s antes de cancelarla (bloqueo de su caché). Son precargas en segundo plano que no cambian lo que se mide.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  // Una interacción real para el INP: la primera pulsación es la más cara (lo que se monta por primera vez), así que es la que se mide.
  const target = page.locator('#contenido button:visible, #contenido summary:visible').first();
  const clicked = (await target.count()) > 0 ? (await target.innerText()).replace(/\s+/g, ' ').trim().slice(0, 40) || 'botón sin texto' : 'ninguno';
  if (clicked !== 'ninguno') await target.click();
  await page.waitForTimeout(500);
  const metrics = await page.evaluate(() => (window as unknown as { __korumPerf: { lcp: number; cls: number; inp: number } }).__korumPerf);
  return { ...metrics, clicked, scripts };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

test.describe('QA-X01 · rendimiento en móvil medio con 4G', () => {
  // Medir con otros navegadores de la suite en paralelo da cifras de la máquina cargada, no de la página: se lanza aparte, con un solo navegador
  // (`npm run test:e2e:perf` con `E2E_PERF=1`, y `CI=1` para usar la compilación de producción).
  test.skip(!process.env.CI || process.env.E2E_PERF !== '1', 'Aparte: npm run test:e2e:perf con CI=1 y E2E_PERF=1.');

  for (const path of PERF_PAGES) {
    test(`${path}: LCP < 2,5 s, CLS < 0,1, INP < 200 ms y JavaScript inicial < 170 KB comprimido`, async ({ page, context, isMobile }) => {
      test.skip(!isMobile, 'El presupuesto se mide en el perfil móvil.');
      test.setTimeout(300_000);
      // Una visita previa sin freno calienta la caché del servidor (la portada se genera la primera vez que se pide), no la del navegador.
      await context.request.get(path);
      // LCP, CLS y JavaScript salen de la primera visita, en frío. La primera pulsación se mide en cinco visitas nuevas y cuenta la mediana (como
      // recomienda Lighthouse): con la CPU frenada, de vez en cuando la pulsación coincide con trabajo de fondo (la precarga de los enlaces, la carga
      // del propio equipo) y sale un pico aislado; la mediana de cinco aguanta dos picos sin dejar de ver una página que es lenta siempre.
      const first = await measureVisit(page, path);
      const others: PerfRun[] = [];
      for (let run = 0; run < 4; run += 1) {
        const fresh = await context.newPage();
        others.push(await measureVisit(fresh, path));
        await fresh.close();
      }
      const inp = median([first.inp, ...others.map((run) => run.inp)]);
      const scriptBytes = first.scripts.reduce((sum, entry) => sum + entry.bytes, 0);
      const heaviest = [...first.scripts].sort((a, b) => b.bytes - a.bytes).slice(0, 20).map((entry) => `${entry.name} ${(entry.bytes / 1024).toFixed(1)}`).join(', ');
      const summary = `${path}: LCP ${Math.round(first.lcp)} ms · CLS ${first.cls.toFixed(3)} · INP ${Math.round(inp)} ms (mediana de ${[first, ...others].map((run) => Math.round(run.inp)).join('/')}, «${first.clicked}») · JS ${(scriptBytes / 1024).toFixed(1)} KB en ${first.scripts.length} archivos (${heaviest})`;
      testInfo().annotations.push({ type: 'perf', description: summary });
      console.log(summary);
      expect(first.lcp, 'LCP').toBeGreaterThan(0);
      expect(first.lcp, 'LCP').toBeLessThan(2_500);
      expect(first.cls, 'CLS').toBeLessThan(0.1);
      expect(inp, 'INP').toBeLessThan(200);
      expect(scriptBytes, 'JavaScript inicial comprimido').toBeLessThan(JS_BUDGET_BYTES);
    });
  }
});

const testInfo = () => test.info();
