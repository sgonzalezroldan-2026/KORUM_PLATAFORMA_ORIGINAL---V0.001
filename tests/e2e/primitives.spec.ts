import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, expectNoSeriousA11yViolations, trackConsoleErrors } from './helpers';

test.describe('Primitivas de interfaz (galería interna)', () => {
  test('la galería carga sin errores, sin desbordes y accesible', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/dev/ui');
    await expect(page.getByRole('heading', { level: 1, name: 'Galería de componentes' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('la galería no se indexa', async ({ page }) => {
    await page.goto('/dev/ui');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('los 9 estados de iniciativa se ven con texto', async ({ page }) => {
    await page.goto('/dev/ui');
    // Acotado al contenido: en desarrollo, el indicador de Next.js (la «N» de la esquina) también usa `data-status`.
    const badges = page.locator('#contenido [data-status]');
    await expect(badges).toHaveCount(9);
    await expect(badges.filter({ hasText: '¡Conseguido!' })).toHaveCount(1);
  });

  test('los importes salen en céntimos exactos con el formato del idioma', async ({ page }) => {
    await page.goto('/dev/ui');
    const amount = page.locator('[data-cents="100000"]').first();
    expect((await amount.textContent())?.replace(/ /g, ' ')).toBe('1.000,00 €');
    expect((await page.locator('[data-cents="-34"]').first().textContent())?.replace(/ /g, ' ')).toBe('-0,34 €');

    await page.goto('/en/dev/ui');
    expect(await page.locator('[data-cents="100000"]').first().textContent()).toBe('€1,000.00');
  });

  test('QA-C02 · con el teclado el tooltip aparece al enfocar, sin retardo, y Escape lo cierra', async ({ page }) => {
    await page.goto('/dev/ui');
    const trigger = page.getByRole('button', { name: 'Pasa el ratón por aquí' });
    const tooltip = page.getByRole('tooltip');

    await trigger.focus();
    await expect(tooltip).toBeVisible({ timeout: 300 });
    await expect(trigger).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
  });

  test.describe('con puntero', () => {
    test.skip(({ isMobile }) => isMobile, 'El retardo con puntero no aplica a la emulación táctil');

    test('QA-C02 · el tooltip aparece a los 1000 ms con el ratón, no antes', async ({ page }) => {
      await page.goto('/dev/ui');
      const trigger = page.getByRole('button', { name: 'Pasa el ratón por aquí' });
      const tooltip = page.getByRole('tooltip');

      const startedAt = Date.now();
      await trigger.hover();
      await page.waitForTimeout(700);
      await expect(tooltip).toBeHidden();
      await expect(tooltip).toBeVisible({ timeout: 2_000 });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(elapsed).toBeLessThan(2_500);

      await page.mouse.move(5, 5);
      await expect(tooltip).toBeHidden();
    });

    test('WCAG 1.4.13 · el ratón puede viajar del disparador a la burbuja sin que se cierre', async ({ page }) => {
      await page.goto('/dev/ui');
      const trigger = page.getByRole('button', { name: 'Pasa el ratón por aquí' });
      const tooltip = page.getByRole('tooltip');

      await trigger.hover();
      await expect(tooltip).toBeVisible({ timeout: 2_000 });
      const triggerBox = (await trigger.boundingBox())!;
      const tooltipBox = (await tooltip.boundingBox())!;

      // Recorre en pasos el camino entre ambos: no puede haber ningún punto en el que desaparezca.
      const from = { x: triggerBox.x + triggerBox.width / 2, y: triggerBox.y + 2 };
      const to = { x: tooltipBox.x + tooltipBox.width / 2, y: tooltipBox.y + tooltipBox.height / 2 };
      for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
        await expect(tooltip).toBeVisible({ timeout: 100 });
      }
      await page.waitForTimeout(300);
      await expect(tooltip).toBeVisible();
    });

    test('WCAG 1.4.13 · Escape cierra la burbuja aunque solo haya puntero encima (sin foco)', async ({ page }) => {
      await page.goto('/dev/ui');
      const trigger = page.getByRole('button', { name: 'Pasa el ratón por aquí' });
      const tooltip = page.getByRole('tooltip');

      await trigger.hover();
      await expect(tooltip).toBeVisible({ timeout: 2_000 });
      await expect(trigger).not.toBeFocused();
      await page.keyboard.press('Escape');
      await expect(tooltip).toBeHidden();
    });
  });
  test('los avisos se anuncian: éxito en la región educada y error en la de alerta, y se cierran', async ({ page }) => {
    await page.goto('/dev/ui');
    await page.getByRole('button', { name: 'Aviso de éxito' }).click();
    const polite = page.locator('[aria-live="polite"]').filter({ hasText: 'Aportación recibida' });
    await expect(polite).toBeVisible();

    await page.getByRole('button', { name: 'Aviso de error' }).click();
    // Se acota a la región de avisos: Next.js tiene además su propio anunciador de rutas con role="alert".
    await expect(page.getByRole('region', { name: 'Avisos' }).getByRole('alert')).toContainText('Bizum no ha confirmado el pago');

    await page.getByRole('button', { name: 'Cerrar aviso' }).first().click();
    await expect(page.getByRole('button', { name: 'Cerrar aviso' })).toHaveCount(1);
    await expectNoSeriousA11yViolations(page);
  });

  test('la tabla se ordena de mayor a menor y viceversa al pulsar cualquier cabecera', async ({ page }) => {
    await page.goto('/dev/ui');
    const firstRow = () => page.locator('tbody tr').first().locator('td').first();
    const header = page.getByRole('columnheader', { name: /Recaudado/ });

    await page.getByRole('button', { name: 'Ordenar por Recaudado' }).click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await expect(firstRow()).toHaveText('Toldos para el patio');

    await page.getByRole('button', { name: 'Ordenar por Recaudado' }).click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await expect(firstRow()).toHaveText('Marcador de la pista');

    await page.getByRole('button', { name: 'Ordenar por Iniciativa' }).click();
    await expect(page.getByRole('columnheader', { name: /Recaudado/ })).toHaveAttribute('aria-sort', 'none');
  });

  test('.mobile-stack apila en una columna en móvil y reparte en 3 en escritorio', async ({ page }, testInfo) => {
    await page.goto('/dev/ui');
    const boxes = await page.locator('.mobile-stack > *').evaluateAll((nodes) =>
      nodes.map((node) => {
        const { x, y, width } = node.getBoundingClientRect();
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width) };
      })
    );
    expect(boxes).toHaveLength(3);
    if (testInfo.project.name === 'mobile') {
      expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
      expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
      expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y);
      await expectNoHorizontalOverflow(page);
    } else {
      expect(new Set(boxes.map((box) => box.y)).size).toBe(1);
      expect(new Set(boxes.map((box) => box.x)).size).toBe(3);
    }
  });

  test('el logotipo tiene nombre accesible y la cabecera enlaza al inicio', async ({ page }) => {
    await page.goto('/ca/dev/ui');
    await expect(page.getByRole('link', { name: 'KORUM', exact: true })).toHaveAttribute('href', '/ca');
    await expect(page.getByRole('img', { name: 'Logotip de KORUM' }).first()).toBeVisible();
  });

  test('con movimiento reducido no se animan ni los esqueletos ni los avisos', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dev/ui');
    const duration = await page.locator('.animate-skeleton').first().evaluate((node) => getComputedStyle(node).animationDuration);
    expect(parseFloat(duration)).toBeLessThan(0.001);
  });
});
