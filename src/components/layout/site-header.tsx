import { useTranslations } from 'next-intl';
import { KorumLogo } from '@/components/brand/korum-logo';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { Link } from '@/i18n/navigation';
import { PILLAR_PAGES, type PillarKey } from '@/lib/seo/marketing-routes';
import { AccountLink } from './account-link';
import { MobileMenu } from './mobile-menu';

/**
 * Enlaces que caben en la cabecera de escritorio a 1280 px en los tres idiomas (el catalán es el más largo); las páginas para cada público
 * y la de seguridad están en el menú desplegable y en el pie.
 */
const HEADER_LINKS: readonly PillarKey[] = ['comoFunciona', 'precios', 'faq'];

/**
 * Cabecera del Entorno 0 (marketing y acceso): logotipo que lleva al inicio, navegación, selector de idioma y acceso. En móvil, las páginas
 * se agrupan en un menú desplegable. El enlace del logotipo no lleva `aria-label`: su nombre es el texto visible «KORUM» (WCAG 2.5.3).
 */
export function SiteHeader() {
  const t = useTranslations('nav');
  const common = useTranslations('common');

  return (
    <header className="relative border-b-2 border-varsity-navy/10 bg-white print:hidden">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="inline-flex min-h-11 min-w-11 items-center rounded-lg">
          {/* Por debajo de 400 px solo cabe el isotipo: con el nombre, la cabecera se saldría de la pantalla a 360 px. */}
          <KorumLogo size={40} className="max-[399px]:hidden" />
          <KorumLogo size={40} markOnly className="min-[400px]:hidden" />
        </Link>
        <nav aria-label={common('mainNavigation')} className="hidden xl:block">
          <ul className="flex items-center gap-1">
            {PILLAR_PAGES.filter((page) => HEADER_LINKS.includes(page.key)).map((page) => (
              <li key={page.key}>
                <Link href={page.path} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 font-semibold text-varsity-navy hover:bg-varsity-navy/10">
                  {t(`pages.${page.key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <AccountLink className="hidden min-h-11 items-center whitespace-nowrap rounded-lg px-3 font-semibold text-varsity-navy hover:bg-varsity-navy/10 xl:inline-flex" />
          <Link href="/registro-comunidad" className="tactile-btn hidden !min-h-11 whitespace-nowrap xl:inline-flex">
            {t('signup')}
          </Link>
          <MobileMenu />
        </div>
      </div>
    </header>
  );
}
