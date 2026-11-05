'use client';

import clsx from 'clsx';
import { useLocale, useTranslations } from 'next-intl';
import NextLink from 'next/link';
import { getPathname, usePathname } from '@/i18n/navigation';
import { LOCALES } from '@/i18n/routing';

/**
 * Selector de idioma. Conserva la ruta actual y es una lista de enlaces reales (los buscadores los siguen). Si hay dos selectores en la misma
 * página (cabecera y pie), el segundo recibe un `label` propio: dos regiones de navegación no pueden llamarse igual.
 */
export function LanguageSwitcher({ className, label }: { className?: string; label?: string }) {
  const t = useTranslations('languageSwitcher');
  const current = useLocale();
  const pathname = usePathname();

  return (
    <nav aria-label={label ?? t('label')} className={className}>
      <ul className="flex items-center gap-1">
        {LOCALES.map((code) => {
          const active = code === current;
          return (
            <li key={code}>
              {/*
                Enlace con la ruta ya resuelta: el castellano va sin prefijo (`/precios`), no como `/es/precios`, que redirigiría. Sin precarga: desde
                `/ca/...`, Next resuelve mal la precarga por segmentos de la URL sin prefijo del castellano y devolvía 404 en la consola.
                Cambiar de idioma es poco frecuente, así que no la necesita.
              */}
              <NextLink
                href={getPathname({ href: pathname, locale: code })}
                prefetch={false}
                lang={code}
                hrefLang={code}
                aria-current={active ? 'true' : undefined}
                className={clsx(
                  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-sm font-bold uppercase tracking-wide',
                  active ? 'bg-varsity-navy text-varsity-ivory' : 'text-varsity-navy hover:bg-varsity-navy/10'
                )}
              >
                <span aria-hidden="true">{code}</span>
                {/* Nombre completo para lectores de pantalla y voz: contiene el texto visible (WCAG 2.5.3). */}
                <span className="sr-only">{`${code.toUpperCase()}, ${t(code)}`}</span>
              </NextLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
