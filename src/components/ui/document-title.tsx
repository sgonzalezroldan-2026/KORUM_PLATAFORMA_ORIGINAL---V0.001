'use client';

import { useEffect } from 'react';

/**
 * Pone el título de la pestaña desde el navegador. Solo para las páginas de error que Next pinta dentro de otra ruta (la 403 de `forbidden()`): ahí el título
 * lo resuelve la página pedida («Consola · KORUM») y un `metadata` propio no se aplica (Sprint 5.5b, WCAG 2.4.2). Lo restaura al desmontarse.
 */
export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
  return null;
}
