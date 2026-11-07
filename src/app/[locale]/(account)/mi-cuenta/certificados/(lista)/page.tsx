import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { requireSession } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { AccountNotFoundError, listDonationDocuments } from '@/repositories/account.repository';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'account.documents' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/**
 * Certificados fiscales y justificantes de donación por ejercicio (Sprint 3.7; el email `tax.certificateReady` de enero enlaza aquí). Solo
 * donaciones completadas y sin devolución: las entradas y las recargas nunca dan documento (Regla 02 §8). El certificado exige la Ley 49/2002
 * verificada y el NIF y el nombre del donante; si no, justificante nominativo sin efectos fiscales.
 */
export default async function DocumentsPage({ params }: Params) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const session = await requireSession(locale, localizedPath(locale, '/mi-cuenta/certificados'));
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'account.documents' }), getFormatter({ locale })]);

  let years;
  try {
    years = await listDonationDocuments(getPrisma(), session.userId);
  } catch (error) {
    if (error instanceof AccountNotFoundError) notFound();
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/mi-cuenta" className="inline-flex min-h-11 items-center gap-1 self-start font-semibold text-varsity-navy underline underline-offset-4">
        <span aria-hidden="true">{'← '}</span>
        {t('back')}
      </Link>
      <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
      <p className="text-ink-soft">{t('intro')}</p>
      {years.length === 0 ? (
        <EmptyState icon="🧾" title={t('emptyTitle')} description={t('emptyText')} action={<Link href="/mi-cuenta" className="tactile-btn">{t('back')}</Link>} />
      ) : (
        years.map(({ fiscalYear, items }) => (
          <section key={fiscalYear} aria-labelledby={`year-${fiscalYear}`} className="korum-trust-vault flex flex-col gap-3 p-5">
            <h2 id={`year-${fiscalYear}`} className="font-corp text-2xl font-extrabold text-varsity-navy">
              {t('year', { year: fiscalYear })}
            </h2>
            <ul className="flex flex-col divide-y divide-varsity-navy/10">
              {items.map((item) => (
                <li key={item.id} className="mobile-stack grid gap-2 py-3 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="min-w-0">
                    <p className="font-bold text-varsity-navy">{item.organizationName}</p>
                    <p className="text-sm text-ink-soft">{t('line', { initiative: item.initiativeTitle, date: format.dateTime(item.createdAt, { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) })}</p>
                    <p className="text-sm font-semibold text-varsity-navy">{t(`kind.${item.kind}`)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 md:justify-end">
                    <CurrencyText cents={item.amountCents} className="text-lg font-extrabold text-varsity-navy" />
                    <Link href={`/mi-cuenta/certificados/${item.id}`} className="tactile-btn">
                      {t('openOne')}
                      {/* El nombre accesible empieza por el texto visible (WCAG 2.5.3) y dice de qué donación es: hay un botón igual por fila. */}
                      {' '}
                      <span className="sr-only">{`· ${item.initiativeTitle} (${formatCents(item.amountCents, locale)})`}</span>
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
