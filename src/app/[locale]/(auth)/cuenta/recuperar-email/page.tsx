import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EmailRevertForm } from '@/components/auth/email-revert-form';
import { routing } from '@/i18n/routing';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'auth.emailRevert' });
  // `no-referrer`: si alguien pulsa un enlace de esta página, el destino no recibe ni la ruta.
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/** «No he sido yo» (Sprint 5.10b): devuelve el email anterior de una cuenta desde el enlace del aviso que recibió ese email. */
export default async function EmailRevertPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'auth.emailRevert' });
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10">
      <section aria-labelledby="email-revert-title" className="korum-trust-vault flex flex-col gap-4 p-6">
        <h1 id="email-revert-title" className="font-corp text-3xl font-extrabold text-varsity-navy">
          {t('title')}
        </h1>
        <EmailRevertForm />
      </section>
    </div>
  );
}
