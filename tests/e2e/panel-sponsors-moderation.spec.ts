import { expect, test, type Page } from '@playwright/test';
import { emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_SCHEMA } from './e2e-database';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 4.2b · Moderación de comercios amigos (QA-S02), como personas reales con cobros simulados: una entidad nueva con una campaña abierta recibe
 * dos patrocinios por su página pública; la dirección aprueba uno (sale en el directorio, recibe su bienvenida con el cartel del escaparate y sus
 * documentos) y no admite el otro con un motivo (se le devuelve el 100 % y recibe la factura rectificativa). Contador de «Aprobaciones», catalán y axe.
 */

const NAVIGATION = { timeout: 45_000 };
const server = expect.configure({ timeout: 30_000 });

test.describe.configure({ timeout: 360_000 });

/** Copia una campaña de presupuesto de la semilla (Cervantes) a la entidad de la prueba, abierta y sin nada recaudado. */
async function openCampaign(slug: string, title: string) {
  await withE2eDb(async (db) => {
    const { rows: columns } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Initiative' ORDER BY ordinal_position`, [E2E_SCHEMA]);
    const skip = new Set(['id', 'walletEscrowId', 'organizationId', 'sourceIdeaId', 'gatePinHash', 'gatePinExpiresAt', 'title', 'status', 'stepIndex', 'raisedCents', 'goalCents', 'closesAt', 'totalContributions', 'matchingPoolTotalCents', 'matchingPoolRemainingCents', 'matchingSponsorName', 'firstPayinAt']);
    const copy = columns.map((row) => row.column_name as string).filter((name) => !skip.has(name));
    const quoted = copy.map((name) => `"${name}"`).join(', ');
    const fromSource = copy.map((name) => `i."${name}"`).join(', ');
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await db.query(
      `INSERT INTO "Initiative" (${quoted}, "walletEscrowId", "organizationId", "title", "status", "stepIndex", "raisedCents", "goalCents", "closesAt")
       SELECT ${fromSource}, $1, (SELECT id FROM "Organization" WHERE slug = $2), $3, 'FUNDRAISING'::"InitiativeStatus", 4, 0, 400000, now() + interval '30 days'
       FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = 'cervantes' AND i.format = 'BUDGET' ORDER BY i.id LIMIT 1`,
      [walletId, slug, title]
    );
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
  await modal.getByLabel('Persona de contacto').fill('Marta López');
  await modal.getByLabel('Teléfono').fill('600 11 22 33');
  await modal.getByLabel('Email para la factura y para pedirte el logotipo').fill(email);
  await modal.locator('label').filter({ hasText: 'Bronce' }).click();
  await modal.getByLabel('Descuento o ventaja para las familias (opcional)').fill('5 % para las familias');
  await expect(modal.getByTestId('sponsor-summary')).toContainText('Total: 118,15 €');
  await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
  await expect(page).toHaveURL(/\/aportar\/simulador\?pedido=KS[0-9A-F]{16}&sig=/, NAVIGATION);
  await page.getByRole('button', { name: 'Confirmar el pago' }).click();
  await expect(page).toHaveURL(/\/aportar\/resultado\?pedido=KS/, NAVIGATION);
  await expect(page.getByTestId('sponsorship-celebration')).toContainText('El centro revisará tu comercio');
}

/** Ruta (sin dominio) del enlace a un documento del comercio que trae su email. */
function documentLink(text: string, kind: string): string {
  const match = new RegExp(`https?://[^\\s]+(/(?:[a-z]{2}/)?[^\\s/]+/comercios/documentos/${kind}\\?pedido=KS[0-9A-F]{16}&sig=[0-9a-f]{64})`).exec(text);
  expect(match, `enlace a ${kind}`).not.toBeNull();
  return match![1]!;
}

test.describe('Sprint 4.2b · comercios amigos en Aprobaciones', () => {
  test('la dirección aprueba un comercio (directorio, bienvenida y cartel) y no admite otro (devolución y rectificativa)', async ({ page, browser, isMobile }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    await openCampaign(entity.slug, 'Toldos para el patio');

    // --- Dos comercios pagan desde la página pública (otro navegador, sin sesión) ---
    const shopContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const shop = await shopContext.newPage();
    const shopErrors = trackConsoleErrors(shop);
    const tag = `${testInfo.project.name} ${Date.now().toString(36)}`;
    const approvedName = `Panadería Aprobada ${tag}`;
    const rejectedName = `Librería Rechazada ${tag}`;
    const approvedEmail = uniqueEmail('panaderia');
    const rejectedEmail = uniqueEmail('libreria');
    await sponsor(shop, entity.slug, approvedName, approvedEmail);
    await sponsor(shop, entity.slug, rejectedName, rejectedEmail);

    // --- Bandeja: contador en la pestaña, tarjetas con importe íntegro y gestión aparte ---
    await page.goto(`/panel/${entity.slug}/aprobaciones`);
    await expect(page).toHaveTitle(/Aprobaciones/);
    await server(page.getByRole('link', { name: /Aprobaciones.*2 decisiones pendientes/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Comercios amigos · 2 por revisar' })).toBeVisible();
    const approvedCard = page.getByTestId('moderation-sponsor').filter({ hasText: approvedName });
    const rejectedCard = page.getByTestId('moderation-sponsor').filter({ hasText: rejectedName });
    await expect(approvedCard).toContainText('Por revisar');
    await expect(approvedCard).toContainText('100,00 €');
    await expect(approvedCard).toContainText('15,00 € + IVA 3,15 €');
    await expect(approvedCard).toContainText('Toldos para el patio');
    await expect(approvedCard.getByRole('link', { name: approvedEmail })).toHaveAttribute('href', `mailto:${approvedEmail}`);
    if (isMobile) await expectMobileStackIsOneColumn(page);
    await expectNoHorizontalOverflow(page);
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);

    // --- Aprobar: aviso con el foco y el comercio queda «Aprobado · visible» ---
    const since = Date.now();
    await approvedCard.getByRole('button', { name: /Aprobar comercio/ }).click();
    // El aviso de los comercios va encima de su sección (el de las ideas, arriba): el foco no salta al principio de la página.
    const notice = page.locator('#comercios').getByTestId('approvals-notice');
    await server(notice).toContainText(`${approvedName} ya es comercio amigo`);
    await expect(notice).toBeFocused();
    await server(approvedCard).toContainText('Aprobado · visible');
    await expect(page.getByRole('link', { name: /Aprobaciones.*1 decisión pendiente/ })).toBeVisible();

    // --- No admitir: el motivo es obligatorio y se dice cuánto se devuelve ---
    await rejectedCard.getByRole('button', { name: 'No admitir' }).click();
    const reason = rejectedCard.getByLabel('Motivo (lo leerá el comercio en su email)');
    await expect(reason).toBeFocused();
    await rejectedCard.getByRole('button', { name: /No admitir y devolver 118,15/ }).click();
    await expect(rejectedCard.getByRole('alert')).toContainText('al menos 10 caracteres');
    await reason.fill('Este curso ya tenemos una librería patrocinando la campaña.');
    await rejectedCard.getByRole('button', { name: /No admitir y devolver 118,15/ }).click();
    await server(notice).toContainText(`${rejectedName} no ha sido admitido. Le devolvemos 118,15 €`);
    await expect(page.getByRole('link', { name: /Aprobaciones.*pendiente/ })).toHaveCount(0);
    await page.getByText(/1 comercio no admitido o devuelto/).click();
    await expect(page.getByTestId('moderation-sponsor').filter({ hasText: rejectedName })).toContainText('No admitido · devuelto');
    await expectNoSeriousA11yViolations(page);

    // --- Directorio público: el aprobado sale al momento; el otro, no ---
    await shop.goto(`/${entity.slug}/comercios`);
    const directory = shop.getByRole('list', { name: 'Comercios amigos' });
    await server(directory).toContainText(approvedName);
    await expect(directory).not.toContainText(rejectedName);
    await expect(directory).not.toContainText(/\d[\d.]*,\d{2}\s?€/);

    // --- Bienvenida: un solo botón a sus documentos; desde el justificante, la factura y el cartel (este, con su propia firma) ---
    const welcome = await emailTo(approvedEmail, since, (text) => text.includes('Comercio amigo'));
    await shop.goto(documentLink(welcome, 'justificante'));
    await expect(shop.getByTestId('sponsor-justificante')).toContainText(approvedName, NAVIGATION);
    const documentsNav = shop.getByRole('navigation', { name: 'Tus otros documentos' });
    await expect(documentsNav.getByRole('link', { name: 'Factura rectificativa' })).toHaveCount(0);
    await documentsNav.getByRole('link', { name: 'Factura', exact: true }).click();
    await expect(shop.getByTestId('sponsor-factura').getByTestId('invoice-number')).toHaveText(/^FAC-\d{4}-\d{4,}$/, NAVIGATION);
    const fiscalSig = new URL(shop.url()).searchParams.get('sig');
    await shop.getByRole('navigation', { name: 'Tus otros documentos' }).getByRole('link', { name: 'Cartel para tu escaparate' }).click();
    const poster = shop.getByTestId('sponsor-poster');
    await expect(poster).toBeVisible(NAVIGATION);
    await expect(poster).toContainText(approvedName);
    await expect(poster).toContainText(`Comercio amigo de ${entity.name}`);
    await expect(poster.getByTestId('poster-url')).toContainText(`/${entity.slug}/comercios`);
    await expect(poster).not.toContainText(/\d[\d.]*,\d{2}\s?€/);
    await expectNoSeriousA11yViolations(shop);
    // El enlace del cartel (el que se comparte) lleva otra firma y no abre los documentos fiscales.
    const posterUrl = new URL(shop.url());
    expect(posterUrl.searchParams.get('sig')).not.toBe(fiscalSig);
    await expect(shop.getByRole('navigation', { name: 'Tus otros documentos' })).toHaveCount(0);
    await shop.goto(`${posterUrl.pathname.replace('/cartel', '/factura')}${posterUrl.search}`);
    await expect(shop.getByRole('heading', { level: 1, name: 'No encontramos este documento' })).toBeVisible(NAVIGATION);

    // --- No admitido: motivo, devolución y factura rectificativa con importes en negativo ---
    const rejection = await emailTo(rejectedEmail, since, (text) => text.includes('no ha admitido'));
    expect(rejection).toContain('«Este curso ya tenemos una librería patrocinando la campaña.»');
    expect(rejection).toContain('118,15');
    await shop.goto(documentLink(rejection, 'rectificativa'));
    const rectifying = shop.getByTestId('sponsor-rectificativa');
    await expect(rectifying.getByTestId('invoice-number')).toHaveText(/^REC-\d{4}-\d{4,}$/, NAVIGATION);
    await expect(rectifying).toContainText(/Rectifica la factura\s*FAC-\d{4}-\d{4,}/);
    await expect(rectifying).toContainText(/[-−]15,00\s€/);
    await expect(rectifying).toContainText(/[-−]18,15\s€/);
    await expect(shop.getByRole('navigation', { name: 'Tus otros documentos' }).getByRole('link', { name: 'Cartel para tu escaparate' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(shop);
    if (isMobile) await expectNoHorizontalOverflow(shop);

    // --- En catalán ---
    await page.goto(`/ca/panel/${entity.slug}/aprobaciones`);
    await expect(page.getByRole('heading', { level: 2, name: 'Comerços amics' })).toBeVisible();
    await expect(page.getByTestId('moderation-sponsor').filter({ hasText: approvedName })).toContainText('Aprovat · visible');
    await expectNoMissingTranslations(page);
    await expectNoSeriousA11yViolations(page);

    await shopContext.close();
    expect(errors).toEqual([]);
    expect(shopErrors).toEqual([]);
  });
});
