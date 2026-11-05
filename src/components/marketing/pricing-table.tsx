import { getTranslations } from 'next-intl/server';
import type { PublicPricing } from '@/core/finance/public-pricing';
import type { Locale } from '@/i18n/routing';
import { fillTokens, pricingTokens } from '@/lib/seo/pricing-tokens';

/**
 * Tabla de tarifas de `/precios`. Todo sale de `GlobalConfig` (vía `pricingTokens`): la fila de comisión describe el modo de tramos vigente y la de
 * mantenimiento dice «sin cuota» mientras esté apagado. Los textos van en `marketing.pricing` con marcas `{exempt}`, `{t1Rate}`…
 */
export async function PricingTable({ pricing, locale }: { pricing: PublicPricing; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'marketing.pricing' });
  const tokens = pricingTokens(pricing, locale);
  const text = (key: string) => fillTokens(String(t.raw(key)), tokens);

  const rows: Array<[label: string, value: string]> = [
    [text('exemptLabel'), text('exemptValue')],
    [text('tier1Label'), text('tier1Value')],
    [text('tier2Label'), text('tier2Value')],
    [text('tier3Label'), text('tier3Value')],
    [text('maintLabel'), text(pricing.maintActive ? 'maintOn' : 'maintOff')],
    [text('gatewayLabel'), text('gatewayValue')],
    [text('ticketsLabel'), text('ticketsValue')],
    [text('sponsorsLabel'), text('sponsorsValue')],
    [text('voluntaryLabel'), text('voluntaryValue')],
    [text('setupLabel'), text('setupValue')],
    [text('durationLabel'), text('durationValue')]
  ];

  return (
    <section aria-labelledby="tarifas" className="korum-trust-vault p-5 sm:p-6">
      <h2 id="tarifas" className="font-corp text-xl font-extrabold text-varsity-navy">
        {text('title')}
      </h2>
      <p className="mt-2 text-ink-soft">{text(pricing.bracket.mode === 'FLAT' ? 'noteFlat' : 'noteMarginal')}</p>
      <table className="mt-4 w-full table-fixed border-collapse text-start text-sm sm:text-base">
        <caption className="sr-only">{text('caption')}</caption>
        <thead>
          <tr className="border-b-2 border-varsity-navy text-varsity-navy">
            <th scope="col" className="w-2/5 py-2 pe-3 text-start font-bold">
              {text('colConcept')}
            </th>
            <th scope="col" className="py-2 text-start font-bold">
              {text('colPrice')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-patio-rule align-top">
              <th scope="row" className="py-3 pe-3 text-start font-semibold text-varsity-navy">
                {label}
              </th>
              <td className="py-3">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-sm text-ink-soft">{text('disclaimer')}</p>
    </section>
  );
}
