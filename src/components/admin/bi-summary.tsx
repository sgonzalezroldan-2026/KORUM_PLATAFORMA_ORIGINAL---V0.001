import { useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import type { BiProjection, BiRealRevenue } from '@/core/finance/bi-summary';

const CARD = 'korum-trust-vault flex flex-col gap-1 p-4';

/**
 * Lo real y lo proyectado, en dos bloques con su propio titular y nunca mezclados (Regla 02 §10): el primero sale del libro mayor y solo
 * cuenta lo ya cobrado; el segundo, de las campañas abiertas al 100 %.
 */
export function BiSummary({ real, projection }: { real: BiRealRevenue; projection: BiProjection }) {
  const t = useTranslations('admin.kpi');
  const { kpis } = projection;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="kpi-real" className="flex flex-col gap-2" data-testid="kpi-real">
        <h3 id="kpi-real" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('realTitle')}
        </h3>
        <p className="text-sm text-ink-soft">{t('realHelp')}</p>
        <dl className="mobile-stack grid gap-4 md:grid-cols-3">
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('realSources')}</dt>
            <dd className="font-corp text-2xl font-extrabold text-varsity-navy">
              <CurrencyText cents={real.sourcesTotalCents} />
            </dd>
          </div>
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('realCosts')}</dt>
            <dd className="font-corp text-2xl font-extrabold text-varsity-navy">
              <CurrencyText cents={-(real.gatewayNetCostCents + real.autoBoostExpenseCents + real.chargebackLossesCents)} />
            </dd>
          </div>
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('realNet')}</dt>
            <dd className={`font-corp text-2xl font-extrabold ${real.netRevenueCents < 0 ? 'text-red-800' : 'text-varsity-emerald'}`} data-testid="kpi-real-net">
              <CurrencyText cents={real.netRevenueCents} />
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="kpi-projection" className="flex flex-col gap-2" data-testid="kpi-projection">
        <h3 id="kpi-projection" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('projectionTitle')}
        </h3>
        <p className="text-sm text-ink-soft">{t('projectionHelp')}</p>
        <dl className="mobile-stack grid gap-4 md:grid-cols-5">
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('potentialGoal')}</dt>
            <dd className="font-corp text-xl font-extrabold text-varsity-navy">
              <CurrencyText cents={kpis.potentialGoalCents} />
            </dd>
          </div>
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('raised')}</dt>
            <dd className="font-corp text-xl font-extrabold text-varsity-emerald">
              <CurrencyText cents={kpis.raisedCents} />
            </dd>
          </div>
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('expectedNet')}</dt>
            <dd className={`font-corp text-xl font-extrabold ${kpis.expectedNetCents < 0 ? 'text-red-800' : 'text-varsity-navy'}`} data-testid="kpi-expected-net">
              <CurrencyText cents={kpis.expectedNetCents} />
            </dd>
          </div>
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('weightedNet')}</dt>
            <dd className={`font-corp text-xl font-extrabold ${kpis.weightedNetCents < 0 ? 'text-red-800' : 'text-varsity-navy'}`}>
              <CurrencyText cents={kpis.weightedNetCents} />
            </dd>
          </div>
          <div className={CARD}>
            <dt className="text-sm font-semibold text-ink-soft">{t('averageProgress')}</dt>
            <dd className="font-corp text-xl font-extrabold tabular-nums text-varsity-navy">{t('percent', { value: kpis.averageProgressPct })}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
