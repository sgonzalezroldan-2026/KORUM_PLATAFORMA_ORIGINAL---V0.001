'use client';

import { useSyncExternalStore } from 'react';

const subscribeNever = () => () => undefined;

/**
 * `false` en el servidor y durante la hidratación; `true` cuando React ya atiende los eventos. Sirve para dos cosas: leer lo que solo existe en
 * el navegador sin descuadrar el HTML del servidor, y desactivar los botones de pago hasta que funcionen (en un móvil lento, un toque antes de
 * hidratar se perdería o enviaría el formulario sin JavaScript).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );
}
