import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Recoge los errores de página y de consola; el test comprueba al final que la lista está vacía (Puerta 4). */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

/** `document.documentElement.scrollWidth` nunca puede superar el ancho de la ventana (430 en móvil). */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(scrollWidth, `scrollWidth ${scrollWidth} > ancho ${innerWidth}`).toBeLessThanOrEqual(innerWidth);
}

/** axe con las etiquetas WCAG 2.2 AA: 0 incidencias serias o críticas. */
export async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  const summary = serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
  expect(summary, 'incidencias de accesibilidad serias o críticas').toEqual([]);
}

/** Ninguna clave de traducción sin resolver (la marca la pone `getMessageFallback`). */
export async function expectNoMissingTranslations(page: Page) {
  await expect(page.locator('body')).not.toContainText('__MISSING__');
}
