import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { codeTo, emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F06 (Mi cuenta), QA-PRIV01, QA-REG03 y, desde el Sprint 5.10b, QA-LEG03 (cambio de email) como una persona real (Sprint 3.7). Lo de diario está en
 * `/mi-cuenta` y el email, los permisos, la copia de los datos, la supresión, las llaves y el idioma en `/mi-cuenta/privacidad` (`R-52`). Cada proyecto crea su propia familia: compra como invitada una
 * donación y una entrada en Cervantes (semilla, Ley 49/2002 verificada) y luego entra con el código de su email, así se comprueba también que lo
 * comprado con ese email aparece en su cuenta. Los códigos se leen de `.email-preview/`.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const server = expect.configure({ timeout: 30_000 });
const firstAction = expect.configure({ timeout: 120_000 });

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  for (const path of ['/mi-cuenta', '/ca/mi-cuenta', '/mi-cuenta/privacidad', '/ca/mi-cuenta/privacidad', '/mi-cuenta/certificados', '/login', '/acceso/continuar']) await request.get(path, { timeout: 120_000 }).catch(() => undefined);
});

/** Compras como invitada con `email` en Cervantes: una donación completada y una entrada con su pase. */
async function seedPurchases(email: string): Promise<{ initiativeTitle: string; eventTitle: string }> {
  return withE2eDb(async (db) => {
    const donation = await db.query(`SELECT id, title FROM "Initiative" WHERE "organizationId" = 'CERVANTES' AND "ticketSubtype" IS NULL AND status = 'FUNDRAISING' ORDER BY id LIMIT 1`);
    const event = await db.query(`SELECT id, title FROM "Initiative" WHERE "organizationId" = 'CERVANTES' AND "ticketSubtype" = 'EVENT' ORDER BY id LIMIT 1`);
    const order = () => `KE2E${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await db.query(
      `INSERT INTO "Contribution" ("organizationId", "initiativeId", "guestEmail", "canonicalEmail", "fiscalYear", type, "amountCents", "totalChargedCents", "paymentMethod", status, "paycometOrder")
       VALUES ('CERVANTES', $1, $2, $2, 2026, 'DONATION', 2500, 2500, 'BIZUM', 'COMPLETED', $3)`,
      [donation.rows[0].id, email, order()]
    );
    const ticket = await db.query(
      `INSERT INTO "Contribution" ("organizationId", "initiativeId", "guestEmail", "canonicalEmail", "fiscalYear", type, "ticketQuantity", "amountCents", "totalChargedCents", "paymentMethod", status, "paycometOrder")
       VALUES ('CERVANTES', $1, $2, $2, 2026, 'TICKET', 2, 1000, 1110, 'CARD', 'COMPLETED', $3) RETURNING id`,
      [event.rows[0].id, email, order()]
    );
    await db.query(`INSERT INTO "TicketPass" (uuid, "contributionId", "initiativeId", "serialCode", "holderEmail", quantity, "qrHmacSignature") VALUES ($1, $2, $3, $4, $5, 2, 'e2e')`, [
      randomUUID(),
      ticket.rows[0].id,
      event.rows[0].id,
      `TKT-E2E-${randomUUID().slice(0, 8)}`,
      email
    ]);
    return { initiativeTitle: donation.rows[0].title as string, eventTitle: event.rows[0].title as string };
  });
}

/**
 * Cada persona entra desde su propia red (cabecera del proxy): el acceso tiene un tope de 5 códigos cada 10 minutos por red, y todas las pruebas
 * salen del mismo ordenador. Es lo que pasa en la vida real: cada familia, desde su casa.
 */
async function signIn(page: Page, email: string, next = '/mi-cuenta') {
  const octet = () => 1 + Math.floor(Math.random() * 250);
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` });
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Tu email').fill(email);
  const since = Date.now();
  await page.getByRole('button', { name: 'Prefiero un código de 6 dígitos' }).click();
  await expect(page.getByRole('heading', { name: 'Escribe el código' })).toBeFocused({ timeout: 30_000 });
  await page.getByLabel('Código de 6 dígitos').fill(await codeTo(email, since));
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await server(page).toHaveURL(new RegExp(`${next.replace(/\//g, '\\/')}$`));
}

/** La sesión de esta persona se verificó hace 20 minutos: exportar o suprimir vuelven a pedir el código. */
const ageReauthentication = (email: string) =>
  withE2eDb((db) => db.query(`UPDATE "Session" SET "reauthenticatedAt" = now() - interval '20 minutes', "secondFactorVerifiedAt" = NULL WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`, [email]));

test.describe('Mi cuenta', () => {
  test('sin sesión lleva a entrar; con sesión: aportaciones e invitada, entrada con firma de vista, cabecera «Mi cuenta», accesible y en una columna', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/mi-cuenta');
    await server(page).toHaveURL(/\/login\?next=%2Fmi-cuenta$/);

    const email = uniqueEmail('cuenta');
    const { initiativeTitle, eventTitle } = await seedPurchases(email);
    await signIn(page, email);
    await expect(page.getByRole('heading', { level: 1, name: 'Mi cuenta' })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.getByText(`Has entrado como ${email}`)).toBeVisible();
    await expect(page.getByTestId('header-account-link').first()).toHaveText('Mi cuenta');

    const contributions = page.locator('#contributions');
    await expect(contributions.getByRole('link', { name: initiativeTitle })).toBeVisible();
    await expect(contributions).toContainText('Completada');
    const pass = page.locator('#passes').getByRole('link', { name: new RegExp(`^Ver mi entrada\\s*· ${eventTitle}$`) });
    await expect(pass).toHaveAttribute('href', /\/cervantes\/entrada\/[0-9a-f-]{36}\?sig=/);

    await expectNoHorizontalOverflow(page);
    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    await expectNoSeriousA11yViolations(page);
    await expectNoMissingTranslations(page);
    // Lo que no es de diario vive en su propia página (Sprint 5.10b, `R-52`): la principal ya no lo carga.
    await expect(page.locator('#privacy')).toHaveCount(0);
    await page.getByTestId('privacy-access-link').click();
    await server(page).toHaveURL(/\/mi-cuenta\/privacidad$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacidad y acceso' })).toBeVisible();
    for (const section of ['#email', '#privacy', '#security', '#language']) await expect(page.locator(section)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    await expectNoSeriousA11yViolations(page);
    await expectNoMissingTranslations(page);
    expect(errors).toEqual([]);
  });

  test('certificados: la donación da su justificante imprimible con la leyenda de borrador; la de otra persona responde 404', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('justificante');
    const { initiativeTitle } = await seedPurchases(email);
    await signIn(page, email);
    await page.getByRole('link', { name: 'Ver certificados y justificantes' }).click();
    await server(page).toHaveURL(/\/mi-cuenta\/certificados$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Ejercicio 2026' })).toBeVisible();
    await expect(page.getByText('Justificante nominativo de aportación')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.getByRole('link', { name: new RegExp(`^Ver documento\\s*· ${initiativeTitle}`) }).click();
    await server(page).toHaveURL(/\/mi-cuenta\/certificados\/\d+$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Justificante nominativo de aportación' })).toBeVisible();
    await expect(page.getByText(/^BORRADOR/)).toBeVisible();
    await expect(page.getByText('25,00 €')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);

    const foreign = await withE2eDb(async (db) => (await db.query(`SELECT id FROM "Contribution" WHERE "canonicalEmail" <> $1 AND type = 'DONATION' AND status = 'COMPLETED' ORDER BY id LIMIT 1`, [email])).rows[0].id as number);
    const response = await page.goto(`/mi-cuenta/certificados/${foreign}`);
    expect(response?.status()).toBe(404);
    expect(errors.filter((message) => !message.includes('404'))).toEqual([]);
  });

  test('descargar mis datos: al momento si acaba de entrar; pasados 10 minutos pide el código por email', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('exporta');
    await seedPurchases(email);
    await signIn(page, email, '/mi-cuenta/privacidad');

    const json = page.waitForEvent('download');
    await page.getByTestId('export-json').click();
    expect((await json).suggestedFilename()).toMatch(/^korum-mis-datos-\d{4}-\d{2}-\d{2}\.json$/);
    await firstAction(page.getByText('Descarga lista.', { exact: false })).toBeVisible();

    await ageReauthentication(email);
    await page.getByTestId('export-pdf').click();
    const dialog = page.getByRole('dialog', { name: 'Confirma que eres tú' });
    await expect(dialog).toBeVisible();
    const since = Date.now();
    await dialog.getByRole('button', { name: 'Enviar código' }).click();
    await dialog.getByLabel('Código de 6 dígitos').fill(await codeTo(email, since));
    // Si la descarga no llega, la prueba falla en 30 s diciendo qué enseña la pantalla (en el CI de GitHub fallaba esperando 4 minutos sin más pistas).
    const pdf = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    const file = await pdf;
    expect(file, `sin descarga del PDF; diálogo: «${await dialog.innerText({ timeout: 2_000 }).catch(() => '(cerrado)')}»; aviso: «${await page.locator('[role="alert"], [role="status"]').allInnerTexts().catch(() => [])}»`).not.toBeNull();
    expect(file!.suggestedFilename()).toMatch(/\.pdf$/);
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.locator('#privacy')).toContainText('Descarga de datos');
    expect(errors).toEqual([]);
  });

  test('idioma de la cuenta: pasa a catalán por URL y lo guarda para los emails', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('idioma');
    await signIn(page, email, '/mi-cuenta/privacidad');
    await page.getByLabel('Idioma de la cuenta').selectOption('ca');
    await page.getByRole('button', { name: 'Guardar idioma' }).click();
    await server(page).toHaveURL(/\/ca\/mi-cuenta\/privacidad/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacitat i accés' })).toBeVisible();
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    const locale = await withE2eDb(async (db) => (await db.query(`SELECT locale FROM "User" WHERE email = $1`, [email])).rows[0].locale as string);
    expect(locale).toBe('ca');
    expect(errors).toEqual([]);
  });

  test('llave de acceso: se añade en Mi cuenta y después se entra con ella, sin email', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

    const email = uniqueEmail('llave');
    await signIn(page, email, '/mi-cuenta/privacidad');
    await page.getByLabel('Nombre de la llave (opcional)').fill('Ordenador de pruebas');
    const added = Date.now();
    await page.getByRole('button', { name: 'Añadir una llave en este dispositivo' }).click();
    await firstAction(page.getByText('Llave añadida.', { exact: false })).toBeVisible();
    // Aviso de seguridad por email y rastro en la auditoría (auditoría del 3.7, I3).
    // El código de acceso de la sesión llega justo antes: se espera el aviso de la llave, no el primer email que haya.
    expect(await emailTo(email, added, (text) => text.includes('Se ha añadido una llave de acceso a tu cuenta'))).toContain('Se ha añadido una llave de acceso a tu cuenta');
    const audited = await withE2eDb(async (db) => (await db.query(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'account.passkey_added' AND "actorUserId" = (SELECT id FROM "User" WHERE email = $1)`, [email])).rows[0].n as number);
    expect(audited).toBe(1);
    await expect(page.locator('#security')).toContainText('Ordenador de pruebas');

    // «Cerrar sesión» está en la página principal de Mi cuenta (Sprint 5.10b, `R-52`).
    await page.goto('/mi-cuenta');
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await server(page).toHaveURL(/\/$/);
    await page.goto(`/login?next=${encodeURIComponent('/mi-cuenta')}`);
    await page.getByTestId('passkey-sign-in').click();
    await server(page).toHaveURL(/\/mi-cuenta$/);
    await expect(page.getByText(`Has entrado como ${email}`)).toBeVisible();
    // Entrar con la llave cuenta como segundo factor (verificación de la persona en el dispositivo).
    const proof = await withE2eDb(async (db) => (await db.query(`SELECT "secondFactorVerifiedAt" FROM "Session" WHERE "userId" = (SELECT id FROM "User" WHERE email = $1) ORDER BY "createdAt" DESC LIMIT 1`, [email])).rows[0]);
    expect(proof.secondFactorVerifiedAt).not.toBeNull();
    expect(errors).toEqual([]);
  });

  test('suprimir mi cuenta: explica lo que se conserva, pide confirmar y deja la cuenta anonimizada', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('suprime');
    await seedPurchases(email);
    await signIn(page, email, '/mi-cuenta/privacidad');
    const block = page.getByTestId('erase-account');
    await expect(block).toContainText('Por ley conservamos');
    // Textos de la supresión (`L-010`): quién conserva los datos fiscales y por qué.
    await expect(block).toContainText('KORUM conserva por cuenta de la entidad');
    const button = block.getByRole('button', { name: 'Suprimir mi cuenta' });
    await expect(button).toBeDisabled();
    await block.getByText('Entiendo que mi cuenta se borra para siempre').click();
    await button.click();
    await firstAction(page.getByRole('heading', { name: 'Tu cuenta se ha suprimido' })).toBeFocused();

    const user = await withE2eDb(async (db) => (await db.query(`SELECT "gdprAnonymizedAt" FROM "User" WHERE "canonicalEmail" LIKE 'suprimida-%' AND id IN (SELECT "userId" FROM "PrivacyRequest" WHERE type = 'ERASURE' AND status = 'COMPLETED') ORDER BY "updatedAt" DESC LIMIT 1`)).rows[0]);
    expect(user.gdprAnonymizedAt).not.toBeNull();
    expect(await withE2eDb(async (db) => (await db.query(`SELECT count(*)::int AS n FROM "User" WHERE email = $1`, [email])).rows[0].n)).toBe(0);
    await page.goto('/mi-cuenta');
    await server(page).toHaveURL(/\/login\?next=%2Fmi-cuenta$/);
    expect(errors).toEqual([]);
  });

  test('cambiar el email: código al email nuevo, lo comprado pasa con él, aviso al antiguo; accesible y en una columna', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('cambia');
    const { initiativeTitle } = await seedPurchases(email);
    await signIn(page, email, '/mi-cuenta/privacidad');
    const block = page.getByTestId('change-email');
    await expect(block).toContainText(`Tu email: ${email}`);
    await block.getByTestId('change-email-start').click();
    const input = block.getByLabel('Tu email nuevo');
    await expect(input).toBeFocused();
    // Un email de correo temporal se rechaza con un aviso claro.
    await input.fill(`${randomUUID().slice(0, 8)}@mailinator.com`);
    await block.getByTestId('change-email-send').click();
    await expect(block.getByRole('alert')).toContainText('correo temporal');
    const newEmail = uniqueEmail('nuevo');
    await input.fill(newEmail);
    const since = Date.now();
    await block.getByTestId('change-email-send').click();
    await firstAction(block.getByRole('status')).toContainText(`Te hemos enviado un código a ${newEmail}`);
    await expectNoSeriousA11yViolations(page);
    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    await block.getByLabel('Código del email nuevo').fill(await codeTo(newEmail, since));
    await block.getByTestId('change-email-confirm').click();
    await firstAction(block.getByTestId('change-email-done')).toContainText(newEmail);
    // El email antiguo recibe el aviso, y lo comprado con él aparece ahora con el nuevo.
    const notice = await emailTo(email, since, (text) => text.includes('El email de tu cuenta de KORUM ha cambiado'));
    expect(notice).not.toContain(newEmail);
    const stored = await withE2eDb(async (db) => (await db.query(`SELECT email FROM "User" WHERE email = $1`, [newEmail])).rows.length);
    expect(stored).toBe(1);
    await page.goto('/mi-cuenta');
    await expect(page.getByText(`Has entrado como ${newEmail}`)).toBeVisible();
    await expect(page.locator('#contributions').getByRole('link', { name: initiativeTitle })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoMissingTranslations(page);

    // «No he sido yo»: el enlace del aviso al email antiguo devuelve la cuenta a ese email y cierra todas las sesiones.
    const revertPath = /\/cuenta\/recuperar-email#t=[\w.-]+/.exec(notice)?.[0];
    expect(revertPath, 'el aviso lleva el enlace «No he sido yo»').toBeTruthy();
    await page.goto(revertPath!);
    await expect(page.getByRole('heading', { level: 1, name: 'No he sido yo' })).toBeVisible();
    await expect(page).toHaveURL(/\/cuenta\/recuperar-email$/);
    await expectNoSeriousA11yViolations(page);
    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    await page.getByTestId('email-revert-confirm').click();
    await firstAction(page.getByTestId('email-revert-done')).toContainText(email);
    expect(await withE2eDb(async (db) => (await db.query(`SELECT count(*)::int AS n FROM "User" WHERE email = $1`, [email])).rows[0].n)).toBe(1);
    await page.goto('/mi-cuenta');
    await server(page).toHaveURL(/\/login\?next=%2Fmi-cuenta$/);
    expect(errors).toEqual([]);
  });
});
