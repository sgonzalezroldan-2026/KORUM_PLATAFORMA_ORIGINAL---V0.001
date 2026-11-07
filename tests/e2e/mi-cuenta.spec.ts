import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { codeIn, emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F06 (Mi cuenta), QA-PRIV01 y QA-REG03 como una persona real (Sprint 3.7). Cada proyecto crea su propia familia: compra como invitada una
 * donación y una entrada en Cervantes (semilla, Ley 49/2002 verificada) y luego entra con el código de su email, así se comprueba también que lo
 * comprado con ese email aparece en su cuenta. Los códigos se leen de `.email-preview/`.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const server = expect.configure({ timeout: 30_000 });
const firstAction = expect.configure({ timeout: 120_000 });

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  for (const path of ['/mi-cuenta', '/ca/mi-cuenta', '/mi-cuenta/certificados', '/login', '/acceso/continuar']) await request.get(path, { timeout: 120_000 }).catch(() => undefined);
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
  await page.getByLabel('Código de 6 dígitos').fill(codeIn(await emailTo(email, since)));
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
    await signIn(page, email);

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
    await dialog.getByLabel('Código de 6 dígitos').fill(codeIn(await emailTo(email, since)));
    const pdf = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.locator('#privacy')).toContainText('Descarga de datos');
    expect(errors).toEqual([]);
  });

  test('idioma de la cuenta: pasa a catalán por URL y lo guarda para los emails', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('idioma');
    await signIn(page, email);
    await page.getByLabel('Idioma de la cuenta').selectOption('ca');
    await page.getByRole('button', { name: 'Guardar idioma' }).click();
    await server(page).toHaveURL(/\/ca\/mi-cuenta/);
    await expect(page.getByRole('heading', { level: 1, name: 'El meu compte' })).toBeVisible();
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
    await signIn(page, email);
    await page.getByLabel('Nombre de la llave (opcional)').fill('Ordenador de pruebas');
    const added = Date.now();
    await page.getByRole('button', { name: 'Añadir una llave en este dispositivo' }).click();
    await firstAction(page.getByText('Llave añadida.', { exact: false })).toBeVisible();
    // Aviso de seguridad por email y rastro en la auditoría (auditoría del 3.7, I3).
    expect(await emailTo(email, added)).toContain('Se ha añadido una llave de acceso a tu cuenta');
    const audited = await withE2eDb(async (db) => (await db.query(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'account.passkey_added' AND "actorUserId" = (SELECT id FROM "User" WHERE email = $1)`, [email])).rows[0].n as number);
    expect(audited).toBe(1);
    await expect(page.locator('#security')).toContainText('Ordenador de pruebas');

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
    await signIn(page, email);
    const block = page.getByTestId('erase-account');
    await expect(block).toContainText('Por ley conservamos');
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
});
