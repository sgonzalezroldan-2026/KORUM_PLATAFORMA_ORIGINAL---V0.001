import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { SponsorRenewalForm } from '@/components/checkout/sponsor-renewal-form';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { signCheckoutResult, verifyCheckoutResult } from '@/core/checkout/checkout-rules';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { sponsorDocumentPath, sponsorsPath } from '@/lib/seo/portal-routes';
import { loadRenewalOffer, loadRenewalResult } from '@/services/checkout/sponsor-renewal.service';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
  searchParams: Promise<{ r?: string | string[]; pedido?: string | string[]; sig?: string | string[] }>;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));

/** Depende del enlace de cada comercio: nunca se genera ni se guarda en caché (el `layout` del portal regenera cada 60 s). */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: isLocale(locale) ? locale : 'es', namespace: 'portal.sponsorRenewal' });
  // El enlace es personal (lleva la renovación de un comercio): ni se indexa ni viaja en el `Referer`.
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/**
 * Renovación anual de un comercio amigo (Sprint 4.2d, `function simulateSponsorAutomaticRenewal` del prototipo, que aquí se paga de verdad). Con `?r=` (el
 * enlace del email) enseña el importe y lleva a la página de pago; con `?pedido=&sig=` (la vuelta de Paycomet) dice cómo ha ido. Lee la URL: dinámica.
 */
export default async function SponsorRenewalPage({ params, searchParams }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'portal.sponsorRenewal' }), getFormatter({ locale })]);
  const search = await searchParams;
  const secret = getEnv().DATA_HMAC_SECRET;
  const date = (value: Date | string) => format.dateTime(new Date(value), { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  const order = first(search.pedido);

  if (order) {
    const result = verifyCheckoutResult(secret, order, first(search.sig)) ? await loadRenewalResult(getPrisma(), orgSlug, order) : null;
    if (!result?.sponsor) return <EmptyState icon="🧾" title={t('invalid.title')} description={t('invalid.description')} headingLevel={1} role="alert" />;
    const done = result.status === 'COMPLETED';
    const failed = result.status === 'FAILED';
    // Segundo pago de la misma renovación (dos pestañas): se devuelve entero; el email «Devolución realizada» llega al ejecutarse.
    if (result.status === 'REFUND_PENDING' || result.status === 'REFUNDED') {
      return <EmptyState icon="↩️" title={t('result.duplicateTitle')} description={t('result.duplicate')} headingLevel={1} action={<Link href={sponsorsPath(orgSlug)} className="tactile-btn">{t('result.directory')}</Link>} />;
    }
    const documents = `${sponsorDocumentPath(orgSlug, 'justificante')}?${new URLSearchParams({ pedido: order, sig: signCheckoutResult(secret, order) }).toString()}`;
    return (
      <EmptyState
        icon={done ? '🎉' : failed ? '⚠️' : '⏳'}
        title={t(done ? 'result.doneTitle' : failed ? 'result.failedTitle' : 'result.pendingTitle')}
        description={done ? t('result.done', { name: result.sponsor.name, date: date(result.sponsor.expiresAt) }) : t(failed ? 'result.failed' : 'result.pending')}
        headingLevel={1}
        playful={done}
        action={
          done ? (
            <Link href={documents} className="tactile-btn">
              {t('result.documents')}
            </Link>
          ) : (
            <Link href={sponsorsPath(orgSlug)} className="tactile-btn">
              {t('result.directory')}
            </Link>
          )
        }
      />
    );
  }

  const offer = await loadRenewalOffer(getPrisma(), secret, orgSlug, first(search.r));
  if (offer.status !== 'OK') {
    return (
      <EmptyState
        icon={offer.status === 'RENEWED' ? '✅' : '🧾'}
        title={t(`${offer.status === 'RENEWED' ? 'renewed' : offer.status === 'EXPIRED' ? 'expired' : 'invalid'}.title`)}
        description={t(`${offer.status === 'RENEWED' ? 'renewed' : offer.status === 'EXPIRED' ? 'expired' : 'invalid'}.description`)}
        headingLevel={1}
        role={offer.status === 'RENEWED' ? undefined : 'alert'}
        action={
          <Link href={sponsorsPath(orgSlug)} className="tactile-btn">
            {t('result.directory')}
          </Link>
        }
      />
    );
  }

  return (
    <section className="mobile-stack mx-auto flex max-w-xl flex-col gap-4 px-4 py-8" aria-labelledby="renewal-title">
      <header className="flex flex-col gap-1">
        <h1 id="renewal-title" className="font-joy text-3xl font-bold wrap-anywhere text-varsity-navy">
          {t('title', { name: offer.name })}
        </h1>
        <p className="text-ink-soft">{t('intro', { organization: offer.organizationName, level: t(`levels.${offer.level}`), date: date(offer.newExpiresAt) })}</p>
      </header>
      <dl className="korum-trust-vault grid grid-cols-[1fr_auto] gap-2 p-4 tabular-nums">
        <dt className="font-bold text-ink-soft">{t('amount')}</dt>
        <dd className="text-end">
          <CurrencyText cents={offer.amountCents} className="font-extrabold text-varsity-emerald" />
        </dd>
        <dt className="font-bold text-ink-soft">{t('fee')}</dt>
        <dd className="text-end">
          <CurrencyText cents={offer.feeCents} />
        </dd>
        <dt className="font-bold text-ink-soft">{t('vat')}</dt>
        <dd className="text-end">
          <CurrencyText cents={offer.vatCents} />
        </dd>
        <dt className="border-t-2 border-varsity-navy/20 pt-2 font-extrabold text-varsity-navy">{t('total')}</dt>
        <dd className="border-t-2 border-varsity-navy/20 pt-2 text-end">
          <CurrencyText cents={offer.totalCents} className="text-lg font-extrabold text-varsity-navy" />
        </dd>
      </dl>
      <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{t(`destination.${offer.rule}`)}</p>
      <SponsorRenewalForm orgSlug={orgSlug} token={first(search.r)} totalLabel={formatCents(offer.totalCents, locale)} />
      <p className="text-sm text-ink-soft">{t('legal')}</p>
    </section>
  );
}
