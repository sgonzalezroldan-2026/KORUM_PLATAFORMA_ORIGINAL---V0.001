'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';

/**
 * Secciones del panel de la entidad. Solo aparecen las que ya existen; las demás (portería) se añaden aquí al llegar su sprint. La sección activa se marca con `aria-current` y con estilo, nunca solo con color. «Aprobaciones» lleva cuántas decisiones esperan, con
 * texto para el lector de pantalla (no solo el número).
 */
export function PanelNav({ orgSlug, pendingApprovals = 0 }: { orgSlug: string; pendingApprovals?: number }) {
  const t = useTranslations('panel.nav');
  const pathname = usePathname();
  const base = `/panel/${orgSlug}`;
  const items = [
    { key: 'dashboard', href: base, active: pathname === base },
    { key: 'studio', href: `${base}/estudio`, active: pathname.startsWith(`${base}/estudio`) },
    { key: 'approvals', href: `${base}/aprobaciones`, active: pathname.startsWith(`${base}/aprobaciones`) },
    { key: 'payouts', href: `${base}/liquidaciones`, active: pathname.startsWith(`${base}/liquidaciones`) },
    { key: 'expired', href: `${base}/vencidas`, active: pathname.startsWith(`${base}/vencidas`) },
    { key: 'achievements', href: `${base}/logros`, active: pathname.startsWith(`${base}/logros`) },
    { key: 'fund', href: `${base}/fondo`, active: pathname.startsWith(`${base}/fondo`) },
    { key: 'settings', href: `${base}/ajustes`, active: pathname.startsWith(`${base}/ajustes`) }
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
              {item.key === 'approvals' && pendingApprovals > 0 ? (
                <span className="ms-2 inline-flex min-w-6 items-center justify-center rounded-full bg-varsity-gold px-1.5 text-xs font-extrabold tabular-nums text-varsity-navy" data-testid="approvals-pending">
                  <span aria-hidden="true">{pendingApprovals}</span>
                  <span className="sr-only">{t('pending', { count: pendingApprovals })}</span>
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
