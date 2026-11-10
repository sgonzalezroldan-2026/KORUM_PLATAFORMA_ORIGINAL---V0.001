import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_SCHEMA } from './e2e-database';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 4.2d · Renovación de comercios amigos, reasignación y `CREDIT_POOL` (QA-S02), como personas reales con cobros simulados: un comercio patrocina
 * una campaña; la entidad lo aprueba y elige la regla «lo elegimos nosotros»; la campaña fracasa y, al pasar la tarea de devoluciones, su dinero espera en
 * la bolsa con su plazo (sigue en el directorio); la entidad lo lleva a otra campaña desde la ficha del comercio; después le envía el enlace de renovación,
 * el comercio paga en la página de pago y vuelve a su renovación con sus documentos. Catalán, axe, 430 px y sin errores de consola.
 */

const NAVIGATION = { timeout: 45_000 };
const server = expect.configure({ timeout: 30_000 });

test.describe.configure({ timeout: 360_000 });

/** Copia una campaña de presupuesto de la semilla (Cervantes) a la entidad de la prueba, abierta y sin nada recaudado. */
async function openCampaign(slug: string, title: string, closesInDays: number): Promise<number> {
  return withE2eDb(async (db) => {
    const { rows: columns } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Initiative' ORDER BY ordinal_position`, [E2E_SCHEMA]);
    const skip = new Set(['id', 'walletEscrowId', 'organizationId', 'sourceIdeaId', 'gatePinHash', 'gatePinExpiresAt', 'title', 'status', 'stepIndex', 'raisedCents', 'goalCents', 'closesAt', 'totalContributions', 'matchingPoolTotalCents', 'matchingPoolRemainingCents', 'matchingSponsorName', 'firstPayinAt']);
    const copy = columns.map((row) => row.column_name as string).filter((name) => !skip.has(name));
    const quoted = copy.map((name) => `"${name}"`).join(', ');
    const fromSource = copy.map((name) => `i."${name}"`).join(', ');
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO "Initiative" (${quoted}, "walletEscrowId", "organizationId", "title", "status", "stepIndex", "raisedCents", "goalCents", "closesAt")
       SELECT ${fromSource}, $1, (SELECT id FROM "Organization" WHERE slug = $2), $3, 'FUNDRAISING'::"InitiativeStatus", 4, 0, 400000, now() + make_interval(days => $4)
       FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = 'cervantes' AND i.format = 'BUDGET' ORDER BY i.id LIMIT 1 RETURNING id`,
      [walletId, slug, title, closesInDays]
    );
    return Number(rows[0].id);
  });
}

/** Un comercio paga su patrocinio (nivel Bronce: 100,00 € + 15,00 € de gestión + 3,15 € de IVA) desde la página de comercios de la entidad. */
async function sponsor(page: Page, slug: string, name: string, email: string) {
  await page.goto(`/${slug}/comercios`);
  await page.getByTestId('sponsor-cta').click();
  await expect(page).toHaveURL(/\/iniciativas\/\d+\/aportar\?modo=comercio$/, NAVIGATION);
  const modal = page.locator('#checkout-modal');
  await expect(modal).toBeVisible(NAVIGATION);
  await modal.getByLabel('Nombre comercial').fill(name);
  await modal.getByLabel('CIF o NIF de facturación').fill('B-12345674');
  await modal.getByLabel('Persona de contacto').fill('Rosa Gil');
  await modal.getByLabel('Teléfono').fill('600 11 22 33');
  await modal.getByLabel('Email para la factura y para pedirte el logotipo').fill(email);
  await modal.locator('label').filter({ hasText: 'Bronce' }).click();
  await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
  await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KS[0-9A-F]{16}&sig=/, NAVIGATION);
  await page.getByRole('button', { name: 'Confirmar el pago' }).click();
  await expect(page).toHaveURL(/\/aportar\/resultado\?pedido=KS/, NAVIGATION);
}

/** Pasa una tarea como lo haría el cron (con su secreto), en una ejecución propia: la del hueco actual puede haberla gastado otra prueba. */
async function runCron(request: APIRequestContext, type: 'MASS_REFUND' | 'OUTBOX_DISPATCH', slug: string) {
  await withE2eDb((db) => db.query(`INSERT INTO "Job" ("idempotencyKey", "type", "payloadJson", "runAt", "updatedAt") VALUES ($1, $2::"JobType", '{}', now(), now())`, [`${type}:e2e-${randomUUID()}`, type]));
  const response = await request.get(`/api/cron/${slug}`, { headers: { authorization: `Bearer ${E2E_SERVER_ENV.CRON_SECRET}` } });
  expect(response.status()).toBe(200);
}

/** La tarea de devoluciones (que reasigna el dinero de los comercios) y después la bandeja de emails, que envía su aviso. */
async function runMassRefund(request: APIRequestContext) {
  await runCron(request, 'MASS_REFUND', 'mass-refund');
  await runCron(request, 'OUTBOX_DISPATCH', 'outbox-dispatch');
}

test.describe('Sprint 4.2d · renovación y reasignación de comercios amigos', () => {
  test('campaña fallida → bolsa con su plazo → la entidad la lleva a otra campaña → enlace de renovación pagado', async ({ page, browser, request, isMobile }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const origin = await openCampaign(entity.slug, 'Toldos para el patio', 30);

    // --- Un comercio paga y la entidad lo aprueba ---
    const shopContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const shop = await shopContext.newPage();
    const shopErrors = trackConsoleErrors(shop);
    const name = `Librería El Faro ${testInfo.project.name} ${Date.now().toString(36)}`;
    const email = uniqueEmail('faro');
    await sponsor(shop, entity.slug, name, email);
    await page.goto(`/panel/${entity.slug}/aprobaciones`);
    const card = page.getByTestId('moderation-sponsor').filter({ hasText: name });
    await card.getByRole('button', { name: /Aprobar comercio/ }).click();
    const notice = page.locator('#comercios').getByTestId('approvals-notice');
    await server(notice).toContainText(`${name} ya es comercio amigo`);

    // --- Regla de la entidad: «Lo elegimos nosotros» ---
    const rule = page.getByTestId('sponsor-renewal-rule');
    await rule.getByLabel(/A dónde va el dinero/).selectOption('MANUAL');
    await rule.getByRole('button', { name: 'Guardar la regla' }).click();
    await server(notice).toContainText('Regla guardada: «Lo elegimos nosotros en cada caso».');
    await expect(notice).toBeFocused();

    // --- La campaña fracasa y pasa la tarea: el dinero espera en la bolsa, con su plazo, y el comercio sigue visible ---
    const target = await openCampaign(entity.slug, 'Gradas del polideportivo', 20);
    await withE2eDb((db) => db.query(`UPDATE "Initiative" SET status = 'REFUNDING' WHERE id = $1`, [origin]));
    const since = Date.now();
    await runMassRefund(request);
    await page.reload();
    await server(card).toContainText('Esperando campaña · visible');
    await card.getByText('Ficha / Renovar').click();
    const detail = card.getByTestId('sponsor-detail');
    await expect(detail.getByTestId('sponsor-money')).toContainText(/100,00\s€ esperando campaña, retenidos en PAYCOMET hasta el/);
    const pooled = await emailTo(email, since, (text) => text.includes('espera una nueva campaña'));
    expect(pooled).toContain('Mientras tanto sigues apareciendo como comercio amigo');
    await shop.goto(`/${entity.slug}/comercios`);
    await server(shop.getByRole('list', { name: 'Comercios amigos' })).toContainText(name);
    if (isMobile) await expectMobileStackIsOneColumn(page);
    await expectNoHorizontalOverflow(page);
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);

    // --- La entidad lo lleva a la otra campaña desde la ficha ---
    await detail.getByLabel('Campaña a la que llevar lo que espera').selectOption(String(target));
    await detail.getByRole('button', { name: /Llevar 100,00\s€ a «Gradas del polideportivo»/ }).click();
    await server(notice).toContainText(`ya suman en «Gradas del polideportivo»`);
    await expect(notice).toBeFocused();
    await server(card).toContainText('Aprobado · visible');
    const reassigned = await emailTo(email, since, (text) => text.includes('sigue sumando'));
    expect(reassigned).toContain('Gradas del polideportivo');

    // --- Renovación: dentro del plazo, la entidad le envía el enlace; el comercio paga y vuelve a su renovación ---
    await withE2eDb((db) => db.query(`UPDATE "Sponsor" SET "expiresAt" = now() + interval '10 days' WHERE name = $1`, [name]));
    await page.reload();
    await card.getByText('Ficha / Renovar').click();
    await card.getByRole('button', { name: /Enviarle el enlace de renovación/ }).click();
    await server(notice).toContainText(`Hemos enviado a ${name} el enlace para renovar.`);
    const linkEmail = await emailTo(email, since, (text) => text.includes('caduca el'));
    const link = /https?:\/\/[^\s]+(\/[^\s/]+\/comercios\/renovar\?r=[0-9]+\.[0-9]+\.[0-9a-f]{64})/.exec(linkEmail);
    expect(link, 'enlace de renovación').not.toBeNull();

    await shop.goto(link![1]!);
    await expect(shop.getByRole('heading', { level: 1 })).toContainText(name, NAVIGATION);
    await expect(shop.getByText(/Total/).locator('..')).toContainText('118,15');
    await expectNoHorizontalOverflow(shop);
    await expectNoSeriousA11yViolations(shop);
    await shop.getByLabel('Bizum').check();
    await shop.getByRole('button', { name: /Pagar .+ y renovar/ }).click();
    await expect(shop).toHaveURL(/\/aportar\/simulador\?pedido=KR[0-9A-F]{16}&sig=/, NAVIGATION);
    await shop.getByRole('button', { name: 'Confirmar el pago' }).click();
    await expect(shop).toHaveURL(/\/comercios\/renovar\?pedido=KR[0-9A-F]{16}&sig=/, NAVIGATION);
    await expect(shop.getByRole('heading', { level: 1 })).toHaveText('¡Renovado! Gracias por un año más');
    await shop.getByRole('link', { name: 'Ver mi justificante y mi factura' }).click();
    await expect(shop.getByTestId('sponsor-justificante')).toContainText(name, NAVIGATION);
    const renewed = await emailTo(email, since, (text) => text.includes('Gracias por un año más'));
    // Con la regla «lo elegimos nosotros», la renovación espera retenida en PAYCOMET hasta que la entidad elija campaña.
    expect(renewed).toContain('elegirá a qué campaña llevar tus');
    // El mismo enlace ya no vuelve a cobrar.
    await shop.goto(link![1]!);
    await expect(shop.getByRole('heading', { level: 1 })).toHaveText('Ya has renovado');

    // --- El directorio enseña al comercio una sola vez; el panel, en catalán ---
    await shop.goto(`/${entity.slug}/comercios`);
    await expect(shop.getByRole('list', { name: 'Comercios amigos' }).getByText(name)).toHaveCount(1);
    await page.goto(`/ca/panel/${entity.slug}/aprobaciones`);
    await expect(page.getByTestId('sponsor-renewal-rule')).toContainText('On van els diners de les renovacions');
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);

    expect(errors).toEqual([]);
    expect(shopErrors).toEqual([]);
    await shopContext.close();
  });
});
