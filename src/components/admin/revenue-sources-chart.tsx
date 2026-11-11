import { useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import type { BiProjection, BiRealRevenue } from '@/core/finance/bi-summary';
import { REVENUE_SOURCE_KEYS, type RevenueSourceKey } from '@/core/finance/bi-analytics.service';

const SOURCE_ICON: Record<RevenueSourceKey, string> = {
  supportGuaranteeCents: '🛡️',
  bracketFeeCents: '🏗️',
  sponsorFeeCents: '🏪',
  digitalTicketFeeCents: '🎟️',
  maintFeeCents: '⚙️',
  huchaTopupFeeCents: '🐷'
};

/** Orden del prototipo (`renderRevenueSourcesChartInto`): primero la garantía voluntaria y los tramos. */
const SOURCE_ORDER: readonly RevenueSourceKey[] = ['supportGuaranteeCents', 'bracketFeeCents', 'sponsorFeeCents', 'digitalTicketFeeCents', 'maintFeeCents', 'huchaTopupFeeCents'];

/** Anchura de la barra en % del mayor de los dos totales (mínimo visible 2 %, solo para que una barra con dinero no desaparezca). */
function barWidth(cents: number, maxCents: number): number {
  if (cents <= 0 || maxCents <= 0) return 0;
  return Math.max(2, Math.round((cents * 100) / maxCents));
}

function Bar({ cents, maxCents, tone }: { cents: number; maxCents: number; tone: string }) {
  return (
    <span aria-hidden="true" className="mt-1 block h-2.5 w-full overflow-hidden rounded-full bg-patio-rule">
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${barWidth(cents, maxCents)}%` }} />
    </span>
  );
}

/**
 * Procedencia de los ingresos de KORUM en sus 6 fuentes: lo cobrado de verdad (libro mayor) y lo que se espera de las campañas abiertas al
 * 100 %. Cada columna suma al céntimo: `Σ 6 fuentes − costes = neto`. Es una tabla (los importes son texto); las barras solo ayudan a verlo.
 */
export function RevenueSourcesChart({ real, projection }: { real: BiRealRevenue; projection: BiProjection }) {
  const t = useTranslations('admin.sources');
  const maxCents = Math.max(...REVENUE_SOURCE_KEYS.flatMap((key) => [real.sourcesCents[key], projection.sourcesCents[key]]), 0);
  const realCosts = real.gatewayNetCostCents + real.autoBoostExpenseCents + real.chargebackLossesCents;

  return (
    <div className="korum-trust-vault flex flex-col gap-3 p-4 md:p-6" data-testid="revenue-sources">
      <p className="text-sm text-ink-soft">{t('intro')}</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('regionLabel')}>
        <table className="w-full border-collapse text-start">
          <caption className="sr-only">{t('caption')}</caption>
          <thead>
            <tr className="border-b-2 border-varsity-navy/20 text-sm">
              <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
                {t('source')}
              </th>
              <th scope="col" className="px-2 py-2 text-end font-corp font-bold">
                {t('real')}
              </th>
              <th scope="col" className="px-2 py-2 text-end font-corp font-bold">
                {t('projected')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-patio-rule">
            {SOURCE_ORDER.map((key) => (
              <tr key={key} data-source={key}>
                <th scope="row" className="px-2 py-2 text-start font-semibold">
                  <span aria-hidden="true">{`${SOURCE_ICON[key]} `}</span>
                  {t(`label.${key}`)}
                </th>
                <td className="w-[27%] px-2 py-2 text-end align-top">
                  <CurrencyText cents={real.sourcesCents[key]} className="font-bold" />
                  <Bar cents={real.sourcesCents[key]} maxCents={maxCents} tone="bg-varsity-emerald" />
                </td>
                <td className="w-[27%] px-2 py-2 text-end align-top">
                  <CurrencyText cents={projection.sourcesCents[key]} className="font-bold" />
                  <Bar cents={projection.sourcesCents[key]} maxCents={maxCents} tone="bg-varsity-gold" />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-varsity-navy/20">
            <tr data-row="sources-total">
              <th scope="row" className="px-2 py-2 text-start font-bold">
                {t('sourcesTotal')}
              </th>
              <td className="px-2 py-2 text-end">
                <CurrencyText cents={real.sourcesTotalCents} className="font-bold" />
              </td>
              <td className="px-2 py-2 text-end">
                <CurrencyText cents={projection.sourcesTotalCents} className="font-bold" />
              </td>
            </tr>
            <tr>
              <th scope="row" className="px-2 py-1 text-start font-semibold text-ink-soft">
                {t('cost.gateway')}
              </th>
              <td className="px-2 py-1 text-end text-ink-soft">
                <CurrencyText cents={-real.gatewayNetCostCents} />
              </td>
              <td className="px-2 py-1 text-end text-ink-soft">
                <CurrencyText cents={-projection.gatewayLossCents} />
              </td>
            </tr>
            <tr>
              <th scope="row" className="px-2 py-1 text-start font-semibold text-ink-soft">
                {t('cost.autoBoost')}
              </th>
              <td className="px-2 py-1 text-end text-ink-soft">
                <CurrencyText cents={-real.autoBoostExpenseCents} />
              </td>
              <td className="px-2 py-1 text-end text-ink-soft">{t('notProjected')}</td>
            </tr>
            <tr>
              <th scope="row" className="px-2 py-1 text-start font-semibold text-ink-soft">
                {t('cost.chargebacks')}
              </th>
              <td className="px-2 py-1 text-end text-ink-soft">
                <CurrencyText cents={-real.chargebackLossesCents} />
              </td>
              <td className="px-2 py-1 text-end text-ink-soft">{t('notProjected')}</td>
            </tr>
            <tr data-row="net" className="border-t border-varsity-navy/20">
              <th scope="row" className="px-2 py-2 text-start font-corp font-extrabold text-varsity-navy">
                {t('net')}
              </th>
              <td className={`px-2 py-2 text-end font-extrabold ${realCosts > real.sourcesTotalCents ? 'text-red-800' : 'text-varsity-navy'}`} data-testid="sources-net-real">
                <CurrencyText cents={real.netRevenueCents} />
              </td>
              <td className={`px-2 py-2 text-end font-extrabold ${projection.netRevenueCents < 0 ? 'text-red-800' : 'text-varsity-navy'}`} data-testid="sources-net-projected">
                <CurrencyText cents={projection.netRevenueCents} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
