import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_SCHEMA } from './e2e-database';
import { E2E_SERVER_ENV } from './e2e-env';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { activateCosigner, registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 4.4a · Liquidación de una campaña conseguida (QA-S03), como personas reales con cobros simulados: una familia completa la meta y recibe
 * «¡Lo hemos conseguido!»; quien dirige entra en Liquidaciones desde el cuadro de mandos, ve el aviso de los 90 días, elige pagar al proveedor (simulado),
 * corrige un IBAN mal escrito, adjunta la factura y firma con su enlace y su código; la cofirma ve el destinatario y la factura, firma en su navegador y el
 * dinero sale en el acto. La campaña queda cerrada, con el paso siguiente (las fotos). Catalán, axe, 430 px, sin errores de consola.
 * (El nombre del archivo incluye el reembolso: el 4.4b añade aquí las campañas vencidas.)
 */

const NAVIGATION = { timeout: 45_000 };
const server = expect.configure({ timeout: 30_000 });
const EMAIL_LABEL = '📧 Tu email para enviarte al instante tu recibo o tus entradas QR';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

test.describe.configure({ timeout: 420_000 });

/** Una campaña de presupuesto de 10 € abierta en la entidad de la prueba (copia de la semilla): comisión 0,50 € y pasarela 0,50 €. */
async function openCampaign(slug: string, title: string): Promise<number> {
  return withE2eDb(async (db) => {
    const { rows: columns } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Initiative' ORDER BY ordinal_position`, [E2E_SCHEMA]);
    const skip = new Set(['id', 'walletEscrowId', 'organizationId', 'sourceIdeaId', 'gatePinHash', 'gatePinExpiresAt', 'title', 'status', 'stepIndex', 'raisedCents', 'goalCents', 'closesAt', 'totalContributions', 'matchingPoolTotalCents', 'matchingPoolRemainingCents', 'matchingSponsorName', 'firstPayinAt', 'bracketFeeCents', 'maintFeeCents', 'gatewayFeeCents', 'beforeFileId', 'afterFileId', 'coverFileId', 'closedAt']);
    const copy = columns.map((row) => row.column_name as string).filter((name) => !skip.has(name));
    const quoted = copy.map((name) => `"${name}"`).join(', ');
    const fromSource = copy.map((name) => `i."${name}"`).join(', ');
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO "Initiative" (${quoted}, "walletEscrowId", "organizationId", "title", "status", "stepIndex", "raisedCents", "goalCents", "closesAt", "bracketFeeCents", "maintFeeCents", "gatewayFeeCents")
       SELECT ${fromSource}, $1, (SELECT id FROM "Organization" WHERE slug = $2), $3, 'FUNDRAISING'::"InitiativeStatus", 4, 0, 1000, now() + interval '30 days', 50, 0, 50
       FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = 'cervantes' AND i.format = 'BUDGET' ORDER BY i.id LIMIT 1 RETURNING id`,
      [walletId, slug, title]
    );
    return Number(rows[0].id);
  });
}

async function runCron(request: APIRequestContext, type: 'SUPPORTER_BROADCAST' | 'OUTBOX_DISPATCH', slug: string) {
  await withE2eDb((db) => db.query(`INSERT INTO "Job" ("idempotencyKey", "type", "payloadJson", "runAt", "updatedAt") VALUES ($1, $2::"JobType", '{}', now(), now())`, [`${type}:e2e-${randomUUID()}`, type]));
  const response = await request.get(`/api/cron/${slug}`, { headers: { authorization: `Bearer ${E2E_SERVER_ENV.CRON_SECRET}` } });
  expect(response.status()).toBe(200);
}

async function signingEmail(address: string, since: number, title: string): Promise<{ path: string; otp: string }> {
  const text = await emailTo(address, since, (body) => body.includes(`Liberar los fondos de «${title}»`));
  const link = /https?:\/\/\S+\/firmar#t=[A-Za-z0-9_-]+/.exec(text)?.[0];
  const otp = /Tu código de 6 dígitos: (\d{6})/.exec(text)?.[1];
  expect(link, 'enlace de firma').toBeTruthy();
  expect(otp, 'código de firma').toBeTruthy();
  const url = new URL(link!);
  return { path: url.pathname + url.hash, otp: otp! };
}

async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectMobileStackIsOneColumn(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
}

test.describe('Sprint 4.4a · liquidación de una campaña conseguida', () => {
  test('meta → aviso a la familia → Liquidaciones con aviso de 90 días → proveedor con factura → doble firma → enviada y cerrada', async ({ page, browser, request, isMobile }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const cosigner = await activateCosigner(browser, entity, page.viewportSize());
    const cosignerErrors = trackConsoleErrors(cosigner.page);
    await withE2eDb((db) => db.query(`UPDATE "Organization" SET "kybStatus" = 'VERIFIED', "paycometSplitId" = $2 WHERE slug = $1`, [entity.slug, `split-e2e-${randomUUID().slice(0, 8)}`]));
    const title = `Toldos del patio ${testInfo.project.name} ${Date.now().toString(36)}`;
    const initiativeId = await openCampaign(entity.slug, title);

    // --- Sin campañas conseguidas, Liquidaciones lo explica ---
    await page.goto(`/panel/${entity.slug}/liquidaciones`);
    await server(page.getByRole('heading', { level: 1, name: 'Liquidaciones de las campañas conseguidas' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Aún no hay campañas por liquidar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Liquidaciones' })).toHaveAttribute('aria-current', 'page');

    // --- Una familia completa la meta (10 €) por el checkout ---
    const familyContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const family = await familyContext.newPage();
    const familyErrors = trackConsoleErrors(family);
    const familyEmail = uniqueEmail('familia');
    await family.goto(`/${entity.slug}/iniciativas/${initiativeId}`);
    await family.locator('#fview-detail a[href$="/aportar"]').click();
    const modal = family.locator('#checkout-modal');
    await expect(modal).toBeVisible(NAVIGATION);
    await modal.getByText('10,00 €', { exact: true }).click();
    await modal.getByLabel(EMAIL_LABEL).fill(familyEmail);
    await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
    await expect(family).toHaveURL(/\/aportar\/simulador\?pedido=KD/, NAVIGATION);
    await family.getByRole('button', { name: 'Confirmar el pago' }).click();
    await expect(family).toHaveURL(/\/aportar\/resultado\?pedido=/, NAVIGATION);

    // «¡Lo hemos conseguido!» le llega por lotes (tarea SUPPORTER_BROADCAST), sin importes de nadie.
    const familySince = Date.now() - 60_000;
    await runCron(request, 'SUPPORTER_BROADCAST', 'supporter-broadcast');
    await runCron(request, 'OUTBOX_DISPATCH', 'outbox-dispatch');
    const celebration = await emailTo(familyEmail, familySince, (text) => text.includes('¡Lo hemos conseguido!'));
    expect(celebration).toContain(title);
    expect(celebration).toContain('Compartir el logro');

    // --- El cuadro de mandos lleva a Liquidaciones; la tarjeta enseña las cifras y el aviso de los 90 días ---
    await page.goto(`/panel/${entity.slug}`);
    await page.getByTestId(`settle-${initiativeId}`).click();
    await expect(page).toHaveURL(new RegExp(`/panel/${entity.slug}/liquidaciones$`), NAVIGATION);
    const card = page.getByTestId(`payout-ready-${initiativeId}`);
    await server(card).toContainText(title);
    await expect(card).toContainText(/Para el proyecto\s*9,00\s€/);
    await expect(page.getByTestId(`payout-window-${initiativeId}`)).toContainText(/Liquidadla antes del .+ \(quedan (89|90) días\)/);
    await checkPage(page, isMobile);

    // --- Al proveedor: un IBAN mal escrito y la factura que falta se dicen junto a su campo ---
    const form = page.getByTestId(`payout-form-${initiativeId}`);
    await form.getByLabel(/Directamente al proveedor/).check();
    await form.getByLabel('Nombre o razón social del proveedor').fill('Toldos Mediterráneo, S.L.');
    await form.getByLabel('CIF o NIF del proveedor').fill('B12345674');
    await form.getByLabel('IBAN del proveedor').fill('ES91 2100 0418 4502 0005 1333');
    await form.getByRole('button', { name: /Pedir la liquidación y firmar/ }).click();
    await expect(form.getByRole('alert').first()).toContainText('El IBAN no es válido');
    await expect(form.getByLabel('IBAN del proveedor')).toBeFocused();
    await form.getByLabel('IBAN del proveedor').fill('ES91 2100 0418 4502 0005 1332');
    await form.getByRole('button', { name: /Pedir la liquidación y firmar/ }).click();
    await expect(form.getByRole('alert')).toContainText('Adjuntad la factura');
    await form.getByLabel('Factura (o proforma) del proveedor').setInputFiles({ name: 'factura-toldos.pdf', mimeType: 'application/pdf', buffer: PDF });
    await server(form.getByTestId('payout-invoice-ready')).toContainText('factura-toldos.pdf');
    const directorSince = Date.now();
    await form.getByRole('button', { name: /Pedir la liquidación y firmar/ }).click();
    const notice = page.getByTestId('approvals-notice');
    await server(notice).toContainText('Liquidación pedida');
    await expect(notice).toBeFocused();
    const pending = page.getByTestId(`payout-pending-${initiativeId}`);
    await expect(pending).toContainText('Doble firma: 0 de 2');
    await expect(pending).toContainText('IBAN con código de entidad 2100, acabado en 1332');
    await expect(page.getByTestId('payout-requested-by')).toContainText('Pedida o cambiada por última vez por');
    await expect(pending).not.toContainText('2100 0418');
    await checkPage(page, isMobile);

    // --- 1ª firma (dirección) con su enlace y su código ---
    const cosignerSince = Date.now();
    const director = await signingEmail(entity.director, directorSince, title);
    await page.goto(director.path);
    await server(page.getByTestId('sign-payout-beneficiary')).toContainText('Para: Toldos Mediterráneo, S.L. · IBAN con código de entidad 2100, acabado en 1332');
    await expect(page.getByTestId('sign-payout-requested')).toContainText('Pedida o cambiada por última vez por');
    await expect(page.getByRole('link', { name: 'Ver la factura del proveedor' })).toBeVisible();
    await checkPage(page, isMobile);
    await page.getByLabel('Código de 6 dígitos del email').fill(director.otp);
    await page.getByRole('button', { name: 'Firmar' }).click();
    await server(page.getByRole('heading', { name: 'Tu firma está registrada: 1 de 2' })).toBeFocused();

    // --- 2ª firma (cofirma) en su navegador: se aprueba y se envía en el acto ---
    const other = await signingEmail(entity.cosigner, cosignerSince, title);
    await cosigner.page.goto(other.path);
    await server(cosigner.page.getByTestId('sign-payout-beneficiary')).toContainText('Toldos Mediterráneo');
    await cosigner.page.getByLabel('Código de 6 dígitos del email').fill(other.otp);
    await cosigner.page.getByRole('button', { name: 'Firmar' }).click();
    await server(cosigner.page.getByRole('heading', { name: '¡Doble firma completa! 2 de 2' })).toBeVisible();
    await expect(cosigner.page.getByText('¡Logro conseguido! El dinero ya va de camino.')).toBeVisible();
    await expect(cosigner.page.getByRole('link', { name: 'Subir las fotos del Antes y el Después' })).toBeVisible();
    await checkPage(cosigner.page, isMobile);
    await cosigner.page.getByRole('link', { name: 'Volver a Liquidaciones' }).click();

    // --- Historial: enviada al proveedor; la campaña está cerrada y el siguiente paso son las fotos ---
    const history = cosigner.page.getByTestId(`payout-history-${initiativeId}`);
    await server(history).toContainText('Enviada');
    await expect(history).toContainText('Toldos Mediterráneo, S.L. (IBAN con código de entidad 2100, acabado en 1332)');
    await expect(cosigner.page.getByTestId(`payout-photos-${initiativeId}`)).toBeVisible();
    await checkPage(cosigner.page, isMobile);
    const { rows } = await withE2eDb((db) => db.query(`SELECT i.status, p.status AS payout, p."destinationSplitId" FROM "Initiative" i JOIN "EscrowPayout" p ON p."initiativeId" = i.id WHERE i.id = $1`, [initiativeId]));
    expect(rows[0]).toMatchObject({ status: 'CLOSED', payout: 'EXECUTED' });
    expect(String(rows[0].destinationSplitId)).toMatch(/^MOCK-PRV-/);
    const executed = await emailTo(entity.director, cosignerSince, (text) => text.includes('¡Liquidación hecha!'));
    expect(executed).toContain('Subir las fotos del Después');

    // --- La misma página en catalán ---
    await page.goto(`/ca/panel/${entity.slug}/liquidaciones`);
    await server(page.getByRole('heading', { level: 1, name: 'Liquidacions de les campanyes aconseguides' })).toBeVisible();
    await expect(page.getByTestId(`payout-history-${initiativeId}`)).toContainText('Enviada');
    await checkPage(page, isMobile);

    expect(errors).toEqual([]);
    expect(cosignerErrors).toEqual([]);
    expect(familyErrors).toEqual([]);
    await cosigner.context.close();
    await familyContext.close();
  });
});
