import { useTranslations } from 'next-intl';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';

export default function NotFound() {
  const t = useTranslations('notFound');

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="contenido" className="mx-auto w-full max-w-2xl flex-1 px-4 py-16">
        <EmptyState
          icon="🧭"
          title={t('title')}
          description={t('description')}
          headingLevel={1}
          action={
            <Link href="/" className="tactile-btn">
              {t('backHome')}
            </Link>
          }
        />
      </main>
      <SiteFooter />
    </div>
  );
}
