'use client';

import clsx from 'clsx';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { LOCALES } from '@/i18n/routing';

/** Selector de idioma. Conserva la ruta actual y es una lista de enlaces reales (los buscadores los siguen). */
export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations('languageSwitcher');
  const current = useLocale();
  const pathname = usePathname();

  return (
    <nav aria-label={t('label')} className={className}>
      <ul className="flex items-center gap-1">
        {LOCALES.map((code) => {
          const active = code === current;
          return (
            <li key={code}>
              <Link
                href={pathname}
                locale={code}
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
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
