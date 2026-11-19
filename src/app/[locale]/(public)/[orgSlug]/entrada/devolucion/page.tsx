import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EventRefundForm } from '@/components/portal/event-refund-form';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { portalPath } from '@/lib/seo/portal-routes';
import { loadEventRefund } from '@/services/ticketing/event-refund-link.service';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
  searchParams: Promise<{ d?: string | string[] }>;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));

/** Depende del enlace de cada persona: nunca se genera ni se guarda en caché. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: isLocale(locale) ? locale : 'es', namespace: 'portal.eventRefund' });
  // El enlace es personal (devuelve el dinero de una persona): ni se indexa ni viaja en el `Referer`.
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/**
 * Devolución de las entradas tras un cambio de fecha (Sprint 5.13, decisión 30 del promotor; condiciones de entradas y vales, punto 3.6). Con `?d=` (el
 * enlace del aviso) enseña la fecha anterior y la nueva, cuánto se devolvería y hasta cuándo, y el botón para pedirlo. Si no se pide, la entrada vale para
 * la fecha nueva.
 */
export default async function EventRefundPage({ params, searchParams }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const [t, format, search] = await Promise.all([getTranslations({ locale, namespace: 'portal.eventRefund' }), getFormatter({ locale }), searchParams]);
  const token = first(search.d);
  const view = await loadEventRefund(getPrisma(), getEnv().DATA_HMAC_SECRET, orgSlug, token);
  const back = (
    <Link href={portalPath(orgSlug)} className="tactile-btn">
      {t('backToPortal')}
    </Link>
  );
  if (view.status === 'INVALID') {
    return <EmptyState icon="🎟️" title={t(token ? 'invalid.title' : 'noLink.title')} description={t(token ? 'invalid.description' : 'noLink.description')} headingLevel={1} role={token ? 'alert' : undefined} action={back} />;
  }

  const dateOf = (at: Date) => format.dateTime(at, { dateStyle: 'full', timeZone: 'Europe/Madrid' });
  const until = format.dateTime(view.refundUntil, { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' });
  if (view.status !== 'OPEN') {
    const key = view.status === 'CANCELLED' ? 'cancelled' : view.status === 'REQUESTED' ? 'requested' : 'closed';
    return <EmptyState icon={view.status === 'REQUESTED' ? '↩️' : '🎟️'} title={t(`${key}.title`)} description={t(`${key}.description`, { title: view.title, date: dateOf(view.newDate) })} headingLevel={1} action={back} />;
  }

  return (
    <section className="mobile-stack mx-auto flex max-w-xl flex-col gap-4 px-4 py-8" aria-labelledby="event-refund-title">
      <header className="flex flex-col gap-2">
        <h1 id="event-refund-title" className="font-joy text-3xl font-bold wrap-anywhere text-varsity-navy">
          {t('title', { title: view.title })}
        </h1>
        <p className="text-ink-soft">{t('intro', { organization: view.organizationName })}</p>
      </header>
      <dl className="korum-trust-vault grid grid-cols-1 gap-2 rounded-2xl border-2 border-varsity-navy bg-white p-4">
        <div>
          <dt className="text-sm text-ink-soft">{t('previousDate')}</dt>
          <dd className="font-semibold">{dateOf(view.previousDate)}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-soft">{t('newDate')}</dt>
          <dd className="font-semibold">{dateOf(view.newDate)}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-soft">{t('amount')}</dt>
          <dd className="font-corp text-xl font-extrabold tabular-nums">{formatCents(view.refundableCents, locale)}</dd>
        </div>
      </dl>
      <ul className="flex list-disc flex-col gap-1 ps-6 text-sm text-varsity-navy">
        <li>{t('rules.keep')}</li>
        <li>{t('rules.refund', { date: until })}</li>
        <li>{t('rules.how')}</li>
        {view.usedPurchases > 0 ? <li>{t('rules.used', { count: view.usedPurchases })}</li> : null}
      </ul>
      <EventRefundForm orgSlug={orgSlug} token={token} amountLabel={formatCents(view.refundableCents, locale)} />
      <p className="font-corp text-sm tabular-nums text-ink-soft">{t('legal', { wallet: view.walletEscrowId })}</p>
    </section>
  );
}
