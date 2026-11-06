import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { InitiativeCatalog } from '@/components/portal/initiative-catalog';
import { PortalHero } from '@/components/portal/portal-hero';
import { JsonLd } from '@/components/seo/json-ld';
import { isLocale } from '@/i18n/routing';
import { breadcrumbJsonLd, entityJsonLd } from '@/lib/seo/json-ld';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { buildPageMetadata, fitText, TITLE_MAX, TITLE_SUFFIX } from '@/lib/seo/metadata';
import { initiativePath, portalPath, sponsorsPath } from '@/lib/seo/portal-routes';
import { Link } from '@/i18n/navigation';
import { loadPortalHome, loadPortalOrganization } from '@/services/portal/portal-data';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) return {};
  const [organization, t] = await Promise.all([loadPortalOrganization(orgSlug), getTranslations({ locale, namespace: 'portal.meta' })]);
  // El título lleva ` · KORUM` detrás: se recorta el nombre para que el conjunto quepa en los 60 caracteres de la skill de SEO.
  const room = TITLE_MAX - TITLE_SUFFIX.length - t('entityTitle', { name: '' }).length;
  return buildPageMetadata({
    locale,
    path: portalPath(orgSlug),
    title: t('entityTitle', { name: fitText(organization.name, room) }),
    description: fitText(t(`entityDescription.${organization.vertical}`, { name: organization.name }), 155),
    imageAlt: t('entityImageAlt', { name: organization.name }),
    noindex: !organization.indexable
  });
}

/**
 * Portada de la entidad (Entorno 1): cabecera con la barra de impacto, y el listado de iniciativas `FUNDRAISING` con los filtros ocultos.
 * Servidor: todo el contenido importante está en el HTML inicial; solo los filtros y el compartir necesitan JavaScript.
 */
export default async function PortalPage({ params }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const [organization, home, t] = await Promise.all([
    loadPortalOrganization(orgSlug),
    loadPortalHome(orgSlug, locale, new Date()),
    getTranslations({ locale, namespace: 'portal' })
  ]);
  const urls = Object.fromEntries(home.cards.map((card) => [card.id, absoluteUrl(locale, initiativePath(orgSlug, card.id))]));
  const description = t(`meta.entityDescription.${organization.vertical}`, { name: organization.name });

  return (
    <div className="space-y-6">
      <JsonLd
        data={[
          breadcrumbJsonLd(locale, [{ name: t('breadcrumb.home'), path: '/' }, { name: organization.name, path: portalPath(orgSlug) }]),
          entityJsonLd(locale, { slug: orgSlug, name: organization.name, vertical: organization.vertical, city: organization.city, postalCode: organization.postalCode, province: organization.province, description })
        ]}
      />
      <PortalHero
        name={organization.name}
        vertical={organization.vertical}
        accent={organization.brandPrimary}
        contentLang={home.contentLang}
        huchaMode={home.huchaMode}
        impact={home.impact}
      />
      <nav aria-label={t('nav.label')}>
        <ul className="flex flex-wrap gap-2">
          <li aria-current="page" className="inline-flex min-h-11 items-center rounded-xl bg-white px-4 font-extrabold text-varsity-navy shadow-sm">
            <span aria-hidden="true">{'🚀 '}</span>
            {t('nav.initiatives')}
          </li>
          <li>
            <Link href={sponsorsPath(orgSlug)} className="inline-flex min-h-11 items-center rounded-xl px-4 font-bold text-ink-soft hover:bg-white">
              <span aria-hidden="true">{'🏪 '}</span>
              {t('nav.sponsors')}
            </Link>
          </li>
        </ul>
      </nav>
      <InitiativeCatalog orgSlug={orgSlug} entityName={organization.name} cards={home.cards} urls={urls} groups={home.groups} contentLang={home.contentLang} />
    </div>
  );
}
