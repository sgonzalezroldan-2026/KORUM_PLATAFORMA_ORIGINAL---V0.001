import { expect, test, type Page } from '@playwright/test';
import QRCode from 'qrcode';
import { withE2eDb } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 4.3 · Estudio dual, pizarra TCO y cartel A4 con QR (QA-S01), como una persona real: desde el estado vacío del cuadro de mandos abre el Estudio, empieza
 * con una plantilla, ve la pizarra cuadrada al céntimo (mantenimiento a «0,00 €»), recibe el aviso del candado semántico al escribir «ventiladores» en una
 * categoría al 0 %, guarda el borrador, ve que no puede publicar sin los documentos del titular y, verificados, publica con confirmación; la campaña recaudando
 * solo admite cambiar lo que no mueve dinero; el cartel A4 lleva un QR real a la ficha pública. Una rifa exige premios y la confirmación de normativa. Catalán,
 * axe, 430 px y sin errores de consola.
 */

const server = expect.configure({ timeout: 30_000 });
const NAVIGATION = { timeout: 45_000 };

test.describe.configure({ timeout: 300_000 });

async function checkPage(page: Page, isMobile: boolean) {
  if (isMobile) await expectMobileStackIsOneColumn(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  await expectNoSeriousA11yViolations(page);
}

test.describe('Sprint 4.3 · Estudio dual y cartel A4 con QR', () => {
  test('plantilla → pizarra cuadrada → candado → borrador → publicar con confirmación → cartel con QR real; rifa con aviso de normativa', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const studio = `/panel/${entity.slug}/estudio`;

    // --- Estado vacío del cuadro de mandos: el paso «Crear la campaña» lleva al Estudio ---
    await server(page.getByTestId('empty-studio-cta')).toBeVisible();
    await page.getByTestId('empty-studio-cta').click();
    await expect(page).toHaveURL(new RegExp(`${studio}$`), NAVIGATION);
    await server(page.getByRole('heading', { level: 1, name: 'Estudio de edición' })).toBeVisible();
    await expect(page.getByTestId('studio-template-climate')).toBeVisible();
    await expect(page.getByTestId('studio-template-raffle')).toBeVisible();
    await expect(page.getByTestId('studio-existing')).toHaveCount(0);
    await checkPage(page, isMobile);

    // --- Plantilla de mejora: el título y la descripción vienen rellenos, el presupuesto no ---
    await page.getByTestId('studio-template-climate').getByRole('link', { name: /Usar plantilla/ }).click();
    await server(page.getByRole('heading', { level: 1, name: 'Confort en las aulas' })).toBeVisible();
    await expect(page.getByLabel('Título de la iniciativa, evento o rifa')).toHaveValue('Aulas más frescas y confortables');
    await expect(page.getByLabel('Presupuesto del proveedor (€)')).toHaveValue('0');
    await expect(page.getByTestId('studio-publish')).toBeDisabled();
    await expect(page.getByTestId('studio-blockers')).toContainText('Falta el presupuesto');
    await expect(page.getByTestId('studio-blockers')).toContainText('Los documentos del titular aún no están verificados');

    // --- Pizarra en vivo: 3.800 € + 1.300 € + 10 % = 5.610 €; mantenimiento a 0,00 €; meta 5.874,00 € ---
    await page.getByLabel('Presupuesto del proveedor (€)').fill('3800');
    await page.getByLabel('Instalación u obra (€)').fill('1300');
    await expect(page.getByTestId('studio-goal')).toHaveText(/^5\.874,00\s€$/);
    const lines = page.getByTestId('studio-tco-lines');
    await expect(lines).toContainText(/1\. Importe exento por defecto\s*1\.000,00\s€ al 0\s%/);
    await expect(lines).toContainText(/3\. Resto sujeto a tramo \(4\.610,00\s€ al 4\s%\)\s*184,40\s€/);
    await expect(lines).toContainText(/4\. Cargo de mantenimiento de la plataforma\s*0,00\s€/);
    await expect(lines).toContainText(/5\. Coste de la pasarela de pago \(Paycomet\)\s*79,60\s€/);
    await expect(page.getByTestId('studio-gateway-formula')).toContainText(/Suma cuadrada: 5\.610,00\s€ \+ 184,40\s€ \+ 0,00\s€ \+ 79,60\s€ = 5\.874,00\s€/);
    await expect(page.locator('body')).not.toContainText(/desactivad/i);
    await checkPage(page, isMobile);

    // --- Candado semántico en vivo: «ventiladores» en una categoría al 0 % avisa; en una con tramos no ---
    const category = page.getByLabel('Categoría', { exact: true });
    // El texto de la plantilla habla de ventilación: en una categoría al 0 % el candado lo bloquea y paga por tramos.
    await category.selectOption('Comunidad y Viajes');
    await server(page.getByTestId('studio-lock-alert')).toContainText('ventilacion');
    await expect(page.getByTestId('studio-badge')).toContainText('Tramo');
    await page.getByLabel('Título de la iniciativa, evento o rifa').fill('Excursión de fin de curso');
    await page.getByLabel('Descripción').fill('Autocar y entradas para todas las familias.');
    await expect(page.getByTestId('studio-lock-alert')).toHaveCount(0);
    await expect(page.getByTestId('studio-badge')).toContainText('Categoría al 0 % de comisión');
    await page.getByLabel('Título de la iniciativa, evento o rifa').fill('Ventiladores para el comedor');
    await server(page.getByTestId('studio-lock-alert')).toContainText('ventiladores');
    await expect(page.getByTestId('studio-badge')).not.toContainText('Categoría al 0 %');
    await page.getByLabel('Título de la iniciativa, evento o rifa').fill('Excursión de fin de curso');
    await expect(page.getByTestId('studio-lock-alert')).toHaveCount(0);
    await expect(page.getByTestId('studio-goal')).toHaveText(/^5\.\d{3},00\s€$/);
    await category.selectOption('Infraestructura y Confort');
    await page.getByLabel('Título de la iniciativa, evento o rifa').fill('Aulas más frescas y confortables');
    await page.getByLabel('Descripción').fill('Ventilación y sombra para que se estudie mejor.');
    await expect(page.getByTestId('studio-goal')).toHaveText(/^5\.874,00\s€$/);

    // --- Fecha: más de 60 días se avisa junto al campo ---
    await page.getByLabel('Fecha límite').fill(new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10));
    await expect(page.getByRole('alert').filter({ hasText: 'más del máximo permitido' })).toBeVisible();
    await page.getByLabel('Fecha límite').fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
    await expect(page.getByRole('alert').filter({ hasText: 'más del máximo permitido' })).toHaveCount(0);

    // --- Guardar borrador: la campaña existe y la dirección apunta a ella ---
    await page.getByTestId('studio-save').click();
    await server(page.getByText(/Borrador guardado\. Meta actual: 5\.874,00\s€/)).toBeVisible();
    await expect(page).toHaveURL(/\/estudio\?iniciativa=\d+$/);
    const initiativeId = Number(new URL(page.url()).searchParams.get('iniciativa'));
    expect(initiativeId).toBeGreaterThan(0);

    // --- Sin los documentos del titular verificados no se publica; con ellos, sí ---
    await expect(page.getByTestId('studio-publish')).toBeDisabled();
    await expect(page.getByTestId('studio-blockers').getByRole('link', { name: 'Ir a los documentos' })).toHaveAttribute('href', `/panel/${entity.slug}/ajustes#documentos`);
    await withE2eDb((db) => db.query(`UPDATE "Organization" SET "kybStatus" = 'VERIFIED' WHERE slug = $1`, [entity.slug]));
    await page.reload();
    await expect(page.getByLabel('Presupuesto del proveedor (€)')).toHaveValue('3800');
    await expect(page.getByTestId('studio-blockers')).toHaveCount(0);
    await expect(page.getByTestId('studio-publish')).toBeEnabled();

    // --- Publicar pide confirmación; «No» devuelve a editar ---
    await page.getByTestId('studio-publish').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeFocused();
    await expect(dialog).toContainText(/meta de 5\.874,00\s€/);
    await dialog.getByRole('button', { name: 'No, seguir editando' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByTestId('studio-publish').click();
    await page.getByTestId('studio-confirm-publish').click();
    const published = page.getByTestId('studio-published');
    await server(published).toBeVisible(NAVIGATION);
    await expect(published).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/estudio\\?iniciativa=${initiativeId}&publicada=1$`));
    await expect(page.getByTestId('studio-publish')).toHaveCount(0);
    await expect(page.getByLabel('Presupuesto del proveedor (€)')).toBeDisabled();
    await expect(page.getByLabel('Título de la iniciativa, evento o rifa')).toBeDisabled();
    await expect(page.getByLabel('Descripción')).toBeEnabled();
    await expect(page.getByTestId('studio-goal')).toHaveText(/^5\.874,00\s€$/);
    await checkPage(page, isMobile);

    // Una campaña recaudando se edita solo en lo que no mueve dinero.
    await page.getByLabel('Descripción').fill('Ventilación y sombra para todas las aulas.');
    await page.getByTestId('studio-save').click();
    await server(page.getByText('Cambios guardados.')).toBeVisible();

    // --- El cuadro de mandos enseña «Editar en Estudio» y el cartel ---
    await page.goto(`/panel/${entity.slug}`);
    await expect(page.getByTestId(`edit-in-studio-${initiativeId}`)).toBeVisible();
    await expect(page.getByTestId('dashboard-new-initiative')).toBeVisible();
    await expect(page.getByTestId('dashboard-new-ticketing')).toBeVisible();
    await page.getByRole('link', { name: /Cartel A4 con QR: Aulas más frescas/ }).click();

    // --- Cartel A4: el QR es real y lleva a la ficha pública ---
    await server(page.getByRole('heading', { level: 1, name: /Cartel de «Aulas más frescas y confortables»/ })).toBeVisible(NAVIGATION);
    const publicPath = `/${entity.slug}/iniciativas/${initiativeId}`;
    // La dirección pública se fija al compilar (`NEXT_PUBLIC_APP_URL`), no con el servidor de la prueba: se compara con la de la compilación.
    const publicUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}${publicPath}`;
    await expect(page.getByTestId('poster-url')).toHaveText(publicUrl.replace(/^https?:\/\//, ''));
    const expectedQr = await QRCode.toString(publicUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    // El navegador reescribe el SVG al insertarlo (orden y comillas de los atributos): se comparan los trazos del código, que son lo que se escanea.
    const drawn = await page.getByTestId('poster-qr').locator('path').evaluateAll((paths) => paths.map((path) => path.getAttribute('d')));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn).toEqual([...expectedQr.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]));
    await page.getByLabel('Título del cartel').fill('Mejoremos nuestras aulas');
    await expect(page.getByTestId('poster-title')).toHaveText('Mejoremos nuestras aulas');
    await expect(page.getByTestId('poster-sheet')).toContainText(/Hucha de la iniciativa WLT-ESC-/);
    await expect(page.getByTestId('poster-sheet')).not.toContainText(/escrow|banco/i);
    await expect(page.getByTestId('poster-download-qr')).toHaveAttribute('href', /^data:image\/png;base64,/);
    await checkPage(page, isMobile);
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('poster-sheet')).toBeVisible();
    await expect(page.getByTestId('poster-print')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });

    // La dirección del QR abre la ficha de la campaña.
    await page.goto(publicPath);
    await server(page.getByRole('heading', { level: 1, name: 'Aulas más frescas y confortables' })).toBeVisible(NAVIGATION);

    // --- Rifa: aviso de normativa, premios y confirmación antes de publicar ---
    await page.goto(`${studio}?nueva=taquilla&plantilla=raffle`);
    await server(page.getByRole('heading', { level: 1, name: 'Rifa solidaria' })).toBeVisible();
    await expect(page.getByTestId('raffle-notice')).toContainText('competencia de cada comunidad autónoma');
    await expect(page.getByLabel('Premios que se sortean')).toHaveValue('3');
    await expect(page.getByTestId('studio-goal')).toHaveText(/^1\.000,00\s€$/);
    await expect(page.getByTestId('studio-publish')).toBeDisabled();
    await expect(page.getByTestId('studio-blockers')).toContainText('Confirmad que la rifa cumple la normativa');
    await page.getByLabel('Premios que se sortean').fill('');
    await expect(page.getByTestId('studio-blockers')).toContainText('Indicad cuántos premios se sortean');
    await page.getByLabel('Premios que se sortean').fill('3');
    await page.getByLabel('Confirmamos que la rifa cumple la normativa de nuestra comunidad autónoma').check();
    await expect(page.getByTestId('studio-publish')).toBeEnabled();
    await checkPage(page, isMobile);
    await page.getByTestId('studio-publish').click();
    await page.getByTestId('studio-confirm-publish').click();
    await server(page.getByTestId('studio-published')).toBeVisible(NAVIGATION);
    const { rows } = await withE2eDb((db) =>
      db.query(`SELECT i."rafflePrizeCount", i."status", i."goalCents", (SELECT count(*) FROM "AuditLog" a WHERE a.action = 'studio.raffle_notice_confirmed' AND a."organizationId" = o.id) AS ack FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = $1 AND i.format = 'TICKETING'`, [entity.slug])
    );
    expect(rows[0]).toMatchObject({ rafflePrizeCount: 3, status: 'FUNDRAISING', goalCents: 100_000 });
    expect(Number(rows[0].ack)).toBe(1);

    // --- El selector del Estudio lista las dos campañas ---
    await page.goto(studio);
    await expect(page.getByTestId('studio-existing').getByRole('listitem')).toHaveCount(2);

    // --- Con una beca de medalla la pizarra no desborda a 430 px, y un borrador se descarta con confirmación ---
    await withE2eDb((db) => db.query(`UPDATE "Organization" SET "medalRank" = 2, "medalGrantAvailableCents" = 100000 WHERE slug = $1`, [entity.slug]));
    await page.goto(`${studio}?nueva=presupuesto&plantilla=playground`);
    await server(page.getByRole('heading', { level: 1, name: 'Patio y deporte' })).toBeVisible();
    await page.getByLabel('Presupuesto del proveedor (€)').fill('3800');
    await expect(page.getByTestId('studio-tco-lines')).toContainText(/2\. Beca exenta por medalla\s*1\.000,00\s€ al 0\s% \(medalla Plata · ahorro/);
    await checkPage(page, isMobile);
    // Al guardar sin título, el aviso sale junto al campo; con título, el borrador se guarda y el aviso está junto al botón.
    await page.getByLabel('Título de la iniciativa, evento o rifa').fill('');
    await page.getByTestId('studio-save').click();
    await server(page.getByRole('alert').filter({ hasText: 'título de al menos 3 letras' }).first()).toBeVisible();
    await page.getByLabel('Título de la iniciativa, evento o rifa').fill('Patio con juegos nuevos');
    await page.getByTestId('studio-save').click();
    await server(page.getByTestId('studio-saved')).toContainText('Borrador guardado');
    await expect(page.getByTestId('studio-discard')).toBeVisible();
    await page.getByTestId('studio-discard').click();
    const discardDialog = page.getByRole('alertdialog');
    await expect(discardDialog).toBeFocused();
    await discardDialog.getByRole('button', { name: 'No, conservarlo' }).click();
    await expect(page.getByTestId('studio-discard')).toBeFocused();
    await page.getByTestId('studio-discard').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('studio-discard')).toBeFocused();
    await page.getByTestId('studio-discard').click();
    await page.getByTestId('studio-confirm-discard').click();
    await expect(page).toHaveURL(new RegExp(`${studio}$`), NAVIGATION);
    await expect(page.getByTestId('studio-existing').getByRole('listitem')).toHaveCount(3);
    await expect(page.getByTestId('studio-existing')).toContainText('Cancelada');

    // --- La misma pantalla en catalán (el título de la campaña lo escribió la entidad: no se traduce) ---
    await page.goto(`/ca${studio}?iniciativa=${initiativeId}`);
    await server(page.getByRole('heading', { level: 1, name: 'Aulas más frescas y confortables' })).toBeVisible();
    await expect(page.getByTestId('studio-tco-lines')).toContainText(/Càrrec de manteniment de la plataforma\s*0,00\s€/);
    await checkPage(page, isMobile);

    expect(errors).toEqual([]);
  });

  // Al guardar por primera vez, Next vuelve a pedir la página al servidor y el Estudio se monta de nuevo. Con la red lenta, una confirmación abierta en ese
  // intervalo desaparecía sola (fallo intermitente de la E2E en móvil): ahora descartar y publicar esperan a que la campaña guardada esté abierta.
  test('guardar un borrador nuevo y pulsar «Descartar» enseguida, con la red lenta, no pierde la confirmación', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    await page.goto(`/panel/${entity.slug}/estudio?nueva=presupuesto&plantilla=playground`);
    await server(page.getByRole('heading', { level: 1, name: 'Patio y deporte' })).toBeVisible();
    await page.getByLabel('Presupuesto del proveedor (€)').fill('3800');
    // La respuesta del servidor con la campaña ya guardada tarda 3 segundos.
    await page.route(/estudio?iniciativa=d+/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });
    await page.getByTestId('studio-save').click();
    await server(page.getByTestId('studio-saved')).toContainText('Borrador guardado');
    // Mientras la campaña guardada se abre, descartar espera y lo dice con texto.
    await expect(page.getByTestId('studio-syncing')).toBeVisible();
    await expect(page.getByTestId('studio-discard')).toBeDisabled();
    // Al estar abierta, la confirmación aparece y ya no se va sola.
    await server(page.getByTestId('studio-discard')).toBeEnabled();
    await page.getByTestId('studio-discard').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeFocused();
    await page.waitForTimeout(1_500);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'No, conservarlo' }).click();
    await expect(page.getByTestId('studio-discard')).toBeFocused();
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });
});
