import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { cancelPendingFocus, focusLater } from '@/lib/focus-later';

/**
 * Devolución del foco tras una acción (WCAG 2.4.3). La espera reintenta durante un segundo y medio hasta que su destino existe; una espera que se queda
 * colgada no puede quitarle el foco a quien ya está en otra cosa. Las dos últimas pruebas reproducen el fallo del CI de GitHub (Sprint 5.6): una espera de
 * la prueba anterior enfocaba un elemento de la siguiente a mitad de escritura (`'Gal'` en vez de `'Galetes'`).
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function add<K extends keyof HTMLElementTagNameMap>(tag: K, id: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.id = id;
  if (tag === 'h2') element.tabIndex = -1;
  document.body.append(element);
  return element;
}

describe('focusLater', () => {
  it('enfoca el destino en cuanto existe y deja de estar deshabilitado', async () => {
    focusLater('guardar');
    await wait(80);
    const button = add('button', 'guardar');
    button.disabled = true;
    await wait(120);
    expect(document.activeElement).not.toBe(button);
    button.disabled = false;
    await wait(120);
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('solo cuenta la última petición', async () => {
    const first = add('button', 'primero');
    const second = add('button', 'segundo');
    focusLater('primero');
    focusLater('segundo');
    await wait(120);
    expect(document.activeElement).toBe(second);
    first.remove();
    second.remove();
  });

  it('una espera anulada ya no enfoca nada, aunque su destino aparezca después', async () => {
    const field = add('input', 'campo');
    field.focus();
    focusLater('aparece-tarde');
    cancelPendingFocus();
    const late = add('h2', 'aparece-tarde');
    await wait(200);
    expect(document.activeElement).toBe(field);
    field.remove();
    late.remove();
  });

  it('(1 de 2) una prueba termina con una devolución de foco esperando a un destino que no llega', () => {
    focusLater('editor-de-la-prueba-siguiente');
    expect(document.getElementById('editor-de-la-prueba-siguiente')).toBeNull();
  });

  it('(2 de 2) la prueba siguiente escribe sin que esa espera le quite el foco', async () => {
    const user = userEvent.setup();
    const field = add('textarea', 'texto');
    await user.type(field, 'Gal');
    // El destino de la espera heredada aparece a mitad de escritura (en el CI, la pantalla de la prueba siguiente terminaba de pintarse entonces).
    const heading = add('h2', 'editor-de-la-prueba-siguiente');
    await wait(200);
    await user.keyboard('etes');
    expect(field.value).toBe('Galetes');
    expect(document.activeElement).toBe(field);
    heading.remove();
    field.remove();
  });
});
