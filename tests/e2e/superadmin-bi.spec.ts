import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { withE2eDb } from './auth-support';
import { expectMobileStackIsOneColumn, expectNoHorizontalOverflow, expectNoMissingTranslations, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';
import { registerEntityAndEnterPanel } from './panel-support';

/**
 * Sprint 5.1 · BI de la consola (QA-A01, QA-A02, QA-FIN05, QA-FIN06): el Super-Admin entra con su segundo factor y ve lo cobrado (libro mayor) separado
 * de la proyección, las 6 fuentes cuadradas al céntimo, las tablas ordenables en las dos direcciones, el diagnóstico 💎 / 🚨, los avisos de precios con
 * su insignia y banner, las alertas con su botón de resolver y las tareas programadas. Las cifras absolutas no se fijan aquí (otras pruebas hacen cobros
 * en la misma base): se comprueban las identidades, que son lo que importa. Las cifras exactas de la semilla las fija la prueba de integración.
 */

const server = expect.configure({ timeout: 30_000 });
test.describe.configure({ timeout: 240_000 });

/** Cents de un importe pintado por `CurrencyText` (`data-cents`). */
async function cents(locator: ReturnType<Page['locator']>): Promise<number> {
  const attribute = await locator.locator('[data-cents]').first().getAttribute('data-cents');
  return Number(attribute);
}

/** Una persona de la prueba con rol de Super-Admin, entrando con su TOTP como cualquier firmante (el alta de la consola es del Sprint 5.4). */
async function enterAsSuperadmin(page: Page, isMobile: boolean) {
  const entity = await registerEntityAndEnterPanel(page, isMobile);
  await withE2eDb((db) => db.query(`UPDATE "User" SET "isSuperadmin" = true WHERE lower("email") = lower($1)`, [entity.director]));
  return entity;
}

async function raiseAlert(type: string, severity: string, dedupeKey: string, extra: { targetType?: string; targetId?: string; detail?: Record<string, unknown> } = {}) {
  await withE2eDb((db) =>
    db.query(
      `INSERT INTO "OpsAlert" ("id", "type", "severity", "dedupeKey", "targetType", "targetId", "detailJson") VALUES ($1, $2::"OpsAlertType", $3::"OpsAlertSeverity", $4, $5, $6, $7::jsonb)`,
      [randomUUID(), type, severity, dedupeKey, extra.targetType ?? null, extra.targetId ?? null, JSON.stringify(extra.detail ?? {})]
    )
  );
}

test('el Super-Admin ve lo real y lo proyectado por separado, con las 6 fuentes cuadradas y las tablas ordenables', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);

  await page.goto('/admin');
  await server(page.getByRole('heading', { level: 1, name: 'Resumen de la plataforma' })).toBeVisible();
  // Franja «de un vistazo» arriba: lo que pide atención, con su número y su enlace a la sección.
  const summary = page.getByTestId('console-summary');
  await expect(summary.getByRole('heading', { name: 'De un vistazo' })).toBeVisible();
  for (const id of ['summary-alerts', 'summary-boost', 'summary-negative', 'summary-pricing']) await expect(summary.getByTestId(id)).toBeVisible();
  await expect(summary.getByTestId('summary-negative')).toContainText('Campañas con 🚨 retorno negativo');
  expect(Number((await summary.getByTestId('summary-negative').locator('span').nth(1).innerText()).trim())).toBeGreaterThanOrEqual(1);
  // Los trimestres se leen como una persona: «4.º trimestre de 2026», no «2026-Q4».
  await expect(page.locator('select[name="trimestre"] option', { hasText: /trimestre de \d{4}/ }).first()).toBeAttached();
  const business = page.getByTestId('admin-business');
  await expect(business.getByRole('heading', { level: 2, name: 'Negocio: ingresos reales y proyectados' })).toBeVisible();
  await expect(page.getByTestId('kpi-real').getByRole('heading', { name: 'Ingresos reales (lo ya cobrado)' })).toBeVisible();
  await expect(page.getByTestId('kpi-projection').getByRole('heading', { name: 'Proyección al 100 % de las campañas abiertas' })).toBeVisible();

  // Las 6 fuentes: en cada columna, Σ fuentes + costes (mostrados en negativo) === neto, al céntimo.
  const chart = page.getByTestId('revenue-sources');
  await expect(chart.locator('[data-source]')).toHaveCount(6);
  for (const column of [0, 1]) {
    let sources = 0;
    for (const row of await chart.locator('[data-source]').all()) sources += await cents(row.locator('td').nth(column));
    const footer = await chart.locator('tfoot tr').all();
    expect(footer).toHaveLength(5);
    expect(await cents(footer[0]!.locator('td').nth(column)), `total de fuentes, columna ${column}`).toBe(sources);
    let net = sources;
    for (const cost of footer.slice(1, 4)) {
      const cell = cost.locator('td').nth(column);
      if ((await cell.locator('[data-cents]').count()) > 0) net += await cents(cell);
    }
    expect(await cents(footer[4]!.locator('td').nth(column)), `neto, columna ${column}`).toBe(net);
  }
  // El neto proyectado de la tabla es el mismo que el del KPI «Ingreso neto esperado».
  expect(await cents(page.getByTestId('sources-net-projected'))).toBe(await cents(page.getByTestId('kpi-expected-net')));
  expect(await cents(page.getByTestId('sources-net-real'))).toBe(await cents(page.getByTestId('kpi-real-net')));

  // Tabla de entidades: las dos columnas pedidas y orden por cualquier título, de mayor a menor y al revés.
  const orgs = page.getByTestId('bi-orgs');
  await expect(orgs.getByRole('columnheader', { name: /Cerradas \(Año \/ Hist\.\)/ })).toBeVisible();
  await expect(orgs.getByRole('columnheader', { name: /Comercios \(Act\. \/ Hist\.\)/ })).toBeVisible();
  const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
  const orgNames = async () => (await orgs.locator('tbody tr th').allInnerTexts()).map((text) => text.split('\n')[0]!.trim());
  await orgs.getByRole('button', { name: 'Ordenar por Entidad / provincia' }).click();
  const descending = await orgNames();
  expect(descending.length).toBeGreaterThanOrEqual(4);
  expect([...descending].sort((a, b) => collator.compare(b, a))).toEqual(descending);
  await orgs.getByRole('button', { name: 'Ordenar por Entidad / provincia' }).click();
  expect(await orgNames()).toEqual([...descending].reverse());

  // Top 10: como mucho 10 filas, con 💛 Aportaciones, ordenable por cualquier columna.
  const top = page.getByTestId('bi-top10');
  await expect(top.getByRole('columnheader', { name: /Aportaciones/ })).toBeVisible();
  expect(await top.locator('tbody tr').count()).toBeLessThanOrEqual(10);
  const netColumn = async () => Promise.all((await top.locator('tbody tr').all()).map((row) => cents(row.locator('td').nth(7))));
  await top.getByRole('button', { name: 'Ordenar por Neto KORUM' }).click();
  const high = await netColumn();
  expect([...high].sort((a, b) => b - a)).toEqual(high);
  await top.getByRole('button', { name: 'Ordenar por Neto KORUM' }).click();
  const low = await netColumn();
  expect([...low].sort((a, b) => a - b)).toEqual(low);

  // Diagnóstico con el texto oficial: la iniciativa exenta de la semilla pierde dinero, y toda campaña rentable de completar lo dice con sus cifras.
  const global = page.getByTestId('bi-global');
  const negative = global.locator('[data-diagnosis="negative"]');
  expect(await negative.count()).toBeGreaterThanOrEqual(1);
  await expect(negative.first()).toHaveText(/^🚨 ¡Peligro Retorno Negativo! \(-[\d.,]+\s€\) · Ajustar precios$/);
  for (const badge of await global.locator('[data-diagnosis="boost"]').all()) await expect(badge).toHaveText(/^💎 ¡Auto-Impulso Rentable! Aportar [\d.,]+\s€ ➔ Retorno \+[\d.,]+\s€$/);
  await expect(global.getByRole('columnheader', { name: /Aportaciones/ })).toBeVisible();
  await global.getByLabel('Mostrar').selectOption('ACTIVE');
  for (const status of await global.locator('tbody [data-status]').all()) await expect(status).toHaveAttribute('data-status', 'FUNDRAISING');

  // Filtros en la dirección web: acotan las entidades y se quitan con un enlace.
  await page.locator('select[name="entidad"]').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
  await expect(page).toHaveURL(/\?.*entidad=/);
  await server(page.getByTestId('bi-orgs').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('1 filtro activo')).toBeVisible();
  await page.getByRole('link', { name: 'Quitar filtros' }).click();
  await expect(page).not.toHaveURL(/entidad=/);
  await server(page.getByTestId('bi-orgs').locator('tbody tr')).not.toHaveCount(1);

  expect(errors).toEqual([]);
});

test('avisos de precios con insignia y banner, alertas que se resuelven y tareas programadas; accesible, en catalán y en móvil', async ({ page, isMobile }) => {
  const errors = trackConsoleErrors(page);
  await enterAsSuperadmin(page, isMobile);
  const reconciliation = `RECONCILIATION_MISMATCH:e2e:${randomUUID()}`;
  const stuck = `REFUND_STUCK:${2_000_000_000 + Math.floor(Math.random() * 1_000)}`;
  await raiseAlert('RECONCILIATION_MISMATCH', 'CRITICAL', reconciliation, { detail: { kind: 'AMOUNT_MISMATCH' } });
  await raiseAlert('REFUND_STUCK', 'CRITICAL', stuck, { targetType: 'Contribution', targetId: stuck.split(':')[1]!, detail: {} });

  await page.goto('/admin');
  await server(page.getByRole('heading', { level: 1, name: 'Resumen de la plataforma' })).toBeVisible();

  // Salud de precios: con los valores por defecto avisa de Mi Hucha (crítico) y del escalón de los tramos; insignia en la cabecera y banner en la portada.
  const badge = page.getByTestId('pricing-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/\d+ avisos? de precios/);
  await expect(page.getByTestId('pricing-banner')).toContainText('aviso');
  const pricing = page.getByTestId('pricing-health');
  await expect(pricing.locator('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]')).toContainText('Mi Hucha');
  await expect(pricing.locator('[data-pricing-alert="BRACKET_CLIFF"]')).toContainText('Considera el modo marginal');
  await expect(pricing.locator('[data-pricing-alert="HUCHA_FEE_BELOW_GATEWAY_COST"]')).toContainText('Crítico');

  // Alertas: el tipo de descuadre en lenguaje llano y el botón de resolver, que la cierra.
  const alerts = page.getByTestId('ops-alerts');
  const mismatch = alerts.locator('[data-alert="RECONCILIATION_MISMATCH"]').filter({ hasText: 'El importe de un cobro no coincide con el de Paycomet' });
  await expect(mismatch).toBeVisible();
  await mismatch.getByRole('button', { name: 'Marcar como resuelta' }).click();
  await server(alerts.locator('[data-alert="RECONCILIATION_MISMATCH"]').filter({ hasText: 'El importe de un cobro no coincide' })).toHaveCount(0);
  // Se anuncia el resultado y el foco pasa al titular de la bandeja.
  await expect(page.getByText('Alerta marcada como resuelta.')).toBeVisible();
  await expect(page.locator('#admin-alerts')).toBeFocused();
  const rows = await withE2eDb((db) => db.query(`SELECT "status" FROM "OpsAlert" WHERE "dedupeKey" = $1`, [reconciliation]));
  expect(rows.rows[0]?.status).toBe('RESOLVED');

  // Una devolución sin respuesta se resuelve a mano; si el cobro ya no está pendiente, lo dice y no toca nada.
  const refund = alerts.locator('[data-alert="REFUND_STUCK"]').last();
  // Una devolución sin respuesta solo se cierra con su formulario: no hay botón genérico que la oculte sin resolverla.
  await expect(refund.getByRole('button', { name: 'Marcar como resuelta' })).toHaveCount(0);
  await refund.getByText('Resolver esta devolución a mano').click();
  await expect(refund.getByRole('button', { name: 'Guardar resolución' })).toBeDisabled();
  await refund.getByLabel('Paycomet no devolvió el dinero (se podrá volver a intentar)').check();
  await refund.getByRole('button', { name: 'Guardar resolución' }).click();
  await server(refund.getByRole('alert')).toContainText('Ese caso ya no está pendiente de resolver');
  expect((await withE2eDb((db) => db.query(`SELECT "status" FROM "OpsAlert" WHERE "dedupeKey" = $1`, [stuck]))).rows[0]?.status).toBe('OPEN');

  // Tareas programadas: la tabla con la última ejecución de cada una, o el aviso de que aún no hay ninguna.
  await expect(page.getByTestId('job-runs').or(page.getByText('Todavía no se ha ejecutado ninguna tarea.'))).toBeVisible();

  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);
  if (isMobile) await expectMobileStackIsOneColumn(page);

  // Catalán: textos de los tres bloques y de los importes con su formato.
  await page.goto('/ca/admin');
  await server(page.getByRole('heading', { level: 2, name: 'Negoci: ingressos reals i projectats' })).toBeVisible();
  await expect(page.getByTestId('kpi-real').getByRole('heading', { name: 'Ingressos reals (el que ja s’ha cobrat)' })).toBeVisible();
  await expect(page.getByTestId('pricing-badge')).toHaveText(/\d+ avisos? de preus/);
  await expect(page.getByTestId('console-summary').getByRole('heading', { name: 'D’un cop d’ull' })).toBeVisible();
  await expect(page).toHaveTitle('Consola · KORUM');
  await expect(page.getByTestId('bi-orgs').getByRole('columnheader', { name: /Tancades \(Any \/ Hist\.\)/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await expectNoMissingTranslations(page);
  await expectNoHorizontalOverflow(page);

  expect(errors).toEqual([]);
});
