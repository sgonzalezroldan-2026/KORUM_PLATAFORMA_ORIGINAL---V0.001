'use client';

import clsx from 'clsx';
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';

export const DEFAULT_TOOLTIP_DELAY_MS = 1000;
const VIEWPORT_MARGIN_PX = 8;

export interface DelayedTooltipProps {
  content: ReactNode;
  /** Retardo con el puntero. Por defecto 1000 ms exactos (Regla 03 / QA-C02). Con teclado aparece al enfocar, sin retardo. */
  delayMs?: number;
  /**
   * Elemento que dispara la ayuda. Debe ser enfocable (botón, enlace, campo) y reenviar `aria-describedby` al elemento DOM.
   * Un botón `disabled` no recibe foco ni eventos de puntero: envuélvelo en un `<span tabIndex={0}>` si necesita ayuda.
   */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  className?: string;
}

/** Centra la burbuja sobre el disparador y la desplaza lo justo para que no se salga del ancho visible (móvil a 430 px). */
function placeBubble(node: HTMLSpanElement | null) {
  if (!node) return;
  node.style.transform = 'translateX(-50%)';
  const { left, right } = node.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  let shiftPx = 0;
  if (left < VIEWPORT_MARGIN_PX) shiftPx = VIEWPORT_MARGIN_PX - left;
  else if (right > viewport - VIEWPORT_MARGIN_PX) shiftPx = viewport - VIEWPORT_MARGIN_PX - right;
  if (shiftPx !== 0) node.style.transform = `translateX(calc(-50% + ${shiftPx}px))`;
}

/**
 * Ayuda contextual que cumple WCAG 1.4.13 (contenido al pasar el puntero o al enfocar):
 * - **Descartable:** Escape la cierra mientras esté abierta, tenga o no el foco (listener en `document`).
 * - **Se puede pasar por encima:** la burbuja cuelga del mismo contenedor y no hay hueco entre ambos (el espacio visual es
 *   `padding` de la propia burbuja), así que el puntero puede viajar del disparador a la burbuja sin que se cierre.
 * - **Persistente:** se mantiene mientras haya puntero o foco sobre el conjunto.
 */
export function DelayedTooltip({ content, delayMs = DEFAULT_TOOLTIP_DELAY_MS, children, className }: DelayedTooltipProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, hide]);

  return (
    <span
      className={clsx('relative inline-flex', className)}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return;
        clearTimer();
        timer.current = setTimeout(() => setOpen(true), delayMs);
      }}
      onPointerLeave={hide}
      onFocus={() => {
        clearTimer();
        setOpen(true);
      }}
      onBlur={hide}
    >
      {cloneElement(children, { 'aria-describedby': open ? tooltipId : children.props['aria-describedby'] })}
      {open ? (
        <span
          ref={placeBubble}
          role="tooltip"
          id={tooltipId}
          // `pb-2` crea la separación visual dentro del propio elemento: sin hueco, el puntero no «sale» al ir hacia la burbuja.
          className="animate-tooltip-in absolute bottom-full left-1/2 z-40 w-max max-w-[min(18rem,calc(100vw-1rem))] pb-2"
        >
          <span className="block rounded-lg bg-varsity-navy px-3 py-2 text-sm font-medium leading-snug text-varsity-ivory shadow-lg">{content}</span>
        </span>
      ) : null}
    </span>
  );
}
