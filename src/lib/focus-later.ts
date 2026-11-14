/**
 * Mueve el foco cuando el botón que lo tenía se deshabilita o desaparece (WCAG 2.4.3): sin esto el teclado vuelve al principio de la página.
 *
 * Si el destino aún no existe o sigue deshabilitado (la acción no ha terminado de pintarse) se reintenta durante un segundo y medio. **Solo cuenta la última
 * petición:** una anterior que siguiera esperando a su destino se anula, para que no le quite el foco a quien ya está en otra cosa. `cancelPendingFocus`
 * anula la que quede (las pruebas lo llaman al terminar cada una: una espera heredada enfocaba un elemento de la prueba siguiente a mitad de escritura y
 * hacía fallar el CI de GitHub, más lento, desde el Sprint 5.4).
 */

const RETRY_MS = 50;
const MAX_ATTEMPTS = 30;

let pending: { cancelled: boolean } | null = null;

export function cancelPendingFocus(): void {
  if (pending) pending.cancelled = true;
  pending = null;
}

export function focusLater(id: string | null | undefined): void {
  if (!id) return;
  cancelPendingFocus();
  const request = { cancelled: false };
  pending = request;
  let attempts = 0;
  const finish = () => {
    if (pending === request) pending = null;
  };
  const attempt = () => {
    if (request.cancelled) return;
    const target = document.getElementById(id) as (HTMLElement & { disabled?: boolean }) | null;
    if (target && !target.disabled) {
      target.focus();
      finish();
      return;
    }
    attempts += 1;
    if (attempts < MAX_ATTEMPTS) setTimeout(attempt, RETRY_MS);
    else finish();
  };
  requestAnimationFrame(attempt);
}
