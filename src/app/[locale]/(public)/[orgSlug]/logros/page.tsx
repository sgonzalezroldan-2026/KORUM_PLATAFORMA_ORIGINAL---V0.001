import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AchievementGrid } from '@/components/achievements/achievement-grid';
import { PortalNav } from '@/components/portal/portal-nav';
import { JsonLd } from '@/components/seo/json-ld';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { breadcrumbJsonLd } from '@/lib/seo/json-ld';
import { buildPageMetadata, fitText, TITLE_MAX, TITLE_SUFFIX } from '@/lib/seo/metadata';
import { achievementsPath, portalPath } from '@/lib/seo/portal-routes';
import { loadAchievements } from '@/services/portal/achievements-data';
import { loadPortalOrganization } from '@/services/portal/portal-data';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) return {};
  const [organization, t] = await Promise.all([loadPortalOrganization(orgSlug), getTranslations({ locale, namespace: 'portal.meta' })]);
  const room = TITLE_MAX - TITLE_SUFFIX.length - t('achievementsTitle', { name: '' }).length;
  return buildPageMetadata({
    locale,
    path: achievementsPath(orgSlug),
    title: t('achievementsTitle', { name: fitText(organization.name, room) }),
    description: fitText(t('achievementsDescription', { name: organization.name }), 155),
    imageAlt: t('entityImageAlt', { name: organization.name }),
    noindex: !organization.indexable
  });
}

/**
 * Logros conseguidos (`id="fview-logros"` del prototipo; QA-F09): lo que la comunidad ya ha hecho, con el comparador Antes / Después y el
 * agradecimiento del centro. Las iniciativas conseguidas llevan a su ficha, que sigue pública. Servidor: el contenido está en el HTML inicial.
 */
export default async function AchievementsPage({ params }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const [organization, items, t, nav] = await Promise.all([
    loadPortalOrganization(orgSlug),
    loadAchievements(orgSlug, locale),
    getTranslations({ locale, namespace: 'portal.achievements' }),
    getTranslations({ locale, namespace: 'portal' })
  ]);

  return (
    <div className="space-y-6">
      <JsonLd data={[breadcrumbJsonLd(locale, [{ name: nav('breadcrumb.home'), path: '/' }, { name: organization.name, path: portalPath(orgSlug) }, { name: t('breadcrumb'), path: achievementsPath(orgSlug) }])]} />
      <PortalNav orgSlug={orgSlug} current="achievements" />

      <section aria-labelledby="achievements-title" className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6">
        <p className="text-xs font-extrabold uppercase text-emerald-800">{t('badge')}</p>
        <h1 id="achievements-title" className="font-joy text-2xl font-bold text-varsity-navy">
          {t('title')}
          <span aria-hidden="true">{' 🎉'}</span>
        </h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('intro')}</p>
      </section>

      {items.length === 0 ? (
        <EmptyState
          icon="✨"
          title={t('empty.title')}
          description={t('empty.description')}
          playful
          action={
            <Link href={portalPath(orgSlug)} className="tactile-btn rounded-2xl! font-joy text-sm">
              {t('empty.action')}
            </Link>
          }
        />
      ) : (
        <AchievementGrid items={items} entityName={organization.name} />
      )}
    </div>
  );
}
