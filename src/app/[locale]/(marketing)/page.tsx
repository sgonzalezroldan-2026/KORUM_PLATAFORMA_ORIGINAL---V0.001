import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { KorumMark } from '@/components/brand/korum-mark';
import { TrustBadge } from '@/components/ui/trust-badge';
import { routing } from '@/i18n/routing';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`;

  return {
    alternates: {
      canonical: prefix || '/',
      languages: { es: '/', ca: '/ca', en: '/en', 'x-default': '/' }
    }
  };
}

/** Portada base del Entorno 0. La landing completa (buscador, calculadora y páginas pilar) llega en el Sprint 3.1. */
export default async function HomePage({ params }: PageProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('home');

  return (
    <div className="korum-paper-dots">
      <section className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-4 py-16 text-center sm:py-24">
        <KorumMark size={112} />
        <p className="font-corp text-sm font-bold uppercase tracking-[0.18em] text-varsity-emerald">{t('eyebrow')}</p>
        <h1 className="font-joy text-4xl font-bold leading-tight text-varsity-navy sm:text-5xl">{t('title')}</h1>
        <p className="max-w-2xl text-lg text-ink-soft">{t('subtitle')}</p>
        <ul className="mt-4 flex flex-wrap justify-center gap-3">
          <li>
            <TrustBadge icon="🛡️" tone="emerald">
              {t('badgeRefund')}
            </TrustBadge>
          </li>
          <li>
            <TrustBadge icon="🤝">{t('badgeProvider')}</TrustBadge>
          </li>
          <li>
            <TrustBadge icon="💳">{t('badgePayments')}</TrustBadge>
          </li>
        </ul>
      </section>
    </div>
  );
}
