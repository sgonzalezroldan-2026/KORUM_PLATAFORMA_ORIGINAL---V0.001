import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { codeTo, emailTo, uniqueEmail, withE2eDb } from './auth-support';
import { E2E_SCHEMA } from './e2e-database';
import { expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 4.4c · Soporte del centro e imagen de la campaña (QA-F09 y QA-S03), como personas reales con la compilación de producción:
 *  - una familia escribe una consulta al centro y quien dirige la ve en «Soporte» sin su email, la contesta una vez, la resuelve y la familia lo lee en
 *    su cuenta tras el aviso por email; el centro escribe a KORUM por su buzón y recibe el acuse;
 *  - quien dirige sube la imagen de una campaña (que se reduce a 1.600 px y sale sin metadatos), se ve en la ficha y en la tarjeta del portal y en la tarjeta
 *    de WhatsApp (menos de 300 KB), y se quita.
 * Catalán, axe, 430 px y sin errores de consola.
 */

const server = expect.configure({ timeout: 30_000 });
const NAVIGATION = { timeout: 45_000 };

test.describe.configure({ timeout: 420_000 });

/** Cada persona entra desde su propia red (cabecera del proxy): el acceso tiene un tope por red y todas las pruebas salen del mismo ordenador. */
async function signInFamily(page: Page, email: string, next: string) {
  const octet = () => 1 + Math.floor(Math.random() * 250);
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` });
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Tu email').fill(email);
  const since = Date.now();
  await page.getByRole('button', { name: 'Prefiero un código de 6 dígitos' }).click();
  await expect(page.getByRole('heading', { name: 'Escribe el código' })).toBeFocused({ timeout: 30_000 });
  await page.getByLabel('Código de 6 dígitos').fill(await codeTo(email, since));
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await server(page).toHaveURL(new RegExp(`${next.replace(/\//g, '\\/')}$`));
}

/** Una campaña abierta en la entidad de la prueba (copia de la semilla de Cervantes), con 10 € de meta. */
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
       FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = $4 AND i.format = 'BUDGET' ORDER BY i.id LIMIT 1 RETURNING id`,
      [walletId, slug, title, 'cervantes']
    );
    return Number(rows[0].id);
  });
}

async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
}

test.describe('Sprint 4.4c · soporte del centro', () => {
  test('una familia escribe al centro → «Soporte» sin su email → contestar una vez → resolver → aviso por email y respuesta en su cuenta; y el centro escribe a KORUM', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);

    // --- Sin consultas, «Soporte» lo explica ---
    await page.goto(`/panel/${entity.slug}/soporte`);
    await server(page.getByRole('heading', { level: 1, name: 'Soporte' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No hay consultas pendientes' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Secciones del panel' }).getByRole('link', { name: 'Soporte' })).toHaveAttribute('aria-current', 'page');

    // --- Una familia escribe una consulta al centro desde su portal ---
    const familyContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const family = await familyContext.newPage();
    const familyErrors = trackConsoleErrors(family);
    const familyEmail = uniqueEmail('familia-soporte');
    await signInFamily(family, familyEmail, `/${entity.slug}/ayuda`);
    const form = family.locator('form').filter({ has: family.getByLabel('Tu mensaje') });
    await expect(form.getByLabel('Sobre qué quieres preguntar')).toBeVisible({ timeout: 30_000 });
    await expect(form.getByTestId('support-routing')).toHaveText('Te contestará el centro.');
    await form.getByLabel('Asunto').fill('¿Cuándo se instalan los toldos?');
    await form.getByLabel('Tu mensaje').fill('Hemos aportado a la campaña de los toldos y querríamos saber en qué fecha se instalan en el patio.');
    await form.getByRole('button', { name: 'Enviar consulta' }).click();
    const sent = family.getByTestId('support-sent');
    await server(sent).toBeVisible({ timeout: 120_000 });
    const code = /TCK-[A-HJKMNP-Z2-9]{6}/.exec((await sent.textContent()) ?? '')?.[0];
    expect(code).toBeTruthy();

    // --- Quien dirige la ve, sin el email de la familia ---
    await page.reload();
    const card = page.locator(`[data-ticket-code="${code}"]`);
    await server(card).toBeVisible();
    await expect(page.getByTestId('support-waiting-title')).toHaveText('1 consulta espera respuesta');
    await expect(card).toContainText('¿Cuándo se instalan los toldos?');
    await expect(card.getByTestId('support-ticket-message')).toContainText('en qué fecha se instalan en el patio');
    await expect(page.locator('body')).not.toContainText(familyEmail);
    // El menú cuenta las consultas que esperan respuesta, con texto para el lector de pantalla.
    await expect(page.getByTestId('support-pending')).toContainText('1 consulta espera respuesta');
    await checkPage(page, isMobile);

    // --- Resolver sin responder pide confirmación (no se deshace): se puede cancelar y, confirmado, avisa de que no hay respuesta ---
    const quick = await withE2eDb(async (db) => {
      const code = `TCK-${randomUUID().replace(/[^a-hjkmnp-z2-9]/gi, '').toUpperCase().slice(0, 6).padEnd(6, 'K')}`;
      await db.query(`INSERT INTO "SupportTicket" ("ticketCode","organizationId","originLabel","target","topic","subject","message","updatedAt") SELECT $1, id, name, 'ORGANIZATION', 'INITIATIVE', 'Una duda rápida del patio', 'Quería saber si el patio estará abierto en las vacaciones de Navidad.', now() FROM "Organization" WHERE slug = $2`, [code, entity.slug]);
      return code;
    });
    await page.reload();
    const quickCard = page.locator(`[data-ticket-code="${quick}"]`);
    await server(quickCard).toBeVisible();
    await expect(page.getByTestId('support-pending')).toContainText('2 consultas esperan respuesta');
    await quickCard.getByRole('button', { name: 'Resolver sin responder' }).click();
    const confirm = quickCard.getByTestId('support-resolve-confirm');
    await expect(confirm).toBeFocused();
    await expect(confirm).toContainText('La familia no recibirá respuesta ni aviso');
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(confirm).toHaveCount(0);
    await quickCard.getByRole('button', { name: 'Resolver sin responder' }).click();
    await quickCard.getByRole('button', { name: 'Sí, resolver sin responder' }).click();
    await server(page.getByTestId('approvals-notice')).toContainText(`La consulta ${quick} está resuelta.`);
    await expect(page.getByTestId('support-pending')).toContainText('1 consulta espera respuesta');
    await expect(page.getByTestId('support-waiting').locator(`[data-ticket-code="${quick}"]`)).toHaveCount(0);

    // --- Contestar: una respuesta demasiado corta se avisa junto al campo; la buena pasa la consulta a «en curso» y anuncia el éxito ---
    await card.getByLabel('Vuestra respuesta').fill('Hola');
    await card.getByRole('button', { name: 'Enviar respuesta' }).click();
    await expect(card.getByRole('alert')).toContainText('La respuesta necesita al menos 5 caracteres.');
    await expect(card.getByLabel('Vuestra respuesta')).toBeFocused();
    await card.getByLabel('Vuestra respuesta').fill('Los toldos se instalan en las vacaciones de Navidad. ¡Gracias por vuestra aportación!');
    const since = Date.now();
    await card.getByRole('button', { name: 'Enviar respuesta' }).click();
    await server(page.getByTestId('approvals-notice')).toContainText(`Respuesta enviada a la consulta ${code}. La familia ha recibido un aviso.`);
    await expect(page.getByTestId('approvals-notice')).toBeFocused();
    await expect(card.getByTestId('support-ticket-reply')).toContainText('Los toldos se instalan en las vacaciones de Navidad.');
    await expect(card).toContainText('En curso');
    // Una consulta contestada ya no admite otra respuesta, solo resolverla.
    await expect(card.getByLabel('Vuestra respuesta')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(familyEmail);

    // --- La familia recibe el aviso (sin el texto) y lo lee en su cuenta ---
    const notice = await emailTo(familyEmail, since, (body) => body.includes(code!));
    expect(notice).toContain('ha contestado tu consulta');
    expect(notice).not.toContain('Los toldos se instalan');
    await family.goto('/mi-cuenta');
    await server(family.getByTestId('support-list')).toContainText('Los toldos se instalan en las vacaciones de Navidad.');

    // --- Resolver ---
    await card.getByRole('button', { name: 'Marcar como resuelta' }).click();
    await server(page.getByTestId('approvals-notice')).toContainText(`La consulta ${code} está resuelta.`);
    await expect(page.getByTestId('support-waiting')).toHaveCount(0);
    await page.getByTestId('support-resolved').locator('summary').click();
    const resolved = page.getByTestId('support-resolved').locator(`[data-ticket-code="${code}"]`);
    await expect(resolved).toContainText('Resuelta');
    await expect(resolved.getByRole('button')).toHaveCount(0);
    await withE2eDb(async (db) => {
      const row = (await db.query(`SELECT "status", "resolvedAt" IS NOT NULL AS closed, "repliedAt" IS NOT NULL AS replied FROM "SupportTicket" WHERE "ticketCode" = $1`, [code])).rows[0];
      expect(row).toMatchObject({ status: 'RESOLVED', closed: true, replied: true });
    });

    // --- El centro escribe a KORUM: se avisa del primer campo que falla y, enviado, sale el código y el acuse ---
    const korum = page.getByTestId('support-korum-form');
    await korum.getByRole('button', { name: 'Enviar mensaje a KORUM' }).click();
    await expect(korum.getByRole('alert')).toContainText('El asunto necesita al menos 5 caracteres.');
    await expect(korum.getByLabel('Asunto')).toHaveAttribute('aria-invalid', 'true');
    await expect(korum.getByLabel('Asunto')).toBeFocused();
    await korum.getByLabel('Sobre qué escribís').selectOption('PAYMENT');
    await korum.getByLabel('Asunto').fill('Cuándo llega la liquidación');
    await korum.getByLabel('Mensaje').fill('Firmaremos el lunes y querríamos saber cuándo se envía el dinero a la cuenta de la entidad.');
    const korumSince = Date.now();
    await korum.getByRole('button', { name: 'Enviar mensaje a KORUM' }).click();
    const korumNotice = page.getByTestId('approvals-notice');
    await server(korumNotice).toContainText('Mensaje enviado a KORUM con el código TCK-');
    const korumCode = /TCK-[A-HJKMNP-Z2-9]{6}/.exec((await korumNotice.textContent()) ?? '')?.[0];
    expect(korumCode).toBeTruthy();
    await expect(page.getByTestId('support-sent')).toContainText('Cuándo llega la liquidación');
    await expect(korum.getByLabel('Asunto')).toHaveValue('');
    await withE2eDb(async (db) => {
      const row = (await db.query(`SELECT "target", "topic", "fromOrganization", "status", "senderEmail" FROM "SupportTicket" WHERE "ticketCode" = $1`, [korumCode])).rows[0];
      expect(row).toMatchObject({ target: 'SUPERADMIN', topic: 'PAYMENT', fromOrganization: true, status: 'OPEN', senderEmail: entity.director });
    });
    expect(await emailTo(entity.director, korumSince, (body) => body.includes(korumCode!))).toContain('KORUM');

    // --- Catalán ---
    await page.goto(`/ca/panel/${entity.slug}/soporte`);
    await server(page.getByRole('heading', { level: 1, name: 'Suport' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Escriure a KORUM' })).toBeVisible();
    await checkPage(page, isMobile);

    expect(errors).toEqual([]);
    expect(familyErrors).toEqual([]);
    await familyContext.close();
  });

  test('«Soporte» solo es de las personas firmantes de esa entidad: una persona cualquiera recibe 403 y una consulta ajena no se contesta', async ({ page, browser, isMobile }) => {
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const outsider = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const stranger = await outsider.newPage();
    await signInFamily(stranger, uniqueEmail('curiosa'), '/mi-cuenta');
    const response = await stranger.goto(`/panel/${entity.slug}/soporte`);
    expect(response?.status()).toBe(403);
    await expect(stranger.locator('body')).not.toContainText('Consultas de las familias');
    await outsider.close();
  });
});

test.describe('Sprint 4.4c · imagen de la campaña', () => {
  test('subir (se reduce a 1.600 px y sin metadatos) → ficha, tarjeta del portal y tarjeta de WhatsApp → quitar', async ({ page, request, isMobile }, testInfo) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const title = `Toldos del patio ${testInfo.project.name} ${randomUUID().slice(0, 6)}`;
    const initiativeId = await openCampaign(entity.slug, title);

    // Una foto de 2.400×1.600 con ruido (pesa mucho) y datos del móvil que no deben salir.
    const photo = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
      .jpeg({ quality: 90 })
      .withMetadata({ exif: { IFD0: { Copyright: 'Maria Lopez', Make: 'Pixel 9' } } })
      .toBuffer();
    expect(photo.length).toBeGreaterThan(500_000);

    await page.goto(`/panel/${entity.slug}/estudio?iniciativa=${initiativeId}`);
    const cover = page.getByTestId('initiative-cover');
    await server(cover.getByRole('heading', { name: 'Imagen de la campaña' })).toBeVisible({ timeout: 60_000 });
    await expect(cover.getByTestId('initiative-cover-empty')).toBeVisible();
    const input = cover.locator('input[type=file]');

    // Sin elegir imagen y sin la casilla de menores, se avisa junto al formulario.
    await cover.getByRole('button', { name: 'Subir imagen' }).click();
    await expect(cover.getByRole('alert')).toContainText('Elegid primero una imagen.');
    await input.setInputFiles({ name: 'toldos.jpg', mimeType: 'image/jpeg', buffer: photo });
    await cover.getByRole('button', { name: 'Subir imagen' }).click();
    await expect(cover.getByRole('alert')).toContainText('Confirma que en la imagen no aparece ningún menor reconocible.');
    await expect(cover.getByTestId('initiative-cover-preview')).toHaveCount(0);

    await cover.getByLabel(/Confirmo que en la imagen no aparece/).check();
    await cover.getByRole('button', { name: 'Subir imagen' }).click();
    await server(cover.getByTestId('initiative-cover-done')).toContainText('Imagen de la campaña publicada: ya se ve en el portal.', { timeout: 60_000 });
    await expect(cover.getByTestId('initiative-cover-done')).toBeFocused();
    const preview = cover.getByTestId('initiative-cover-preview');
    await server(preview).toBeVisible();
    await checkPage(page, isMobile);

    // --- Lo publicado: 1.600 px de ancho, sin metadatos y mucho más ligero ---
    const src = (await preview.getAttribute('src'))!;
    const published = await request.get(src);
    expect(published.status()).toBe(200);
    expect(published.headers()['content-type']).toBe('image/jpeg');
    const body = await published.body();
    const meta = await sharp(body).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 1067]);
    expect(meta.exif).toBeUndefined();
    expect(body.includes(Buffer.from('Maria Lopez'))).toBe(false);
    expect(body.length).toBeLessThan(photo.length);
    await withE2eDb(async (db) => {
      const row = (await db.query(`SELECT a."purpose", a."visibility" FROM "Initiative" i JOIN "FileAsset" a ON a.id = i."coverFileId" WHERE i.id = $1`, [initiativeId])).rows[0];
      expect(row).toMatchObject({ purpose: 'INITIATIVE_COVER', visibility: 'PUBLIC' });
      const audit = (await db.query(`SELECT "metadataJson" FROM "AuditLog" WHERE "action" = 'initiative.cover_published' AND "targetId" = $1`, [String(initiativeId)])).rows[0];
      expect(audit.metadataJson).toMatchObject({ noMinorsConfirmed: true, width: 1600, height: 1067 });
      expect(JSON.stringify(audit.metadataJson)).not.toMatch(/Maria|Pixel/);
    });

    // --- El portal: la ficha y la tarjeta del listado ---
    await page.goto(`/${entity.slug}/iniciativas/${initiativeId}`);
    const detailCover = page.getByTestId('initiative-detail-cover');
    await server(detailCover).toBeVisible(NAVIGATION);
    await expect.poll(() => detailCover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(detailCover).toHaveAttribute('alt', '');
    await checkPage(page, isMobile);
    await page.goto(`/${entity.slug}`);
    const listed = page.locator(`[data-testid="initiative-card"][data-initiative-id="${initiativeId}"]`);
    await server(listed.getByTestId('initiative-card-cover')).toBeVisible(NAVIGATION);
    await checkPage(page, isMobile);

    // --- La tarjeta de WhatsApp lleva la miniatura y sigue por debajo de los 300 KB ---
    const card = await request.get(`/api/og/initiative/${initiativeId}?locale=es`);
    expect(card.status()).toBe(200);
    expect(card.headers()['content-type']).toContain('image/png');
    const cardBytes = await card.body();
    expect(cardBytes.length).toBeLessThan(300 * 1024);
    const cardMeta = await sharp(cardBytes).metadata();
    expect([cardMeta.width, cardMeta.height]).toEqual([1200, 630]);

    // --- Catalán: el formulario y la ficha ---
    await page.goto(`/ca/panel/${entity.slug}/estudio?iniciativa=${initiativeId}`);
    await server(page.getByTestId('initiative-cover').getByRole('heading', { name: 'Imatge de la campanya' })).toBeVisible({ timeout: 60_000 });
    await expectNoMissingTranslations(page);

    // --- Quitar: vuelve el degradado de siempre ---
    await page.goto(`/panel/${entity.slug}/estudio?iniciativa=${initiativeId}`);
    await server(cover.getByTestId('initiative-cover-preview')).toBeVisible({ timeout: 60_000 });
    await cover.getByRole('button', { name: 'Quitar la imagen' }).click();
    await server(cover.getByTestId('initiative-cover-done')).toContainText('Imagen retirada.');
    await expect(cover.getByTestId('initiative-cover-done')).toBeFocused();
    await expect(cover.getByTestId('initiative-cover-empty')).toBeVisible();
    await expect.poll(async () => (await request.get(src)).status()).toBe(404);
    await page.goto(`/${entity.slug}/iniciativas/${initiativeId}`);
    await server(page.getByRole('heading', { level: 1, name: title })).toBeVisible(NAVIGATION);
    await expect(page.getByTestId('initiative-detail-cover')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
