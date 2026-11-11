import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildPassQrPayload, signPass } from '@/core/ticketing/qr-signature';
import { verifyDrawAct } from '@/core/ticketing/raffle-draw';
import { withE2eDb } from './auth-support';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { activateCosigner, registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 4.5 · Portería móvil y sorteo certificado (QA-S04, QA-F06, QA-SEC05, QA-SEC09), como personas reales con la compilación de producción:
 *  - quien dirige crea el PIN de la puerta en «Taquilla y portería»; un voluntario sin cuenta entra con él desde otro navegador, lee pases (por código
 *    escrito, como haría un lector con teclado), elige cuántas personas entran, ve la alerta roja de un pase usado, una firma falsa y el aforo en directo;
 *  - sin cobertura valida con la lista descargada, guarda las lecturas y las envía al volver la red, y un conflicto (otro móvil ya había dejado entrar el pase)
 *    queda a la vista; quien dirige cierra la sesión y el móvil lo sabe;
 *  - el sorteo de una rifa se proyecta, saca los premios entre las papeletas pagadas y deja un acta que se puede descargar y comprobar; antes del día del evento
 *    no se abre; la cámara solo se concede a la portería.
 * Catalán, axe, 430 px y sin errores de consola.
 */

const server = expect.configure({ timeout: 30_000 });
const QR_SECRET = E2E_SERVER_ENV.QR_HMAC_SECRET!;

test.describe.configure({ timeout: 420_000 });
// Cámara de pruebas del navegador (un vídeo sintético) y permiso concedido a las personas de portería que se crean a mano.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

interface SeedPass {
  uuid: string;
  payload: string;
  quantity: number;
  numbers: number[];
}

const octet = () => 1 + Math.floor(Math.random() * 250);

/** Un evento o una rifa con venta de entradas en la entidad de la prueba, con sus pases ya pagados. */
async function createTicketEvent(slug: string, options: { title: string; subtype: 'EVENT' | 'RAFFLE'; quantities: number[]; closes: 'today' | 'future'; prizes?: number }): Promise<{ id: number; passes: SeedPass[] }> {
  const total = options.quantities.reduce((sum, quantity) => sum + quantity, 0);
  const raffle = options.subtype === 'RAFFLE';
  return withE2eDb(async (db) => {
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "stepIndex", "closesAt", "quarter", "goalCents", "description",
         "ticketSubtype", "ticketPriceCents", "ticketMax", "ticketsSold", "ticketFeeMode", "rafflePrizeCount", "ticketVenue", "raisedCents", "updatedAt")
       VALUES ($1, 'TICKETING'::"InitiativeFormat", (SELECT id FROM "Organization" WHERE slug = $2), '2026-2027', $3, 'Fiesta', 'Infantil', $4::"InitiativeStatus", $5,
         ${options.closes === 'today' ? 'now()' : "now() + interval '3 days'"}, '2026-Q4', $6, 'Prueba E2E de portería', $7::"TicketSubtype", 500, $8, $9, 'ADD'::"TicketFeeMode", $10, 'Patio central', $11, now())
       RETURNING id`,
      [walletId, slug, options.title, raffle ? 'GOAL_REACHED' : 'FUNDRAISING', raffle ? 5 : 4, total * 500, options.subtype, raffle ? total : total + 50, total, raffle ? (options.prizes ?? 1) : null, raffle ? total * 500 : 0]
    );
    const initiativeId = Number(rows[0].id);
    const passes: SeedPass[] = [];
    let nextNumber = 1;
    for (const quantity of options.quantities) {
      const uuid = randomUUID();
      const email = `familia-${uuid.slice(0, 8)}@pruebas.example`;
      const contribution = await db.query(
        `INSERT INTO "Contribution" ("organizationId", "initiativeId", "guestEmail", "canonicalEmail", "fiscalYear", "type", "ticketQuantity", "amountCents", "totalChargedCents", "paymentMethod", "status", "paycometOrder")
         VALUES ((SELECT id FROM "Organization" WHERE slug = $1), $2, $3, $3, 2026, 'TICKET'::"ContributionType", $4, $5, $5, 'BIZUM'::"PaymentMethod", 'COMPLETED'::"ContributionStatus", $6) RETURNING id`,
        [slug, initiativeId, email, quantity, quantity * 500, `KT${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`]
      );
      const numbers = raffle ? Array.from({ length: quantity }, () => nextNumber++) : [];
      const pass = await db.query(
        `INSERT INTO "TicketPass" ("uuid", "contributionId", "initiativeId", "serialCode", "subtype", "holderEmail", "quantity", "raffleNumbers", "qrHmacSignature")
         VALUES ($1, $2, $3, $4, $5::"TicketSubtype", $6, $7, $8, $9) RETURNING id`,
        [uuid, contribution.rows[0].id, initiativeId, `${raffle ? 'RIFA' : 'PASE'}-2026-${uuid.slice(0, 6).toUpperCase()}`, options.subtype, email, quantity, numbers, signPass(QR_SECRET, uuid)]
      );
      for (const number of numbers) await db.query(`INSERT INTO "RaffleNumber" ("initiativeId", "number", "ticketPassId") VALUES ($1, $2, $3)`, [initiativeId, number, pass.rows[0].id]);
      passes.push({ uuid, payload: buildPassQrPayload(QR_SECRET, uuid), quantity, numbers });
    }
    return { id: initiativeId, passes };
  });
}

/** Un móvil de voluntario: otro navegador, sin cuenta, desde su propia red, con la cámara permitida y la vibración anotada. */
async function volunteerPhone(browser: Browser, isMobile: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3100}`,
    viewport: isMobile ? { width: 430, height: 932 } : { width: 1440, height: 900 },
    isMobile,
    hasTouch: isMobile,
    permissions: ['camera'],
    extraHTTPHeaders: { 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` }
  });
  await context.addInitScript(() => {
    const record: unknown[] = [];
    (window as unknown as { __vibrations: unknown[] }).__vibrations = record;
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern: unknown) => (record.push(pattern), true) });
  });
  return { context, page: await context.newPage() };
}

/** Quien dirige crea el PIN de un evento en «Taquilla y portería» y lo lee de la pantalla. */
async function createPin(page: Page, slug: string, title: string): Promise<string> {
  await page.goto(`/panel/${slug}/taquilla`);
  const card = page.getByTestId('gate-admin-event').filter({ has: page.getByRole('heading', { name: title }) });
  await server(card).toBeVisible();
  await card.getByRole('button', { name: 'Crear el PIN de la puerta' }).click();
  const pinBox = card.getByTestId('gate-admin-pin');
  await server(pinBox).toBeVisible();
  const pin = (await pinBox.getByTestId('gate-admin-pin-digits').innerText()).trim();
  expect(pin).toMatch(/^\d{6}$/);
  return pin;
}

/** El código no adivinable de la puerta de un evento (se genera al crear su primer PIN): es lo que lleva el enlace de la portería. */
const gateCodeOf = async (initiativeId: number): Promise<string> => (await withE2eDb((db) => db.query(`SELECT "gateCode" FROM "Initiative" WHERE id = $1`, [initiativeId]))).rows[0].gateCode as string;

async function enterGate(page: Page, slug: string, gateCode: string, pin: string, device?: string) {
  await page.goto(`/panel/${slug}/porteria/${gateCode}`);
  await page.getByLabel('PIN del evento').fill(pin);
  if (device) await page.getByLabel('Nombre de este móvil (opcional)').fill(device);
  await page.getByRole('button', { name: 'Entrar en la portería' }).click();
}

const result = (page: Page) => page.getByTestId('gate-result');

async function scan(page: Page, payload: string) {
  await page.getByLabel('Código del pase').fill(payload);
  await page.getByRole('button', { name: 'Comprobar pase' }).click();
}

async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
}

const forged = (payload: string) => `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;

test.describe('Sprint 4.5 · portería móvil', () => {
  test('PIN en el panel → lector con cámara y código → parcial, alerta roja y firma falsa → sin cobertura y conflicto → cierre de sesión', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    // 1 y 2 plazas sueltas (sin red), un grupo de 4 (parcial), un pase para el conflicto y uno que se usa entero: 1 + 4 + 1 + 2 + 1 = 9.
    const event = await createTicketEvent(entity.slug, { title: 'Fiesta de fin de curso', subtype: 'EVENT', quantities: [1, 4, 1, 2, 1], closes: 'future' });
    const [single, group, offlineOne, conflict, spare] = event.passes as [SeedPass, SeedPass, SeedPass, SeedPass, SeedPass];

    // --- Quien dirige: «Taquilla y portería» ---
    await page.goto(`/panel/${entity.slug}/taquilla`);
    await server(page.getByRole('heading', { level: 1, name: 'Taquilla y portería' })).toBeVisible();
    await expect(page.getByText('Esta puerta aún no tiene PIN: ningún voluntario puede abrir la portería todavía.')).toBeVisible();
    await checkPage(page, isMobile);
    const pin = await createPin(page, entity.slug, 'Fiesta de fin de curso');
    await expect(page.getByTestId('gate-admin-pin')).toContainText('no se vuelve a mostrar');
    const eventCode = await gateCodeOf(event.id);
    expect(eventCode).toMatch(/^[a-z2-7]{10}$/);
    // El enlace del panel lleva el código, no el identificador, y la dirección con el identificador no abre nada ni lista eventos.
    await expect(page.getByTestId('gate-admin-link')).toHaveAttribute('href', new RegExp(`/porteria/${eventCode}$`));
    expect((await page.request.get(`/panel/${entity.slug}/porteria/${event.id}`)).status()).toBe(404);
    expect((await page.request.get(`/panel/${entity.slug}/porteria/abcdefghij`)).status()).toBe(404);
    await page.goto(`/panel/${entity.slug}/porteria`);
    await expect(page.getByRole('heading', { level: 1, name: 'Portería de eventos' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Fiesta de fin de curso');
    await page.goto(`/panel/${entity.slug}/taquilla`);
    // El PIN se enseñó una vez: al volver a la pantalla ya no está.
    await expect(page.getByTestId('gate-admin-pin')).toHaveCount(0);

    // --- El voluntario: otro móvil, sin cuenta ---
    const phone = await volunteerPhone(browser, isMobile);
    const volunteer = phone.page;
    const volunteerErrors = trackConsoleErrors(volunteer);
    await volunteer.goto(`/panel/${entity.slug}/porteria/${eventCode}`);
    await volunteer.getByLabel('PIN del evento').fill(pin === '000000' ? '000001' : '000000');
    await volunteer.getByRole('button', { name: 'Entrar en la portería' }).click();
    await server(volunteer.getByText('El PIN no es correcto o ya no está activo.')).toBeVisible();
    await volunteer.getByLabel('PIN del evento').fill(pin);
    await volunteer.getByLabel('Nombre de este móvil (opcional)').fill('Puerta norte');
    await volunteer.getByRole('button', { name: 'Entrar en la portería' }).click();
    await server(volunteer.getByRole('heading', { name: 'Aforo en directo' })).toBeVisible();
    await expect(volunteer.getByTestId('gate-capacity')).toContainText('0 / 9 asistentes dentro del recinto');
    await expect(volunteer.locator('main')).not.toContainText('€');
    await expect(volunteer.getByTestId('gate-list-info')).toContainText('Lista de 5 pases descargada', { timeout: 30_000 });
    await checkPage(volunteer, isMobile);

    // La cámara solo se concede a la portería: con ella permitida, el lector arranca y enseña la ayuda.
    const portería = await volunteer.request.get(`/panel/${entity.slug}/porteria/${eventCode}`);
    expect(portería.headers()['permissions-policy']).toContain('camera=(self)');
    expect((await volunteer.request.get('/')).headers()['permissions-policy']).toContain('camera=()');
    await volunteer.getByTestId('gate-camera-start').click();
    await server(volunteer.getByText('Apunta al código QR de la entrada.')).toBeVisible();
    await expect(volunteer.getByLabel('Imagen de la cámara')).toBeVisible();
    await volunteer.getByRole('button', { name: 'Apagar la cámara' }).click();

    // --- Un pase de una persona entra de una vez ---
    await scan(volunteer, single.payload);
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'ACCEPTED');
    await expect(result(volunteer)).toContainText('Entran 1 · pase de 1 · pase completo');
    await expect(volunteer.getByTestId('gate-capacity')).toContainText('1 / 9');

    // --- Un pase de 4: pregunta cuántas entran (parcial, «Entran 3 de 4»), y la última persona entra sin preguntar ---
    await volunteer.getByTestId('gate-next').click();
    await scan(volunteer, group.payload);
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'CHOOSE');
    await expect(volunteer.getByRole('heading', { name: '¿Cuántas personas entran?' })).toBeVisible();
    await expect(volunteer.getByTestId('gate-people')).toHaveText('4');
    await volunteer.getByRole('button', { name: 'Una persona menos' }).click();
    await volunteer.getByRole('button', { name: 'Dejar entrar a 3 personas' }).click();
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'ACCEPTED');
    await expect(result(volunteer)).toContainText('Entran 3 · pase de 4 · queda 1 por entrar');
    await expect(volunteer.getByTestId('gate-capacity')).toContainText('4 / 9');
    await volunteer.getByTestId('gate-next').click();
    await scan(volunteer, group.payload);
    await expect(result(volunteer)).toContainText('pase completo');
    await expect(volunteer.getByTestId('gate-capacity')).toContainText('5 / 9');

    // --- Alerta roja: pase ya usado, con la hora del primer acceso, y vibración larga ---
    await volunteer.getByTestId('gate-next').click();
    await scan(volunteer, group.payload);
    const red = volunteer.getByRole('alert').filter({ has: volunteer.getByRole('heading', { name: 'ALERTA ROJA: PASE YA UTILIZADO' }) });
    await expect(red).toBeVisible();
    await expect(red).toHaveText(/Primer acceso a las \d{1,2}:\d{2}/);
    expect((await volunteer.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations)).some((pattern) => Array.isArray(pattern) && pattern.length >= 3)).toBe(true);
    await checkPage(volunteer, isMobile);
    await volunteer.getByTestId('gate-next').click();

    // --- Una firma alterada ---
    await scan(volunteer, forged(spare.payload));
    await expect(volunteer.getByRole('heading', { name: 'FIRMA INVÁLIDA' })).toBeVisible();
    await volunteer.getByTestId('gate-next').click();

    // --- El mismo móvil en catalán ---
    await volunteer.goto(`/ca/panel/${entity.slug}/porteria/${eventCode}`);
    await server(volunteer.getByRole('heading', { name: 'Aforament en directe' })).toBeVisible();
    await expect(volunteer.getByTestId('gate-capacity')).toContainText('5 / 9 assistents dins del recinte');
    await expectNoMissingTranslations(volunteer);
    await volunteer.goto(`/panel/${entity.slug}/porteria/${eventCode}`);
    await server(volunteer.getByRole('heading', { name: 'Aforo en directo' })).toBeVisible();
    await expect(volunteer.getByTestId('gate-list-info')).toContainText('Lista de 5 pases descargada', { timeout: 30_000 });

    // --- Sin cobertura: se valida con la lista y las lecturas esperan ---
    await phone.context.setOffline(true);
    await expect(volunteer.getByTestId('gate-offline')).toBeVisible();
    await scan(volunteer, offlineOne.payload);
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'ACCEPTED');
    await expect(result(volunteer)).toContainText('Guardado en este móvil');
    await expect(volunteer.getByTestId('gate-pending')).toContainText('1 lectura pendiente de enviar');
    await volunteer.getByTestId('gate-next').click();
    await scan(volunteer, conflict.payload);
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'CHOOSE');
    await volunteer.getByRole('button', { name: 'Dejar entrar a 2 personas' }).click();
    await expect(result(volunteer)).toContainText('Entran 2 · pase de 2 · pase completo');
    await expect(volunteer.getByTestId('gate-pending')).toContainText('2 lecturas pendientes de enviar');
    await expect(volunteer.getByTestId('gate-capacity')).toContainText('8 / 9');
    await volunteer.getByTestId('gate-next').click();
    // El mismo pase otra vez, sin red: ya se usó en este móvil. Una firma falsa: no está en la lista.
    await scan(volunteer, offlineOne.payload);
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'EXHAUSTED');
    await volunteer.getByTestId('gate-next').click();
    await scan(volunteer, forged(spare.payload));
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'UNKNOWN');
    await expect(result(volunteer)).toContainText('No está en la lista descargada');
    await volunteer.getByTestId('gate-next').click();
    // Mientras tanto, otro móvil deja entrar al grupo del conflicto.
    await withE2eDb((db) => db.query(`UPDATE "TicketPass" SET "checkedInCount" = "quantity" WHERE "uuid" = $1`, [conflict.uuid]));

    // --- Vuelve la red: se envía sola y el conflicto queda a la vista ---
    await phone.context.setOffline(false);
    await server(volunteer.getByTestId('gate-conflicts')).toBeVisible({ timeout: 60_000 });
    await expect(volunteer.getByTestId('gate-conflicts')).toContainText('Conflictos al enviar lecturas');
    await expect(volunteer.getByTestId('gate-pending')).toHaveCount(0);
    await expect(volunteer.getByTestId('gate-offline')).toHaveCount(0);
    const rows = await withE2eDb((db) => db.query(`SELECT p."uuid", p."checkedInCount", c."offline", c."accepted" FROM "TicketPass" p JOIN "TicketCheckIn" c ON c."ticketPassId" = p.id WHERE p."uuid" = ANY($1) ORDER BY c.id`, [[offlineOne.uuid, conflict.uuid]]));
    expect(rows.rows.find((row) => row.uuid === offlineOne.uuid)).toMatchObject({ checkedInCount: 1, offline: true, accepted: true });
    expect(rows.rows.find((row) => row.uuid === conflict.uuid)).toMatchObject({ checkedInCount: 2, offline: true, accepted: false });
    await checkPage(volunteer, isMobile);
    await volunteer.getByRole('button', { name: 'Entendido' }).click();

    // --- Quien dirige ve el móvil dentro y cierra su sesión mientras el voluntario trabaja sin cobertura ---
    await phone.context.setOffline(true);
    await expect(volunteer.getByTestId('gate-offline')).toBeVisible();
    await scan(volunteer, spare.payload);
    await expect(result(volunteer)).toHaveAttribute('data-outcome', 'ACCEPTED');
    await volunteer.getByTestId('gate-next').click();
    await expect(volunteer.getByTestId('gate-pending')).toContainText('1 lectura pendiente de enviar');
    await page.goto(`/panel/${entity.slug}/taquilla`);
    const session = page.getByTestId('gate-admin-session');
    await server(session).toBeVisible();
    await expect(session).toContainText('Puerta norte');
    await expect(page.getByRole('link', { name: /Abrir la portería/ })).toHaveAttribute('target', '_blank');
    await checkPage(page, isMobile);
    await session.getByRole('button', { name: 'Cerrar sesión de Puerta norte' }).click();
    await server(page.getByText('Ningún móvil dentro')).toBeVisible();

    // --- Vuelve la red: la sesión ya no vale, pero la lectura guardada NO se pierde y se envía al volver a entrar con el PIN ---
    await phone.context.setOffline(false);
    await server(volunteer.getByTestId('gate-ended')).toBeVisible({ timeout: 60_000 });
    await expect(volunteer.getByRole('heading', { name: 'La sesión de portería ya no vale' })).toBeVisible();
    await expect(volunteer.getByTestId('gate-ended-pending')).toContainText('1 lectura guardada en este móvil');
    await volunteer.getByRole('button', { name: 'Volver a entrar' }).click();
    await server(volunteer.getByLabel('PIN del evento')).toBeVisible();
    await volunteer.getByLabel('PIN del evento').fill(pin);
    await volunteer.getByRole('button', { name: 'Entrar en la portería' }).click();
    await server(volunteer.getByRole('heading', { name: 'Aforo en directo' })).toBeVisible();
    await expect(volunteer.getByTestId('gate-pending')).toHaveCount(0, { timeout: 60_000 });
    const spareRow = await withE2eDb((db) => db.query(`SELECT p."checkedInCount", c."offline" FROM "TicketPass" p JOIN "TicketCheckIn" c ON c."ticketPassId" = p.id WHERE p."uuid" = $1 AND c."accepted"`, [spare.uuid]));
    expect(spareRow.rows).toEqual([{ checkedInCount: 1, offline: true }]);

    // --- El PIN se anula por abuso con un móvil dentro: el panel lo dice y crear otro pide confirmación (cierra las sesiones) ---
    await withE2eDb(async (db) => {
      await db.query(`UPDATE "Initiative" SET "gatePinHash" = NULL, "gatePinExpiresAt" = NULL WHERE id = $1`, [event.id]);
      await db.query(`INSERT INTO "AuditLog" ("actorType", "organizationId", "action", "targetType", "targetId", "metadataJson") VALUES ('GATE_SESSION'::"AuditActorType", (SELECT id FROM "Organization" WHERE slug = $1), 'gate.pin_revoked', 'Initiative', $2, '{}'::jsonb)`, [entity.slug, String(event.id)]);
    });
    await page.goto(`/panel/${entity.slug}/taquilla`);
    await server(page.getByTestId('gate-admin-pin-state')).toContainText('Hemos anulado el PIN por demasiados intentos fallidos.');
    await expect(page.getByTestId('gate-admin-pin-state')).toContainText('El móvil que ya está dentro sigue funcionando.');
    await expect(page.getByTestId('gate-admin-pin-state')).not.toContainText('aún no tiene PIN');
    await page.getByRole('button', { name: 'Crear un PIN nuevo' }).click();
    await expect(page.getByTestId('gate-admin-pin-confirm')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'se cerrará 1 móvil que está dentro' })).toBeVisible();
    await page.getByRole('button', { name: 'No cambiarlo' }).click();
    await expect(page.getByRole('button', { name: 'Crear un PIN nuevo' })).toBeFocused();
    await page.getByRole('button', { name: 'Crear un PIN nuevo' }).click();
    await page.getByTestId('gate-admin-pin-confirm').click();
    await server(page.getByTestId('gate-admin-pin-digits')).toHaveText(/^\d{6}$/);

    // --- Cambiar el enlace de la puerta: el anterior deja de abrir nada y el nuevo funciona ---
    await page.getByTestId('gate-admin-rotate').click();
    await expect(page.getByTestId('gate-admin-rotate-confirm')).toContainText('El enlace anterior dejará de funcionar');
    await page.getByTestId('gate-admin-rotate-confirm').getByRole('button', { name: 'No cambiarlo' }).click();
    await expect(page.getByTestId('gate-admin-rotate')).toBeFocused();
    await page.getByTestId('gate-admin-rotate').click();
    await page.getByTestId('gate-admin-rotate-yes').click();
    await expect.poll(() => gateCodeOf(event.id), { timeout: 30_000 }).not.toBe(eventCode);
    const newCode = await gateCodeOf(event.id);
    expect((await page.request.get(`/panel/${entity.slug}/porteria/${eventCode}`)).status()).toBe(404);
    expect((await page.request.get(`/panel/${entity.slug}/porteria/${newCode}`)).status()).toBe(200);

    const ignorable = /ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR/;
    expect(errors.filter((message) => !ignorable.test(message))).toEqual([]);
    expect(volunteerErrors.filter((message) => !ignorable.test(message))).toEqual([]);
    await phone.context.close();
  });

  test('sorteo certificado: no se abre antes del día del evento, se proyecta, saca los premios y deja un acta que se puede descargar y comprobar', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    // La segunda persona firmante acepta su invitación: solo a quien ya firma se le avisa de una ronda extra.
    const cosigner = await activateCosigner(browser, entity, isMobile ? { width: 430, height: 932 } : null);
    const today = await createTicketEvent(entity.slug, { title: 'Rifa de hoy', subtype: 'RAFFLE', quantities: [1, 1, 1, 1, 1, 1], closes: 'today', prizes: 2 });
    const later = await createTicketEvent(entity.slug, { title: 'Rifa de la semana que viene', subtype: 'RAFFLE', quantities: [2, 2], closes: 'future', prizes: 1 });
    const pinToday = await createPin(page, entity.slug, 'Rifa de hoy');
    const pinLater = await createPin(page, entity.slug, 'Rifa de la semana que viene');
    await expect(page.getByText(/Rifa · /).first()).toBeVisible();

    const phone = await volunteerPhone(browser, isMobile);
    const volunteer = phone.page;
    const volunteerErrors = trackConsoleErrors(volunteer);

    // --- Antes del día del evento, con la venta cerrada, el sorteo no se abre ---
    const laterCode = await gateCodeOf(later.id);
    const todayCode = await gateCodeOf(today.id);
    await enterGate(volunteer, entity.slug, laterCode, pinLater);
    await server(volunteer.getByRole('heading', { name: 'Sorteo de la rifa' })).toBeVisible();
    await volunteer.getByTestId('gate-raffle-link').click();
    await server(volunteer.getByTestId('raffle-stage')).toBeVisible();
    await expect(volunteer.getByText(/El sorteo se abre el .+, el día del evento\./)).toBeVisible();
    await expect(volunteer.getByTestId('raffle-draw')).toHaveCount(0);
    await checkPage(volunteer, isMobile);

    // --- La sesión de un evento no vale para otro ---
    await volunteer.goto(`/panel/${entity.slug}/porteria/${todayCode}`);
    await expect(volunteer.getByLabel('PIN del evento')).toBeVisible();

    // --- El día del evento: se proyecta y se sortean los 2 premios entre las 6 papeletas ---
    await enterGate(volunteer, entity.slug, todayCode, pinToday);
    await server(volunteer.getByTestId('gate-raffle-link')).toBeVisible();
    await volunteer.getByTestId('gate-raffle-link').click();
    await server(volunteer.getByTestId('raffle-stage')).toBeVisible();
    await expect(volunteer.getByTestId('raffle-entries')).toHaveText('6');
    await expect(volunteer.getByTestId('raffle-left')).toHaveText('2');
    await expect(volunteer.getByTestId('raffle-fullscreen')).toBeVisible();
    await checkPage(volunteer, isMobile);
    await volunteer.getByLabel('¿Cuántos premios sorteas ahora? (quedan 2)').fill('2');
    await volunteer.getByTestId('raffle-draw').click();
    await server(volunteer.getByTestId('raffle-result')).toBeVisible();
    const shown = (await volunteer.getByTestId('raffle-number').allInnerTexts()).map((text) => Number(text.replace('#', '')));
    expect(shown).toHaveLength(2);
    expect(new Set(shown).size).toBe(2);
    for (const number of shown) expect(number).toBeGreaterThanOrEqual(1);
    for (const number of shown) expect(number).toBeLessThanOrEqual(6);
    await expect(volunteer.getByTestId('raffle-participants')).toHaveText('6');
    await expect(volunteer.getByTestId('raffle-list-hash')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(volunteer.getByTestId('raffle-act-hash')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(volunteer.getByText('Ya se han sorteado todos los premios.')).toBeVisible();
    await expect(volunteer.getByTestId('raffle-draw')).toHaveCount(0);
    await expect(volunteer.getByTestId('raffle-left')).toHaveText('0');
    await checkPage(volunteer, isMobile);

    // --- El acta se descarga y cualquiera puede comprobarla ---
    const [download] = await Promise.all([volunteer.waitForEvent('download'), volunteer.getByTestId('raffle-download').click()]);
    const file = JSON.parse(await readFile(await download.path(), 'utf8')) as { kind: string; initiativeId: number; round: number; drawnAt: string; winningNumbers: number[]; participantCount: number; participantsSha256: string; actSha256: string; participants: { number: number; serialCode: string }[] };
    expect(file).toMatchObject({ kind: 'korum-raffle-act', initiativeId: today.id, round: 1, participantCount: 6 });
    expect(file.winningNumbers).toEqual(shown);
    expect(JSON.stringify(file)).not.toContain('@');
    expect(verifyDrawAct({ initiativeId: file.initiativeId, round: file.round, drawnAt: file.drawnAt, participantsSha256: file.participantsSha256, participantCount: file.participantCount, winningNumbers: file.winningNumbers }, file.participants, file.actSha256)).toBe(true);
    expect(createHash('sha256').update(JSON.stringify(file.participants), 'utf8').digest('hex')).toBe(file.participantsSha256);
    const draws = await withE2eDb((db) => db.query(`SELECT "winningNumbers", "actSha256" FROM "RaffleDraw" WHERE "initiativeId" = $1`, [today.id]));
    expect(draws.rows).toHaveLength(1);
    expect(draws.rows[0].winningNumbers).toEqual(shown);

    // --- Al recargar, el resultado sigue ahí y en catalán se lee igual ---
    await volunteer.reload();
    await server(volunteer.getByTestId('raffle-result')).toBeVisible();
    await volunteer.goto(`/ca/panel/${entity.slug}/porteria/${todayCode}/sorteo`);
    await server(volunteer.getByRole('heading', { level: 1, name: 'Sorteig certificat' })).toBeVisible();
    await expect(volunteer.getByText('Ja s’han sortejat tots els premis.')).toBeVisible();
    await expectNoMissingTranslations(volunteer);

    // --- Quien dirige: ronda extra por un premio que nadie reclama (una sola persona firmante, sin doble firma) ---
    await page.goto(`/panel/${entity.slug}/taquilla`);
    const raffleCard = page.getByTestId('gate-admin-event').filter({ has: page.getByRole('heading', { name: 'Rifa de hoy' }) });
    const admin = raffleCard.getByTestId('gate-raffle-admin');
    await server(admin).toBeVisible();
    await expect(admin.getByTestId('gate-raffle-summary')).toHaveText('Premios sorteados: 2 de 2. Sustituidos con rondas extra: 0.');
    await expect(admin.getByTestId('gate-raffle-rounds').getByRole('listitem')).toHaveCount(1);
    // Sin ganador reembolsado, ese motivo no se ofrece: solo el premio sin reclamar.
    await expect(admin.getByLabel('Motivo').locator('option')).toHaveText(['Premio sin reclamar (hasta 2 premios)']);
    await checkPage(page, isMobile);
    const tag = (number: number) => `#${String(number).padStart(4, '0')}`;
    // Sin elegir ninguna papeleta ganadora no se prepara la ronda.
    await admin.getByTestId('gate-raffle-prepare').click();
    await expect(admin.getByText('Marca al menos una papeleta ganadora para sustituirla.')).toBeVisible();
    // El premio sin reclamar es el de la segunda papeleta ganadora: consta qué número se sustituye.
    // Se elige una sola papeleta ganadora: elegir otra cambia la elección (no queda una casilla muerta).
    await expect(admin.getByTestId('gate-raffle-replace').getByRole('radio')).toHaveCount(2);
    await admin.getByRole('radio', { name: tag(shown[0]!) }).check();
    await admin.getByRole('radio', { name: tag(shown[1]!) }).check();
    await expect(admin.getByRole('radio', { name: tag(shown[0]!) })).not.toBeChecked();
    await admin.getByTestId('gate-raffle-prepare').click();
    await expect(admin.getByTestId('gate-raffle-confirm')).toContainText(`¿Sortear 1 papeleta para sustituir la ${tag(shown[1]!)}?`);
    await expect(admin.getByTestId('gate-raffle-confirm')).toContainText('Quedará en el acta y en el historial de la entidad, y avisaremos a la otra persona firmante si la hay.');
    await admin.getByTestId('gate-raffle-confirm-yes').click();
    await server(admin.getByTestId('gate-raffle-done')).toContainText('Ronda 2 hecha');
    await expect(admin.getByTestId('gate-raffle-done')).toContainText(`sustituye a ${tag(shown[1]!)}. Anota qué premio era. La otra persona firmante recibirá un aviso.`);
    await expect(admin.getByTestId('gate-raffle-summary')).toHaveText('Premios sorteados: 2 de 2. Sustituidos con rondas extra: 1.');
    await expect(admin.getByTestId('gate-raffle-rounds').getByRole('listitem')).toHaveCount(2);
    await expect(admin.getByTestId('gate-raffle-rounds')).toContainText('Ronda 2 (extra: premio sin reclamar)');
    await expect(admin.getByTestId('gate-raffle-rounds')).toContainText(`sustituye a ${tag(shown[1]!)}`);
    const extraRound = await withE2eDb((db) => db.query(`SELECT "winningNumbers", "replacedNumbers", "extraRoundReason" FROM "RaffleDraw" WHERE "initiativeId" = $1 AND round = 2`, [today.id]));
    expect(extraRound.rows[0].extraRoundReason).toBe('PRIZE_UNCLAIMED');
    expect(extraRound.rows[0].winningNumbers).toHaveLength(1);
    expect(extraRound.rows[0].replacedNumbers).toEqual([shown[1]]);
    expect(shown).not.toContain(extraRound.rows[0].winningNumbers[0]);
    // La otra persona firmante recibe el aviso; quien la hizo, no.
    const notices = await withE2eDb((db) => db.query(`SELECT "toAddress" FROM "OutboxMessage" WHERE "templateKey" = 'raffle.extraRound' AND "organizationId" = (SELECT id FROM "Organization" WHERE slug = $1)`, [entity.slug]));
    expect(notices.rows.map((row) => row.toAddress)).toEqual([entity.cosigner]);
    const payload = await withE2eDb((db) => db.query(`SELECT "payloadJson" FROM "OutboxMessage" WHERE "templateKey" = 'raffle.extraRound' AND "toAddress" = $1`, [entity.cosigner]));
    expect(payload.rows[0].payloadJson).toMatchObject({ round: 2, numbers: extraRound.rows[0].winningNumbers, replaced: [shown[1]], by: 'Carla Puig' });

    // --- El acta de la ronda extra se descarga desde el panel ---
    const [panelDownload] = await Promise.all([page.waitForEvent('download'), admin.getByRole('button', { name: 'Descargar acta de la ronda 2' }).click()]);
    const extraAct = JSON.parse(await readFile(await panelDownload.path(), 'utf8')) as { round: number; winningNumbers: number[]; participantCount: number; extraRoundReason: string | null; drawnBy: string; replacedNumbers: number[] };
    expect(extraAct).toMatchObject({ round: 2, winningNumbers: extraRound.rows[0].winningNumbers, participantCount: 4, extraRoundReason: 'PRIZE_UNCLAIMED', drawnBy: 'USER', replacedNumbers: [shown[1]] });

    // --- Un ganador reembolsado habilita su motivo ---
    await withE2eDb(async (db) => {
      const { rows } = await db.query(`SELECT "ticketPassId" FROM "RaffleNumber" WHERE "initiativeId" = $1 AND number = $2`, [today.id, shown[0]]);
      await db.query(`UPDATE "TicketPass" SET "revokedAt" = now() WHERE id = $1`, [rows[0].ticketPassId]);
      await db.query(`DELETE FROM "RaffleNumber" WHERE "ticketPassId" = $1`, [rows[0].ticketPassId]);
    });
    await page.reload();
    await expect(admin.getByLabel('Motivo').locator('option')).toHaveText(['Premio sin reclamar (hasta 1 premio)', 'Papeleta ganadora reembolsada (hasta 1 premio)'], { timeout: 30_000 });
    await admin.getByLabel('Motivo').selectOption('WINNER_REFUNDED');
    // Con el reembolso solo aparece la papeleta ganadora reembolsada.
    await expect(admin.getByTestId('gate-raffle-replace').getByRole('radio')).toHaveCount(1);
    await admin.getByRole('radio', { name: `${tag(shown[0]!)} (reembolsada)` }).check();
    await admin.getByTestId('gate-raffle-prepare').click();
    await admin.getByTestId('gate-raffle-confirm-yes').click();
    await server(admin.getByTestId('gate-raffle-done')).toContainText('Ronda 3 hecha');
    await expect(admin.getByTestId('gate-raffle-rounds')).toContainText('Ronda 3 (extra: papeleta ganadora reembolsada)');
    await expect(admin.getByTestId('gate-raffle-rounds')).toContainText(`sustituye a ${tag(shown[0]!)}`);
    await checkPage(page, isMobile);
    await page.goto(`/ca/panel/${entity.slug}/taquilla`);
    await server(page.getByRole('heading', { name: 'Sorteig i rondes extra' }).first()).toBeVisible();
    await expectNoMissingTranslations(page);

    expect(errors).toEqual([]);
    expect(volunteerErrors).toEqual([]);
    await phone.context.close();
    await cosigner.context.close();
  });
});
