import { expect, test, type Page } from '@playwright/test';
import { emailTo, uniqueEmail } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F04 · QA-F07 · QA-F10 · Checkout en 10 segundos, taquilla con pase QR y recuperación de un pago rechazado, como una familia real con
 * cobros simulados (`PAYCOMET_MODE=mock`: el simulador entrega al webhook la misma notificación firmada que Paycomet). Datos de la semilla:
 * Cervantes (`cervantes`, Ley 49 verificada): 1 campaña abierta, 2 taquilla con 4 plazas libres, 3 conseguida. IES Mediterráneo (`ies-mediterraneo`,
 * sin Ley 49): 8 abierta. Club de básquet (`basket-valles`, deportivo): 7 abierta.
 */

const EMAIL_LABEL = '📧 Tu email para enviarte al instante tu recibo o tus entradas QR';
const dialog = (page: Page) => page.locator('#checkout-modal');
/** En desarrollo, la primera visita a cada ruta se compila al vuelo: las navegaciones del pago esperan más que una aserción normal. */
const NAVIGATION = { timeout: 45_000 };

test.describe.configure({ timeout: 120_000 });

async function openCheckout(page: Page, path: string) {
  await page.goto(path);
  // El botón de la ficha (su texto cambia con el idioma y el formato) lleva siempre a `/aportar`.
  await page.locator('#fview-detail a[href$="/aportar"]').click();
  await expect(page).toHaveURL(/\/aportar$/, NAVIGATION);
  await expect(dialog(page)).toBeVisible(NAVIGATION);
}

test.describe('QA-F04 · checkout de invitado', () => {
  test('solo el email, 13 + 2 cursos, aportación voluntaria desmarcada con el texto de Ley 49 y NIF opcional; pago con celebración', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('madre');
    await openCheckout(page, '/cervantes/iniciativas/1');
    const modal = dialog(page);

    // Un único campo de datos personales para el invitado: el email, con el texto oficial.
    await expect(modal.getByLabel(EMAIL_LABEL)).toBeVisible();
    await expect(modal.locator('input[type="email"]')).toHaveCount(1);
    await expect(modal.locator('input[type="password"]')).toHaveCount(0);

    // Grupo del reto: 13 cursos + 2 de comunidad, con «Prefiero no elegir».
    const group = modal.getByLabel('¿A qué curso sumamos tu participación en el reto?');
    await expect(group.locator('option')).toHaveCount(16);
    await expect(group.locator('optgroup')).toHaveCount(4);

    // Aportación voluntaria a KORUM: desmarcada, título y punto (3) exactos.
    await expect(modal.getByTestId('guarantee-check')).not.toBeChecked();
    await expect(modal.getByTestId('guarantee-title')).toHaveText('🛡️ Apoyar a KORUM con una aportación voluntaria (+1,80 €)');
    await expect(modal.getByTestId('guarantee-description')).toHaveText(/^Es opcional y no cambia nada de tu donación\..*\(3\) la emisión automática de tu Certificado Fiscal de donación \(Ley 49\/2002\)\.$/);
    await expect(modal).not.toContainText('propina');

    // NIF opcional: solo aparece si se pide el certificado.
    await expect(modal.getByLabel('NIF o NIE')).toHaveCount(0);
    await modal.getByLabel('Quiero mi certificado fiscal').check();
    await expect(modal.getByLabel('NIF o NIE')).toBeVisible();
    await modal.getByLabel('Quiero mi certificado fiscal').uncheck();

    await expectNoMissingTranslations(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);

    // Elegir 10 €, el curso y pagar con Bizum: el total no incluye nada que no se haya marcado.
    await modal.getByText('10,00 €', { exact: true }).click();
    // Un curso que ninguna otra prueba cuenta al número exacto (el catálogo comprueba 3º de Primaria): las suites corren en paralelo.
    await group.selectOption('2º de ESO');
    await modal.getByLabel(EMAIL_LABEL).fill(email);
    await expect(modal.getByTestId('checkout-summary')).toContainText('Total: 10,00 €');
    const since = Date.now();
    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();

    await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KD[0-9A-F]{16}&sig=/, NAVIGATION);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Pago simulado', NAVIGATION);
    await expect(page.getByText('10,00 €')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar el pago' }).click();

    await expect(page).toHaveURL(/\/aportar\/resultado\?pedido=/, NAVIGATION);
    const celebration = page.getByTestId('checkout-celebration');
    await expect(celebration.getByRole('heading', { level: 1 })).toHaveText(/¡Gracias! Tu aportación ya suma/);
    await expect(celebration).toContainText('Has pagado 10,00 €');
    await expect(celebration.getByRole('progressbar')).toBeVisible();
    await expect(celebration).toContainText(/Ya suman \d+ aportaciones/);
    await expect(celebration).toContainText(/2º de ESO ya suma \d+ famil/);
    await expect(celebration.getByRole('button', { name: /Compartir/ })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    const receipt = await emailTo(email, since);
    expect(receipt).toContain('10,00');
    expect(errors).toEqual([]);
  });

  test('sin Ley 49 verificada: justificante nominativo y sin NIF; club deportivo: categorías y afición', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openCheckout(page, '/ies-mediterraneo/iniciativas/8');
    await expect(dialog(page).getByTestId('guarantee-description')).toHaveText(/\(3\) la emisión automática de tu Justificante Nominativo de Aportación\.$/);
    await expect(dialog(page).getByLabel('Quiero mi certificado fiscal')).toHaveCount(0);

    await openCheckout(page, '/basket-valles/iniciativas/7');
    const group = dialog(page).getByLabel('¿A qué equipo sumamos tu participación en el reto?');
    await expect(group.locator('option', { hasText: 'Prebenjamín' })).toHaveCount(1);
    await expect(group.locator('option', { hasText: 'Socio / Afición' })).toHaveCount(1);
    await expect(group.locator('option')).toHaveCount(11);
    expect(errors).toEqual([]);
  });

  test('en catalán, con el selector manual de la aportación voluntaria desde 0 €', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openCheckout(page, '/ca/cervantes/iniciativas/1');
    const modal = dialog(page);
    await expect(modal.getByLabel('📧 El teu correu per enviar-te a l’instant el rebut o les entrades QR')).toBeVisible();
    await modal.getByRole('button', { name: /Triar un altre import/ }).click();
    await modal.getByText('2,00 €', { exact: true }).click();
    await expect(modal.getByTestId('guarantee-check')).toBeChecked();
    await expect(modal.getByTestId('checkout-summary')).toContainText('Total: 27,00 €');
    await modal.getByText('0,00 €', { exact: true }).click();
    await expect(modal.getByTestId('guarantee-check')).not.toBeChecked();
    await expect(modal.getByTestId('checkout-summary')).toContainText('Total: 25,00 €');
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('una iniciativa conseguida no admite pagar y cerrar el pago vuelve a la ficha', async ({ page }) => {
    await page.goto('/cervantes/iniciativas/3/aportar');
    await expect(dialog(page)).toBeVisible(NAVIGATION);
    await expect(dialog(page)).toContainText('Ya no se puede aportar');
    await expect(dialog(page).getByRole('button', { name: /^Pagar .+ con Bizum$/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/cervantes\/iniciativas\/3$/, NAVIGATION);
  });
});

test.describe('QA-F10 · pago rechazado', () => {
  test('explica qué ha pasado y deja pagar con tarjeta sin perder lo introducido', async ({ page, context }) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('abuelo');
    await openCheckout(page, '/cervantes/iniciativas/1');
    const modal = dialog(page);
    await modal.getByLabel('Otro importe (€)').first().fill('12');
    await modal.getByRole('button', { name: /Elegir otro importe/ }).click();
    await modal.getByText('1,00 €', { exact: true }).click();
    await modal.getByLabel(EMAIL_LABEL).fill(email);
    await expect(modal.getByTestId('checkout-summary')).toContainText('Total: 13,00 €');
    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await page.getByRole('button', { name: 'Rechazar el pago' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bizum no ha confirmado el pago', NAVIGATION);
    await expect(page.locator('main').getByRole('alert')).toContainText('No se te ha cobrado nada');
    await expectNoSeriousA11yViolations(page);
    // Si al volver de Bizum se abre otra pestaña (sin `sessionStorage`), el enlace ya lleva lo elegido: importe y aportación voluntaria.
    const retryHref = await page.getByRole('link', { name: 'Probar otra vez' }).getAttribute('href');
    const otherTab = await context.newPage();
    await otherTab.goto(retryHref ?? '');
    await expect(otherTab.locator('#checkout-modal')).toBeVisible(NAVIGATION);
    await expect(otherTab.locator('#checkout-modal').getByTestId('checkout-summary')).toContainText('Total: 13,00 €');
    await otherTab.close();

    await page.getByRole('link', { name: 'Pagar con tarjeta' }).click();

    await expect(dialog(page)).toBeVisible(NAVIGATION);
    await expect(dialog(page).getByLabel(EMAIL_LABEL)).toHaveValue(email);
    await expect(dialog(page).getByLabel('Otro importe (€)').first()).toHaveValue('12');
    await expect(dialog(page).getByTestId('guarantee-check')).toBeChecked();
    await expect(dialog(page).getByTestId('checkout-summary')).toContainText('Total: 13,00 €');
    expect(errors).toEqual([]);
  });

  test('un enlace del simulador o del resultado sin su firma no deja hacer nada', async ({ page }) => {
    await page.goto('/cervantes/iniciativas/1/aportar/simulador?pedido=KD0000000000000000&sig=' + 'a'.repeat(64));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Este pago ya no está pendiente');
    await expect(page.getByRole('button', { name: 'Confirmar el pago' })).toHaveCount(0);
    await page.goto('/cervantes/iniciativas/1/aportar/resultado?pedido=KD0000000000000000&sig=' + 'a'.repeat(64));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('No podemos abrir este resultado');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
});

test.describe('QA-F07 · taquilla', () => {
  test('aforo disponible, Gastos de gestión digital desglosados y pase imprimible con QR que también llega por email', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const email = uniqueEmail('padre');
    await openCheckout(page, '/cervantes/iniciativas/2');
    const modal = dialog(page);
    const available = Number((await modal.getByText(/^Quedan \d+ de 200$/).textContent())?.match(/Quedan (\d+)/)?.[1]);
    expect(available).toBeGreaterThan(0);
    await expect(modal).toContainText(/Precio: 5,00\s€ \+ 0,\d\d\s€ de Gastos de gestión digital/);

    // El «+» se detiene en las plazas libres: nunca se puede pedir más aforo del que queda.
    const more = modal.getByRole('button', { name: 'Añadir una' });
    for (let i = 1; i < available; i += 1) await more.click();
    await expect(modal.getByTestId('ticket-quantity')).toHaveText(String(Math.min(available, 20)));
    await expect(more).toBeDisabled();
    while (Number(await modal.getByTestId('ticket-quantity').textContent()) > 1) await modal.getByRole('button', { name: 'Quitar una' }).click();
    await expect(modal.getByTestId('checkout-summary')).toContainText(/1 × 5,00\s€ \+ 0,\d\d\s€ de Gastos de gestión digital/);

    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);

    await modal.getByLabel(EMAIL_LABEL).fill(email);
    const since = Date.now();
    await modal.getByRole('button', { name: /Tarjeta, Apple Pay o Google Pay/ }).click();
    await expect(page.getByText('Tarjeta, Apple Pay o Google Pay')).toBeVisible(NAVIGATION);
    await page.getByRole('button', { name: 'Confirmar el pago' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Tus entradas ya son tuyas/, NAVIGATION);
    await page.getByTestId('view-pass').click();
    await expect(page).toHaveURL(/\/cervantes\/entrada\/[0-9a-f-]{36}\?sig=/, NAVIGATION);
    await expect(page.getByRole('img', { name: 'Código QR para entrar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Imprimir' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Enviar por WhatsApp/ })).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
    await expectNoSeriousA11yViolations(page);

    // Impresión limpia: sin cabecera, pie ni botones; el QR sigue.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('header').first()).toBeHidden();
    await expect(page.getByRole('button', { name: 'Imprimir' })).toBeHidden();
    await expect(page.getByRole('img', { name: 'Código QR para entrar' })).toBeVisible();
    await page.emulateMedia({ media: 'screen' });

    const message = await emailTo(email, since);
    expect(message).toMatch(/\/cervantes\/entrada\/[0-9a-f-]{36}\?sig=/);
    expect(errors).toEqual([]);
  });
});
