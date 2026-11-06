import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { InitiativeDetail } from '@/components/portal/initiative-detail';
import { JsonLd } from '@/components/seo/json-ld';
import { isLocale, type Locale } from '@/i18n/routing';
import { breadcrumbJsonLd, eventJsonLd, type JsonLdNode } from '@/lib/seo/json-ld';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { buildPageMetadata, DESCRIPTION_MAX, fitText, TITLE_MAX, TITLE_SUFFIX } from '@/lib/seo/metadata';
import { INITIATIVE_ID_PATTERN, initiativePath, ogInitiativeUrl, portalPath } from '@/lib/seo/portal-routes';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { loadInitiativePage, loadPortalOrganization } from '@/services/portal/portal-data';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string; id: string }>;
  searchParams: Promise<{ grupo?: string | string[] }>;
}

/** `?grupo=` solo se usa para elegir la imagen social: se compara con los grupos de la entidad y el texto de la URL nunca se dibuja. */
function requestedGroup(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length <= 60 ? first : '';
}

async function load(locale: Locale, orgSlug: string, rawId: string, group: string) {
  if (!INITIATIVE_ID_PATTERN.test(rawId)) notFound();
  try {
    return await loadInitiativePage(orgSlug, Number(rawId), locale, group);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale, orgSlug, id } = await params;
  if (!isLocale(locale)) return {};
  const [organization, page, t] = await Promise.all([
    loadPortalOrganization(orgSlug),
    load(locale, orgSlug, id, requestedGroup((await searchParams).grupo)),
    getTranslations({ locale, namespace: 'portal.meta' })
  ]);
  const { card } = page.detail;
  const prefix = t('initiativeDescription', { pct: card.pct, text: '' });
  const titleRoom = TITLE_MAX - TITLE_SUFFIX.length - t('initiativeTitle', { title: '', entity: organization.name }).length;
  return buildPageMetadata({
    locale,
    path: initiativePath(orgSlug, card.id),
    title: t('initiativeTitle', { title: fitText(page.title, Math.max(titleRoom, 12)), entity: organization.name }),
    description: t('initiativeDescription', { pct: card.pct, text: fitText(page.rawDescription, DESCRIPTION_MAX - prefix.length) }),
    imageAlt: t('initiativeImageAlt', { title: page.title, pct: card.pct }),
    imageUrl: ogInitiativeUrl(locale, card.id, page.updatedAt.getTime(), page.groupSlug),
    noindex: !organization.indexable
  });
}

/** Ficha pública de una iniciativa. La canónica no lleva `?grupo=`: solo cambia la imagen que ven WhatsApp y las redes. */
export default async function InitiativePage({ params, searchParams }: PageProps) {
  const { locale, orgSlug, id } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const [organization, page, t] = await Promise.all([
    loadPortalOrganization(orgSlug),
    load(locale, orgSlug, id, requestedGroup((await searchParams).grupo)),
    getTranslations({ locale, namespace: 'portal' })
  ]);
  const { card, ticket } = page.detail;
  const trail = [
    { name: t('breadcrumb.home'), path: '/' },
    { name: organization.name, path: portalPath(orgSlug) },
    { name: page.title, path: initiativePath(orgSlug, card.id) }
  ];
  const structured: JsonLdNode[] = [breadcrumbJsonLd(locale, trail)];
  if (card.format === 'TICKETING' && ticket) {
    structured.push(
      eventJsonLd(locale, {
        entitySlug: orgSlug,
        entityName: organization.name,
        initiativeId: card.id,
        name: page.title,
        description: page.rawDescription,
        startsAtIso: page.detail.closesAtIso,
        venue: ticket.venue,
        priceCents: ticket.buyerUnitCents,
        available: card.closed ? 0 : card.ticketsAvailable,
        imageUrl: ogInitiativeUrl(locale, card.id, page.updatedAt.getTime())
      })
    );
  }

  return (
    <>
      <JsonLd data={structured} />
      <InitiativeDetail
        orgSlug={orgSlug}
        entityName={organization.name}
        vertical={organization.vertical}
        detail={page.detail}
        shareUrl={absoluteUrl(locale, initiativePath(orgSlug, card.id))}
        groups={page.groups}
        contentLang={page.contentLang}
      />
    </>
  );
}
