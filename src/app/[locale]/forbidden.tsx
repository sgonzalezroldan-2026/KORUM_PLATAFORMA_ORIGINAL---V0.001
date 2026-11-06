import { useTranslations } from 'next-intl';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';

/** 403 de los entornos privados (`forbidden()` en las guardias): la sesión es válida pero no tiene permiso para esta entidad o esta consola. */
export default function Forbidden() {
  const t = useTranslations('forbidden');

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="contenido" className="mx-auto w-full max-w-2xl flex-1 px-4 py-16">
        <EmptyState
          icon="🔒"
          title={t('title')}
          description={t('description')}
          headingLevel={1}
          action={
            <Link href="/login" className="tactile-btn">
              {t('switchAccount')}
            </Link>
          }
        />
      </main>
      <SiteFooter />
    </div>
  );
}
