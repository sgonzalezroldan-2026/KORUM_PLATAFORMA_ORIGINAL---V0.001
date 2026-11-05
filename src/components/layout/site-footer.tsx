import { useTranslations } from 'next-intl';
import { KorumLogo } from '@/components/brand/korum-logo';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { Link } from '@/i18n/navigation';
import { PILLAR_PAGES } from '@/lib/seo/marketing-routes';

/** Pie del Entorno 0: todas las páginas, el selector de idioma y la aclaración de quién es KORUM y quién gestiona el dinero (Regla 03 §4). */
export function SiteFooter() {
  const t = useTranslations('nav');
  const common = useTranslations('common');
  const brand = useTranslations('brand');
  const groups = [
    { id: 'audience', title: t('footerAudiences') },
    { id: 'info', title: t('footerInfo') }
  ] as const;

  return (
    <footer className="border-t-2 border-varsity-navy/10 bg-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
        <div className="mobile-stack grid gap-8 md:grid-cols-3">
          <div className="flex flex-col gap-3">
            <KorumLogo size={40} />
            <p className="text-ink-soft">{brand('tagline')}</p>
            <LanguageSwitcher label={t('footerLanguage')} />
          </div>
          {groups.map((group) => (
            <nav key={group.id} aria-label={group.title}>
              <p className="font-corp font-extrabold text-varsity-navy">{group.title}</p>
              <ul className="mt-2 flex flex-col">
                {PILLAR_PAGES.filter((page) => page.group === group.id).map((page) => (
                  <li key={page.key}>
                    <Link href={page.path} className="inline-flex min-h-11 items-center rounded-lg underline-offset-4 hover:underline">
                      {t(`pages.${page.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className="text-sm text-ink-soft">{common('footerNote')}</p>
      </div>
    </footer>
  );
}
