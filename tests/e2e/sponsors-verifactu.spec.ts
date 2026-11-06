import { expect, test, type Page } from '@playwright/test';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F05 · Comercios amigos y patrocinio, como una persona real con cobros simulados (`PAYCOMET_MODE=mock`). Datos de la semilla: Cervantes
 * (`cervantes`) tiene comercios aprobados (ORO, PLATA y BRONCE), uno pendiente (Academia Kids) y la bolsa Matching 2x de la campaña 1 ya ocupada; los
 * pagos se hacen en San José (`san-jose`, campaña 6, con mucho margen hasta su meta): un patrocinio ORO en Cervantes completaría la campaña 1.
 * IES Mediterráneo (`ies-mediterraneo`) tiene la campaña 8 sin bolsa. Niveles de San José: 150, 300 y 600 €, con fee del 15 % y 21 % de IVA sobre el fee.
 */

const dialog = (page: Page) => page.locator('#checkout-modal');
const NAVIGATION = { timeout: 45_000 };
const RANK = { ORO: 3, PLATA: 2, BRONCE: 1 } as const;

test.describe.configure({ timeout: 150_000 });

async function openMerchantCheckout(page: Page) {
  await page.goto('/san-jose/comercios');
  await page.getByTestId('sponsor-cta').click();
  await expect(page).toHaveURL(/\/iniciativas\/\d+\/aportar\?modo=comercio$/, NAVIGATION);
  await expect(dialog(page)).toBeVisible(NAVIGATION);
}

async function fillBusiness(page: Page, name: string, taxId = 'B-12345674') {
  const modal = dialog(page);
  await modal.getByLabel('Nombre comercial').fill(name);
  await modal.getByLabel('CIF o NIF de facturación').fill(taxId);
  await modal.getByLabel('Persona de contacto').fill('Marta López');
  await modal.getByLabel('Teléfono').fill('600 11 22 33');
  await modal.getByLabel('Email para la factura y para pedirte el logotipo').fill('marta@comercio.example');
}

test.describe('QA-F05 · directorio de comercios amigos', () => {
  test('categoría ORO > PLATA > BRONCE, sin importes, solo aprobados, con cupón y navegación desde la portada', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/cervantes');
    await page.getByRole('navigation', { name: 'Secciones de la comunidad' }).getByRole('link', { name: /Comercios amigos/ }).click();
    await expect(page).toHaveURL(/\/cervantes\/comercios$/, NAVIGATION);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Negocios del barrio que impulsan a');

    const cards = page.getByTestId('sponsor-card');
    const total = await cards.count();
    expect(total).toBeGreaterThanOrEqual(2);
    // Orden estricto: el rango nunca sube al avanzar por la lista.
    const levels = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-level') ?? ''));
    const ranks = levels.map((level) => RANK[level as keyof typeof RANK]);
    expect(ranks.every((rank) => rank !== undefined)).toBe(true);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));

    // En público no hay importes ni fees, y un comercio pendiente de aprobar no aparece.
    const list = page.getByRole('list', { name: 'Comercios amigos' });
    await expect(list).not.toContainText(/\d[\d.]*,\d{2}\s?€/);
    await expect(list).not.toContainText(/fee|comisi/i);
    await expect(list).not.toContainText('Academia Kids');
    await expect(list.getByText(/Categoría (ORO|PLATA|BRONCE)/).first()).toBeVisible();

    // Cupón: diálogo con el código grande, copiar y compartir por WhatsApp.
    const coupon = page.getByRole('button', { name: 'Ver mi cupón' }).first();
    await coupon.click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByTestId('sponsor-code')).toHaveText(/^[A-Z0-9_-]+$/);
    await expect(modal.getByRole('button', { name: 'Copiar código' })).toBeVisible();
    await expect(modal.getByRole('link', { name: /WhatsApp/ })).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    if (testInfo.project.name === 'mobile') await expectMobileStackIsOneColumn(page);
    await expectNoHorizontalOverflow(page);
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('en catalán y en inglés, con los metadatos de la página y la entrada en el mapa del sitio', async ({ page, request }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/ca/cervantes/comercios');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Negocis del barri que impulsen');
    await expect(page.getByText(/Comerç amic · Categoria/).first()).toBeVisible();
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute('href', /\/en\/cervantes\/comercios$/);
    await expectNoMissingTranslations(page);
    await page.goto('/en/cervantes/comercios');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Local businesses backing');
    await expectNoSeriousA11yViolations(page);

    // Con la base de datos ocupada, el mapa del sitio sirve solo las páginas fijas (a propósito: un mapa incompleto es mejor que ninguno) y vuelve a completarse en cuanto responde.
    await expect.poll(async () => (await request.get('/sitemap.xml')).text(), { timeout: 40_000 }).toContain('/cervantes/comercios</loc>');
    expect(errors).toEqual([]);
  });

  test('una entidad inexistente responde 404', async ({ page }) => {
    const response = await page.goto('/no-existe-esta-entidad/comercios');
    expect(response?.status()).toBe(404);
  });
});

test.describe('QA-F05 · patrocinio de un comercio', () => {
  test('pestaña de comercio con fee e IVA encima, pago simulado, justificante y factura registrada en Veri*factu', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const name = `Panadería E2E ${testInfo.project.name} ${Date.now()}`;
    await openMerchantCheckout(page);
    const modal = dialog(page);

    // La pestaña de comercio está activa y la de familia sigue disponible.
    await expect(modal.getByRole('tab', { name: /Soy comercio local/ })).toHaveAttribute('aria-selected', 'true');
    await expect(modal.getByRole('tab', { name: /Soy familia o vecino/ })).toHaveAttribute('aria-selected', 'false');
    await expect(modal).toContainText('Patrocinio 100 % íntegro');
    await expect(modal.locator('input[type="password"]')).toHaveCount(0);

    // Sin datos no se paga: los errores salen junto a cada campo y el foco va al primero.
    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await expect(modal.getByLabel('Nombre comercial')).toBeFocused();
    await expect(modal.getByRole('alert').first()).toContainText('obligatorio');
    await fillBusiness(page, name, 'B12345679');
    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await expect(modal.getByLabel('CIF o NIF de facturación')).toBeFocused();
    await expect(modal.getByRole('alert').first()).toContainText('no parece válido');
    await modal.getByLabel('CIF o NIF de facturación').fill('B-12345674');

    // Nivel ORO: 600,00 € íntegros + 90,00 € de gestión + 18,90 € de IVA = 708,90 €.
    await modal.locator('label').filter({ hasText: 'Oro' }).click();
    const summary = modal.getByTestId('sponsor-summary');
    await expect(summary).toContainText('600,00 € íntegros a la iniciativa + 90,00 € de gestión publicitaria (15 %) + 18,90 € de IVA');
    await expect(summary).toContainText('Total: 708,90 €');
    await modal.getByLabel('Descuento o ventaja para las familias (opcional)').fill('10 % en pan');
    await modal.getByLabel('Código o cupón (opcional)').fill('E2E10');
    await expect(modal.getByLabel(/Recordatorio de renovación/)).toBeChecked();
    await expect(modal).not.toContainText('propina');

    if (testInfo.project.name === 'mobile') await expectNoHorizontalOverflow(page);
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);

    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KS[0-9A-F]{16}&sig=/, NAVIGATION);
    await expect(page.getByText('708,90 €')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar el pago' }).click();

    await expect(page).toHaveURL(/\/aportar\/resultado\?pedido=KS/, NAVIGATION);
    const celebration = page.getByTestId('sponsorship-celebration');
    await expect(celebration.getByRole('heading', { level: 1 })).toContainText(`¡Gracias, ${name}!`);
    await expect(celebration).toContainText('Has pagado 708,90 €');
    await expect(celebration).toContainText('Tus 600,00 € llegan íntegros a la hucha de la iniciativa');
    await expect(celebration).toContainText('El centro revisará tu comercio');
    await expectNoSeriousA11yViolations(page);

    // Justificante: el 100 % del nivel, sin mezclar el fee.
    await page.getByTestId('sponsor-doc-justificante').click();
    const receipt = page.getByTestId('sponsor-justificante');
    await expect(receipt).toBeVisible(NAVIGATION);
    await expect(receipt).toContainText(name);
    await expect(receipt).toContainText('B12345674');
    await expect(receipt).toContainText('600,00 €');
    await expect(receipt).toContainText('Oro');
    await expect(receipt).toContainText('Hucha de la iniciativa');
    await expect(receipt).not.toContainText('90,00 €');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expectNoSeriousA11yViolations(page);

    // Factura de KORUM por el fee: base 90,00 €, IVA 18,90 €, total 108,90 €, con su número y su huella Veri*factu.
    await page.goBack();
    await page.getByTestId('sponsor-doc-factura').click();
    const invoice = page.getByTestId('sponsor-factura');
    await expect(invoice).toBeVisible(NAVIGATION);
    await expect(invoice.getByTestId('invoice-number')).toHaveText(/^FAC-\d{4}-\d{4,}$/);
    await expect(invoice).toContainText('90,00 €');
    await expect(invoice).toContainText('18,90 €');
    await expect(invoice).toContainText('108,90 €');
    await expect(invoice).toContainText('A58818501');
    await expect(invoice).toContainText('Veri*factu');
    await expect(invoice.getByRole('link', { name: /Verificar en la Agencia Tributaria/ })).toHaveAttribute('href', /^https:\/\//);

    // Impresión limpia: sin cabecera ni botones.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('header').first()).toBeHidden();
    await expect(page.getByRole('button', { name: 'Imprimir o guardar en PDF' })).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
    await expectNoSeriousA11yViolations(page);

    // Mientras el centro no lo apruebe (Sprint 4.2), el comercio no aparece en el directorio público.
    await page.goto('/san-jose/comercios');
    await expect(page.getByRole('list', { name: 'Comercios amigos' })).not.toContainText(name);
    expect(errors).toEqual([]);
  });

  test('un pago rechazado explica qué pasó y vuelve a la pestaña de comercio sin perder lo escrito, salvo el CIF', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const name = `Librería rechazada ${testInfo.project.name} ${Date.now()}`;
    await openMerchantCheckout(page);
    const modal = dialog(page);
    await fillBusiness(page, name);
    await modal.getByLabel('Código o cupón (opcional)').fill('RECHAZO5');
    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await page.getByRole('button', { name: 'Rechazar el pago' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bizum no ha confirmado el pago', NAVIGATION);
    await expect(page.locator('main').getByRole('alert')).toContainText('No se te ha cobrado nada');
    await expectNoSeriousA11yViolations(page);
    await page.getByRole('link', { name: 'Pagar con tarjeta' }).click();

    await expect(dialog(page)).toBeVisible(NAVIGATION);
    await expect(dialog(page).getByRole('tab', { name: /Soy comercio local/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog(page).getByLabel('Nombre comercial')).toHaveValue(name);
    await expect(dialog(page).getByLabel('Código o cupón (opcional)')).toHaveValue('RECHAZO5');
    // El CIF nunca se guarda en el navegador.
    await expect(dialog(page).getByLabel('CIF o NIF de facturación')).toHaveValue('');
    expect(errors).toEqual([]);
  });

  test('la bolsa Matching 2x se ofrece solo si la iniciativa no la tiene; una taquilla no admite comercios', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    // IES Mediterráneo, campaña 8: sin bolsa, así que el comercio puede destinar su patrocinio a ella.
    await page.goto('/ies-mediterraneo/iniciativas/8/aportar?modo=comercio');
    await expect(dialog(page)).toBeVisible(NAVIGATION);
    await expect(dialog(page).getByLabel('Destinar mi patrocinio a la bolsa Matching 2x')).toBeVisible();
    await expect(dialog(page).getByLabel('Destinar mi patrocinio a la bolsa Matching 2x')).not.toBeChecked();
    await expectNoSeriousA11yViolations(page);

    // Cervantes, campaña 1: su bolsa Matching 2x ya está ocupada, así que no se ofrece otra.
    await page.goto('/cervantes/iniciativas/1/aportar?modo=comercio');
    await expect(dialog(page)).toBeVisible(NAVIGATION);
    await expect(dialog(page).getByLabel('Nombre comercial')).toBeVisible();
    await expect(dialog(page).getByLabel('Destinar mi patrocinio a la bolsa Matching 2x')).toHaveCount(0);

    // La entrada de Cervantes (taquilla, campaña 2) no tiene pestaña de comercio aunque se pida por la URL.
    await page.goto('/cervantes/iniciativas/2/aportar?modo=comercio');
    await expect(dialog(page)).toBeVisible(NAVIGATION);
    await expect(dialog(page).getByRole('tab')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('los documentos de un patrocinio no se abren sin la firma de su pedido', async ({ page }) => {
    await page.goto('/cervantes/comercios/documentos/factura?pedido=KS0000000000000000&sig=' + 'a'.repeat(64));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('No encontramos este documento');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const response = await page.goto('/cervantes/comercios/documentos/otra-cosa?pedido=KS0000000000000000&sig=' + 'a'.repeat(64));
    expect(response?.status()).toBe(404);
  });
});
