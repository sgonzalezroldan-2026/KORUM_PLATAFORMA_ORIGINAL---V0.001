import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { achievementsPath, helpPath, ideasPath, portalPath, sponsorsPath } from '@/lib/seo/portal-routes';

export type PortalSection = 'initiatives' | 'ideas' | 'achievements' | 'sponsors' | 'help';

const SECTIONS: ReadonlyArray<{ id: PortalSection; icon: string; href: (orgSlug: string) => string }> = [
  { id: 'initiatives', icon: '🚀', href: portalPath },
  { id: 'ideas', icon: '💡', href: ideasPath },
  { id: 'achievements', icon: '✨', href: achievementsPath },
  { id: 'sponsors', icon: '🏪', href: sponsorsPath },
  { id: 'help', icon: '❓', href: helpPath }
];

/**
 * Navegación entre los apartados del portal de la entidad (Entorno 1): iniciativas y taquilla, buzón de ideas, logros, comercios amigos y FAQ y soporte. El
 * apartado actual no es un enlace y se marca con `aria-current`; en móvil caben en filas, sin desplazamiento lateral.
 */
export function PortalNav({ orgSlug, current }: { orgSlug: string; current: PortalSection }) {
  const t = useTranslations('portal.nav');

  return (
    <nav aria-label={t('label')}>
      <ul className="flex flex-wrap gap-2">
        {SECTIONS.map((section) => {
          const label = (
            <>
              <span aria-hidden="true">{`${section.icon} `}</span>
              {t(section.id)}
            </>
          );
          return section.id === current ? (
            <li key={section.id}>
              <span aria-current="page" className="inline-flex min-h-11 items-center rounded-xl bg-white px-4 font-extrabold text-varsity-navy shadow-sm">
                {label}
              </span>
            </li>
          ) : (
            <li key={section.id}>
              <Link href={section.href(orgSlug)} className="inline-flex min-h-11 items-center rounded-xl px-4 font-bold text-ink-soft hover:bg-white">
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
