import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AchievementPhotoForm } from '@/components/panel/achievement-photo-form';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { achievementsPath } from '@/lib/seo/portal-routes';
import { listAchievementWorkbench } from '@/repositories/achievements.repository';
import { MAX_UPLOAD_BYTES, THANKS_MESSAGE_MAX } from '@/services/storage/achievement-photos.service';

/** Título propio de la pestaña (WCAG 2.4.2; antes heredaba el genérico de KORUM, auditoría de experiencia del 5.5a). */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.achievements' });
  return { title: t('title') };
}

/**
 * Logros de la entidad (Sprint 3.6): subir las fotos Antes / Después y escribir el agradecimiento que verán las familias en
 * `/{orgSlug}/logros`. La guardia del `layout` ya exige firmante con segundo factor; el repositorio lo vuelve a comprobar para esta entidad.
 */
export default async function AchievementsWorkbenchPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [items, t] = await Promise.all([listAchievementWorkbench(getPrisma(), actor, organization.id), getTranslations({ locale, namespace: 'panel.achievements' })]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-joy text-3xl font-bold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
        <Link href={achievementsPath(organization.slug)} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline underline-offset-4">
          {t('viewPublic')}
        </Link>
      </header>

      {items.length === 0 ? (
        <EmptyState icon="📷" title={t('empty.title')} description={t('empty.description')} playful />
      ) : (
        <ul className="mobile-stack grid gap-5 lg:grid-cols-2" aria-label={t('listLabel')}>
          {items.map((item) => (
            <li key={item.id}>
              <AchievementPhotoForm
                orgSlug={organization.slug}
                initiativeId={item.id}
                title={item.title}
                hasBefore={item.beforeFileId !== null}
                hasAfter={item.afterFileId !== null}
                thanksMessage={item.thanksMessage ?? ''}
                maxBytes={MAX_UPLOAD_BYTES}
                thanksMax={THANKS_MESSAGE_MAX}
                visibleToFamilies={item.status === 'CLOSED'}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
