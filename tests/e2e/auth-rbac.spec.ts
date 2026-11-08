import { expect, test, type Page } from '@playwright/test';
import { hashGatePin } from '@/core/ticketing/gate-pin';
import { totpCode } from '../support/totp';
import { codeTo, emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-M02 y QA-SEC05 · Acceso por rol, alta autónoma y portería con PIN (Sprint 3.2), en escritorio (1440) y móvil (430), con axe y sin
 * errores de consola. Los códigos y enlaces se leen de `.email-preview/`, como los recibiría la persona.
 */

// En serie: cada prueba crea cuentas y sesiones, y con la base local de una sola conexión (PGlite) varias a la vez se ponen en cola.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** Esperas que dependen del servidor (crear la sesión, comprobar el PIN): en desarrollo, la primera vez se compila la ruta. */
const server = expect.configure({ timeout: 30_000 });

/**
 * El servidor de desarrollo compila cada ruta la primera vez que se pide; si escritorio y móvil la piden a la vez, Next puede leer su índice
 * a medio escribir («Unexpected end of JSON input», un 500 que no existe en la compilación de producción). Se piden una vez antes, de una en
 * una; lo que respondan aquí no cuenta.
 */
test.beforeAll(async ({ request }) => {
  // Con la caché de desarrollo vacía, compilar estas rutas lleva varios minutos.
  test.setTimeout(600_000);
  for (const path of ['/login', '/acceso/continuar', '/acceso/doble-factor', '/invitacion', '/registro-comunidad', '/panel/cervantes', '/panel/cervantes/porteria', '/admin', '/ca/admin']) {
    // Con una cookie de sesión inventada el proxy deja pasar y la ruta se compila; el layout la rechaza y manda a /login.
    await request.get(path, { maxRedirects: 0, timeout: 120_000, headers: { cookie: 'korum.session_token=calentamiento' } }).catch(() => undefined);
  }
});

async function checkPage(page: Page, errors: string[]) {
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
}

test.describe('Entrada a /login', () => {
  test('se ve en castellano y catalán, no se indexa y ofrece los dos caminos', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    for (const [path, title] of [['/login', 'Entra en KORUM'], ['/ca/login', 'Entra a KORUM']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
      await checkPage(page, errors);
    }
    await page.getByRole('button', { name: 'Signants i equip' }).click();
    await expect(page.getByLabel('Contrasenya')).toBeVisible();
    await checkPage(page, errors);
  });

  test('sin sesión, el panel y la consola llevan a /login con la ruta de vuelta; la portería entra con PIN', async ({ page }) => {
    await page.goto('/panel/cervantes');
    await expect(page).toHaveURL(/\/login\?next=%2Fpanel%2Fcervantes$/);
    await page.goto('/ca/admin');
    await expect(page).toHaveURL(/\/ca\/login\?next=%2Fca%2Fadmin$/);
    const gate = await page.goto('/panel/cervantes/porteria');
    expect(gate?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});

test.describe('Familias: código por email y acceso denegado al panel y a la consola', () => {
  test('una familia entra con un código, y /panel y /admin le responden 403', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('familia');
    await page.goto('/login');
    await page.getByLabel('Tu email').fill(email);
    const since = Date.now();
    await page.getByRole('button', { name: 'Prefiero un código de 6 dígitos' }).click();
    // La primera petición a /api/auth compila la ruta en el servidor de desarrollo: se da más margen.
    await expect(page.getByRole('heading', { name: 'Escribe el código' })).toBeFocused({ timeout: 30_000 });
    const code = await codeTo(email, since);
    expect(code).toMatch(/^\d{6}$/);
    await page.getByLabel('Código de 6 dígitos').fill(code);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await server(page).toHaveURL(/\/$/);

    for (const path of ['/panel/cervantes', '/admin']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(403);
      await expect(page.getByRole('heading', { level: 1, name: 'No tienes acceso a esta página' })).toBeVisible();
    }
    // El navegador anota en la consola el 403 del documento: es justo lo que se comprueba, no un error de la página.
    const unexpected = errors.filter((error) => !error.includes('status of 403 (Forbidden)'));
    await checkPage(page, unexpected);
    const denied = await withE2eDb(async (db) => (await db.query(`SELECT count(*)::int AS n FROM "AuditLog" a JOIN "User" u ON u.id = a."actorUserId" WHERE u.email = $1 AND a.action = 'tenant.access_denied'`, [email])).rows[0].n as number);
    expect(denied).toBeGreaterThanOrEqual(2);
  });
});

test.describe('Alta autónoma de una entidad (QA-M02)', () => {
  test('3 pasos, reglas legales, verificación del email, TOTP y panel; entrada con contraseña + código; la segunda firma acepta su invitación', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const suffix = `${isMobile ? 'm' : 'd'}${Date.now().toString(36)}`;
    const director = uniqueEmail('direccion');
    const cosigner = uniqueEmail('afa');
    const password = 'una-contraseña-muy-larga';
    await page.goto('/registro-comunidad');
    await expect(page.getByRole('heading', { level: 1, name: 'Dad de alta vuestra comunidad' })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await checkPage(page, errors);

    // Paso 1: un colegio público con una fundación como titular no se admite.
    await page.getByLabel('Nombre público').fill(`CEIP Prueba ${suffix}`);
    await expect(page.getByLabel('Dirección de vuestra página')).toHaveValue(`ceip-prueba-${suffix}`);
    await page.getByLabel('Provincia').selectOption('08');
    await page.getByLabel('Municipio').fill('Sabadell');
    await page.getByLabel('Código postal').fill('08201');
    await page.getByLabel('Razón social del titular').fill(`AFA CEIP Prueba ${suffix}`);
    await page.getByLabel('Forma jurídica').selectOption('FOUNDATION');
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByText('Un colegio público solo puede darse de alta a través de su AMPA/AFA.')).toBeVisible();
    await page.getByLabel('Forma jurídica').selectOption('PARENTS_ASSOCIATION');
    await page.getByRole('button', { name: 'Continuar' }).click();

    // Paso 2: las dos personas firmantes.
    await expect(page.getByRole('heading', { level: 2, name: 'Las dos personas firmantes' })).toBeFocused();
    const signer = (index: number) => page.locator('fieldset').nth(index);
    await signer(0).getByLabel('Nombre y apellidos').fill('Carla Puig');
    await signer(0).getByLabel('Email').fill(director);
    await signer(0).getByLabel('Teléfono').fill('600 111 222');
    await signer(0).getByLabel('Contraseña', { exact: true }).fill(password);
    await signer(0).getByLabel('Repite la contraseña').fill(password);
    await signer(1).getByLabel('Nombre y apellidos').fill('Marta Soler');
    await signer(1).getByLabel('Email').fill(cosigner);
    await signer(1).getByLabel('Teléfono').fill('600 333 444');
    await checkPage(page, errors);
    await page.getByRole('button', { name: 'Continuar' }).click();

    // Paso 3: activación con los euros exentos del motor de reglas.
    await expect(page.getByText('1.000,00 €').first()).toBeVisible();
    await page.getByLabel(/Declaro que represento/).check();
    const since = Date.now();
    await page.getByRole('button', { name: 'Dar de alta' }).click();
    await expect(page.getByRole('heading', { name: `¡CEIP Prueba ${suffix} ya está en KORUM!` })).toBeVisible({ timeout: 30_000 });
    await checkPage(page, errors);
    const invitation = await emailTo(cosigner, since);
    expect(invitation).toContain('/invitacion#t=');

    // Verificación del email y activación del TOTP.
    await page.getByLabel('Código de 6 dígitos').fill(await codeTo(director, since));
    await page.getByRole('button', { name: 'Verificar y continuar' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Activa la verificación en dos pasos' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Tu contraseña').fill(password);
    await page.getByRole('button', { name: 'Empezar' }).click();
    await server(page.getByRole('img', { name: 'Código QR para añadir KORUM a tu app de verificación' })).toBeVisible();
    await checkPage(page, errors);
    const secret = (await page.locator('code').first().innerText()).trim();
    await page.getByLabel('He guardado los códigos de respaldo').check();
    await page.getByLabel('Primer código de la app').fill(totpCode(secret));
    await page.getByRole('button', { name: 'Activar y continuar' }).click();

    // Panel: la hucha, los 1.000 € exentos y la doble firma a medias (la segunda persona está invitada).
    await expect(page).toHaveURL(new RegExp(`/panel/ceip-prueba-${suffix}$`), { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1, name: `Hola, CEIP Prueba ${suffix}` })).toBeVisible();
    await expect(page.getByText(/^WLT-ESC-[A-Z2-9]{6}$/)).toBeVisible();
    await expect(page.getByText('Invitación enviada: aún no ha activado su cuenta')).toBeVisible();
    await checkPage(page, errors);

    // Sesión nueva: la contraseña sola no abre el panel; con el código de la app, sí.
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    // Cerrar sesión borra la sesión en la base y después navega: con la base local de una sola conexión puede pasar de 7 s.
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await page.goto(`/panel/ceip-prueba-${suffix}`);
    await page.getByRole('button', { name: 'Firmantes y equipo' }).click();
    await page.getByLabel('Tu email').fill(director);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await server(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
    await page.getByLabel('Código de la app').fill(totpCode(secret, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(new RegExp(`/panel/ceip-prueba-${suffix}$`), { timeout: 30_000 });
    await checkPage(page, errors);

    // La segunda firma abre su invitación en otro navegador: el token sale de la barra, crea su contraseña y activa su TOTP.
    const link = /https?:\/\/\S+\/invitacion#t=\S+/.exec(invitation)?.[0];
    expect(link).toBeTruthy();
    const other = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const guest = await other.newPage();
    const guestErrors = trackConsoleErrors(guest);
    await guest.goto(new URL(link!).pathname + new URL(link!).hash);
    await server(guest.getByText(/te ha nombrado Presidencia del AMPA\/AFA/)).toBeVisible();
    expect(new URL(guest.url()).hash).toBe('');
    await guest.getByLabel('Crea tu contraseña').fill(password);
    await guest.getByLabel('Repite la contraseña').fill(password);
    await guest.getByRole('button', { name: 'Crear contraseña y continuar' }).click();
    await server(guest.getByRole('heading', { level: 1, name: 'Activa la verificación en dos pasos' })).toBeVisible();
    await guest.getByLabel('Tu contraseña').fill(password);
    await guest.getByRole('button', { name: 'Empezar' }).click();
    await server(guest.getByRole('img', { name: 'Código QR para añadir KORUM a tu app de verificación' })).toBeVisible();
    const cosignerSecret = (await guest.locator('code').first().innerText()).trim();
    await guest.getByLabel('He guardado los códigos de respaldo').check();
    await guest.getByLabel('Primer código de la app').fill(totpCode(cosignerSecret));
    await guest.getByRole('button', { name: 'Activar y continuar' }).click();
    await server(guest).toHaveURL(new RegExp(`/panel/ceip-prueba-${suffix}$`));
    await checkPage(guest, guestErrors);
    await other.close();

    // En el panel de quien dirige, las dos firmas ya están listas.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Doble firma (2 de 2 listas)' })).toBeVisible();
  });
});

test.describe('Portería con PIN (QA-SEC05)', () => {
  test('con un PIN incorrecto no entra; con el del evento ve solo el aforo de ese evento', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // Escritorio y móvil se ejecutan a la vez sobre el mismo evento: el mismo PIN, para que uno no anule el del otro.
    const pin = '731846';
    const eventId = await withE2eDb(async (db) => {
      const { rows } = await db.query(`SELECT i.id FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = 'cervantes' AND i.format = 'TICKETING' ORDER BY i.id LIMIT 1`);
      const id = rows[0].id as number;
      // Lo que hace `setGatePin` desde el panel (Sprint 4.5): solo el hash del PIN, con caducidad. Solo si no hay uno vigente: escritorio y
      // móvil comparten el evento y cambiar la huella a mitad de una entrada la invalida (comportamiento correcto del servidor).
      await db.query(`UPDATE "Initiative" SET "gatePinHash" = $1, "gatePinExpiresAt" = now() + interval '1 day' WHERE id = $2 AND ("gatePinHash" IS NULL OR "gatePinExpiresAt" < now())`, [await hashGatePin(E2E_SERVER_ENV.DATA_HMAC_SECRET!, pin), id]);
      return id;
    });
    await page.goto(`/panel/cervantes/porteria/${eventId}`);
    await page.getByLabel('PIN del evento').fill('000000');
    await page.getByRole('button', { name: 'Entrar en la portería' }).click();
    await server(page.getByText('El PIN no es correcto o ya no está activo.')).toBeVisible();
    await page.getByLabel('PIN del evento').fill(pin);
    await page.getByRole('button', { name: 'Entrar en la portería' }).click();
    await server(page.getByRole('heading', { name: 'Aforo en directo' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('€');
    await checkPage(page, errors);
    // La sesión de portería no abre el panel de la entidad.
    await page.goto('/panel/cervantes');
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});
