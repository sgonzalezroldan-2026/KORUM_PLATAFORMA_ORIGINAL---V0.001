import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { academicYearFor } from '@/core/finance/academic-year';
import { quarterOf } from '@/core/ideas/idea-conversion';
import { buildPassQrPayload, signPass } from '@/core/ticketing/qr-signature';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 5.14c · Vales después de venderse, como personas reales con la compilación de producción (QA-VAL04 y QA-VAL05):
 *
 * - Quien firma ve la venta de vales en «Taquilla y portería» y crea el PIN del puesto; quien atiende el puesto entra desde otro móvil sin cuenta, lee el QR
 *   (como un lector con teclado), ve cuántos vales quedan, teclea cuántos se gastan y ve lo que queda; un QR falso sale en rojo. Quien firma cancela la venta
 *   y el móvil del puesto se queda fuera.
 * - Una familia compra un vale y, desde su pase, pide la devolución de 14 días con un clic: el pase dice que se ha devuelto y le llega el email.
 *
 * Axe sin incidencias, 430 px sin desbordes, sin claves sin traducir, sin la palabra «saldo» y sin errores de consola.
 */

const server = expect.configure({ timeout: 30_000 });
const NAVIGATION = { timeout: 45_000 };
const QR_SECRET = E2E_SERVER_ENV.QR_HMAC_SECRET!;
const EMAIL_LABEL = '📧 Tu email para enviarte al instante tu recibo o tus entradas QR';
const DAY = 86_400_000;
const octet = () => 1 + Math.floor(Math.random() * 250);

test.describe.configure({ timeout: 300_000 });

async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
  await expect(page.locator('body')).not.toContainText(/\bsaldo\b/i);
}

/** Una venta de vales a la venta en la entidad de la prueba, con una compra de 5 vales ya pagada (su pase firmado). */
async function voucherSaleWithPurchase(slug: string, title: string): Promise<{ id: number; payload: string; passUuid: string }> {
  return withE2eDb(async (db) => {
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const closesAt = new Date(Date.now() + 10 * DAY);
    const { rows } = await db.query(
      `INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "stepIndex", "closesAt", "quarter", "goalCents", "description",
         "ticketSubtype", "ticketPriceCents", "ticketMax", "ticketsSold", "ticketFeeMode", "voucherValidUntil", "raisedCents", "quotaReservedAt", "updatedAt")
       VALUES ($1, 'TICKETING'::"InitiativeFormat", (SELECT id FROM "Organization" WHERE slug = $2), $3, $4, 'Taquilla', 'Todo el centro', 'FUNDRAISING'::"InitiativeStatus", 4, $5, $6, 20000,
         'Vales para el puesto de la fiesta.', 'VOUCHER'::"TicketSubtype", 200, 100, 5, 'ADD'::"TicketFeeMode", $7, 1000, now(), now())
       RETURNING id`,
      [walletId, slug, academicYearFor(new Date()), title, closesAt, quarterOf(closesAt), new Date(Date.now() + 60 * DAY)]
    );
    const initiativeId = Number(rows[0].id);
    const uuid = randomUUID();
    const email = `familia-${uuid.slice(0, 8)}@pruebas.example`;
    const contribution = await db.query(
      `INSERT INTO "Contribution" ("organizationId", "initiativeId", "guestEmail", "canonicalEmail", "fiscalYear", "type", "ticketQuantity", "amountCents", "totalChargedCents", "paymentMethod", "status", "paycometOrder")
       VALUES ((SELECT id FROM "Organization" WHERE slug = $1), $2, $3, $3, 2026, 'TICKET'::"ContributionType", 5, 1000, 1065, 'BIZUM'::"PaymentMethod", 'COMPLETED'::"ContributionStatus", $4) RETURNING id`,
      [slug, initiativeId, email, `KV${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`]
    );
    await db.query(
      `INSERT INTO "TicketPass" ("uuid", "contributionId", "initiativeId", "serialCode", "subtype", "holderEmail", "quantity", "qrHmacSignature")
       VALUES ($1, $2, $3, $4, 'VOUCHER'::"TicketSubtype", $5, 5, $6)`,
      [uuid, contribution.rows[0].id, initiativeId, `VALE-2026-${uuid.slice(0, 6).toUpperCase()}`, email, signPass(QR_SECRET, uuid)]
    );
    return { id: initiativeId, payload: buildPassQrPayload(QR_SECRET, uuid), passUuid: uuid };
  });
}

/** El móvil de quien atiende el puesto: otro navegador, sin cuenta y desde su propia red. */
async function standPhone(browser: Browser, isMobile: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3100}`,
    viewport: isMobile ? { width: 430, height: 932 } : { width: 1440, height: 900 },
    isMobile,
    hasTouch: isMobile,
    extraHTTPHeaders: { 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` }
  });
  return { context, page: await context.newPage() };
}

async function readCode(stand: Page, payload: string) {
  await stand.getByLabel('Código de los vales').fill(payload);
  await stand.getByRole('button', { name: 'Comprobar vales' }).click();
}

test.describe('QA-VAL05 · puesto de canje de vales', () => {
  test('PIN del puesto en el panel → se lee el QR, se ve lo que queda y se descuenta lo tecleado → QR falso en rojo → la entidad cancela y el puesto se cierra', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const sale = await voucherSaleWithPurchase(entity.slug, 'Fichas de la fiesta de primavera');

    // --- Quien firma: «Taquilla y portería» ---
    await page.goto(`/panel/${entity.slug}/taquilla`);
    const card = page.getByTestId('gate-admin-event').filter({ has: page.getByRole('heading', { name: 'Fichas de la fiesta de primavera' }) });
    await server(card).toBeVisible();
    await expect(card).toContainText('Venta de vales');
    await expect(card).toContainText('5 de 100 vales vendidos');
    await expect(card.getByTestId('gate-admin-pin-state')).toHaveText('Este puesto aún no tiene PIN: nadie puede abrirlo todavía.');
    await checkPage(page, isMobile);
    await card.getByRole('button', { name: 'Crear el PIN del puesto' }).click();
    await server(card.getByTestId('gate-admin-pin')).toBeVisible();
    await expect(card.getByTestId('gate-admin-pin')).toContainText('cuando caducan los vales');
    const pin = (await card.getByTestId('gate-admin-pin-digits').innerText()).trim();
    expect(pin).toMatch(/^\d{6}$/);
    const href = await card.getByTestId('gate-admin-link').getAttribute('href');
    await expect(card.getByTestId('gate-admin-link')).toHaveText(/Abrir el puesto de vales/);

    // --- Quien atiende el puesto ---
    const phone = await standPhone(browser, isMobile);
    const stand = phone.page;
    const standErrors = trackConsoleErrors(stand);
    await stand.goto(href!);
    await stand.getByLabel('PIN del puesto').fill(pin);
    await stand.getByRole('button', { name: 'Entrar en el puesto' }).click();
    await server(stand.getByRole('heading', { name: 'Puesto de canje de vales' })).toBeVisible(NAVIGATION);
    await expect(stand.getByTestId('voucher-station-spent')).toHaveText('Aún no se ha gastado ningún vale desde que abriste esta pantalla');
    await checkPage(stand, isMobile);

    await readCode(stand, sale.payload);
    const balance = stand.getByTestId('voucher-station-balance');
    await server(balance).toBeVisible();
    await expect(balance.getByRole('heading')).toHaveText('Quedan 5 vales de 5');
    await expect(balance.getByRole('heading')).toBeFocused();
    await checkPage(stand, isMobile);
    await stand.getByRole('button', { name: 'Uno más' }).click();
    await expect(stand.getByTestId('voucher-station-quantity')).toHaveValue('2');
    await stand.getByTestId('voucher-station-redeem').click();
    const done = stand.getByTestId('voucher-station-done');
    await server(done).toContainText('Gastados 2 vales. Quedan 3 vales.');
    await expect(stand.getByTestId('voucher-station-spent')).toHaveText('2 vales gastados desde que abriste esta pantalla');
    await stand.getByTestId('voucher-station-next').click();

    // No se gasta más de lo que queda: con 3, se escriben 4 y el botón no deja.
    await readCode(stand, sale.payload);
    await server(balance.getByRole('heading')).toHaveText('Quedan 3 vales de 5');
    await stand.getByTestId('voucher-station-quantity').fill('4');
    await expect(balance.getByRole('alert')).toHaveText('Escribe un número entre 1 y 3.');
    await expect(stand.getByTestId('voucher-station-redeem')).toBeDisabled();
    await stand.getByTestId('voucher-station-quantity').fill('3');
    await stand.getByTestId('voucher-station-redeem').click();
    await server(done).toContainText('Gastados 3 vales. Ya no quedan vales en este código.');
    await stand.getByTestId('voucher-station-next').click();

    // Leer un código ya gastado del todo sale en rojo, con su motivo (no un «Quedan 0»).
    await readCode(stand, sale.payload);
    await server(stand.getByTestId('voucher-station-error')).toContainText('Ya no quedan vales en este código.');
    await stand.getByTestId('voucher-station-next').click();

    // Un QR falso o alterado, en rojo y con texto (no solo color).
    await readCode(stand, `${sale.payload.slice(0, -1)}${sale.payload.endsWith('A') ? 'B' : 'A'}`);
    await server(stand.getByTestId('voucher-station-error')).toContainText('Este código no es un vale válido.');
    await checkPage(stand, isMobile);
    await stand.getByTestId('voucher-station-next').click();
    expect((await withE2eDb((db) => db.query(`SELECT "checkedInCount" FROM "TicketPass" WHERE uuid = $1`, [sale.passUuid]))).rows[0].checkedInCount).toBe(5);

    // --- Quien firma cancela la venta (con todo gastado, no hay nada que devolver) ---
    await page.goto(`/panel/${entity.slug}/taquilla`);
    await server(card.getByTestId('voucher-sale-panel')).toBeVisible();
    await card.getByTestId('voucher-cancel').click();
    const confirm = card.getByTestId('voucher-cancel-confirm');
    await expect(confirm).toBeFocused();
    await expect(confirm).toContainText('Devolveremos automáticamente a cada persona lo que no haya gastado');
    await checkPage(page, isMobile);
    await card.getByTestId('voucher-cancel-yes').click();
    await server(card.getByTestId('voucher-sale-done')).toContainText('Venta cancelada.');
    await expect(card.getByTestId('gate-admin-closed')).toContainText('Venta cancelada');
    await checkPage(page, isMobile);

    // El móvil del puesto ya no canjea: su sesión se cerró.
    await readCode(stand, sale.payload);
    await server(stand.getByTestId('voucher-station-ended')).toContainText('La sesión del puesto ha terminado');
    await checkPage(stand, isMobile);
    expect(errors).toEqual([]);
    expect(standErrors).toEqual([]);
    await phone.context.close();
  });
});

test.describe('QA-VAL04 · devolución de 14 días desde el pase', () => {
  test('una familia compra un vale y, sin gastarlo, recupera el 100 % con un clic desde su pase; le llega «Devolución realizada»', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('devolucion-vales');
    await page.goto('/basket-valles/iniciativas/9');
    await server(page.getByTestId('voucher-details')).toBeVisible(NAVIGATION);
    const since = Date.now();
    await page.getByTestId('detail-cta').click();
    const modal = page.locator('#checkout-modal');
    await server(modal).toBeVisible(NAVIGATION);
    await modal.getByLabel(EMAIL_LABEL).fill(email);
    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KV[0-9A-F]{16}&sig=/, NAVIGATION);
    await page.getByRole('button', { name: 'Confirmar el pago' }).click();
    const celebration = page.getByTestId('checkout-celebration');
    await server(celebration.getByRole('heading', { level: 1 })).toHaveText(/Tus vales ya son tuyos/, NAVIGATION);
    await celebration.getByTestId('view-pass').click();

    const refund = page.getByTestId('voucher-refund');
    await server(refund).toBeVisible(NAVIGATION);
    await expect(refund).toContainText(/puedes recuperar el 100 % \(2,49\s€\) hasta el/);
    await checkPage(page, isMobile);
    await refund.getByTestId('voucher-refund-open').click();
    await expect(refund.getByRole('alertdialog')).toBeFocused();
    await expect(refund.getByRole('alertdialog')).toContainText('estos vales dejarán de valer');
    await checkPage(page, isMobile);
    await refund.getByTestId('voucher-refund-yes').click();
    await server(page.getByRole('heading', { level: 1, name: 'Esta compra de vales ya no es válida' })).toBeVisible(NAVIGATION);
    await checkPage(page, isMobile);

    const message = await emailTo(email, since, (text) => text.includes('Te hemos devuelto'));
    expect(message).toContain('2,49');
    expect(errors).toEqual([]);
  });
});
