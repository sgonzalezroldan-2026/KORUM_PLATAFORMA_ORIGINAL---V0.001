import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { SponsorDocument } from '@/components/checkout/sponsor-document';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import { verifyCheckoutResult } from '@/core/checkout/checkout-rules';
import { openSponsorTaxId } from '@/core/tax/tax-id-vault';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { SPONSOR_DOCUMENTS, type SponsorDocumentKind } from '@/lib/seo/portal-routes';
import { getSponsorshipDocuments } from '@/repositories/sponsorship.repository';
import { getSetting } from '@/services/settings/settings.service';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string; kind: string }>;
  searchParams: Promise<{ pedido?: string | string[]; sig?: string | string[] }>;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
const isKind = (value: string): value is SponsorDocumentKind => (SPONSOR_DOCUMENTS as readonly string[]).includes(value);

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, kind } = await params;
  if (!isLocale(locale) || !isKind(kind)) return {};
  const t = await getTranslations({ locale, namespace: 'portal.sponsorDocs' });
  // Contiene datos fiscales del comercio: nunca se indexa ni se envía en el `Referer`.
  return { title: t(`${kind}.title`), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/**
 * Justificante o factura de un patrocinio (`?pedido=&sig=`). Solo lo abre quien tiene el enlace firmado de su pedido (la vuelta del pago o el email);
 * otro pedido, otra entidad o una firma mala responden lo mismo. El CIF o NIF se descifra aquí, en servidor, y no sale en ningún otro sitio.
 */
export default async function SponsorDocumentPage({ params, searchParams }: PageProps) {
  const { locale, orgSlug, kind } = await params;
  if (!isLocale(locale) || !isKind(kind)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'portal.sponsorDocs' });
  const query = await searchParams;
  const order = first(query.pedido);

  const documents = verifyCheckoutResult(getEnv().DATA_HMAC_SECRET, order, first(query.sig)) ? await getSponsorshipDocuments(getPrisma(), orgSlug, order) : null;
  if (!documents?.sponsor?.cifEnc) {
    return <EmptyState icon="🧾" title={t('invalid.title')} description={t('invalid.description')} headingLevel={1} role="alert" />;
  }
  const taxId = openSponsorTaxId(getKeyring(), { organizationId: documents.organizationId, cifEnc: documents.sponsor.cifEnc, cifKeyVersion: documents.sponsor.cifKeyVersion });
  // La razón social del emisor sale de la consola; si no está (o no es válida), el documento usa el nombre de la plataforma.
  const issuerName = await getSetting(getPrisma(), 'invoicing.issuerName').catch(() => undefined);
  return <SponsorDocument kind={kind} locale={locale} documents={documents} taxId={taxId} issuerName={issuerName} />;
}
