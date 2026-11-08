'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';

/**
 * Secciones del panel de la entidad. Solo aparecen las que ya existen; las demás (aprobaciones, Estudio, liquidaciones, portería) se añaden aquí
 * al llegar su sprint. La sección activa se marca con `aria-current` y con estilo, nunca solo con color.
 */
export function PanelNav({ orgSlug }: { orgSlug: string }) {
  const t = useTranslations('panel.nav');
  const pathname = usePathname();
  const base = `/panel/${orgSlug}`;
  const items = [
    { key: 'dashboard', href: base, active: pathname === base },
    { key: 'achievements', href: `${base}/logros`, active: pathname.startsWith(`${base}/logros`) }
  ] as const;

  return (
    <nav aria-label={t('label')}>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={clsx(
                'inline-flex min-h-11 items-center rounded-xl border-2 px-4 font-corp text-sm font-extrabold',
                item.active ? 'border-varsity-navy bg-varsity-navy text-varsity-ivory' : 'border-varsity-navy/30 bg-white text-varsity-navy hover:border-varsity-navy'
              )}
            >
              {t(item.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
