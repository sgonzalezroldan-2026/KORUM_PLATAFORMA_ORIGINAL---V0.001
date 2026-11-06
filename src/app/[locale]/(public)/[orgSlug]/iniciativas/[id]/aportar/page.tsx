import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CheckoutModal } from '@/components/checkout/checkout-modal';
import { InitiativeDetail } from '@/components/portal/initiative-detail';
import { isLocale } from '@/i18n/routing';
import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { INITIATIVE_ID_PATTERN, initiativePath } from '@/lib/seo/portal-routes';
import { getCheckoutContext } from '@/repositories/checkout.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { buildCheckoutOffer } from '@/services/checkout/checkout-offer';
import { loadInitiativePage, loadPortalOrganization } from '@/services/portal/portal-data';
import { startCheckoutAction } from './actions';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string; id: string }>;
  searchParams: Promise<{ grupo?: string | string[]; reintento?: string | string[]; metodo?: string | string[]; importe?: string | string[]; aportacion?: string | string[]; cantidad?: string | string[] }>;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
/** Entero positivo pequeño de la URL de reintento, o `null`: solo propone valores, el servidor los vuelve a validar al pagar. */
const hintNumber = (value: string | string[] | undefined): number | null => (/^\d{1,7}$/.test(first(value)) ? Number(first(value)) : null);

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, orgSlug, id } = await params;
  if (!isLocale(locale) || !INITIATIVE_ID_PATTERN.test(id)) return {};
  let page;
  try {
    page = await loadInitiativePage(orgSlug, Number(id), locale, '');
  } catch (error) {
    // `generateMetadata` corre a la vez que el `layout`: una iniciativa inexistente es un 404 aquí también, nunca un 500 (skill de interfaz §5).
    if (error instanceof ResourceNotFoundError) notFound();
    throw error;
  }
  const t = await getTranslations({ locale, namespace: 'portal.checkout' });
  // El pago no se indexa nunca y su canónica es la ficha (skill de SEO: checkout con `noindex`).
  return { title: t('metaTitle', { title: page.title }), robots: { index: false, follow: false }, alternates: { canonical: absoluteUrl(locale, initiativePath(orgSlug, Number(id))) } };
}

/**
 * Checkout de una iniciativa (`/[orgSlug]/iniciativas/[id]/aportar`): la misma ficha con el pago abierto encima. Así funcionan los enlaces de
 * «Aportar» de la portada y de la ficha, un enlace compartido o recargar la página; al cerrar el pago se vuelve a la ficha. Página dinámica:
 * depende de la sesión (con ella no se pide el email) y de `?reintento=` (recuperar lo elegido tras un pago rechazado).
 */
export default async function CheckoutPage({ params, searchParams }: PageProps) {
  const { locale, orgSlug, id } = await params;
  if (!isLocale(locale) || !INITIATIVE_ID_PATTERN.test(id)) notFound();
  setRequestLocale(locale);
  const query = await searchParams;
  const initiativeId = Number(id);
  const requested = first(query.grupo).slice(0, 60);

  let loaded;
  try {
    loaded = await Promise.all([loadPortalOrganization(orgSlug), loadInitiativePage(orgSlug, initiativeId, locale, requested), getCheckoutContext(getPrisma(), orgSlug, initiativeId), getAuthSession()]);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) notFound();
    throw error;
  }
  const [organization, page, context, session] = loaded;
  const method = first(query.metodo);
  const offer = buildCheckoutOffer({ orgSlug, title: page.title, contentLang: page.contentLang, detail: page.detail, context, requestedGroup: requested, sessionEmail: session?.email ?? null, now: new Date() });

  return (
    <>
      <InitiativeDetail
        orgSlug={orgSlug}
        entityName={organization.name}
        vertical={organization.vertical}
        detail={page.detail}
        shareUrl={absoluteUrl(locale, initiativePath(orgSlug, initiativeId))}
        groups={page.groups}
        contentLang={page.contentLang}
      />
      <CheckoutModal offer={offer} restore={first(query.reintento) === '1'} restoreMethod={method === 'CARD' || method === 'BIZUM' ? method : null}
        retryHint={{ amountCents: hintNumber(query.importe), guaranteeCents: hintNumber(query.aportacion), quantity: hintNumber(query.cantidad) }}
        startAction={startCheckoutAction} />
    </>
  );
}
