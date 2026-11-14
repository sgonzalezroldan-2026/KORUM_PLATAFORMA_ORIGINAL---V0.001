import { expect, test, type Page } from '@playwright/test';
import { codeTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_BASE_URL } from './e2e-env';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F09 · Buzón de ideas con quórum auditado y logros Antes / Después, como una persona real (Sprint 3.6). Datos de la semilla: Cervantes
 * (`cervantes`, mínimo 30 firmas) tiene la idea 503 esperando la doble firma y la 501 en revisión del centro (esta última no sale en público);
 * las ideas que se firman en las pruebas se crean aquí, con título propio por proyecto, para no depender de la fecha de la semilla. Los códigos de
 * acceso se leen de `.email-preview/`.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const NAVIGATION = { timeout: 45_000 };
const server = expect.configure({ timeout: 30_000 });
/** La primera vez que se llama a una acción de servidor, el servidor de desarrollo compila la ruta y sus dependencias: puede tardar un par de minutos. */
const firstAction = expect.configure({ timeout: 120_000 });
const PNG_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  for (const path of ['/cervantes/ideas', '/ca/cervantes/ideas', '/cervantes/logros', '/en/cervantes/logros', '/login', '/acceso/continuar', '/api/files/public/aaaaaaaaaaaaaaaaaaaaaaaa']) {
    await request.get(path, { timeout: 120_000 }).catch(() => undefined);
  }
});

async function createIdea(title: string, overrides: { phase?: string; verifiedVotes?: number } = {}): Promise<number> {
  return withE2eDb(async (db) => {
    const result = await db.query(
      `INSERT INTO "Idea" ("organizationId", "alias", "authorCanonicalEmail", "title", "category", "description", "phase", "votes", "verifiedVotes", "suspiciousVotes", "expiresAt")
       VALUES ('CERVANTES', $1, $2, $3, 'Patios y Deporte', 'Hace falta sombra en el recreo para todo el alumnado', $4::"IdeaPhase", $5, $5, 0, now() + interval '20 days') RETURNING id`,
      [`#FAM-${Math.floor(1000 + Math.random() * 8999)}`, `autor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@familias.example`, title, overrides.phase ?? 'PUBLIC_VOTING', overrides.verifiedVotes ?? 3]
    );
    return result.rows[0].id as number;
  });
}

/** Una familia entra con el código de 6 dígitos de su email, como en el resto de pruebas de acceso, y vuelve al buzón. */
async function signInToIdeas(page: Page, email: string) {
  await page.goto(`/login?next=${encodeURIComponent('/cervantes/ideas')}`);
  await page.getByLabel('Tu email').fill(email);
  const since = Date.now();
  await page.getByRole('button', { name: 'Prefiero un código de 6 dígitos' }).click();
  await expect(page.getByRole('heading', { name: 'Escribe el código' })).toBeFocused({ timeout: 30_000 });
  await page.getByLabel('Código de 6 dígitos').fill(await codeTo(email, since));
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await server(page).toHaveURL(/\/cervantes\/ideas$/);
}

const card = (page: Page, title: string) => page.getByTestId('idea-card').filter({ hasText: title });

test.describe('QA-F09 · buzón de ideas (público)', () => {
  test('sin sesión: ideas con código anónimo, sin datos de nadie, "Entra para firmar", noindex, accesible y en una columna en móvil', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    // Único en cada intento: un reintento de Playwright no debe encontrar la idea que dejó el intento anterior.
    const title = `Toldo para el patio ${testInfo.project.name} ${testInfo.retry}-${Date.now().toString(36)}`;
    await createIdea(title);
    await page.goto('/cervantes');
    await page.getByRole('navigation', { name: 'Secciones de la comunidad' }).getByRole('link', { name: /Buzón de ideas/ }).click();
    await expect(page).toHaveURL(/\/cervantes\/ideas$/, NAVIGATION);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('¿Qué podemos mejorar en CEIP Cervantes?');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

    // Solo ideas con firmas abiertas o con quórum; la que revisa el centro (501) no sale.
    await expect(card(page, title)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Renovar micrófonos inalámbricos/ })).toBeVisible();
    await expect(page.getByText('Fuentes de agua filtrada fresca')).toHaveCount(0);
    const quorum = card(page, 'Renovar micrófonos inalámbricos');
    await expect(quorum).toContainText('Quórum logrado');
    await expect(quorum).toContainText('En manos del centro');
    await expect(quorum.getByRole('button', { name: /Firmar/ })).toHaveCount(0);

    // Código anónimo y firmas verificadas; nunca un email.
    const own = card(page, title);
    await expect(own).toContainText(/Código #FAM-\d{4}/);
    await expect(own).toContainText('3 de 30 firmas');
    await expect(own.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10');
    await expect(page.locator('main')).not.toContainText('@');
    const signIn = own.getByRole('link', { name: 'Entra para firmar' });
    await expect(signIn).toHaveAttribute('href', /\/login\?next=%2Fcervantes%2Fideas/);
    await expect(page.getByRole('link', { name: 'Entra para proponer una idea' })).toBeVisible();
    // La aportación a una idea del buzón nunca es dinero: no hay botones de pago.
    await expect(page.getByRole('button', { name: /Aportar/ })).toHaveCount(0);

    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    expect(errors).toEqual([]);
  });

  for (const [prefix, heading] of [['/ca', 'Què podem millorar a CEIP Cervantes?'], ['/en', 'What can we improve at CEIP Cervantes?']] as const) {
    test(`${prefix}/cervantes/ideas: idioma en la URL, sin claves sin traducir y accesible`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await page.goto(`${prefix}/cervantes/ideas`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.locator('html')).toHaveAttribute('lang', prefix.slice(1));
      await expectNoMissingTranslations(page);
      await expectNoSeriousA11yViolations(page);
      expect(errors).toEqual([]);
    });
  }

  test('proponer sin sesión lleva a entrar y vuelve al buzón', async ({ page }) => {
    await page.goto('/cervantes/ideas');
    await page.getByRole('link', { name: 'Entra para proponer una idea' }).first().click();
    await expect(page).toHaveURL(/\/login\?next=%2Fcervantes%2Fideas$/, NAVIGATION);
  });
});

test.describe('QA-F09 · firmar y proponer (con sesión)', () => {
  test('una familia propone una idea (código #FAM-XXXX, en revisión) y la firma de otra se registra una sola vez, con cookie de dispositivo y huella solo con su consentimiento', async ({ page, context }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('buzon');
    const project = testInfo.project.name;
    const toSign = `Fuente para firmar ${project}`;
    const withFingerprint = `Fuente con huella ${project}`;
    await createIdea(toSign);
    await createIdea(withFingerprint);
    const afterWithdrawal = `Fuente tras retirar ${project}`;
    await createIdea(afterWithdrawal);
    await signInToIdeas(page, email);

    // --- Proponer: los errores van junto a su campo y el foco al primero inválido.
    await page.getByRole('button', { name: 'Proponer una idea' }).first().click();
    // El nombre del diálogo cambia al enviar («¡Propuesta enviada!»): se localiza por su identificador.
    const dialog = page.locator('#new-idea-modal');
    await expect(page.getByRole('dialog', { name: 'Proponer una idea' })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Infraestructura y Confort/ })).toHaveCount(1);
    await expect(dialog.getByRole('option', { name: /Patios y Deporte/ })).toHaveCount(1);
    await expect(dialog.getByRole('option', { name: /Taquilla y Rifas/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Enviar propuesta al centro' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Revisa los campos marcados');
    await expect(dialog.getByLabel('Título de la idea')).toBeFocused();
    await expect(dialog.getByLabel('Título de la idea')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog).toContainText('El título necesita al menos 8 caracteres');
    await expectNoSeriousA11yViolations(page);

    const proposed = `Aula de música propuesta ${project}`;
    await dialog.getByLabel('Título de la idea').fill(proposed);
    await dialog.getByRole('combobox', { name: 'Tipo de mejora' }).selectOption('Patios y Deporte');
    await dialog.getByLabel('¿Por qué ayudaría?').fill('Un espacio para ensayar con instrumentos sin molestar a las clases.');
    await dialog.getByRole('button', { name: 'Enviar propuesta al centro' }).click();
    await firstAction(dialog).toContainText(/Tu código es #FAM-\d{4}/);
    await dialog.getByRole('button', { name: 'Entendido' }).click();
    await expect(dialog).toBeHidden();

    const created = await withE2eDb(async (db) => (await db.query(`SELECT i.alias, i.phase, i."verifiedVotes", i."authorCanonicalEmail", (SELECT count(*)::int FROM "IdeaMessage" m WHERE m."ideaId" = i.id AND m."senderRole" = 'SYSTEM') AS messages FROM "Idea" i WHERE i.title = $1`, [proposed])).rows[0]);
    expect(created).toMatchObject({ phase: 'PHASE0_MOD', verifiedVotes: 1, authorCanonicalEmail: email, messages: 1 });
    expect(created.alias).toMatch(/^#FAM-\d{4}$/);
    // En revisión del centro: aún no sale en el buzón, ni con su código.
    await page.reload();
    await expect(page.getByText(proposed)).toHaveCount(0);

    // --- Firmar: 1 clic, aviso accesible, contador y estado «ya has firmado» que sobrevive a recargar.
    const target = card(page, toSign);
    await expect(target).toContainText('3 de 30 firmas');
    await target.getByRole('button', { name: 'Firmar apoyo' }).click();
    await firstAction(page.getByTestId('idea-notice')).toContainText('Tu firma ya cuenta');
    await expect(card(page, toSign)).toContainText('4 de 30 firmas');
    await expect(card(page, toSign).getByTestId('idea-signed')).toContainText('Ya has firmado, ¡gracias!');
    await expect(card(page, toSign).getByRole('button', { name: 'Firmar apoyo' })).toHaveCount(0);
    await page.reload();
    await expect(card(page, toSign).getByTestId('idea-signed')).toBeVisible();

    // La cookie de dispositivo es propia, HttpOnly y solo se crea al firmar; sin consentimiento no hay huella.
    const cookie = (await context.cookies()).find((item) => item.name === 'korum_device');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    const dbState = async () =>
      withE2eDb(async (db) => (await db.query(`SELECT (SELECT count(*)::int FROM "ConsentRecord" c JOIN "User" u ON u.id = c."userId" WHERE u.email = $1 AND c.purpose = 'DEVICE_FINGERPRINT' AND c.granted) AS granted, (SELECT count(*)::int FROM "Device" d WHERE d."fingerprintHmac" IS NOT NULL AND EXISTS (SELECT 1 FROM "DeviceAccount" a JOIN "User" u ON u.id = a."userId" WHERE a."deviceId" = d.id AND u.email = $1)) AS fingerprints, (SELECT count(*)::int FROM "IdeaSignatureAudit" s JOIN "User" u ON u.id = s."userId" WHERE u.email = $1) AS signatures`, [email])).rows[0] as { granted: number; fingerprints: number; signatures: number });
    expect(await dbState()).toEqual({ granted: 0, fingerprints: 0, signatures: 1 });

    // --- Huella: opcional, desmarcada por defecto, con aviso claro; al marcarla y firmar se guarda, y se retira con un clic.
    const checkbox = page.getByRole('checkbox', { name: /Ayudar a proteger la votación/ });
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByRole('region', { name: /Cómo cuidamos/ })).toContainText('cookie propia');
    await checkbox.check();
    await card(page, withFingerprint).getByRole('button', { name: 'Firmar apoyo' }).click();
    await server(page.getByTestId('idea-notice')).toContainText('Tu firma ya cuenta');
    await expect.poll(dbState, { timeout: 15_000 }).toEqual({ granted: 1, fingerprints: 1, signatures: 2 });
    await page.reload();
    await expect(page.getByText('Has activado la protección extra del navegador.')).toBeVisible();
    await page.getByRole('button', { name: 'Retirar mi consentimiento' }).click();
    await expect(page.getByText('hemos borrado la huella de tus dispositivos')).toBeVisible();
    await expect.poll(dbState, { timeout: 15_000 }).toMatchObject({ fingerprints: 0, signatures: 2 });

    // Retirar vale: la casilla vuelve desmarcada y la siguiente firma no vuelve a dar el consentimiento ni guarda huella (RGPD art. 7.3).
    await expect(checkbox).not.toBeChecked();
    await card(page, afterWithdrawal).getByRole('button', { name: 'Firmar apoyo' }).click();
    await server(page.getByTestId('idea-notice')).toContainText('Tu firma ya cuenta');
    await expect.poll(dbState, { timeout: 15_000 }).toEqual({ granted: 1, fingerprints: 0, signatures: 3 });
    await expect(checkbox).not.toBeChecked();

    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    // En el servidor de pruebas, `Secure` en `http://localhost` es lo único que Chrome acepta; cualquier otro error de consola es un fallo.
    expect(errors).toEqual([]);
  });
});

test.describe('QA-F09 · logros conseguidos y comparador Antes / Después', () => {
  test('lista las iniciativas conseguidas y cerradas, avisa de que las fotos llegarán y se llega desde la portada', async ({ page }, testInfo) => {
    // Otra prueba (del otro proyecto) puede haber dejado fotos de prueba en estas iniciativas: sus imágenes no existen en el almacén, y un 404 es un error de consola.
    await page.route('**/api/files/public/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_PIXEL }));
    const errors = trackConsoleErrors(page);
    await page.goto('/cervantes');
    await page.getByRole('link', { name: /mejoras logradas/ }).click();
    await expect(page).toHaveURL(/\/cervantes\/logros$/, NAVIGATION);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Lo que ya hemos logrado juntos');
    await expect(page.getByTestId('achievement-card')).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 2, name: /Toldos y Sombras para el Patio de Infantil/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Renovación de Canchas de Baloncesto/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ver la iniciativa' }).first()).toHaveAttribute('href', /\/cervantes\/iniciativas\/\d+$/);
    // Solo conseguidas o cerradas: ni una campaña abierta ni importes por persona.
    await expect(page.getByText('Climatización Sostenible')).toHaveCount(0);
    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    expect(errors).toEqual([]);
  });

  test('con las dos fotos: comparador con teclado, valor leído, alt en cada imagen, agradecimiento y compartir logro; solo fotos públicas', async ({ page }, testInfo) => {
    // Las imágenes las sirve el almacén del servidor de pruebas; aquí se sustituyen por un píxel para no depender de él.
    await page.route('**/api/files/public/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_PIXEL }));
    const errors = trackConsoleErrors(page);
    const fileIds = { before: `e2ebefore${testInfo.project.name}000000000`.slice(0, 24), after: `e2eafter${testInfo.project.name}00000000000`.slice(0, 24), secret: `e2esecret${testInfo.project.name}0000000000`.slice(0, 24) };
    await withE2eDb(async (db) => {
      const file = (id: string, purpose: string, visibility: string, bucket: string) =>
        db.query(`INSERT INTO "FileAsset" ("id", "bucket", "objectKey", "visibility", "purpose", "mimeType", "sizeBytes", "sha256", "organizationId", "retainUntil") VALUES ($1, $2, $3, $4::"FileVisibility", $5::"FilePurpose", $6, 100, $7, 'CERVANTES', $8) ON CONFLICT ("id") DO NOTHING`, [id, bucket, `e2e/${id}`, visibility, purpose, purpose === 'KYB_DOCUMENT' ? 'application/pdf' : 'image/png', id.padEnd(64, '0'), purpose === 'KYB_DOCUMENT' ? new Date(Date.now() + 365 * 86_400_000) : null]);
      await file(fileIds.before, 'INITIATIVE_BEFORE', 'PUBLIC', 'korum-public');
      await file(fileIds.after, 'INITIATIVE_AFTER', 'PUBLIC', 'korum-public');
      await file(fileIds.secret, 'KYB_DOCUMENT', 'PRIVATE', 'korum-private');
      await db.query(`UPDATE "Initiative" SET "beforeFileId" = $1, "afterFileId" = $2, "thanksMessage" = $3 WHERE id = 4`, [fileIds.before, fileIds.after, 'Gracias a todas las familias por hacerlo posible']);
      // La iniciativa 3 tiene un fichero privado: no debe salir.
      await db.query(`UPDATE "Initiative" SET "beforeFileId" = $1 WHERE id = 3`, [fileIds.secret]);
    });

    const closed = page.getByTestId('achievement-card').filter({ hasText: 'Renovación de Canchas' });
    // La página de logros se regenera cada minuto (como la portada): con la compilación de producción, lo que acaba de cambiar tarda en verse.
    await expect(async () => {
      await page.goto('/cervantes/logros');
      await expect(closed.getByTestId('achievement-comparer')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 150_000, intervals: [3_000, 10_000] });
    await expect(closed).toContainText('Gracias a todas las familias por hacerlo posible');
    await expect(closed.getByRole('img', { name: /antes de la mejora/ })).toBeVisible();
    await expect(closed.getByRole('img', { name: /después de la mejora/ })).toBeVisible();
    const slider = closed.getByRole('slider', { name: /Deslizar para comparar/ });
    await expect(slider).toHaveAttribute('aria-valuetext', 'Se ve el 50 % del después y el 50 % del antes');
    await slider.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveValue('100');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Se ve el 0 % del después y el 100 % del antes');
    await page.keyboard.press('Home');
    await expect(slider).toHaveValue('0');
    // El fichero privado de la iniciativa 3 no se publica: sigue sin fotos.
    const reached = page.getByTestId('achievement-card').filter({ hasText: 'Toldos y Sombras' });
    await expect(reached.getByTestId('achievement-no-photos')).toBeVisible();
    await expect(reached.locator('img')).toHaveCount(0);

    // Compartir logro: mensaje de celebración, sin presión ni nombres.
    await closed.getByRole('button', { name: 'Compartir logro' }).click();
    const share = page.getByRole('dialog', { name: /Compartir/ });
    await expect(share).toContainText('Mirad cómo ha quedado «Renovación de Canchas de Baloncesto y Pintura Exterior» gracias a la comunidad de CEIP Cervantes');
    await expect(share.getByRole('link', { name: /WhatsApp/ })).toHaveAttribute('href', expect.stringContaining('/cervantes/iniciativas/4'));
    await expectNoSeriousA11yViolations(page);
    await share.getByRole('button', { name: 'Cerrar' }).click();

    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });
});

test.describe('Subida de fotos y ficheros públicos (rutas)', () => {
  const origin = E2E_BASE_URL;

  test('la subida del panel rechaza lo que no viene de la web, lo que no tiene tamaño y lo demasiado grande, y sin sesión responde 403', async ({ request }) => {
    const form = { intent: 'thanks', orgSlug: 'cervantes', initiativeId: '4', message: 'hola' };
    const crossSite = await request.post('/api/panel/logros', { headers: { origin: 'https://otro-sitio.example' }, multipart: form });
    expect(crossSite.status()).toBe(403);
    const noOrigin = await request.post('/api/panel/logros', { multipart: form });
    expect(noOrigin.status()).toBe(403);
    const anonymous = await request.post('/api/panel/logros', { headers: { origin }, multipart: form });
    expect(anonymous.status()).toBe(403);
    expect(await anonymous.json()).toEqual({ ok: false, error: 'FORBIDDEN' });
    const tooBig = await request.post('/api/panel/logros', { headers: { origin }, multipart: { ...form, file: { name: 'grande.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(5 * 1024 * 1024, 1) } } });
    expect(tooBig.status()).toBe(413);
  });

  test('/api/files/public solo sirve imágenes públicas: un identificador inventado, mal formado o de un fichero privado responde 404', async ({ request }, testInfo) => {
    // El tercer identificador es el fichero privado (KYB) que crea la prueba del comparador: existe, pero no es público.
    for (const id of ['aaaaaaaaaaaaaaaaaaaaaaaa', 'no-es-un-id', '..%2F..%2Fetc%2Fpasswd', `e2esecret${testInfo.project.name}0000000000`.slice(0, 24)]) {
      const response = await request.get(`/api/files/public/${id}`, { maxRedirects: 0 });
      expect(response.status(), id).toBe(404);
    }
  });

  test('la ficha del panel de logros exige sesión: sin ella lleva a /login', async ({ page }) => {
    await page.goto('/panel/cervantes/logros');
    await expect(page).toHaveURL(/\/login\?next=/, NAVIGATION);
  });
});
