import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { getConsoleOverview } from '@/repositories/console.repository';

const SEVERITY_STYLE = { CRITICAL: 'bg-red-100 text-red-900', WARNING: 'bg-amber-100 text-amber-900', INFO: 'bg-slate-100 text-slate-800' } as const;

/** Portada de la consola: entidades, KYB pendientes y la bandeja de alertas abiertas (incluidos los emails que no salen). */
export default async function AdminHomePage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const overview = await getConsoleOverview(getPrisma(), actor);
  const t = await getTranslations({ locale, namespace: 'admin' });
  const format = await getFormatter({ locale });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
      <dl className="mobile-stack grid gap-4 md:grid-cols-2">
        <div className="korum-trust-vault p-5">
          <dt className="font-semibold text-ink-soft">{t('organizations')}</dt>
          <dd className="font-corp text-3xl font-extrabold tabular-nums text-varsity-navy">{overview.organizations}</dd>
        </div>
        <div className="korum-trust-vault p-5">
          <dt className="font-semibold text-ink-soft">{t('pendingKyb')}</dt>
          <dd className="font-corp text-3xl font-extrabold tabular-nums text-varsity-navy">{overview.pendingKyb}</dd>
        </div>
      </dl>
      <section aria-labelledby="admin-funds" className="flex flex-col gap-3" data-testid="admin-funds">
        <h2 id="admin-funds" className="font-corp text-xl font-extrabold text-varsity-navy">
          {t('fundsTitle', { count: overview.activityFunds.length })}
        </h2>
        {overview.activityFunds.length === 0 ? (
          <p className="text-ink-soft">{t('fundsNone')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {overview.activityFunds.map((fund) => (
              <li key={fund.slug} className="flex flex-col gap-1 rounded-xl border-2 border-varsity-navy/15 bg-white p-3 md:flex-row md:items-center md:justify-between">
                <span className="font-bold text-varsity-navy">{fund.name}</span>
                <span className="flex flex-wrap items-center gap-3 text-sm">
                  <CurrencyText cents={fund.balanceCents} className="font-extrabold text-varsity-navy" />
                  <span className="text-ink-soft">{fund.openPayout ? t(`fundPayout.${fund.openPayout.status}`) : t('fundPayout.NONE')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="admin-alerts" className="flex flex-col gap-3">
        <h2 id="admin-alerts" className="font-corp text-xl font-extrabold text-varsity-navy">
          {t('alertsTitle', { count: overview.alerts.length })}
        </h2>
        {overview.alerts.length === 0 ? (
          <EmptyState title={t('noAlertsTitle')} description={t('noAlertsText')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {overview.alerts.map((alert) => (
              <li key={alert.id} className="flex flex-col gap-1 rounded-xl border-2 border-varsity-navy/15 bg-white p-3 md:flex-row md:items-center md:justify-between">
                <span className="font-bold text-varsity-navy">
                  <span className={`me-2 rounded-full px-2 py-0.5 text-xs font-extrabold ${SEVERITY_STYLE[alert.severity]}`}>{t(`severity.${alert.severity}`)}</span>
                  {t(`alertType.${alert.type}`)}
                  {alert.organization ? ` · ${alert.organization.name}` : ''}
                </span>
                <span className="text-sm text-ink-soft">{t('alertMeta', { count: alert.occurrences, date: format.dateTime(alert.lastSeenAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
