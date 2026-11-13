import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { BiFiltersForm } from '@/components/admin/bi-filters';
import { BiForecast } from '@/components/admin/bi-forecast';
import { BiInitiativesTables } from '@/components/admin/bi-initiatives-tables';
import { BiOrganizationsTable } from '@/components/admin/bi-organizations-table';
import { BiSummary } from '@/components/admin/bi-summary';
import { ConsoleSummary } from '@/components/admin/console-summary';
import { JobRuns, OpsAlerts } from '@/components/admin/ops-alerts';
import { PricingHealthPanel } from '@/components/admin/pricing-health-panel';
import { SplitsToResolve } from '@/components/admin/splits-to-resolve';
import { RevenueSourcesChart } from '@/components/admin/revenue-sources-chart';
import { CurrencyText } from '@/components/ui/currency-text';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPricingHealthForRequest } from '@/lib/console-pricing';
import { getPrisma } from '@/lib/prisma';
import { getConsoleBusiness, getConsoleOverview } from '@/repositories/console.repository';
import { parseBiFilters } from '@/services/admin/bi-snapshot';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin' });
  return { title: t('metaTitle') };
}

const SECTION = 'flex scroll-mt-4 flex-col gap-4';
const H2 = 'font-corp text-2xl font-extrabold text-varsity-navy';
const H3 = 'font-corp text-xl font-extrabold text-varsity-navy';

/**
 * Portada de la consola (Sprint 5.1): el negocio con lo real (libro mayor) y lo proyectado (campañas abiertas al 100 %) por separado, las
 * tablas ordenables con el diagnóstico 💎 / 🚨, y debajo lo que pide atención: alertas, salud de precios, tareas programadas y Fondos de actividades.
 */
export default async function AdminHomePage({ params, searchParams }: { params: Promise<{ locale: Locale }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const filters = parseBiFilters(await searchParams);
  const db = getPrisma();
  const [overview, business, pricing] = await Promise.all([getConsoleOverview(db, actor), getConsoleBusiness(db, actor, filters), getPricingHealthForRequest()]);
  const t = await getTranslations({ locale, namespace: 'admin' });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8">
      <div className="flex flex-col gap-4">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        {pricing.openCritical > 0 ? (
          <section aria-labelledby="pricing-banner" className="rounded-xl border-2 border-red-700 bg-red-50 p-4 text-red-950" data-testid="pricing-banner">
            <h2 id="pricing-banner" className="font-corp text-lg font-extrabold">
              <span aria-hidden="true">{'❗ '}</span>
              {t('pricingHealth.bannerTitle', { count: pricing.openCritical })}
            </h2>
            <p>
              {t('pricingHealth.bannerText')}{' '}
              <Link href="/admin#salud-de-precios" className="inline-flex min-h-11 items-center font-bold underline">
                {t('pricingHealth.bannerLink')}
              </Link>
            </p>
          </section>
        ) : null}
        <ConsoleSummary
          data={{
            openAlerts: overview.openAlerts,
            criticalAlerts: overview.criticalAlerts,
            boostCampaigns: business.initiatives.filter((row) => row.isProfitableSelfBoost).length,
            negativeCampaigns: business.initiatives.filter((row) => row.isNegativeReturnAlert).length,
            openPricingAlerts: pricing.open,
            filtered: Object.keys(business.filters).length > 0
          }}
        />
        <nav aria-label={t('nav.label')} className="flex flex-wrap gap-2">
          {(['negocio', 'avisos', 'repartos', 'salud-de-precios', 'procesos', 'fondos'] as const).map((anchor) => (
            <a key={anchor} href={`#${anchor}`} className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy/30 px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/5">
              {t(`nav.${anchor}`)}
            </a>
          ))}
          <Link href="/admin/entidades" className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy bg-varsity-navy px-4 font-semibold text-white hover:bg-varsity-navy-deep" data-testid="nav-entities">
            {t('nav.entities', { count: overview.pendingKyb })}
          </Link>
          <Link href="/admin/reglas" className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy bg-varsity-navy px-4 font-semibold text-white hover:bg-varsity-navy-deep" data-testid="nav-rules">
            {t('nav.rules')}
          </Link>
          <Link href="/admin/soporte" className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy bg-varsity-navy px-4 font-semibold text-white hover:bg-varsity-navy-deep" data-testid="nav-support">
            {t('nav.support', { count: overview.supportWaiting })}
          </Link>
          <Link href="/admin/ajustes" className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy bg-varsity-navy px-4 font-semibold text-white hover:bg-varsity-navy-deep" data-testid="nav-settings">
            {t('nav.settings')}
          </Link>
        </nav>
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
      </div>

      <section id="negocio" aria-labelledby="negocio-title" className={SECTION} data-testid="admin-business">
        <h2 id="negocio-title" className={H2}>
          {t('sections.business')}
        </h2>
        <BiFiltersForm options={business.options} filters={business.filters} />
        <BiSummary real={business.real} projection={business.projection} />
        <section aria-labelledby="sources-title" className="flex flex-col gap-2">
          <h3 id="sources-title" className={H3}>
            {t('sources.title')}
          </h3>
          <RevenueSourcesChart real={business.real} projection={business.projection} />
        </section>
        <section aria-labelledby="orgs-title" className="flex flex-col gap-2">
          <h3 id="orgs-title" className={H3}>
            {t('orgs.title')}
          </h3>
          <p className="text-sm text-ink-soft">{t('orgs.hint')}</p>
          <BiOrganizationsTable rows={business.organizations} />
        </section>
        <section aria-labelledby="forecast-title" className="flex flex-col gap-2">
          <h3 id="forecast-title" className={H3}>
            {t('forecast.title')}
          </h3>
          <BiForecast forecast={business.forecast} projection={business.projection} />
        </section>
        <div id="iniciativas" className="scroll-mt-4">
          <BiInitiativesTables rows={business.initiatives} truncated={business.truncated} />
        </div>
      </section>

      <section id="avisos" aria-labelledby="admin-alerts" className={SECTION}>
        <h2 id="admin-alerts" tabIndex={-1} className={H2}>
          {t('alertsTitle', { count: overview.openAlerts })}
        </h2>
        <OpsAlerts alerts={overview.alerts} openTotal={overview.openAlerts} locale={locale} />
      </section>

      <section id="repartos" aria-labelledby="splits-title" className={SECTION} data-testid="admin-splits">
        <h2 id="splits-title" tabIndex={-1} className={H2}>
          {t('splits.sectionTitle', { count: overview.splitsToResolve.length })}
        </h2>
        <p className="text-ink-soft">{t('splits.sectionIntro')}</p>
        <SplitsToResolve splits={overview.splitsToResolve} />
      </section>

      <section id="salud-de-precios" aria-labelledby="pricing-title" className={SECTION}>
        <h2 id="pricing-title" tabIndex={-1} className={H2}>
          {t('pricingHealth.title')}
        </h2>
        <p className="text-ink-soft">{t('pricingHealth.intro')}</p>
        <PricingHealthPanel alerts={pricing.alerts} />
      </section>

      <section id="procesos" aria-labelledby="jobs-title" className={SECTION}>
        <h2 id="jobs-title" className={H2}>
          {t('jobs.title')}
        </h2>
        <JobRuns jobs={overview.jobs} locale={locale} />
      </section>

      <section id="fondos" aria-labelledby="admin-funds" className={SECTION} data-testid="admin-funds">
        <h2 id="admin-funds" className={H2}>
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
    </div>
  );
}
