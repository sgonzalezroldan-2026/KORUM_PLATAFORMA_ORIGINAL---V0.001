import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { RegistrationWizard } from '@/components/auth/registration-wizard';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { siteUrl } from '@/lib/seo/marketing-routes';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';

// Página pública e indexable (ficha 3.2): los primeros euros exentos salen del motor de reglas y se regeneran cada 10 minutos.
export const revalidate = 600;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'registration' });
  return buildPageMetadata({ locale, path: '/registro-comunidad', title: t('metaTitle'), description: t('metaDescription'), imageAlt: t('metaTitle'), ogPage: 'home' });
}

export default async function RegisterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'registration' });
  const { pricing } = await getPublicPlatformConfig();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-3">
        <h1 className="font-joy text-3xl font-bold text-varsity-navy md:text-4xl">{t('title')}</h1>
        <p className="text-lg text-ink">{t('intro', { exempt: formatCents(pricing.exemptLimitCents, locale) })}</p>
        <p className="text-ink-soft">
          {t('haveAccount')}{' '}
          <Link href="/login" className="font-bold text-varsity-navy underline underline-offset-4">
            {t('login')}
          </Link>
        </p>
      </header>
      <section aria-label={t('formLabel')} className="korum-trust-vault p-5 md:p-8">
        <RegistrationWizard exemptLimitCents={pricing.exemptLimitCents} appHost={siteUrl().replace(/^https?:\/\//, '')} />
      </section>
    </div>
  );
}
