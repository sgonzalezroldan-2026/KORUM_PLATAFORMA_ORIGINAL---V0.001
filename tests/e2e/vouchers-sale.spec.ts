import { expect, test, type Page } from '@playwright/test';
import { academicYearFor } from '@/core/finance/academic-year';
import { quarterOf } from '@/core/ideas/idea-conversion';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { expectBoardRowsReadable, expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 5.14b · La venta de vales como la viven una entidad y una familia (QA-VAL03), con cobros simulados (`PAYCOMET_MODE=mock`):
 *
 * - La entidad crea en el Estudio una venta de vales con su texto libre (sin lista de artículos), ve su pizarra (con tope y sin tope, con su objetivo), la validez
 *   por defecto hasta el inicio del curso siguiente, el aviso si la pone antes del cierre, y la publica.
 * - Una familia abre la venta de la semilla (`basket-valles`, iniciativa 9) en el móvil: precio, validez y existencias antes de comprar; compra 2 vales en 10
 *   segundos; ve su pase con el QR y los vales que le quedan; le llega el email con el QR.
 * - Con la venta agotada y «sin producto» activado, el aviso (sin vale, sin certificado y sin devolución) sale antes de pagar y la aportación se cobra sin pase.
 *
 * Sin la palabra «saldo» (Regla 03 §4), axe sin incidencias, 430 px sin desbordes y sin claves sin traducir.
 */

const server = expect.configure({ timeout: 30_000 });
const NAVIGATION = { timeout: 45_000 };
const EMAIL_LABEL = '📧 Tu email para enviarte al instante tu recibo o tus entradas QR';
const DAY = 86_400_000;

test.describe.configure({ timeout: 300_000 });

async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectMobileStackIsOneColumn(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
  await expect(page.locator('body')).not.toContainText(/\bsaldo\b/i);
}

/** Una venta de vales agotada de verdad, con «sin producto» activado, en la entidad de la semilla `basket-valles` (club deportivo, sin ánimo de lucro). */
async function soldOutSale(): Promise<number> {
  return withE2eDb(async (db) => {
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const closesAt = new Date(Date.now() + 20 * DAY);
    const { rows } = await db.query(
      `INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "stepIndex", "closesAt", "quarter", "goalCents", "description",
         "ticketSubtype", "ticketPriceCents", "ticketMax", "ticketsSold", "ticketFeeMode", "voucherValidUntil", "voucherNoProductEnabled", "quotaReservedAt", "updatedAt")
       VALUES ($1, 'TICKETING'::"InitiativeFormat", (SELECT id FROM "Organization" WHERE slug = 'basket-valles'), $2, 'Vales agotados de la prueba E2E', 'Taquilla', 'Todo el club',
         'FUNDRAISING'::"InitiativeStatus", 4, $3, $4, 400, 'Vales para la merienda del torneo.', 'VOUCHER'::"TicketSubtype", 200, 2, 2, 'ADD'::"TicketFeeMode", $5, true, now(), now())
       RETURNING id`,
      [walletId, academicYearFor(new Date()), closesAt, quarterOf(closesAt), new Date(Date.now() + 40 * DAY)]
    );
    return Number(rows[0].id);
  });
}

test.describe('QA-VAL03 · venta de vales', () => {
  test('la entidad crea y publica una venta de vales en el Estudio: texto libre, tope u objetivo, validez y pizarra', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    await withE2eDb((db) => db.query(`UPDATE "Organization" SET "kybStatus" = 'VERIFIED' WHERE slug = $1`, [entity.slug]));
    await page.goto(`/panel/${entity.slug}/estudio`);
    await server(page.getByTestId('studio-new-vouchers')).toBeVisible();
    await page.getByTestId('studio-new-vouchers').click();
    await server(page.getByRole('heading', { level: 1, name: /Nueva venta de vales/ })).toBeVisible();

    // Sin lista de artículos: el texto lo escribe la entidad. Precio de partida 2 €, tope 200 y validez hasta el inicio del curso siguiente.
    await expect(page.getByTestId('studio-voucher-fields')).toBeVisible();
    await expect(page.getByLabel('Precio de un vale')).toHaveValue('2');
    await expect(page.getByLabel('Tope de vales')).toHaveValue('200');
    await expect(page.getByTestId('studio-voucher-valid-on')).toHaveValue(/^\d{4}-09-01$/);
    await page.getByLabel('Título de la iniciativa o del evento').fill('Vales de la merienda solidaria');
    await page.getByLabel('Descripción').fill('Cada vale vale por una merienda en el puesto del AMPA durante la fiesta.');
    await expect(page.getByTestId('studio-badge')).toHaveText('Vales');
    await expect(page.getByTestId('studio-goal')).toHaveText(/^400,00\s€$/);
    await expect(page.getByTestId('studio-voucher-board')).toContainText(/Precio de los 200 vales del tope\s*400,00\s€/);
    await checkPage(page, isMobile);
    await expectBoardRowsReadable(page);

    // Sin tope: pide el objetivo orientativo y la meta sale de él.
    await page.getByLabel('Cantidad de vales').selectOption('OPEN');
    await page.getByTestId('studio-voucher-target').fill('150');
    await expect(page.getByTestId('studio-goal')).toHaveText(/^300,00\s€$/);
    await expect(page.getByLabel('Al agotarse, dejar seguir aportando «sin producto»')).toHaveCount(0);
    await page.getByLabel('Cantidad de vales').selectOption('CAPPED');
    await page.getByLabel('Al agotarse, dejar seguir aportando «sin producto»').check();

    // Una validez anterior al cierre se avisa junto al campo, al momento.
    const validity = page.getByTestId('studio-voucher-valid-on');
    const defaultValidity = await validity.inputValue();
    await validity.fill('2020-01-01');
    await expect(page.getByTestId('studio-voucher-fields').getByText('Los vales no pueden caducar antes del día de cierre de la venta.')).toBeVisible();
    await validity.fill(defaultValidity);
    await expect(page.getByTestId('studio-voucher-fields').getByText('Los vales no pueden caducar antes del día de cierre de la venta.')).toHaveCount(0);

    await expect(page.getByTestId('studio-publish')).toBeEnabled();
    await page.getByTestId('studio-publish').click();
    await page.getByTestId('studio-confirm-publish').click();
    await server(page.getByTestId('studio-published')).toBeVisible(NAVIGATION);
    const initiativeId = Number(new URL(page.url()).searchParams.get('iniciativa'));
    const { rows } = await withE2eDb((db) => db.query(`SELECT "status", "ticketSubtype", "ticketMax", "voucherNoProductEnabled", "voucherValidUntil", "goalCents" FROM "Initiative" WHERE id = $1`, [initiativeId]));
    expect(rows[0]).toMatchObject({ status: 'FUNDRAISING', ticketSubtype: 'VOUCHER', ticketMax: 200, voucherNoProductEnabled: true, goalCents: 40_000 });
    // Publicada, el formulario de dinero queda bloqueado y la pizarra sigue siendo la de vales.
    await expect(page.getByLabel('Precio de un vale')).toBeDisabled();
    await expect(page.getByTestId('studio-voucher-board')).toBeVisible();
    await checkPage(page, isMobile);

    // La ficha pública: precio, validez y existencias, y el botón de comprar vales.
    await page.goto(`/${entity.slug}/iniciativas/${initiativeId}`);
    await server(page.getByTestId('voucher-details')).toBeVisible();
    await expect(page.getByTestId('voucher-stock')).toContainText('0 de 200 vales vendidos');
    await expect(page.getByTestId('detail-cta')).toHaveText(/Comprar vales/);
    await checkPage(page, isMobile);
    expect(errors).toEqual([]);
  });

  test('una familia compra 2 vales en el móvil y ve su pase con el QR y los vales que le quedan; le llega el email', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('vales');
    await page.goto('/basket-valles');
    const card = page.locator('[data-testid="initiative-card"][data-initiative-id="9"]');
    await server(card).toBeVisible();
    await expect(card.getByTestId('voucher-price')).toContainText('2,00 € / vale + gastos');
    await expect(card).toContainText('Devolución del 100 % en 14 días si no gastas ningún vale');

    await page.goto('/basket-valles/iniciativas/9');
    await server(page.getByTestId('voucher-details')).toBeVisible();
    await expect(page.getByTestId('voucher-valid-until')).toBeVisible();
    await expect(page.getByTestId('voucher-details')).toContainText('0,45 € + 2 % por compra');
    await checkPage(page, isMobile);

    const since = Date.now();
    await page.getByTestId('detail-cta').click();
    const modal = page.locator('#checkout-modal');
    await server(modal).toBeVisible(NAVIGATION);
    await expect(modal.getByTestId('checkout-voucher-info')).toContainText(/Quedan \d+ de 300/);
    await expect(modal.getByTestId('checkout-voucher-info')).toContainText('Se pueden gastar hasta el');
    // Ni reto por curso, ni aportación voluntaria, ni NIF: es una compra.
    await expect(modal.getByTestId('guarantee-check')).toHaveCount(0);
    await expect(modal.getByLabel('Quiero mi certificado fiscal')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Un vale más' }).click();
    await expect(modal.getByTestId('voucher-quantity')).toHaveText('2');
    await modal.getByLabel(EMAIL_LABEL).fill(email);
    // 2 vales de 2 € y una sola vez los gastos de la compra: 0,45 € + 2 % de 4 € = 0,53 €.
    await expect(modal.getByTestId('checkout-summary')).toContainText(/2 vales \(4,00\s€\) \+ 0,53\s€ de Gastos de gestión digital/);
    await expect(modal.getByTestId('checkout-summary')).toContainText(/Total: 4,53\s€/);
    await checkPage(page, isMobile);

    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KV[0-9A-F]{16}&sig=/, NAVIGATION);
    await page.getByRole('button', { name: 'Confirmar el pago' }).click();
    const celebration = page.getByTestId('checkout-celebration');
    await server(celebration.getByRole('heading', { level: 1 })).toHaveText(/Tus vales ya son tuyos/, NAVIGATION);
    await expect(celebration).toContainText(/Has pagado 4,53\s€/);
    await checkPage(page, isMobile);

    await celebration.getByTestId('view-pass').click();
    const pass = page.getByTestId('voucher-pass');
    await server(pass).toBeVisible(NAVIGATION);
    await expect(page.getByTestId('voucher-balance')).toHaveText('Te quedan 2 vales de 2');
    await expect(pass.getByRole('img', { name: 'Código QR de tus vales' })).toBeVisible();
    await expect(pass).toContainText(/VALE-\d{4}-\d{6}/);
    await checkPage(page, isMobile);

    // La tarjeta para WhatsApp de la venta: un PNG de 1200×630 por debajo del límite de WhatsApp, en los tres idiomas.
    for (const locale of ['es', 'ca', 'en']) {
      const response = await page.request.get(`/api/og/initiative/9?locale=${locale}&v=1`);
      expect(response.status(), locale).toBe(200);
      expect(response.headers()['content-type']).toContain('image/png');
      expect((await response.body()).byteLength).toBeLessThan(300 * 1024);
    }

    const message = await emailTo(email, since);
    expect(message).toContain('Tus vales de');
    expect(message).toContain('2 vales');
    expect(message).not.toMatch(/\bsaldo\b/i);
    expect(errors).toEqual([]);
  });

  test('venta agotada con «sin producto»: el aviso sale antes de pagar y la aportación se cobra sin pase', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const initiativeId = await soldOutSale();
    await page.goto(`/basket-valles/iniciativas/${initiativeId}`);
    await server(page.getByTestId('no-product-notice')).toBeVisible();
    await expect(page.getByTestId('detail-cta')).toHaveText(/Aportar sin producto/);
    await checkPage(page, isMobile);

    await page.getByTestId('detail-cta').click();
    const modal = page.locator('#checkout-modal');
    await server(modal).toBeVisible(NAVIGATION);
    const notice = modal.getByTestId('no-product-notice');
    await expect(notice).toContainText('No recibes vales ni código QR.');
    await expect(notice).toContainText('No da derecho a certificado fiscal de donación.');
    await expect(notice).toContainText('No se devuelve, salvo que la entidad cancele la venta.');
    await modal.getByRole('button', { name: 'Un vale más' }).click();
    await modal.getByLabel(EMAIL_LABEL).fill(uniqueEmail('sinproducto'));
    await expect(modal.getByTestId('checkout-summary')).toContainText('Sin producto · equivale a 2 vales');
    await checkPage(page, isMobile);

    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KV/, NAVIGATION);
    await page.getByRole('button', { name: 'Confirmar el pago' }).click();
    const celebration = page.getByTestId('checkout-celebration');
    await server(celebration.getByRole('heading', { level: 1 })).toHaveText(/Tu aportación ya suma/, NAVIGATION);
    await expect(celebration.getByTestId('result-no-product')).toContainText('no da vales ni certificado fiscal');
    await expect(celebration.getByTestId('view-pass')).toHaveCount(0);
    // No se celebra un «agotado» que este pago no ha causado: la venta ya lo estaba (auditoría financiera).
    await expect(celebration).not.toContainText('se han agotado los vales');
    await checkPage(page, isMobile);
    expect(errors).toEqual([]);
  });
});
