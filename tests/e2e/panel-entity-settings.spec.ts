import { expect, test, type Page } from '@playwright/test';
import { validateTaxId } from '@/core/tax/tax-id';
import { withE2eDb } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * QA-S02 (KYB) · Ajustes de la entidad (Sprint 4.2c), en escritorio (1440) y móvil (430), con axe y sin errores de consola. Una entidad recién dada
 * de alta por la interfaz completa sus documentos del titular (CIF validado, cuatro documentos al cubo privado, abrir uno con su enlace firmado),
 * los envía a revisión y ya no puede cambiarlos; guarda sus importes, ideas, teléfono, idioma e indexación, y la página se ve en catalán.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const server = expect.configure({ timeout: 30_000 });

async function checkPage(page: Page, errors: string[], isMobile: boolean) {
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);
  if (isMobile) await expectMobileStackIsOneColumn(page);
  expect(errors).toEqual([]);
}

/** Un CIF con dígito de control válido y distinto en cada ejecución. */
function validCif(): string {
  for (let number = 3_000_000 + (Date.now() % 6_000_000); ; number += 1) {
    for (const control of '0123456789') {
      const cif = `G${number}${control}`;
      if (validateTaxId(cif).valid) return cif;
    }
  }
}

const pdf = (label: string) => ({ name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`, 'latin1') });

const KINDS = [
  { label: 'Tarjeta de identificación fiscal (CIF)', testId: 'kyb-TAX_ID_CARD' },
  { label: 'Estatutos, acta fundacional o escrituras', testId: 'kyb-STATUTES' },
  { label: 'DNI o NIE de quien representa a la entidad', testId: 'kyb-REPRESENTATIVE_ID' },
  { label: 'Certificado de titularidad de la cuenta de la entidad', testId: 'kyb-ACCOUNT_OWNERSHIP' }
];

test.describe('Panel de la entidad: documentos del titular y ajustes', () => {
  test('KYB completo y enviado a revisión; importes, ideas, teléfono, idioma e indexación guardados; catalán', async ({ page, isMobile }) => {
    const errors = trackConsoleErrors(page);
    const entity = await registerEntityAndEnterPanel(page, isMobile);
    const slug = entity.slug;

    // --- Desde el cuadro de mandos: la cabecera y el paso del estado vacío llevan a los documentos ---
    await expect(page.getByText('Documentos pendientes')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a los documentos' })).toHaveAttribute('href', `/panel/${slug}/ajustes#documentos`);
    await page.getByRole('link', { name: 'Ver los documentos' }).click();
    await server(page).toHaveURL(new RegExp(`/panel/${slug}/ajustes#documentos$`));
    await expect(page).toHaveTitle(/Ajustes de la entidad/);
    await expect(page.getByRole('heading', { level: 1, name: 'Ajustes de la entidad' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ajustes' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('kyb-status')).toContainText('Aún no los habéis enviado');
    await expect(page.getByText(/IBAN|cuenta bancaria/i)).toHaveCount(0);
    const submitBox = page.getByTestId('kyb-submit');
    await expect(submitBox).toContainText('el CIF del titular');
    await expect(page.getByRole('button', { name: /Enviar los documentos a revisión/ })).toHaveCount(0);
    await checkPage(page, errors, isMobile);

    // --- Datos del titular: un CIF mal escrito se dice junto al campo; uno válido se guarda ---
    const cifField = page.getByLabel('CIF del titular');
    await cifField.fill('G1234567X');
    await page.getByRole('button', { name: 'Guardar los datos del titular' }).click();
    await expect(page.getByText(/Ese CIF no es válido/)).toBeVisible();
    await expect(cifField).toBeFocused();
    const cif = validCif();
    await cifField.fill(cif.toLowerCase());
    await page.getByRole('button', { name: 'Guardar los datos del titular' }).click();
    await server(page.getByTestId('approvals-notice').first()).toContainText('Datos del titular guardados.');
    await expect(submitBox).not.toContainText('el CIF del titular');

    // --- Cuatro documentos al cubo privado ---
    for (const kind of KINDS) {
      const row = page.getByTestId(kind.testId);
      await row.getByLabel(`Fichero para «${kind.label}»`).setInputFiles(pdf(kind.testId));
      await row.getByRole('button', { name: /Subir/ }).click();
      await server(row).toContainText(/Entregado el .* · PDF/);
      await expect(row).toContainText(`«${kind.label}»: documento recibido.`);
      await expect(row.getByRole('heading', { level: 4, name: kind.label })).toBeFocused();
    }
    // Sustituir uno deja constancia de que el anterior se conserva.
    const statutes = page.getByTestId('kyb-STATUTES');
    await statutes.getByLabel(/Fichero para/).setInputFiles(pdf('estatutos-v2'));
    await statutes.getByRole('button', { name: /Sustituir/ }).click();
    await server(page.getByText('1 documento sustituido se conserva el tiempo que exige la ley.')).toBeVisible();

    // Abrir: la ruta redirige a un enlace firmado de corta duración, sin caché.
    const href = await page.getByTestId('kyb-REPRESENTATIVE_ID').getByRole('link', { name: /Abrir/ }).getAttribute('href');
    const opened = await page.request.get(href!, { maxRedirects: 0 });
    expect(opened.status()).toBe(303);
    expect(opened.headers()['location']).toMatch(/^memory:\/\/signed\//);
    expect(opened.headers()['cache-control']).toBe('no-store');
    // Desde otra web, ni desde otro subdominio, no se abre.
    for (const site of ['cross-site', 'same-site']) expect((await page.request.get(href!, { maxRedirects: 0, headers: { 'sec-fetch-site': site } })).status()).toBe(403);
    expect(opened.headers()['referrer-policy']).toBe('no-referrer');
    // Subir desde otra web: rechazado antes de leer nada.
    const foreign = await page.request.post(`/api/panel/documentos?orgSlug=${slug}&kind=STATUTES`, { headers: { origin: 'https://otra-web.example' }, multipart: { file: pdf('ajeno') } });
    expect(foreign.status()).toBe(403);
    await checkPage(page, errors, isMobile);

    // --- Envío a revisión: queda bloqueado y la cabecera lo dice ---
    await expect(submitBox).toContainText('Está todo: ya podéis enviarlos a revisión.');
    await page.getByRole('button', { name: /Enviar los documentos a revisión/ }).click();
    await server(page.getByTestId('kyb-status')).toContainText(/Enviados el .* Están en revisión/);
    await expect(page.getByTestId('approvals-notice').first()).toContainText('Documentos enviados.');
    await expect(page.getByText('Documentos en revisión')).toBeVisible();
    await expect(page.getByLabel(/Fichero para/)).toHaveCount(0);
    await expect(page.getByLabel('CIF del titular')).toHaveCount(0);
    await expect(page.getByText(cif)).toBeVisible();
    await withE2eDb(async (db) => {
      const { rows } = await db.query(`SELECT "kybStatus", cif FROM "Organization" WHERE slug = $1`, [slug]);
      expect(rows[0]).toEqual({ kybStatus: 'SUBMITTED', cif });
      const files = await db.query(`SELECT f.visibility, f."retainUntil" FROM "KybDocument" k JOIN "FileAsset" f ON f.id = k."fileId" JOIN "Organization" o ON o.id = k."organizationId" WHERE o.slug = $1`, [slug]);
      expect(files.rows).toHaveLength(5);
      expect(files.rows.every((row) => row.visibility === 'PRIVATE' && row.retainUntil !== null)).toBe(true);
    });
    await checkPage(page, errors, isMobile);

    // --- Ajustes generales ---
    const first = page.getByLabel('Botón 1 (€)');
    await first.fill('60');
    await page.getByRole('button', { name: /Guardar los ajustes/ }).click();
    await expect(page.getByText(/Tres importes de 1 a 5000 €/)).toBeVisible();
    await expect(first).toBeFocused();
    await first.fill('5');
    await page.getByLabel('Botón 2 (€)').fill('15');
    await page.getByLabel('Importe preseleccionado').selectOption('0');
    await page.getByLabel(/Firmas mínimas/).fill('20');
    await page.getByLabel('Oro (€)').fill('750');
    await page.getByLabel('Teléfono de la entidad').fill('93 123 45 67');
    await page.getByLabel('Idioma en que escribís vuestras campañas').selectOption('ca');
    await page.getByLabel(/Mostrar el portal en buscadores/).uncheck();
    await page.getByRole('button', { name: /Guardar los ajustes/ }).click();
    await server(page.getByTestId('approvals-notice').last()).toContainText('Ajustes guardados.');
    await withE2eDb(async (db) => {
      const { rows } = await db.query(`SELECT "donationPresetsCents", "defaultDonationIdx", "minVotes", "sponsorTiersCents", phone, "contentLocale", "publicIndexing" FROM "Organization" WHERE slug = $1`, [slug]);
      expect(rows[0]).toEqual({ donationPresetsCents: [500, 1500, 5000], defaultDonationIdx: 0, minVotes: 20, sponsorTiersCents: [10000, 25000, 75000], phone: '931234567', contentLocale: 'ca', publicIndexing: false });
    });
    await page.reload();
    await expect(page.getByLabel('Botón 1 (€)')).toHaveValue('5');
    await expect(page.getByLabel('Teléfono de la entidad')).toHaveValue('931234567');
    await expect(page.getByLabel(/Mostrar el portal en buscadores/)).not.toBeChecked();
    await checkPage(page, errors, isMobile);

    // --- En catalán ---
    await page.goto(`/ca/panel/${slug}/ajustes`);
    await expect(page.getByRole('heading', { level: 1, name: "Configuració de l'entitat" })).toBeVisible();
    await expect(page.getByTestId('kyb-status')).toContainText('Estan en revisió');
    await expect(page.getByRole('link', { name: 'Configuració' })).toHaveAttribute('aria-current', 'page');
    await checkPage(page, errors, isMobile);
  });
});
