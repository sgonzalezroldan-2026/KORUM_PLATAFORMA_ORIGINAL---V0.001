'use client';

import { useEffect } from 'react';

/**
 * Quita `?bienvenida=1` de la barra de direcciones en cuanto el panel se muestra (Sprint 5.5): recargar, guardar el enlace o compartirlo ya no
 * repite la bienvenida. Usa `history.replaceState`, que Next integra con su enrutador sin volver a pedir la página al servidor: la bienvenida
 * que ya se ve se queda en pantalla.
 */
export function WelcomeUrlCleanup() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('bienvenida')) return;
    url.searchParams.delete('bienvenida');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return null;
}
