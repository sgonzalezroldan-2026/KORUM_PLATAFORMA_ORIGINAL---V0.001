'use client';

import { useTranslations } from 'next-intl';
import type { VisibleHuchaMode } from '@/core/public/catalog';
import { DelayedTooltip } from '@/components/ui/delayed-tooltip';
import { Link } from '@/i18n/navigation';
import { HUCHA_PATH } from '@/lib/seo/portal-routes';

/**
 * Píldora de Mi Hucha de la cabecera. Según el modo que fija el Super-Admin: `PLEDGE` es una aportación mensual programada (no hay saldo que
 * enseñar, KORUM nunca lo guarda) y `REGULATED_WALLET` un monedero que custodia una entidad autorizada. En `DISABLED` no se dibuja.
 * El saldo del monedero y la pantalla de Mi Hucha llegan con el Sprint 3.7: la portada es estática y no lee la sesión.
 */
export function HuchaPill({ mode }: { mode: VisibleHuchaMode }) {
  const t = useTranslations('portal.hucha');

  return (
    <DelayedTooltip content={t(`tip.${mode}`)}>
      <Link
        href={HUCHA_PATH}
        prefetch={false}
        className="tactile-btn bg-white! text-varsity-navy! shadow-[0_4px_0_var(--color-patio-rule-strong)]!"
      >
        <span aria-hidden="true">{'🐷'}</span>
        <span className="font-corp">{t('name')}</span>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-sm font-extrabold text-emerald-950">{t(mode)}</span>
      </Link>
    </DelayedTooltip>
  );
}
