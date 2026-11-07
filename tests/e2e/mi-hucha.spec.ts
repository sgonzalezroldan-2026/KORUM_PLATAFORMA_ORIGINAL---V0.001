import { expect, test, type Page } from '@playwright/test';
import { codeIn, emailTo, uniqueEmail } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

/**
 * QA-F06 (Mi Hucha) y QA-F08 (modo `PLEDGE`) como una persona real (Sprint 3.8). Cada proyecto crea su propia familia, entra con el código de
 * su email desde la píldora de Mi Hucha de Cervantes (semilla), programa una aportación mensual, paga el primer mes en el simulador de Paycomet
 * (que guarda la tarjeta) y la pausa, la reanuda y la cancela. Nunca ve un saldo. El modo `DISABLED` (404 y sin píldora) se comprueba sin
 * cambiar el ajuste global, que compartirían las pruebas en paralelo: está cubierto en `tests/unit/hucha-page.spec.tsx` y en la integración.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const server = expect.configure({ timeout: 30_000 });

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  for (const path of ['/mi-hucha', '/ca/mi-hucha', '/login', '/cervantes']) await request.get(path, { timeout: 120_000 }).catch(() => undefined);
});

async function signIn(page: Page, email: string) {
  const octet = () => 1 + Math.floor(Math.random() * 250);
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` });
  await page.goto(`/login?next=${encodeURIComponent('/mi-hucha')}`);
  await page.getByLabel('Tu email').fill(email);
  const since = Date.now();
  await page.getByRole('button', { name: 'Prefiero un código de 6 dígitos' }).click();
  await expect(page.getByRole('heading', { name: 'Escribe el código' })).toBeFocused({ timeout: 30_000 });
  await page.getByLabel('Código de 6 dígitos').fill(codeIn(await emailTo(email, since)));
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await server(page).toHaveURL(/\/mi-hucha$/);
}

/** En móvil todo va en una columna; en escritorio el formulario reparte duración y campaña en dos a propósito. */
async function checkPage(page: Page, mobile: boolean) {
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);
  if (mobile) await expectMobileStackIsOneColumn(page);
  await expectNoSeriousA11yViolations(page);
}

test.describe('Mi Hucha · aportación mensual', () => {
  test('desde la portada: entrar, programar 5 €/mes, pagar el primer mes, y pausar, reanudar y cancelar en un clic; nunca un saldo', async ({ page }, testInfo) => {
    const mobile = testInfo.project.name === 'mobile';
    const errors = trackConsoleErrors(page);
    // La píldora de la portada abre Mi Hucha con el alta para esa entidad; sin sesión, primero a entrar.
    await page.goto('/cervantes');
    await expect(page.getByRole('link', { name: /Mi Hucha/ })).toHaveAttribute('href', '/mi-hucha?entidad=cervantes');
    await page.goto('/mi-hucha?entidad=cervantes');
    await server(page).toHaveURL(/\/login\?next=%2Fmi-hucha%3Fentidad%3Dcervantes$/);

    await signIn(page, uniqueEmail('hucha'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mi Hucha' })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.getByRole('heading', { name: 'Todavía no aportas cada mes' })).toBeVisible();

    await page.goto('/mi-hucha?entidad=cervantes');
    await expect(page.getByRole('heading', { level: 2, name: /^Aportar cada mes a / })).toBeVisible();
    await page.getByText('5,00 € al mes').click();
    await page.getByLabel('¿Durante cuántos meses?').selectOption('3');
    const summary = page.getByTestId('pledge-summary');
    await expect(summary).toContainText('Cada mes: 5,00 € para la campaña + 0,25 € de gestión de Mi Hucha = 5,25 €');
    await expect(summary).toContainText('durante 3 meses');
    await expect(summary).toContainText('Como mucho, 15,75 € en total');
    await expect(page.getByText(/KORUM nunca la ve/)).toBeVisible();
    await expect(page.getByText(/saldo disponible/i)).toHaveCount(0);
    await checkPage(page, mobile);

    // Un importe fuera de rango se avisa junto al campo, sin ir a pagar.
    await page.getByLabel('Otro importe al mes (€)').fill('1');
    await page.getByRole('button', { name: /Pagar el primer mes y activar/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Escribe un importe entre 2,00 € y 200,00 € al mes.' })).toBeVisible();
    await page.getByLabel('Otro importe al mes (€)').fill('');
    await page.getByText('5,00 € al mes').click();

    // El primer mes, en la página de pago (el simulador en pruebas), que avisa de que guarda la tarjeta.
    await page.getByRole('button', { name: /Pagar el primer mes y activar/ }).click();
    await server(page).toHaveURL(/\/aportar\/simulador\?pedido=KH/);
    await expect(page.getByText('Es el primer mes de una aportación mensual')).toBeVisible();
    await expect(page.getByText('5,25 €')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar el pago' }).click();

    await server(page).toHaveURL(/\/mi-hucha\?pedido=KH[0-9A-F]{16}$/);
    const result = page.getByTestId('pledge-result');
    // La confirmación llega por la notificación del pago: margen para un equipo cargado (QA del 3.8).
    await server(result).toHaveAttribute('data-variant', 'activated');
    await expect(page.getByRole('heading', { name: '¡Aportación mensual activada!' })).toBeFocused();

    const card = page.getByTestId('pledge-card');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-status', 'ACTIVE');
    await expect(card).toContainText('Activa');
    await expect(card).toContainText('1 de 3');
    await expect(card).toContainText('5,00 €');
    await expect(card).toContainText('VISA');
    await expect(card).toContainText('Próximo cobro');
    await checkPage(page, mobile);

    // Pausar y reanudar con un clic; el resultado se anuncia y recibe el foco.
    await card.getByRole('button', { name: 'Pausar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Aportación en pausa' })).toBeFocused();
    await expect(card).toHaveAttribute('data-status', 'PAUSED');
    await expect(card).toContainText('En pausa');
    await card.getByRole('button', { name: 'Reanudar' }).click();
    await expect(card).toHaveAttribute('data-status', 'ACTIVE');

    // Volver a darse de alta con la misma entidad: ya tiene una viva.
    await page.goto('/mi-hucha?entidad=cervantes');
    await page.getByRole('button', { name: /Pagar el primer mes y activar/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Ya tienes una aportación mensual con esta entidad' })).toBeFocused();

    // Cancelar pide confirmarlo en el sitio, sin ventanas del navegador.
    await card.getByRole('button', { name: 'Cancelar la aportación' }).click();
    await expect(card.getByRole('group', { name: 'Confirmar la cancelación' })).toContainText('borraremos tu tarjeta guardada');
    await card.getByRole('button', { name: 'Sí, cancelar' }).click();
    await expect(card).toHaveAttribute('data-status', 'CANCELLED');
    await expect(card).toContainText('Cancelada');
    await expect(card.getByRole('button', { name: 'Reanudar' })).toHaveCount(0);
    // Tras cancelar, la vuelta del pago (`?pedido=`) ya no cuenta nada sobre aquel pago.
    await expect(page.getByTestId('pledge-result')).toHaveCount(0);
    await card.getByText(/Ver el mes cobrado/).click();
    await expect(card).toContainText('Cobrado');
    await checkPage(page, mobile);
    expect(errors).toEqual([]);
  });

  test('en catalán, sin entidad elegida, propone buscarla y no deja ningún texto sin traducir', async ({ page }, testInfo) => {
    const mobile = testInfo.project.name === 'mobile';
    const errors = trackConsoleErrors(page);
    await signIn(page, uniqueEmail('guardiola'));
    await page.goto('/ca/mi-hucha');
    await expect(page.getByRole('heading', { level: 1, name: 'La meva Guardiola' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Programar una aportació mensual' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cercar el meu centre o club' })).toBeVisible();
    await page.goto('/ca/mi-hucha?entidad=no-existeix');
    await expect(page.getByRole('alert').filter({ hasText: 'No trobem aquesta entitat' })).toBeVisible();
    await checkPage(page, mobile);
    expect(errors).toEqual([]);
  });
});
