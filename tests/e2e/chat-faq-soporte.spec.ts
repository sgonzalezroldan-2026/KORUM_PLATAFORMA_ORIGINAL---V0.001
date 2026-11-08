import { expect, test, type Page } from '@playwright/test';
import { codeTo, uniqueEmail, withE2eDb } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F06 · FAQ y soporte, y chat anónimo `#FAM-XXXX` con «Mis firmas», como una persona real (Sprint 3.9). Datos de la semilla: Cervantes
 * (`cervantes`). Las ideas del chat se crean aquí con la base de pruebas, con el email de quien las propone, y las respuestas del centro también
 * (el panel que las escribe llega en el Sprint 4.2). Los códigos de acceso se leen de `.email-preview/`.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const server = expect.configure({ timeout: 30_000 });
/** La primera vez que se llama a una acción de servidor, el servidor de desarrollo compila la ruta y sus dependencias. */
const firstAction = expect.configure({ timeout: 120_000 });

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  for (const path of ['/cervantes/ayuda', '/ca/cervantes/ayuda', '/en/cervantes/ayuda', '/login', '/mi-cuenta', '/mi-cuenta/propuestas']) {
    await request.get(path, { timeout: 120_000 }).catch(() => undefined);
  }
});

/** Cada persona entra desde su propia red (cabecera del proxy): el acceso tiene un tope por red y todas las pruebas salen del mismo ordenador. */
async function signIn(page: Page, email: string, next: string) {
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

const ageReauthentication = (email: string) =>
  withE2eDb((db) => db.query(`UPDATE "Session" SET "reauthenticatedAt" = now() - interval '20 minutes', "secondFactorVerifiedAt" = NULL WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`, [email]));

async function createProposal(email: string, title: string, phase = 'PUBLIC_VOTING'): Promise<number> {
  return withE2eDb(async (db) => {
    const result = await db.query(
      `INSERT INTO "Idea" ("organizationId", "alias", "authorCanonicalEmail", "title", "category", "description", "phase", "votes", "verifiedVotes", "suspiciousVotes", "expiresAt")
       VALUES ('CERVANTES', $1, $2, $3, 'Patios y Deporte', 'Hace falta sombra en el recreo para todo el alumnado', $4::"IdeaPhase", 4, 4, 0, now() + interval '20 days') RETURNING id`,
      [`#FAM-${Math.floor(1000 + Math.random() * 8999)}`, email.toLowerCase(), title, phase]
    );
    const id = result.rows[0].id as number;
    await db.query(`INSERT INTO "IdeaMessage" ("ideaId", "senderRole", "senderLabel", "body") VALUES ($1, 'SYSTEM', 'KORUM', 'Propuesta registrada.'), ($1, 'ORGANIZATION', 'Dirección del centro', 'Gracias por la idea, la revisamos esta semana.')`, [id]);
    return id;
  });
}

test.describe('QA-F06 · FAQ y soporte (público)', () => {
  test('sin sesión: preguntas en desplegables, aviso para entrar a escribir, datos estructurados, accesible y en una columna en móvil', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/cervantes');
    await page.getByRole('navigation', { name: 'Secciones de la comunidad' }).getByRole('link', { name: /FAQ y soporte/ }).click();
    await expect(page).toHaveURL(/\/cervantes\/ayuda$/, { timeout: 45_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preguntas frecuentes y soporte');
    await expect(page.getByRole('navigation', { name: 'Secciones de la comunidad' }).locator('[aria-current="page"]')).toContainText('FAQ y soporte');

    const items = page.getByTestId('faq-item');
    expect(await items.count()).toBeGreaterThanOrEqual(8);
    await expect(items.first()).toHaveAttribute('open', '');
    await expect(items.nth(1)).not.toHaveAttribute('open', '');
    await items.nth(1).getByText(/Pueden firmar el padre y la madre/).click();
    await expect(items.nth(1)).toContainText('Hasta dos cuentas familiares');
    await page.getByText('¿Quién guarda el dinero?').click();
    await expect(page.getByText(/PAYCOMET, entidad de pago autorizada por el Banco de España/).first()).toBeVisible();
    // Vocabulario prohibido en público (Regla 03 §4).
    await expect(page.locator('main')).not.toContainText(/propina|escrow|exención CNMV|garantizado por ley/i);

    const structured = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(structured.some((json) => json.includes('"FAQPage"'))).toBe(true);

    await expect(page.getByTestId('support-login')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Iniciar sesión' }).last()).toHaveAttribute('href', /\/login\?next=%2Fcervantes%2Fayuda/);
    await expect(page.getByLabel('Tu mensaje')).toHaveCount(0);

    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    await expectNoHorizontalOverflow(page);
    if ((page.viewportSize()?.width ?? 1440) < 768) await expectMobileStackIsOneColumn(page);
    expect(errors).toEqual([]);
  });

  test('en catalán y en inglés: textos traducidos, sin claves sueltas y con el idioma en la URL', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/ca/cervantes/ayuda');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preguntes freqüents i suport');
    await expect(page.getByRole('navigation', { name: 'Seccions de la comunitat' }).getByRole('link', { name: /Bústia d’idees/ })).toBeVisible();
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    await page.goto('/en/cervantes/ayuda');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Frequently asked questions and support');
    await expect(page.getByText('Sign in to write to us')).toBeVisible({ timeout: 30_000 });
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('una entidad que no existe responde 404 de verdad', async ({ request }) => {
    expect((await request.get('/entidad-que-no-existe/ayuda')).status()).toBe(404);
  });
});

test.describe('QA-F06 · escribir al soporte', () => {
  test('con sesión: envía la consulta, recibe su código y la ve en Mi cuenta; corregir datos pide confirmar la identidad y abre la solicitud', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('soporte');
    await signIn(page, email, '/cervantes/ayuda');

    const form = page.locator('form').filter({ has: page.getByLabel('Tu mensaje') });
    await expect(form.getByLabel('Sobre qué quieres preguntar')).toBeVisible({ timeout: 30_000 });
    // Campos vacíos o demasiado cortos: el servidor lo rechaza con un aviso en texto, junto al formulario.
    await form.getByLabel('Asunto').fill('Hola');
    await form.getByLabel('Tu mensaje').fill('Corto');
    await form.getByRole('button', { name: 'Enviar consulta' }).click();
    await firstAction(page.getByRole('alert').filter({ hasText: 'Revisa el asunto' })).toBeVisible();

    await expect(form.getByTestId('support-routing')).toHaveText('Te contestará el centro.');
    await form.getByLabel('Sobre qué quieres preguntar').selectOption('PAYMENT');
    await expect(form.getByTestId('support-routing')).toHaveText('Te contestará el equipo de KORUM.');
    await form.getByLabel('Asunto').fill('No veo mi devolución');
    await form.getByLabel('Tu mensaje').fill('Hice una aportación hace dos semanas y todavía no me ha llegado la devolución.');
    await expect(form.getByText('78 de 2000 caracteres')).toBeVisible();
    await form.getByRole('button', { name: 'Enviar consulta' }).click();
    const sent = page.getByTestId('support-sent');
    await firstAction(sent).toBeVisible();
    await expect(sent.getByRole('heading', { name: 'Consulta enviada' })).toBeFocused();
    const code = /TCK-[A-HJKMNP-Z2-9]{6}/.exec((await sent.textContent()) ?? '')?.[0];
    expect(code).toBeTruthy();
    await expectNoSeriousA11yViolations(page);

    await withE2eDb(async (db) => {
      const row = (await db.query(`SELECT "target", "topic", "status", "senderEmail" FROM "SupportTicket" WHERE "ticketCode" = $1`, [code])).rows[0];
      expect(row).toMatchObject({ target: 'SUPERADMIN', topic: 'PAYMENT', status: 'OPEN', senderEmail: email });
      expect((await db.query(`SELECT 1 FROM "OutboxMessage" WHERE "idempotencyKey" = $1`, [`support.received:${code}`])).rowCount).toBe(1);
    });

    // El acuse de la primera consulta sale por la bandeja: se espera a que salga para que no se confunda con el código de acceso del paso siguiente.
    await expect
      .poll(() => withE2eDb(async (db) => (await db.query(`SELECT "status" FROM "OutboxMessage" WHERE "idempotencyKey" = $1`, [`support.received:${code}`])).rows[0]?.status), { timeout: 60_000 })
      .toBe('SENT');

    // Corregir mis datos: con la identidad confirmada hace más de 10 minutos, primero el código por email.
    await sent.getByRole('button', { name: 'Escribir otra consulta' }).click();
    await ageReauthentication(email);
    await form.getByLabel('Sobre qué quieres preguntar').selectOption('RECTIFICATION');
    await expect(form.getByText(/solicitud de rectificación con plazo de un mes/)).toBeVisible();
    await form.getByLabel('Asunto').fill('Corregir mi apellido');
    await form.getByLabel('Tu mensaje').fill('Mi segundo apellido está mal escrito en la cuenta y en los justificantes.');
    await form.getByRole('button', { name: 'Enviar consulta' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirma que eres tú' });
    await expect(dialog).toBeVisible();
    const since = Date.now();
    await dialog.getByRole('button', { name: 'Enviar código' }).click();
    await dialog.getByLabel('Código de 6 dígitos').fill(await codeTo(email, since));
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await firstAction(page.getByTestId('support-sent')).toContainText('solicitud de rectificación');

    await page.goto('/mi-cuenta');
    const tickets = page.getByTestId('support-list');
    await expect(tickets).toContainText(code!);
    await expect(tickets).toContainText('No veo mi devolución');
    await expect(tickets).toContainText('Recibida');
    await expect(page.locator('#privacy')).toContainText('Rectificación');
    await expectNoSeriousA11yViolations(page);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});

test.describe('QA-F06 · mis propuestas, chat anónimo y mis firmas', () => {
  test('quien propuso ve su chat con el centro, escribe, se frena tras tres mensajes sin respuesta y solo él lo ve; las firmadas salen en «Mis firmas»', async ({ page, browser }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('propone');
    const title = `Toldo del patio ${testInfo.project.name} ${Date.now().toString(36)}`;
    const signedTitle = `Fuente firmada ${testInfo.project.name} ${Date.now().toString(36)}`;
    const ideaId = await createProposal(email, title);
    const signedId = await createProposal(uniqueEmail('otro'), signedTitle);
    // Un tercero entra primero: su firma se registra con el email de quien luego mira «Mis firmas».
    await signIn(page, email, '/mi-cuenta/propuestas');
    await withE2eDb((db) =>
      db.query(`INSERT INTO "IdeaSignatureAudit" ("ideaId", "userId", "canonicalEmail", "reason", "status") VALUES ($1, (SELECT id FROM "User" WHERE email = $2), $3, 'ideas.audit.firstAccount', 'SUSPICIOUS')`, [signedId, email, email.toLowerCase()])
    );
    await page.reload();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mis propuestas y firmas');
    const mine = page.getByTestId('my-proposal').filter({ hasText: title });
    await expect(mine).toBeVisible();
    await expect(mine.getByTestId('proposal-alias')).toHaveText(/#FAM-\d{4}/);
    await expect(mine).toContainText('Abierta a firmas');
    const log = mine.getByRole('log');
    await expect(log).toContainText('Dirección del centro');
    await expect(log).toContainText('Gracias por la idea, la revisamos esta semana.');
    await expect(page.locator('main')).not.toContainText(email);
    // Desde el buzón de ideas se llega al chat.
    await page.goto('/cervantes/ideas');
    await expect(page.getByRole('link', { name: /Mis propuestas y mensajes con el centro/ })).toHaveAttribute('href', '/mi-cuenta/propuestas');
    await page.goto('/mi-cuenta/propuestas');

    // «Mis firmas»: la idea firmada, sin decir que la firma está en revisión.
    const signatures = page.getByTestId('signatures-list');
    await expect(signatures).toContainText(signedTitle);
    await expect(signatures).not.toContainText(/revisi[oó]n|sospech|SUSPICIOUS/i);
    await expect(signatures.getByRole('link', { name: /Ir al buzón de CEIP Cervantes/ }).first()).toHaveAttribute('href', '/cervantes/ideas');

    // Escribe tres mensajes: el centro ya respondió, así que caben tres más; el cuarto espera.
    const field = mine.getByLabel('Escribir un mensaje al centro');
    for (const text of ['Primer mensaje de la familia', 'Segundo mensaje de la familia', 'Tercer mensaje de la familia']) {
      await field.fill(text);
      await mine.getByRole('button', { name: 'Enviar mensaje' }).click();
      await firstAction(log).toContainText(text);
      // Mientras cabe otro mensaje, el foco sigue en el campo; al enviar el último, pasa al aviso de espera.
      if (text.startsWith('Tercer')) await expect(mine.getByTestId('chat-blocked')).toBeFocused();
      else await expect(field).toBeFocused();
    }
    await expect(log.getByText(/Tú \(#FAM-\d{4}\)/)).toHaveCount(3);
    await expect(mine.getByTestId('chat-blocked')).toContainText('Cuando responda');
    await expect(mine.getByLabel('Escribir un mensaje al centro')).toHaveCount(0);

    // El centro responde (lo hará el panel, Sprint 4.2): se libera.
    await withE2eDb((db) => db.query(`INSERT INTO "IdeaMessage" ("ideaId", "senderRole", "senderLabel", "body") VALUES ($1, 'ORGANIZATION', 'Dirección del centro', 'Os contestamos en cuanto lo veamos.')`, [ideaId]));
    await page.reload();
    await expect(mine.getByLabel('Escribir un mensaje al centro')).toBeVisible();

    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);

    // Resumen en Mi cuenta.
    await page.goto('/mi-cuenta');
    await expect(page.getByTestId('ideas-summary')).toContainText('1 propuesta y 1 firma');

    // Otra persona no ve nada de esto, ni sus mensajes ni su idea.
    const stranger = await browser.newContext();
    const other = await stranger.newPage();
    await signIn(other, uniqueEmail('ajena'), '/mi-cuenta/propuestas');
    await expect(other.getByTestId('my-proposal')).toHaveCount(0);
    await expect(other.getByText('Todavía no has propuesto ninguna idea')).toBeVisible();
    await expect(other.locator('main')).not.toContainText(title);
    await stranger.close();
  });

  test('sin sesión, las páginas de la cuenta llevan a entrar', async ({ page }) => {
    await page.goto('/mi-cuenta/propuestas');
    await expect(page).toHaveURL(/\/login\?next=/, { timeout: 45_000 });
  });
});
