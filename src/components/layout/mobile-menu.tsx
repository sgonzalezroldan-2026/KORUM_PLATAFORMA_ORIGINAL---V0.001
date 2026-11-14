'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from '@/i18n/navigation';
import { AccountLink } from './account-link';
import { NavLink } from './nav-link';
import { PILLAR_PAGES } from '@/lib/seo/marketing-routes';

/**
 * Menú de la cabecera en móvil y tableta (< 1280 px): un botón que despliega todas las páginas de KORUM. Es un botón con `aria-expanded`
 * (no un menú ARIA complejo): Escape lo cierra y devuelve el foco al botón, y elegir un enlace también lo cierra, porque la cabecera
 * no se vuelve a montar al navegar. Pulsar fuera del menú también lo cierra (heredado del Sprint 3.1), sin mover el foco: quien pulsa fuera ya
 * ha elegido dónde seguir.
 */
export function MobileMenu() {
  const t = useTranslations('nav');
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [open]);

  function closeOnEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || !open) return;
    setOpen(false);
    event.currentTarget.querySelector('button')?.focus();
  }

  return (
    <div ref={containerRef} className="xl:hidden" onKeyDown={closeOnEscape}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border-2 border-varsity-navy px-3 font-bold text-varsity-navy"
      >
        <span aria-hidden="true">{open ? '✕' : '☰'}</span>
        {t('menu')}
      </button>
      {open ? (
        <nav id={panelId} aria-label={t('menu')} className="absolute inset-x-0 top-full z-40 border-b-2 border-varsity-navy/10 bg-white px-4 pb-4 shadow-vault">
          <ul className="mx-auto flex max-w-6xl flex-col">
            {PILLAR_PAGES.map((page) => (
              <li key={page.key}>
                <NavLink href={page.path} onClick={() => setOpen(false)} className="flex min-h-11 items-center font-semibold text-varsity-navy aria-[current=page]:underline aria-[current=page]:decoration-varsity-gold aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-4">
                  {t(`pages.${page.key}`)}
                </NavLink>
              </li>
            ))}
            <li>
              <AccountLink onNavigate={() => setOpen(false)} className="flex min-h-11 items-center font-semibold text-varsity-navy" />
            </li>
            <li className="pt-2">
              <Link href="/registro-comunidad" onClick={() => setOpen(false)} className="tactile-btn w-full">
                {t('signup')}
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
