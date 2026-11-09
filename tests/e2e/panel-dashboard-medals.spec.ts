import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { validateTaxId } from '@/core/tax/tax-id';
import { withE2eDb } from './auth-support';
import { E2E_SCHEMA } from './e2e-database';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * QA-S02 y QA-S05 · cabecera de gestión, cuadro de mandos, kit de medallas y Modelo 182 del panel (Sprint 4.1), en escritorio (1440) y móvil
 * (430), con axe y sin errores de consola. Se da de alta una entidad real por la interfaz (queda sin campañas: estado vacío guiado) y después se
 * le preparan en la base de pruebas tres campañas, la medalla Plata y la Ley 49/2002 verificada para recorrer el resto.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const server = expect.configure({ timeout: 30_000 });

async function checkPage(page: Page, errors: string[]) {
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
}

/** Un CIF con dígito de control válido y distinto en cada ejecución. */
function validCif(): string {
  for (let number = 2_000_000 + (Date.now() % 7_000_000); ; number += 1) {
    for (const control of '0123456789') {
      const cif = `G${number}${control}`;
      if (validateTaxId(cif).valid) return cif;
    }
  }
}

/** Copia una campaña de la semilla (Cervantes) a la entidad de la prueba con otro título, estado y recaudado. */
async function cloneCampaign(slug: string, overrides: { title: string; status: string; stepIndex: number; raisedCents: number }) {
  await withE2eDb(async (db) => {
    const { rows: columns } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Initiative' ORDER BY ordinal_position`, [E2E_SCHEMA]);
    const skip = new Set(['id', 'walletEscrowId', 'organizationId', 'sourceIdeaId', 'gatePinHash', 'gatePinExpiresAt', 'title', 'status', 'stepIndex', 'raisedCents', 'goalCents']);
    const copy = columns.map((row) => row.column_name as string).filter((name) => !skip.has(name));
    const quoted = copy.map((name) => `"${name}"`).join(', ');
    const fromSource = copy.map((name) => `i."${name}"`).join(', ');
    const walletId = `WLT-ESC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await db.query(
      `INSERT INTO "Initiative" (${quoted}, "walletEscrowId", "organizationId", "title", "status", "stepIndex", "raisedCents", "goalCents")
       SELECT ${fromSource}, $1, (SELECT id FROM "Organization" WHERE slug = $2), $3, $4::"InitiativeStatus", $5, $6, 400000
       FROM "Initiative" i JOIN "Organization" o ON o.id = i."organizationId" WHERE o.slug = 'cervantes' AND i.format = 'BUDGET' ORDER BY i.id LIMIT 1`,
      [walletId, slug, overrides.title, overrides.status, overrides.stepIndex, overrides.raisedCents]
    );
  });
}

test.describe('Panel de la entidad: cuadro de mandos, medallas y Modelo 182', () => {
  test('entidad nueva con estado vacío guiado; con campañas, medalla Plata y Ley 49/2002: filtros, línea de estados, kit y fichero', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const slug = entity.slug;

    // --- Sin campañas: cabecera de gestión y estado vacío guiado ---
    await expect(page.getByRole('heading', { level: 1, name: `Hola, ${entity.name}` })).toBeVisible();
    await expect(page.getByText(/^WLT-ESC-[A-Z2-9]{6}$/)).toBeVisible();
    await expect(page.getByText('Documentos pendientes')).toBeVisible();
    await expect(page.getByText(/^Cupos del curso/)).toBeVisible();
    await expect(page.getByText(/Mantenimiento de la plataforma: 0,00\s€/)).toBeVisible();
    await expect(page.getByText(/Desactivado/)).toHaveCount(0);
    await expect(page.getByText('Doble firma (1 de 2 listas)', { exact: true })).toBeVisible();
    await expect(page.getByText('Presidencia del AMPA/AFA · Marta Soler')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cuadro de mandos' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Vuestra primera campaña empieza aquí' })).toBeVisible();
    const steps = page.getByRole('list', { name: 'Pasos hasta la primera campaña' }).getByRole('listitem');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Falta que la otra persona firmante');
    await expect(page.getByRole('button', { name: /Filtrar/ })).toHaveCount(0);
    // Medallas: aún ninguna conseguida, así que no hay kit y se explica en positivo qué falta.
    await expect(page.getByRole('heading', { name: 'Medallas KORUM' })).toBeVisible();
    await expect(page.getByText('Siguiente medalla: os falta 1 campaña conseguida este curso.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Sello y texto para redes/ })).toHaveCount(0);
    // Sin la Ley 49/2002 acreditada no hay descarga del Modelo 182.
    await expect(page.getByText(/justificante nominativo de aportación, sin efectos fiscales/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Descargar el fichero/ })).toHaveCount(0);
    await checkPage(page, errors);
    if (isMobile) await expectMobileStackIsOneColumn(page);

    // --- Se prepara la entidad: Plata, Ley 49/2002 verificada y tres campañas ---
    await withE2eDb((db) =>
      db.query(
        `UPDATE "Organization" SET "medalRank" = 2, "completedThisYear" = 2, "medalGrantAvailableCents" = 100000, "kybStatus" = 'VERIFIED', ley49 = true, "ley49VerifiedAt" = now(), "contactPhone" = '934 12 88 90', cif = $2 WHERE slug = $1`,
        [slug, validCif()]
      )
    );
    await cloneCampaign(slug, { title: 'Campaña viva E2E', status: 'FUNDRAISING', stepIndex: 4, raisedCents: 150_000 });
    await cloneCampaign(slug, { title: 'Campaña conseguida E2E', status: 'GOAL_REACHED', stepIndex: 5, raisedCents: 400_000 });
    await cloneCampaign(slug, { title: 'Campaña cerrada E2E', status: 'CLOSED', stepIndex: 5, raisedCents: 250_000 });
    await page.reload();

    // --- Cuadro de mandos con datos ---
    await expect(page.getByText('Titular verificado')).toBeVisible();
    await expect(page.getByText(/Beca de medalla/)).toContainText('+1.000,00');
    const kpis = page.locator('dl dd');
    await expect(kpis).toHaveText(['3', '1', '2', '8.000,00 €', '0']);
    const live = page.getByRole('heading', { level: 3, name: 'Campaña viva E2E' }).locator('xpath=ancestor::li[1]');
    await expect(live.getByText(/^Hucha WLT-ESC-/)).toBeVisible();
    await expect(live.getByText('1.500,00 € de 4.000,00 €')).toBeVisible();
    await expect(live.getByRole('listitem').filter({ hasText: '5. Recaudando' })).toHaveAttribute('aria-current', 'step');
    await expect(live.getByRole('link', { name: /Ver la ficha pública/ })).toHaveAttribute('href', new RegExp(`/${slug}/iniciativas/\\d+$`));

    // Filtros ocultos por defecto; se abren con «Filtrar» y el contador cuenta los activos.
    const filter = page.getByRole('button', { name: /^Filtrar/ });
    await expect(page.getByLabel('Estado')).toBeHidden();
    await filter.click();
    await page.getByLabel('Estado').selectOption('CLOSED');
    await expect(filter).toContainText('1 filtro activo');
    await expect(page.getByRole('heading', { level: 3, name: 'Campaña cerrada E2E' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Campaña viva E2E' })).toHaveCount(0);
    await expect(kpis).toHaveText(['1', '0', '1', '2.500,00 €', '0']);
    await page.getByRole('button', { name: 'Restablecer' }).click();
    await expect(kpis.first()).toHaveText('3');
    await filter.click();
    await checkPage(page, errors);
    if (isMobile) await expectMobileStackIsOneColumn(page);

    // --- Kit de medallas: Bronce y Plata conseguidas, Oro por conseguir ---
    const levels = page.getByRole('heading', { name: 'Medallas KORUM' }).locator('xpath=ancestor::section[1]').getByRole('listitem');
    await expect(levels.filter({ hasText: 'Medalla Oro' })).toContainText('Siguiente medalla: os falta 1 campaña conseguida este curso.');
    await expect(levels.filter({ hasText: 'Medalla Oro' }).getByRole('button')).toHaveCount(0);
    await levels.filter({ hasText: 'Medalla Plata' }).getByRole('button', { name: /Sello y texto para redes/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Kit oficial · Medalla Plata' });
    await expect(dialog).toBeVisible();
    const post = dialog.getByRole('textbox', { name: /Texto para las redes de la entidad/ });
    await expect(post).toHaveValue(new RegExp(`${entity.name}.*nivel Plata`));
    await expect(post).toHaveValue(/#ComunidadKORUM #CEIPPanel/);
    await expect(dialog.getByRole('link', { name: /Compartir por WhatsApp/ })).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
    await expectNoSeriousA11yViolations(page);

    const [pdf] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('link', { name: /Descargar el informe/ }).click()]);
    expect(pdf.suggestedFilename()).toBe(`korum-medalla-silver-${slug}.pdf`);
    const pdfBytes = await readFile((await pdf.path())!);
    expect(pdfBytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdfBytes.toString('latin1')).toContain('Campa\\361as conseguidas');
    const [seal] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('link', { name: /Descargar el sello/ }).click()]);
    expect(seal.suggestedFilename()).toBe(`korum-medalla-silver-${slug}.svg`);
    const svg = await readFile((await seal.path())!, 'utf8');
    expect(svg).toContain('PLATA');
    expect(svg).toContain(entity.name.slice(0, 20));
    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(dialog).toBeHidden();

    // Un nivel que aún no se tiene no se entrega aunque se pida a mano; sin Origin, el Modelo 182 tampoco.
    const gold = await page.request.get(`/api/panel/medalla?orgSlug=${slug}&nivel=gold&tipo=sello&locale=es`);
    expect(gold.status()).toBe(409);
    expect(await gold.json()).toMatchObject({ error: 'NOT_EARNED' });
    const crossSite = await page.request.post('/api/panel/modelo-182', { data: { orgSlug: slug, fiscalYear: 2025, contactPhone: '934128890' } });
    expect(crossSite.status()).toBe(403);

    // --- Modelo 182: con la Ley 49/2002 verificada se descarga el fichero y se cuenta lo que entró ---
    const model = page.getByRole('heading', { name: 'Modelo 182 (donativos)' }).locator('xpath=ancestor::section[1]');
    await expect(model.getByLabel('Teléfono de contacto')).toHaveValue('934128890');
    await model.getByLabel('Teléfono de contacto').fill('12345');
    await model.getByRole('button', { name: /Descargar el fichero/ }).click();
    await expect(model.getByLabel('Teléfono de contacto')).toHaveAttribute('aria-invalid', 'true');
    await expect(model.getByRole('alert')).toContainText('Escribid un teléfono de 9 cifras.');
    await model.getByLabel('Teléfono de contacto').fill('+34 934 12 88 90');
    await model.getByLabel('Ejercicio').selectOption('2025');
    const [file] = await Promise.all([page.waitForEvent('download'), model.getByRole('button', { name: /Descargar el fichero/ }).click()]);
    expect(file.suggestedFilename()).toBe(`modelo182-2025-${slug}.txt`);
    const records = (await readFile((await file.path())!, 'latin1')).split('\r\n').filter(Boolean);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.every((record) => record.length === 250)).toBe(true);
    await expect(model.getByRole('status')).toContainText('Fichero del ejercicio 2025 descargado: 0 personas declaradas');
    await checkPage(page, errors);

    // --- Otros idiomas y navegación entre secciones ---
    await page.goto(`/ca/panel/${slug}`);
    await expect(page.getByRole('link', { name: 'Quadre de comandament' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Medalles KORUM' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Model 182 (donatius)' })).toBeVisible();
    await checkPage(page, errors);
    await page.goto(`/en/panel/${slug}`);
    await expect(page.getByRole('heading', { name: 'KORUM medals' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Form 182 (donations)' })).toBeVisible();
    await checkPage(page, errors);
    await page.getByRole('link', { name: 'Achievements' }).click();
    await server(page).toHaveURL(new RegExp(`/en/panel/${slug}/logros$`));
    await expect(page.getByRole('link', { name: 'Achievements' })).toHaveAttribute('aria-current', 'page');
    // La cabecera de gestión acompaña a todas las páginas del panel.
    await expect(page.getByText('Dual signature (1 of 2 ready)', { exact: true })).toBeVisible();
    await checkPage(page, errors);
  });
});
