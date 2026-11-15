'use client';

import { useEffect } from 'react';

/**
 * Lleva la vista y el foco al resultado del selector de expedientes cuando la página vuelve con su ancla (Sprint 5.8b). El formulario ya apunta a
 * `#dossier-result`, pero las páginas del panel y de la consola pintan antes su esqueleto de carga: si el resultado aún no existe cuando el navegador
 * busca el ancla, no se desplaza hasta él y parece que no ha pasado nada (lo destapó la prueba de navegador en el móvil). No pinta nada. Sin JavaScript
 * queda el ancla del navegador.
 */
export function DossierResultFocus({ targetId }: { targetId: string }) {
  useEffect(() => {
    if (window.location.hash !== `#${targetId}`) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    // El desplazamiento ya está hecho: el foco no debe mover la página otra vez.
    target.focus({ preventScroll: true });
  }, [targetId]);
  return null;
}
