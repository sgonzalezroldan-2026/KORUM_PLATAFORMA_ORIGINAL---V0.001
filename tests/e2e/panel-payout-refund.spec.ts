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
 * Sprint 4.4b · Campañas vencidas: la entidad lanza la votación o devuelve el 100 %; las familias votan desde su enlace (una pide su devolución) y gana
 * el proyecto con la meta nueva y la comisión proporcional; la otra campaña se devuelve y el panel enseña el progreso.
 */

const NAVIGATION = { timeout: 45_000 };
const server = expect.configure({ timeout: 30_000 });
const EMAIL_LABEL = '📧 Tu email para enviarte al instante tu recibo o tus entradas QR';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

test.describe.configure({ timeout: 420_000 });

/**
 * Una campaña de presupuesto abierta en la entidad de la prueba (copia de la semilla). Por defecto, de 10 €: comisión 0,50 € y pasarela 0,50 €. Con `budget`,
 * la meta, el presupuesto y la instalación (reserva del 0 %) y las comisiones que se le indiquen, para que su desglose público cuadre.
 */
async function openCampaign(slug: string, title: string, budget: { goalCents: number; costMatCents: number; costInstCents: number; bracketFeeCents: number; gatewayFeeCents: number } | null = null): Promise<number> {
  return withE2eDb(async (db) => {
    const { rows: columns } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Initiative' ORDER BY ordinal_position`, [E2E_SCHEMA]);
    const skip = new Set(['id', 'walletEscrowId', 'organizationId', 'sourceIdeaId', 'gatePinHash', 'gatePinExpiresAt', 'title', 'status', 'stepIndex', 'raisedCents', 'goalCents', 'closesAt', 'totalContributions', 'matchingPoolTotalCents', 'matchingPoolRemainingCents', 'matchingSponsorName', 'firstPayinAt', 'bracketFeeCents', 'maintFeeCents', 'gatewayFeeCents', 'beforeFileId', 'afterFileId', 'coverFileId', 'closedAt', ...(budget ? ['costMatCents', 'costInstCents', 'contingencyBps'] : [])]);
    const copy = columns.map((row) => row.column_name as string).filter((name) => !skip.has(name));
    const quoted = copy.map((name) => `"${name}"`).join(', ');
    const fromSource = copy.map((name) => `i."${name}"`).join(', ');
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const extra = budget ? ', "costMatCents", "costInstCents", "contingencyBps"' : '';
    const extraValues = budget ? ', $8, $9, 0' : '';
    const { rows } = await db.query(
      `INSERT INTO "Initiative" (${quoted}, "walletEscrowId", "organizationId", "title", "status", "stepIndex", "raisedCents", "goalCents", "closesAt", "bracketFeeCents", "maintFeeCents", "gatewayFeeCents"${extra})
       SELECT ${fromSource}, $1, (SELECT id FROM "Organization" WHERE slug = $2), $3, 'FUNDRAISING'::"InitiativeStatus", 4, 0, $4, now() + interval '30 days', $5, 0, $6${extraValues}
       FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = $7 AND i.format = 'BUDGET' ORDER BY i.id LIMIT 1 RETURNING id`,
      [walletId, slug, title, budget?.goalCents ?? 1000, budget?.bracketFeeCents ?? 50, budget?.gatewayFeeCents ?? 50, 'cervantes', ...(budget ? [budget.costMatCents, budget.costInstCents] : [])]
    );
    return Number(rows[0].id);
  });
}

async function runCron(request: APIRequestContext, type: 'SUPPORTER_BROADCAST' | 'OUTBOX_DISPATCH' | 'CAMPAIGN_EXPIRY' | 'MASS_REFUND', slug: string) {
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
    await server(cosigner.page.getByRole('heading', { name: '¡Firma completa!' })).toBeVisible();
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

type Cron = ['SUPPORTER_BROADCAST', 'supporter-broadcast'] | ['OUTBOX_DISPATCH', 'outbox-dispatch'] | ['CAMPAIGN_EXPIRY', 'campaign-expiry'] | ['MASS_REFUND', 'mass-refund'];
const BROADCAST: Cron[] = [['SUPPORTER_BROADCAST', 'supporter-broadcast'], ['OUTBOX_DISPATCH', 'outbox-dispatch']];

/**
 * Pasa las tareas hasta ver el estado esperado en la base: escritorio y móvil comparten el servidor, y una llamada a la tarea puede volver mientras la del
 * otro proyecto aún está haciendo el trabajo.
 */
async function cronUntil(request: APIRequestContext, crons: Cron[], done: () => Promise<boolean>) {
  await expect
    .poll(
      async () => {
        for (const [type, slug] of crons) await runCron(request, type, slug);
        return done();
      },
      { timeout: 120_000, intervals: [500, 2_000, 5_000] }
    )
    .toBe(true);
}

const sentTo = (templateKey: string, address: string) =>
  withE2eDb((db) => db.query(`SELECT 1 FROM "OutboxMessage" WHERE "templateKey" = $1 AND "toAddress" = $2 AND status = 'SENT'`, [templateKey, address])).then((result) => (result.rowCount ?? 0) > 0);
const statusOf = (initiativeId: number) => withE2eDb((db) => db.query(`SELECT status FROM "Initiative" WHERE id = $1`, [initiativeId])).then((result) => String(result.rows[0]?.status));

/** Una familia aporta 10 € desde la ficha pública con el checkout de invitado y el pago simulado. */
async function donateTen(family: Page, slug: string, initiativeId: number, email: string) {
  await family.goto(`/${slug}/iniciativas/${initiativeId}`);
  await family.locator('#fview-detail a[href$="/aportar"]').click();
  const modal = family.locator('#checkout-modal');
  await expect(modal).toBeVisible(NAVIGATION);
  await modal.getByText('10,00 €', { exact: true }).click();
  await modal.getByLabel(EMAIL_LABEL).fill(email);
  await modal.getByRole('button', { name: /^Pagar .+ con Bizum$/ }).click();
  await expect(family).toHaveURL(/\/aportar\/simulador\?pedido=KD/, NAVIGATION);
  await family.getByRole('button', { name: 'Confirmar el pago' }).click();
  await expect(family).toHaveURL(/\/aportar\/resultado\?pedido=/, NAVIGATION);
}

/** Enlace personal de voto del email «Tú decides» (ruta y consulta, para abrirlo en el servidor de la prueba). */
async function voteLink(address: string, since: number, title: string): Promise<string> {
  const text = await emailTo(address, since, (body) => body.includes('Tú decides') && body.includes(title));
  const link = /https?:\/\/\S+\/votacion\?v=[0-9a-f.]+/.exec(text)?.[0];
  expect(link, 'enlace de voto').toBeTruthy();
  const url = new URL(link!);
  return url.pathname + url.search;
}

test.describe('Sprint 4.4b · campañas vencidas sin llegar a la meta', () => {
  test('vence → la entidad lanza la votación → una familia pide su devolución y otra vota → gana el proyecto con la meta nueva; otra campaña se devuelve al 100 %', async ({ page, browser, request, isMobile }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    await withE2eDb((db) => db.query(`UPDATE "Organization" SET "kybStatus" = 'VERIFIED', "paycometSplitId" = $2 WHERE slug = $1`, [entity.slug, `split-e2e-${randomUUID().slice(0, 8)}`]));
    const suffix = `${testInfo.project.name} ${Date.now().toString(36)}`;
    const voteTitle = `Tablets para la biblioteca ${suffix}`;
    const refundTitle = `Pizarras digitales ${suffix}`;
    // 50 € de meta: 45 € de proyecto, 2,50 € de comisión de tramo y 2,50 € de pasarela.
    const budget = { goalCents: 5_000, costMatCents: 4_000, costInstCents: 500, bracketFeeCents: 250, gatewayFeeCents: 250 };
    const voteId = await openCampaign(entity.slug, voteTitle, budget);
    const refundId = await openCampaign(entity.slug, refundTitle, budget);

    // --- Dos familias aportan 10 € cada una a la primera y una de ellas, 10 € a la segunda; las dos vencen sin llegar ---
    const familyContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const family = await familyContext.newPage();
    const familyErrors = trackConsoleErrors(family);
    const keeps = uniqueEmail('familia-vota');
    const asksBack = uniqueEmail('familia-devolucion');
    await donateTen(family, entity.slug, voteId, keeps);
    await donateTen(family, entity.slug, voteId, asksBack);
    await donateTen(family, entity.slug, refundId, keeps);
    await withE2eDb((db) => db.query(`UPDATE "Initiative" SET "closesAt" = now() - interval '1 minute' WHERE id = ANY($1::int[])`, [[voteId, refundId]]));
    await cronUntil(request, [['CAMPAIGN_EXPIRY', 'campaign-expiry']], async () => (await statusOf(voteId)) === 'EXPIRED' && (await statusOf(refundId)) === 'EXPIRED');

    // --- El cuadro de mandos lleva a Campañas vencidas ---
    await page.goto(`/panel/${entity.slug}`);
    await page.getByTestId(`expired-${voteId}`).click();
    await expect(page).toHaveURL(new RegExp(`/panel/${entity.slug}/vencidas$`), NAVIGATION);
    await server(page.getByRole('heading', { level: 1, name: 'Campañas que vencieron sin llegar a la meta' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Campañas vencidas' })).toHaveAttribute('aria-current', 'page');
    const voteCard = page.getByTestId(`expired-card-${voteId}`);
    await expect(voteCard).toContainText('Vencida · falta vuestra decisión');
    await expect(voteCard).toContainText(/Recaudado 20,00\s€ de 50,00\s€ \(40 %\)/);
    await checkPage(page, isMobile);

    // --- Lanzar la votación: sin opciones se dice junto al campo; con ellas, se confirma ---
    const decision = page.getByTestId(`expired-decision-${voteId}`);
    await decision.getByRole('button', { name: /Lanzar la votación/ }).click();
    await expect(decision.getByLabel('Opción A')).toBeFocused();
    await expect(decision.getByRole('alert').first()).toContainText('Escribid entre 10 y 160 caracteres');
    await decision.getByLabel('Opción A').fill('Comprar 4 tablets con lo recaudado');
    await decision.getByLabel('Opción B').fill('Comprar 3 tablets y una funda de carga');
    await decision.getByRole('button', { name: /Lanzar la votación/ }).click();
    const confirm = page.getByTestId(`expired-confirm-${voteId}`);
    await expect(confirm).toBeFocused();
    await expect(confirm).toContainText('Durará 7 días');
    const familySince = Date.now();
    await confirm.getByRole('button', { name: 'Sí, lanzar la votación' }).click();
    const notice = page.getByTestId('approvals-notice');
    await server(notice).toContainText('Votación lanzada');
    await expect(notice).toBeFocused();
    await server(page.getByTestId(`expired-poll-${voteId}`)).toContainText('Votación abierta hasta el');
    await checkPage(page, isMobile);

    // --- La segunda campaña se devuelve al 100 % ---
    const refundDecision = page.getByTestId(`expired-decision-${refundId}`);
    await refundDecision.getByRole('button', { name: 'Devolver el 100 %' }).click();
    await page.getByTestId(`expired-confirm-${refundId}`).getByRole('button', { name: 'Sí, devolver el 100 %' }).click();
    await server(notice).toContainText('Devolución en marcha');
    await server(page.getByTestId(`expired-refund-${refundId}`)).toContainText('Devueltas 0 de 1 aportaciones');

    // --- Cada familia recibe su papeleta (una por persona) y vota desde su enlace ---
    await cronUntil(request, BROADCAST, async () => (await sentTo('initiative.resizePoll', asksBack)) && (await sentTo('initiative.resizePoll', keeps)));
    await family.goto(await voteLink(asksBack, familySince, voteTitle));
    await server(family.getByRole('heading', { level: 1, name: `¿Qué hacemos con «${voteTitle}»?` })).toBeVisible();
    await checkPage(family, isMobile);
    await family.getByRole('button', { name: /Votar/ }).click();
    await expect(family.getByTestId('resize-ballot').getByRole('alert')).toContainText('Elige una opción antes de votar');
    await family.getByLabel(/Prefiero que me devolváis mi aportación/).check();
    await family.getByRole('button', { name: /Votar/ }).click();
    const ballotConfirm = family.getByTestId('resize-ballot-confirm');
    await expect(ballotConfirm).toBeFocused();
    await expect(ballotConfirm).toContainText('Te devolvemos el 100 % de lo que aportaste a tu medio de pago original');
    await ballotConfirm.getByRole('button', { name: 'Confirmar mi voto' }).click();
    const done = family.getByTestId('resize-ballot-done');
    await server(done).toContainText('Tu voto está registrado');
    await expect(done).toBeFocused();
    await expect(done).toContainText('te la devolvemos entera');
    await family.reload();
    await server(family.getByRole('heading', { level: 1, name: 'Tu voto está registrado' })).toBeVisible();

    await family.goto(await voteLink(keeps, familySince, voteTitle));
    await family.getByLabel(/A\. Comprar 4 tablets/).check();
    await family.getByRole('button', { name: /Votar/ }).click();
    await family.getByTestId('resize-ballot-confirm').getByRole('button', { name: 'Confirmar mi voto' }).click();
    await server(family.getByTestId('resize-ballot-done')).toContainText('Votaste «Comprar 4 tablets con lo recaudado».');
    await checkPage(family, isMobile);

    await page.reload();
    await server(page.getByTestId(`expired-poll-${voteId}`)).toContainText('Han votado 2 personas · 1 ha pedido su devolución');

    // --- Pasan los 7 días (se simula en la base: la votación no deja cambiar su plazo) y se cierra; las devoluciones salen ---
    await withE2eDb(async (db) => {
      await db.query('BEGIN');
      await db.query('SET LOCAL session_replication_role = replica');
      await db.query(`UPDATE "ResizePoll" SET "createdAt" = now() - interval '8 days', "closesAt" = now() - interval '1 minute' WHERE "initiativeId" = $1`, [voteId]);
      await db.query('COMMIT');
    });
    const refundedTo = (address: string) => withE2eDb((db) => db.query(`SELECT 1 FROM "Contribution" WHERE "initiativeId" = $1 AND "guestEmail" = $2 AND status = 'REFUNDED'`, [voteId, address])).then((result) => (result.rowCount ?? 0) > 0);
    await cronUntil(request, [['CAMPAIGN_EXPIRY', 'campaign-expiry'], ['MASS_REFUND', 'mass-refund']], async () => (await statusOf(voteId)) === 'GOAL_REACHED' && (await statusOf(refundId)) === 'REFUNDED' && (await refundedTo(asksBack)));
    await page.reload();
    const result = page.getByTestId(`expired-result-${voteId}`);
    await server(result).toContainText('La votación eligió: «Comprar 4 tablets con lo recaudado»');
    await expect(result).toContainText(/Meta nueva \(lo que aportaron quienes votaron un proyecto\): 10,00\s€/);
    await expect(page.getByTestId(`expired-refund-${refundId}`)).toContainText(/Devuelto el 100 %: 1 aportación \(10,00\s€\)/);
    await checkPage(page, isMobile);

    // --- A liquidar con la comisión proporcional: 10 € − 0,50 € de tramo − 0,50 € de pasarela ---
    await page.getByTestId(`expired-settle-${voteId}`).click();
    await expect(page).toHaveURL(new RegExp(`/panel/${entity.slug}/liquidaciones$`), NAVIGATION);
    await server(page.getByTestId(`payout-ready-${voteId}`)).toContainText(/Para el proyecto\s*9,00\s€/);

    // --- Los avisos a las familias: el resultado a quien siguió en la campaña y la devolución hecha a quien la pidió ---
    await cronUntil(request, BROADCAST, async () => (await sentTo('initiative.resizeResult', keeps)) && (await sentTo('initiative.refundingSupporter', keeps)));
    expect(await emailTo(keeps, familySince, (text) => text.includes('sale adelante'))).toContain('Comprar 4 tablets con lo recaudado');
    expect(await emailTo(keeps, familySince, (text) => text.includes(refundTitle) && text.includes('Te devolvemos'))).toBeTruthy();

    // --- La misma página en catalán ---
    await page.goto(`/ca/panel/${entity.slug}/vencidas`);
    await server(page.getByRole('heading', { level: 1, name: 'Campanyes que van vèncer sense arribar a la meta' })).toBeVisible();
    await checkPage(page, isMobile);

    expect(errors).toEqual([]);
    expect(familyErrors).toEqual([]);
    await familyContext.close();
  });
});
