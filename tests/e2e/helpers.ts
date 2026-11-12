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

/**
 * Espera a que acaben las animaciones finitas de la página (como la aparición de los números del sorteo, 700 ms). axe mide el contraste con la opacidad que tiene el
 * elemento en ese instante: en un servidor lento (el CI de GitHub) la medición caía a mitad de la animación y daba un falso «color-contrast». Las infinitas
 * (confeti, esqueletos) se dejan: esperarlas no terminaría nunca.
 */
export async function waitForFiniteAnimations(page: Page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** axe con las etiquetas WCAG 2.2 AA: 0 incidencias serias o críticas. */
export async function expectNoSeriousA11yViolations(page: Page) {
  await waitForFiniteAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  const summary = serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
  expect(summary, 'incidencias de accesibilidad serias o críticas').toEqual([]);
}

/** Ninguna clave de traducción sin resolver (la marca la pone `getMessageFallback`). */
export async function expectNoMissingTranslations(page: Page) {
  await expect(page.locator('body')).not.toContainText('__MISSING__');
}

/**
 * QA-F06: en móvil (< 768 px) los hijos de cada `.mobile-stack` van uno debajo de otro, sin columnas laterales comprimidas:
 * `box[i+1].y >= box[i].y + box[i].height - 1`.
 */
export async function expectMobileStackIsOneColumn(page: Page) {
  const problems = await page.evaluate(() => {
    const found: string[] = [];
    document.querySelectorAll('.mobile-stack').forEach((container, index) => {
      const boxes = [...container.children].map((child) => child.getBoundingClientRect()).filter((box) => box.height > 0);
      for (let i = 0; i < boxes.length - 1; i += 1) {
        const current = boxes[i];
        const next = boxes[i + 1];
        if (current && next && next.y < current.y + current.height - 1) found.push(`.mobile-stack #${index}: el bloque ${i + 1} empieza antes de que acabe el ${i}`);
      }
    });
    return found;
  });
  expect(problems).toEqual([]);
}
