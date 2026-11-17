'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Da el foco a un elemento **cuando React ya ha pintado el cambio** (Sprint 5.9, WCAG 2.4.3). Sirve para los paneles de confirmación en línea y los
 * avisos que aparecen tras una acción: el destino (el título del panel, el botón seguro, el campo con error) solo existe después de pintar.
 *
 * Antes se hacía con `requestAnimationFrame` al pulsar: en la compilación de producción el fotograma puede llegar antes de que React pinte el panel y el
 * foco se perdía (Sprint 3.8). Aquí la petición se guarda en el estado y se ejecuta en un efecto, que React lanza tras confirmar el cambio en pantalla, sea
 * cual sea el fotograma. Se pasa una función (no el elemento) porque la referencia no existe hasta ese momento.
 */
export function useFocusPainted(): (target: () => HTMLElement | null | undefined) => void {
  const [request, setRequest] = useState<{ target: () => HTMLElement | null | undefined } | null>(null);

  useEffect(() => {
    request?.target()?.focus();
  }, [request]);

  return useCallback((target) => setRequest({ target }), []);
}
