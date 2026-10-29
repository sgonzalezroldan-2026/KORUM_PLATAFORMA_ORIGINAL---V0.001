import { useTranslations } from 'next-intl';

/** Pie del Entorno 0. Aclara quién es KORUM y quién gestiona el dinero (Regla 03 §4). */
export function SiteFooter() {
  const t = useTranslations('common');

  return (
    <footer className="border-t-2 border-varsity-navy/10 bg-white">
      <p className="mx-auto w-full max-w-6xl px-4 py-6 text-sm text-ink-soft">{t('footerNote')}</p>
    </footer>
  );
}
