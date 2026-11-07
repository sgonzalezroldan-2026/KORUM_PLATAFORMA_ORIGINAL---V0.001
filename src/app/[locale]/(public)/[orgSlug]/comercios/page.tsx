import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PortalNav } from '@/components/portal/portal-nav';
import { SponsorCard } from '@/components/portal/sponsor-card';
import { JsonLd } from '@/components/seo/json-ld';
import { EmptyState } from '@/components/ui/empty-state';
import { sortSponsorsByLevel, type SponsorLevel } from '@/core/sponsors/sponsorship-rules';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { breadcrumbJsonLd } from '@/lib/seo/json-ld';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { buildPageMetadata, fitText, TITLE_MAX, TITLE_SUFFIX } from '@/lib/seo/metadata';
import { checkoutPath, portalPath, sponsorsPath } from '@/lib/seo/portal-routes';
import { loadPortalOrganization, loadSponsorDirectory } from '@/services/portal/portal-data';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) return {};
  const [organization, t] = await Promise.all([loadPortalOrganization(orgSlug), getTranslations({ locale, namespace: 'portal.meta' })]);
  const room = TITLE_MAX - TITLE_SUFFIX.length - t('sponsorsTitle', { name: '' }).length;
  return buildPageMetadata({
    locale,
    path: sponsorsPath(orgSlug),
    title: t('sponsorsTitle', { name: fitText(organization.name, room) }),
    description: fitText(t('sponsorsDescription', { name: organization.name }), 155),
    imageAlt: t('entityImageAlt', { name: organization.name }),
    noindex: !organization.indexable
  });
}

/**
 * Comercios amigos (`id="fview-comercios"` del prototipo; QA-F05): los negocios del barrio que apoyan a la entidad, por categoría y siempre en
 * el orden ORO > PLATA > BRONCE. **Nunca importes ni fees**: solo categoría, nombre, tipo de negocio y la ventaja para las familias. Solo
 * aparecen los aprobados por el centro y vigentes. Servidor: todo el contenido está en el HTML inicial.
 */
export default async function SponsorsPage({ params }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const [organization, directory, t, nav] = await Promise.all([
    loadPortalOrganization(orgSlug),
    loadSponsorDirectory(orgSlug, new Date()),
    getTranslations({ locale, namespace: 'portal.sponsors' }),
    getTranslations({ locale, namespace: 'portal' })
  ]);
  const sponsors = sortSponsorsByLevel(directory.sponsors);
  const pageUrl = absoluteUrl(locale, sponsorsPath(orgSlug));
  const collaborate = directory.sponsorableInitiativeId === null ? null : `${checkoutPath(orgSlug, directory.sponsorableInitiativeId)}?modo=comercio`;
  const linkClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-5 text-center font-extrabold';

  return (
    <div className="space-y-6">
      <JsonLd data={[breadcrumbJsonLd(locale, [{ name: nav('breadcrumb.home'), path: '/' }, { name: organization.name, path: portalPath(orgSlug) }, { name: t('breadcrumb'), path: sponsorsPath(orgSlug) }])]} />
      <PortalNav orgSlug={orgSlug} current="sponsors" />

      <section aria-labelledby="sponsors-title" className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-amber-300 bg-amber-50 p-6">
        <div className="max-w-xl space-y-2">
          <p className="inline-flex rounded-full bg-amber-400 px-3 py-0.5 text-xs font-extrabold uppercase text-slate-900">{t('badge')}</p>
          <h1 id="sponsors-title" className="font-joy text-2xl font-bold text-slate-900">
            {t('title', { name: organization.name })}
          </h1>
          <p className="text-ink-soft">{t('intro')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`${t('sharePage', { name: organization.name })} ${pageUrl}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${linkClass} border border-amber-400 bg-white text-slate-900`}
          >
            <span aria-hidden="true">{'📤 '}</span>
            {t('share')}
          </a>
          {collaborate ? (
            <Link href={collaborate} prefetch={false} className={`${linkClass} bg-varsity-navy text-amber-300`} data-testid="sponsor-cta">
              <span aria-hidden="true">{'🏪 '}</span>
              {t('collaborate')}
            </Link>
          ) : null}
        </div>
      </section>

      {sponsors.length === 0 ? (
        <EmptyState icon="🏪" title={t('empty.title')} description={t('empty.description')} playful action={collaborate ? <Link href={collaborate} prefetch={false} className={`${linkClass} bg-varsity-navy text-white`}>{t('collaborate')}</Link> : undefined} />
      ) : (
        <ul className="mobile-stack grid gap-5 md:grid-cols-2 lg:grid-cols-3" aria-label={t('listLabel')}>
          {sponsors.map((sponsor) => (
            <li key={sponsor.id} className="flex">
              <SponsorCard sponsor={{ id: sponsor.id, name: sponsor.name, sector: sponsor.sector, level: sponsor.categoryLevel as SponsorLevel, promo: sponsor.promo, code: sponsor.code }} entityName={organization.name} pageUrl={pageUrl} contentLang={organization.contentLocale === locale ? undefined : organization.contentLocale} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
