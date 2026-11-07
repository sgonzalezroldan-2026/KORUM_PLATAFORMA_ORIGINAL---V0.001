'use client';

import { useTranslations } from 'next-intl';
import type { VisibleHuchaMode } from '@/core/public/catalog';
import { DelayedTooltip } from '@/components/ui/delayed-tooltip';
import { Link } from '@/i18n/navigation';
import { huchaForOrganizationPath } from '@/lib/seo/portal-routes';

/**
 * Píldora de Mi Hucha de la cabecera. Según el modo que fija el Super-Admin: `PLEDGE` es una aportación mensual programada (no hay saldo que
 * enseñar, KORUM nunca lo guarda) y `REGULATED_WALLET` un monedero que custodia una entidad autorizada. En `DISABLED` no se dibuja.
 * En `PLEDGE` abre Mi Hucha con el alta de la aportación mensual a esta entidad (Sprint 3.8). La portada es estática y no lee la sesión: si no
 * la hay, Mi Hucha manda a iniciar sesión y vuelve aquí.
 */
export function HuchaPill({ mode, orgSlug }: { mode: VisibleHuchaMode; orgSlug: string }) {
  const t = useTranslations('portal.hucha');

  return (
    <DelayedTooltip content={t(`tip.${mode}`)}>
      <Link
        href={huchaForOrganizationPath(orgSlug)}
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
