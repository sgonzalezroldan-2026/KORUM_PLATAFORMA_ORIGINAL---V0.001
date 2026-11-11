import { useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import type { BiProjection, BiQuarterForecast } from '@/core/finance/bi-summary';
import { quarterParts } from './quarter-label';

/** Previsión de cierres por trimestre de las campañas abiertas, sin ponderar y ponderada por el avance, más el consolidado. */
export function BiForecast({ forecast, projection }: { forecast: BiQuarterForecast[]; projection: BiProjection }) {
  const t = useTranslations('admin.forecast');
  const ta = useTranslations('admin');

  return (
    <div className="mobile-stack grid gap-4 md:grid-cols-3" data-testid="forecast">
      {forecast.length === 0 ? <p className="text-ink-soft md:col-span-2">{t('none')}</p> : null}
      {forecast.map((quarter) => (
        <article key={quarter.quarter} className="korum-trust-vault flex flex-col gap-2 p-4" data-quarter={quarter.quarter}>
          <h4 className="font-corp text-lg font-extrabold text-varsity-navy">{t('quarterTitle', { quarter: quarterParts(quarter.quarter) ? ta('quarterLabel', quarterParts(quarter.quarter)!) : quarter.quarter })}</h4>
          <p className="text-sm text-ink-soft">{t('count', { count: quarter.count })}</p>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt>{t('goal')}</dt>
              <dd className="font-bold">
                <CurrencyText cents={quarter.goalCents} />
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>{t('unweighted')}</dt>
              <dd className="font-bold">
                <CurrencyText cents={quarter.unweightedNetCents} />
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>{t('weighted')}</dt>
              <dd className="font-bold text-varsity-emerald">
                <CurrencyText cents={quarter.weightedNetCents} />
              </dd>
            </div>
          </dl>
        </article>
      ))}
      <article className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-navy bg-varsity-navy p-4 text-varsity-ivory" data-testid="forecast-total">
        <h4 className="font-corp text-lg font-extrabold">{t('totalTitle')}</h4>
        <p className="text-sm">
          {t('totalUnweighted')} <CurrencyText cents={projection.kpis.expectedNetCents} className="font-extrabold" />
        </p>
        <p className="font-corp text-xl font-extrabold text-varsity-gold">
          {t('totalWeighted')} <CurrencyText cents={projection.kpis.weightedNetCents} />
        </p>
      </article>
    </div>
  );
}
