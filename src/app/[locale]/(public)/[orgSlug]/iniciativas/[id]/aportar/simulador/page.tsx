import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { SimulatorButtons } from '@/components/checkout/simulator-buttons';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { verifyPaymentSimulator } from '@/core/checkout/checkout-rules';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { INITIATIVE_ID_PATTERN } from '@/lib/seo/portal-routes';
import { getSimulatedPayment } from '@/repositories/checkout.repository';
import { settleSimulatedPaymentAction } from '../actions';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: isLocale(locale) ? locale : 'es', namespace: 'portal.simulator' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string; id: string }>;
  searchParams: Promise<{ pedido?: string | string[]; sig?: string | string[] }>;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));

/**
 * Página de pago simulada (`PAYCOMET_MODE=mock`): sustituye a la de Paycomet mientras no hay cobros reales. Con `sandbox` o `live` no existe
 * (404). Solo enseña el importe y la forma de pago, nada de la persona.
 */
export default async function PaymentSimulatorPage({ params, searchParams }: PageProps) {
  const { locale, orgSlug, id } = await params;
  const env = getEnv();
  if (env.PAYCOMET_MODE !== 'mock' || !isLocale(locale) || !INITIATIVE_ID_PATTERN.test(id)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'portal.simulator' });
  const query = await searchParams;
  const order = first(query.pedido);
  const signature = first(query.sig);
  const initiativeId = Number(id);

  const payment = verifyPaymentSimulator(env.DATA_HMAC_SECRET, order, signature) ? await getSimulatedPayment(getPrisma(), orgSlug, initiativeId, order) : null;
  if (!payment || payment.status !== 'PENDING') {
    return <EmptyState icon="🧪" title={t('invalid.title')} description={t('invalid.description')} headingLevel={1} role="alert" />;
  }

  return (
    <section className="korum-trust-vault mx-auto max-w-md space-y-4 p-6" aria-labelledby="simulator-title">
      <h1 id="simulator-title" className="font-corp text-xl font-extrabold text-varsity-navy">
        <span aria-hidden="true">{'🧪 '}</span>
        {t('title')}
      </h1>
      <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-950">{t('intro')}</p>
      <dl className="grid grid-cols-2 gap-2 rounded-2xl bg-patio-cream p-4">
        <dt className="font-bold text-ink-soft">{t('amount')}</dt>
        <dd className="text-end">
          <CurrencyText cents={payment.totalChargedCents} className="text-lg font-extrabold text-varsity-navy" />
        </dd>
        <dt className="font-bold text-ink-soft">{t('method')}</dt>
        <dd className="text-end font-extrabold text-varsity-navy">{t(`methods.${payment.paymentMethod === 'BIZUM' ? 'BIZUM' : 'CARD'}`)}</dd>
      </dl>
      <SimulatorButtons orgSlug={orgSlug} initiativeId={initiativeId} order={order} signature={signature} settle={settleSimulatedPaymentAction} />
    </section>
  );
}
