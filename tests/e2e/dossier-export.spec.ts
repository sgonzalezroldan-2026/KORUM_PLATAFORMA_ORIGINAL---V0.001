import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { academicYearFor } from '@/core/finance/academic-year';
import { quarterOf } from '@/core/ideas/idea-conversion';
import { withE2eDb } from './auth-support';
import { expectHeadingsInOrder, expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel, type RegisteredEntity } from './panel-support';

/**
 * Sprint 5.8b · QA-SEC13 · expediente exportable en el navegador.
 *
 * - **Panel de la entidad:** desde su registro de actividad elige una de sus campañas, ve de qué es el expediente y lo descarga en PDF; la descarga queda
 *   anotada en ese mismo registro. Una campaña de otra entidad, escrita a mano en la dirección, no se encuentra.
 * - **Consola:** el Super-Admin pide el de una campaña de la demostración por su número y el de una aportación por su pedido de Paycomet; el PDF dice que
 *   sus cifras coinciden con el libro mayor. Un número mal escrito o que no existe se dice en la propia página.
 *
 * En castellano, catalán e inglés, a 1440 y 430 px, con axe.
 */

const server = expect.configure({ timeout: 30_000 });
test.describe.configure({ timeout: 240_000 });

const picker = (page: Page) => page.getByTestId('dossier-picker');
const result = (page: Page) => page.getByTestId('dossier-result');
/** El formulario va plegado, como los filtros: se abre para usarlo. */
const openForm = (page: Page) => page.getByTestId('dossier-form').locator('summary').click();

async function checkPage(page: Page, isMobile: boolean) {
  await expectNoSeriousA11yViolations(page);
  await expectHeadingsInOrder(page);
  await expectNoHorizontalOverflow(page);
  await expectNoMissingTranslations(page);
  if (isMobile) await expectMobileStackIsOneColumn(page);
}

/** El PDF descargado, como texto: el contenido es ASCII (los acentos van escapados), así que las referencias y las palabras sin acento se leen tal cual. */
async function pdfOf(download: Download): Promise<string> {
  const file = await download.path();
  return (await readFile(file)).toString('latin1');
}

async function downloadFrom(page: Page): Promise<{ name: string; pdf: string }> {
  const waiting = page.waitForEvent('download');
  await page.getByTestId('dossier-download').click();
  const download = await waiting;
  return { name: download.suggestedFilename(), pdf: await pdfOf(download) };
}

const organizationIdOf = (entity: RegisteredEntity) => withE2eDb(async (db) => (await db.query<{ id: string }>(`SELECT id FROM "Organization" WHERE slug = $1`, [entity.slug])).rows[0]!.id);

const createCampaign = (organizationId: string, title: string) =>
  withE2eDb(async (db) => {
    const closesAt = new Date(Date.now() + 30 * 86_400_000);
    const { rows } = await db.query<{ id: number; walletEscrowId: string }>(
      `INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "stepIndex", "closesAt", "quarter", "goalCents", "costMatCents", "costInstCents", "description", "updatedAt")
       VALUES ($1, 'BUDGET', $2, $3, $4, 'Patios y Deporte', 'Infantil', 'FUNDRAISING', 4, $5, $6, 50000, 30000, 10000, 'Campaña de la prueba del expediente', now()) RETURNING id, "walletEscrowId"`,
      [`WLT-ESC-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`, organizationId, academicYearFor(new Date()), title, closesAt, quarterOf(closesAt)]
    );
    return rows[0]!;
  });

test('QA-SEC13 · la entidad descarga el expediente de una campaña suya desde su registro de actividad, y la descarga queda anotada', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  const organizationId = await organizationIdOf(entity);

  // Sin campañas no hay de qué preparar un expediente: se dice, sin un formulario vacío.
  await page.goto(`/panel/${entity.slug}/auditoria`);
  await server(picker(page).getByRole('heading', { level: 2, name: 'Expedientes en PDF' })).toBeVisible();
  await expect(page.getByTestId('dossier-empty')).toHaveText('Todavía no tenéis ninguna campaña de la que preparar un expediente.');
  await expect(page.getByTestId('dossier-find')).toHaveCount(0);

  const title = `Toldos del patio ${randomUUID().slice(0, 6)}`;
  const campaign = await createCampaign(organizationId, title);
  const foreign = await withE2eDb(async (db) => (await db.query<{ id: number; title: string }>(`SELECT id, title FROM "Initiative" WHERE "organizationId" <> $1 ORDER BY id ASC LIMIT 1`, [organizationId])).rows[0]!);
  await page.reload();
  // Plegado al cargar, para no empujar el registro hacia abajo.
  await server(page.getByTestId('dossier-form')).toBeVisible();
  await expect(page.getByTestId('dossier-form')).not.toHaveAttribute('open', '');
  // Plegado, se sigue viendo para qué sirve; y lo que se despliega es un rótulo con su icono, como «Filtrar», no un enlace.
  await expect(picker(page)).toContainText('Reúne en un PDF lo registrado sobre una de vuestras campañas');
  await expect(page.getByTestId('dossier-form').locator('summary')).toHaveText('📄Preparar un expediente');
  await openForm(page);
  await expect(page.getByTestId('dossier-find')).toBeVisible();
  // Solo se ofrecen sus campañas; todavía no hay ninguna liquidación; y no se puede elegir una aportación.
  const select = picker(page).getByLabel('De qué queréis el expediente');
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('optgroup')).toHaveCount(1);
  // El tipo y el número van delante y enteros; solo se recortaría el título.
  await expect(select.locator('option').nth(1)).toHaveText(`Campaña n.º ${campaign.id} · ${title}`);
  await expect(picker(page)).not.toContainText(foreign.title);
  await checkPage(page, isMobile);

  await select.selectOption(`campana:${campaign.id}`);
  await page.getByTestId('dossier-find').click();
  await server(page).toHaveURL(new RegExp(`/auditoria\\?expediente=campana(:|%3A)${campaign.id}#dossier-result$`));
  await expect(result(page)).toHaveAttribute('data-status', 'ready');
  // El resultado queda a la vista, justo bajo el título del bloque, y el formulario sigue abierto con lo elegido.
  await expect(result(page)).toBeInViewport();
  await expect(result(page)).toBeFocused();
  await expect(page.getByTestId('dossier-form')).toHaveAttribute('open', '');
  await expect(result(page)).toContainText(`Listo: expediente de la campaña n.º ${campaign.id} · ${title}.`);
  await expect(result(page)).toContainText('Cada descarga queda anotada en este registro.');
  await checkPage(page, isMobile);

  const { name, pdf } = await downloadFrom(page);
  expect(name).toBe(`KORUM-EXP-C-${campaign.id}.pdf`);
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  // Con su referencia y su número de página al pie, y los movimientos de la hucha en vez de asientos.
  for (const expected of [`EXP-C-${campaign.id} \\267 P\\341gina 1 de `, campaign.walletEscrowId, 'COINCIDE', 'Movimientos de la hucha']) expect(pdf).toContain(expected);
  for (const unexpected of ['Debe', 'Haber', 'Asiento']) expect(pdf).not.toContain(unexpected);
  expect(pdf).not.toContain('NO COINCIDE');
  // Ni el email de quien dirige la entidad ni el de nadie.
  expect(pdf).not.toContain('@');

  // La descarga está en su registro, con el nombre de quien la hizo y de qué campaña.
  await page.goto(`/panel/${entity.slug}/auditoria`);
  const row = page.locator('[data-testid="audit-row"][data-action="dossier.downloaded"]');
  await server(row).toHaveCount(1);
  await expect(row).toContainText('Expediente en PDF descargado');
  await expect(row.getByTestId('audit-actor')).toContainText('Carla Puig');
  await expect(row.getByTestId('audit-target')).toContainText(`Campaña ${campaign.id} · ${title}`);

  // Una campaña de otra entidad, o algo que no es un número: no se encuentra, y no hay enlace que descargar.
  await page.goto(`/panel/${entity.slug}/auditoria?expediente=campana:${foreign.id}`);
  await server(result(page)).toHaveAttribute('data-status', 'notFound');
  await expect(result(page)).toHaveText('No hemos encontrado eso entre lo vuestro. Elegidlo de la lista.');
  await expect(page.getByTestId('dossier-download')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(foreign.title);
  await page.goto(`/panel/${entity.slug}/auditoria?expediente=aportacion:1`);
  await server(result(page)).toHaveAttribute('data-status', 'notFound');
  await page.goto(`/panel/${entity.slug}/auditoria?expediente=campana:abc`);
  await server(result(page)).toHaveAttribute('data-status', 'invalid');
  await expect(result(page)).toHaveText('No hemos entendido lo que pedíais. Elegidlo de la lista.');
  // Un enlace puesto en otra web con una campaña ajena no deja ningún intento anotado a nombre de quien lo pulsa: la página no comprueba nada.
  const probes = () => withE2eDb(async (db) => (await db.query(`SELECT 1 FROM "AuditLog" WHERE "organizationId" = $1 AND action IN ('tenant.resource_outside_tenant', 'tenant.resource_not_found', 'api.panel_dossier_denied')`, [organizationId])).rowCount);
  const probesBefore = await probes();
  for (const wanted of [`campana:${foreign.id}`, 'aportacion:1']) {
    const fromElsewhere = await page.request.get(`/panel/${entity.slug}/auditoria?expediente=${wanted}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(fromElsewhere.status()).toBe(200);
    expect(await fromElsewhere.text()).not.toContain('data-testid="dossier-result"');
  }
  expect(await probes()).toBe(probesBefore);
  // Pedir directamente la descarga de lo ajeno responde lo mismo que algo que no existe.
  const [theirs, missing] = await Promise.all([foreign.id, 2_000_000_000].map((id) => page.request.get(`/api/panel/expediente?org=${entity.slug}&expediente=campana:${id}&lang=es`)));
  expect([theirs!.status(), missing!.status()]).toEqual([404, 404]);
  expect(await theirs!.text()).toBe(await missing!.text());

  // En catalán y en inglés.
  await page.goto(`/ca/panel/${entity.slug}/auditoria?expediente=campana:${campaign.id}`);
  await server(picker(page).getByRole('heading', { level: 2, name: 'Expedients en PDF' })).toBeVisible();
  await expect(result(page)).toContainText(`Preparat: expedient de la campanya núm. ${campaign.id} · ${title}.`);
  await expect(page.getByTestId('dossier-download')).toHaveAttribute('href', new RegExp('lang=ca'));
  await checkPage(page, isMobile);
  await page.goto(`/en/panel/${entity.slug}/auditoria?expediente=campana:${campaign.id}`);
  await server(result(page)).toContainText(`Ready: case file for campaign No. ${campaign.id} · ${title}.`);
  const english = await downloadFrom(page);
  expect(english.name).toBe(`KORUM-EXP-C-${campaign.id}.pdf`);
  expect(english.pdf).toContain('Case file for a campaign');
  expect(english.pdf).toContain('Page 1 of ');
  await checkPage(page, isMobile);

  // Los 404 buscados a propósito son los únicos errores que ha visto el navegador.
  expect(errors.filter((error) => !/status of 404/.test(error))).toEqual([]);
});

test('QA-SEC13 · el Super-Admin descarga el expediente de una campaña y el de una aportación por su pedido de Paycomet, y sus cifras coinciden con el libro mayor', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  const sample = await withE2eDb(async (db) => {
    await db.query(`UPDATE "User" SET "isSuperadmin" = true WHERE lower(email) = lower($1)`, [entity.director]);
    // Una campaña de la demostración ya liquidada y una donación suya cobrada, con su pedido.
    const campaign = (await db.query<{ id: number; walletEscrowId: string; payoutId: number }>(`SELECT i.id, i."walletEscrowId", p.id AS "payoutId" FROM "Initiative" i JOIN "EscrowPayout" p ON p."initiativeId" = i.id WHERE p.status = 'EXECUTED' ORDER BY i.id ASC LIMIT 1`)).rows[0]!;
    const charge = (await db.query<{ id: number; paycometOrder: string; guestEmail: string | null }>(`SELECT id, "paycometOrder", "guestEmail" FROM "Contribution" WHERE type = 'DONATION' AND status = 'COMPLETED' AND "paycometOrder" IS NOT NULL ORDER BY id ASC LIMIT 1`)).rows[0]!;
    return { campaign, charge };
  });

  await page.goto('/admin/auditoria');
  await server(picker(page).getByRole('heading', { level: 2, name: 'Expedientes en PDF' })).toBeVisible();
  await openForm(page);
  const kind = picker(page).getByLabel('De qué es el expediente');
  const reference = picker(page).getByLabel('Número o pedido');
  await expect(kind.locator('option')).toHaveText(['Una aportación', 'Una campaña', 'Una liquidación']);
  await checkPage(page, isMobile);

  // Campaña, por su número.
  await kind.selectOption('campana');
  await reference.fill(String(sample.campaign.id));
  await page.getByTestId('dossier-find').click();
  await server(result(page)).toHaveAttribute('data-status', 'ready');
  await expect(result(page)).toContainText(`Listo: expediente de la campaña n.º ${sample.campaign.id}`);
  await expect(result(page)).toBeInViewport();
  await expect(result(page)).toBeFocused();
  const campaign = await downloadFrom(page);
  expect(campaign.name).toBe(`KORUM-EXP-C-${sample.campaign.id}.pdf`);
  for (const expected of [sample.campaign.walletEscrowId, 'COINCIDE', 'Debe', 'Haber']) expect(campaign.pdf).toContain(expected);
  expect(campaign.pdf).not.toContain('NO COINCIDE');
  expect(campaign.pdf).not.toContain('@');

  // Liquidación, por su número.
  await kind.selectOption('liquidacion');
  await reference.fill(String(sample.campaign.payoutId));
  await page.getByTestId('dossier-find').click();
  await server(result(page)).toContainText(`Listo: expediente de la liquidación n.º ${sample.campaign.payoutId}, de la campaña n.º ${sample.campaign.id}`);
  const payout = await downloadFrom(page);
  expect(payout.name).toBe(`KORUM-EXP-L-${sample.campaign.payoutId}.pdf`);
  // Lo aprobado y lo enviado, las dos cifras contra el libro mayor (la liquidación de la demostración tiene sus envíos cobro a cobro).
  for (const expected of ['Importe aprobado para el proyecto', 'Importe ya enviado', 'COINCIDE']) expect(payout.pdf).toContain(expected);
  expect(payout.pdf).not.toContain('NO COINCIDE');
  expect(payout.pdf).not.toContain('No constan env');

  // Aportación, por su pedido de Paycomet (lo que trae un contracargo).
  await kind.selectOption('aportacion');
  await reference.fill(sample.charge.paycometOrder);
  await page.getByTestId('dossier-find').click();
  await server(result(page)).toContainText(`Listo: expediente de la aportación n.º ${sample.charge.id}`);
  await checkPage(page, isMobile);
  const charge = await downloadFrom(page);
  expect(charge.name).toBe(`KORUM-EXP-A-${sample.charge.id}.pdf`);
  expect(charge.pdf).toContain(sample.charge.paycometOrder);
  expect(charge.pdf).toContain('COINCIDE');
  expect(charge.pdf).not.toContain('NO COINCIDE');
  expect(charge.pdf).not.toContain('@');

  // Lo que no existe y lo mal escrito se dicen en la página, sin enlace de descarga.
  await kind.selectOption('campana');
  await reference.fill('2000000000');
  await page.getByTestId('dossier-find').click();
  await server(result(page)).toHaveText('No hay nada con ese número. Revisa el tipo y el número.');
  await expect(page.getByTestId('dossier-download')).toHaveCount(0);
  // El campo conserva lo escrito, queda marcado y remite al aviso: no hay que reescribirlo.
  await expect(reference).toHaveValue('2000000000');
  await expect(reference).toHaveAttribute('aria-invalid', 'true');
  await expect(reference).toHaveAttribute('aria-describedby', 'dossier-ref-hint dossier-result');
  await expect(kind).toHaveValue('campana');
  await reference.fill('doce');
  await page.getByTestId('dossier-find').click();
  await server(result(page)).toHaveText('Eso no es un número válido. Escribe solo el número (o el pedido de Paycomet, si es una aportación).');
  await expect(reference).toHaveValue('doce');
  await expect(reference).toHaveAttribute('aria-invalid', 'true');

  // Las tres descargas quedaron anotadas a su nombre.
  await page.goto('/admin/auditoria?accion=dossier.downloaded');
  await server(page.locator('[data-testid="audit-row"][data-action="dossier.downloaded"]').first()).toContainText('Expediente en PDF descargado');

  await page.goto(`/en/admin/auditoria?expediente=campana&ref=${sample.campaign.id}`);
  await server(result(page)).toContainText(`Ready: case file for campaign No. ${sample.campaign.id}`);
  await checkPage(page, isMobile);
  expect(errors).toEqual([]);
});
