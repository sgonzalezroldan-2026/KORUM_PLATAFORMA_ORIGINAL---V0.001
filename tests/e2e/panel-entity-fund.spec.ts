import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_SCHEMA } from './e2e-database';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { activateCosigner, registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 4.2f · Fondo de actividades (QA-S02: una bolsa vencida pasa al Fondo y se liquida a la entidad con doble firma, sin devolver nada al comercio),
 * como personas reales con cobros simulados: un comercio patrocina una campaña y la entidad lo admite; la campaña fracasa, su dinero espera en la bolsa y
 * la bolsa vence; la tarea diaria lo pasa al Fondo y avisa al comercio. Quien dirige pide la liquidación con su destino y firma con su enlace y su código;
 * la cofirma firma en su navegador; el dinero sale a la cuenta de la entidad y el justificante se descarga en PDF. Catalán, axe, 430 px, sin errores.
 */

const NAVIGATION = { timeout: 45_000 };
const server = expect.configure({ timeout: 30_000 });
const PURPOSE = 'Material para las colonias de primavera y la merienda de la fiesta de fin de curso';

test.describe.configure({ timeout: 420_000 });

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
  await modal.getByLabel('Persona de contacto').fill('Iván Sanz');
  await modal.getByLabel('Teléfono').fill('600 44 55 66');
  await modal.getByLabel('Email para la factura y para pedirte el logotipo').fill(email);
  await modal.locator('label').filter({ hasText: 'Bronce' }).click();
  await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
  await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KS[0-9A-F]{16}&sig=/, NAVIGATION);
  await page.getByRole('button', { name: 'Confirmar el pago' }).click();
  await expect(page).toHaveURL(/\/aportar\/resultado\?pedido=KS/, NAVIGATION);
}

/** Pasa una tarea como lo haría el cron (con su secreto), en una ejecución propia: la del hueco actual puede haberla gastado otra prueba. */
async function runCron(request: APIRequestContext, type: 'MASS_REFUND' | 'CREDIT_POOL_EXPIRY' | 'OUTBOX_DISPATCH', slug: string) {
  await withE2eDb((db) => db.query(`INSERT INTO "Job" ("idempotencyKey", "type", "payloadJson", "runAt", "updatedAt") VALUES ($1, $2::"JobType", '{}', now(), now())`, [`${type}:e2e-${randomUUID()}`, type]));
  const response = await request.get(`/api/cron/${slug}`, { headers: { authorization: `Bearer ${E2E_SERVER_ENV.CRON_SECRET}` } });
  expect(response.status()).toBe(200);
}

/** El enlace de firma y el código que acaban de llegar a una persona. */
async function signingEmail(address: string, since: number): Promise<{ path: string; otp: string; text: string }> {
  const text = await emailTo(address, since, (body) => body.includes('Liquidar el Fondo de actividades'));
  const link = /https?:\/\/\S+\/firmar#t=[A-Za-z0-9_-]+/.exec(text)?.[0];
  const otp = /Tu código de 6 dígitos: (\d{6})/.exec(text)?.[1];
  expect(link, 'enlace de firma').toBeTruthy();
  expect(otp, 'código de firma').toBeTruthy();
  const url = new URL(link!);
  return { path: url.pathname + url.hash, otp: otp!, text };
}

async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectMobileStackIsOneColumn(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
}

test.describe('Sprint 4.2f · Fondo de actividades de la entidad', () => {
  test('bolsa vencida → Fondo → liquidación con destino y doble firma → justificante, sin devolver nada al comercio', async ({ page, browser, request, isMobile }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const cosigner = await activateCosigner(browser, entity, page.viewportSize());
    const cosignerErrors = trackConsoleErrors(cosigner.page);
    const origin = await openCampaign(entity.slug, 'Toldos para el patio', 30);

    // --- Fondo vacío: el panel lo explica ---
    await page.goto(`/panel/${entity.slug}/fondo`);
    await server(page.getByRole('heading', { level: 1, name: 'Fondo de actividades' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Vuestro Fondo está vacío' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Fondo de actividades' })).toHaveAttribute('aria-current', 'page');

    // --- Un comercio paga y la entidad lo admite; la campaña fracasa y su dinero espera en la bolsa ---
    const shopContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const shop = await shopContext.newPage();
    const shopErrors = trackConsoleErrors(shop);
    const name = `Papelería Nube ${testInfo.project.name} ${Date.now().toString(36)}`;
    const email = uniqueEmail('nube');
    await sponsor(shop, entity.slug, name, email);
    await page.goto(`/panel/${entity.slug}/aprobaciones`);
    await page.getByTestId('moderation-sponsor').filter({ hasText: name }).getByRole('button', { name: /Aprobar comercio/ }).click();
    await server(page.locator('#comercios').getByTestId('approvals-notice')).toContainText(`${name} ya es comercio amigo`);
    await withE2eDb((db) => db.query(`UPDATE "Initiative" SET status = 'REFUNDING' WHERE id = $1`, [origin]));
    await runCron(request, 'MASS_REFUND', 'mass-refund');

    // --- La bolsa vence (61 días en ella) y la tarea diaria la pasa al Fondo; el comercio recibe su aviso ---
    await withE2eDb((db) => db.query(`UPDATE "Sponsor" SET "creditPoolAt" = now() - interval '61 days' WHERE name = $1 AND status = 'CREDIT_POOL'`, [name]));
    const since = Date.now();
    await runCron(request, 'CREDIT_POOL_EXPIRY', 'credit-pool-expiry');
    await runCron(request, 'OUTBOX_DISPATCH', 'outbox-dispatch');
    const toFund = await emailTo(email, since, (text) => text.includes('Fondo de actividades'));
    expect(toFund).toContain('no se devuelve una vez admitido el comercio');

    // --- Sin los documentos verificados, el Fondo se ve pero no se puede pedir ---
    await page.goto(`/panel/${entity.slug}/fondo`);
    const summary = page.getByTestId('fund-summary');
    await server(summary).toContainText(/100,00\s€/);
    await expect(summary).toContainText('Liquidadlo antes del');
    await expect(summary).toContainText('necesitáis los documentos del titular verificados');
    await expect(page.getByTestId('fund-request')).toHaveCount(0);
    await expect(page.getByTestId('fund-deposits')).toContainText(name);
    await expect(page.getByTestId('fund-deposits')).toContainText('Toldos para el patio');
    await checkPage(page, isMobile);

    // --- KORUM verifica los documentos (Super-Admin) y la entidad ya tiene cuenta destino ---
    await withE2eDb((db) => db.query(`UPDATE "Organization" SET "kybStatus" = 'VERIFIED', "paycometSplitId" = $2 WHERE slug = $1`, [entity.slug, `split-e2e-${randomUUID().slice(0, 8)}`]));
    await page.reload();
    const form = page.getByTestId('fund-request');
    await server(form).toContainText(/Hoy podéis liquidar 100,00\s€/);
    const purpose = form.getByLabel('Para qué se usará el dinero');
    await form.getByRole('button', { name: /Pedir la liquidación/ }).click();
    await expect(form.getByRole('alert')).toContainText('Escribid entre 10 y 500 caracteres');
    await expect(purpose).toBeFocused();
    await purpose.fill(PURPOSE);
    const directorSince = Date.now();
    await form.getByRole('button', { name: /Pedir la liquidación/ }).click();
    const notice = page.getByTestId('approvals-notice');
    await server(notice).toContainText('Liquidación pedida');
    await expect(notice).toBeFocused();
    const pending = page.getByTestId('fund-pending');
    await expect(pending).toContainText('Doble firma: 0 de 2');
    await expect(pending).toContainText(PURPOSE);
    await checkPage(page, isMobile);

    // --- 1ª firma (dirección) con su enlace y su código ---
    const cosignerSince = Date.now();
    const director = await signingEmail(entity.director, directorSince);
    await page.goto(director.path);
    await server(page.getByText(PURPOSE)).toBeVisible();
    await expect(page.getByText(/100,00\s€ · de 1 comercio/)).toBeVisible();
    await expect(page.getByText('Con las firmas que exige la entidad, el dinero se envía a la cuenta de la entidad. No se puede deshacer.')).toBeVisible();
    await checkPage(page, isMobile);
    await page.getByLabel('Código de 6 dígitos del email').fill(director.otp);
    await page.getByRole('button', { name: 'Firmar' }).click();
    await server(page.getByRole('heading', { name: 'Tu firma está registrada: 1 de 2' })).toBeFocused();

    // --- 2ª firma (cofirma) en su navegador: se aprueba y se envía en el acto ---
    const other = await signingEmail(entity.cosigner, cosignerSince);
    await cosigner.page.goto(other.path);
    await server(cosigner.page.getByText(PURPOSE)).toBeVisible();
    await cosigner.page.getByLabel('Código de 6 dígitos del email').fill(other.otp);
    await cosigner.page.getByRole('button', { name: 'Firmar' }).click();
    await server(cosigner.page.getByRole('heading', { name: '¡Firma completa!' })).toBeVisible();
    await expect(cosigner.page.getByText(/el dinero ya va de camino a la cuenta de la entidad/)).toBeVisible();
    await cosigner.page.getByRole('link', { name: 'Volver al Fondo de actividades' }).click();

    // --- Historial: enviada, con su justificante en PDF; el Fondo vuelve a estar vacío ---
    await server(cosigner.page.getByTestId('fund-history')).toContainText('Enviada a vuestra cuenta');
    await expect(cosigner.page.getByTestId('fund-summary')).toContainText(/0,00\s€/);
    const download = cosigner.page.waitForEvent('download');
    await cosigner.page.getByTestId('fund-receipt').click();
    expect((await download).suggestedFilename()).toMatch(/^justificante-fondo-FA-\d+\.pdf$/);
    await checkPage(cosigner.page, isMobile);
    const paid = await emailTo(entity.director, cosignerSince, (text) => text.includes('Fondo de actividades liquidado'));
    expect(paid).toMatch(/FA-\d+/);

    // --- Nada vuelve al comercio: su pago sigue completado ---
    const { rows } = await withE2eDb((db) => db.query(`SELECT c.status, c."refundedCents" FROM "Contribution" c JOIN "Sponsor" s ON s.id = c."sponsorId" WHERE s.name = $1`, [name]));
    expect(rows[0]).toMatchObject({ status: 'COMPLETED', refundedCents: 0 });

    // --- La misma página en catalán ---
    await page.goto(`/ca/panel/${entity.slug}/fondo`);
    await server(page.getByRole('heading', { level: 1, name: 'Fons d’activitats' })).toBeVisible();
    await expect(page.getByTestId('fund-history')).toContainText('Enviada al vostre compte');
    await checkPage(page, isMobile);

    expect(errors).toEqual([]);
    expect(cosignerErrors).toEqual([]);
    expect(shopErrors).toEqual([]);
    await cosigner.context.close();
    await shopContext.close();
  });
});
