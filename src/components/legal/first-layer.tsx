import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';

/**
 * Primera capa de privacidad de un formulario que no es un pago (primeras capas §4 y §11, Sprint 5.10a): una **línea visible** junto al botón y un
 * **desplegable** con los datos de privacidad, cerrado por defecto. Solo pinta: los textos llegan ya traducidos (la usan el alta, en el navegador, y la
 * pantalla de acceso, en el servidor).
 */
export function FirstLayer({ line, summary, items, privacyLabel, newTab, testId }: { line: ReactNode; summary: string; items: ReactNode[]; privacyLabel: string; newTab: string; testId: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm text-ink" data-testid={testId}>
      <p>{line}</p>
      <details className="group rounded-xl border-2 border-varsity-navy/15 bg-white px-3 py-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 font-semibold text-varsity-navy [&::-webkit-details-marker]:hidden">
          {summary}
          <span aria-hidden="true" className="text-lg leading-none transition-transform group-open:rotate-180 motion-reduce:transition-none">
            {'▾'}
          </span>
        </summary>
        <ul className="flex flex-col gap-1 pb-2">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
          <li>
            <Link href="/privacidad" target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-semibold text-varsity-navy underline underline-offset-4">
              {privacyLabel}
              <span className="sr-only">{` (${newTab})`}</span>
            </Link>
          </li>
        </ul>
      </details>
    </div>
  );
}

/** Enlace de la línea a un texto legal: se abre en otra pestaña para no perder lo escrito en el formulario, y lo dice. */
export function FirstLayerLink({ href, children, newTab }: { href: string; children: ReactNode; newTab: string }) {
  return (
    <Link href={href} target="_blank" rel="noopener" className="font-semibold text-varsity-navy underline underline-offset-4">
      {children}
      <span className="sr-only">{` (${newTab})`}</span>
    </Link>
  );
}
