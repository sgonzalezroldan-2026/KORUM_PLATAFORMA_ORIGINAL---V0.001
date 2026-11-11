import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReviewedPricingAlert } from '@/core/finance/pricing-health';
import type { MoneyLocale } from '@/core/finance/money';
import { pricingMessageValues } from '@/core/finance/pricing-alert-format';
import { isLocale } from '@/i18n/routing';

/**
 * Avisos de las reglas de precio (skill korum-tco-calculator §2.1): cada uno con la cifra concreta, en lenguaje llano y con texto además del
 * icono. Un aviso aceptado no desaparece: se muestra atenuado con quién lo aceptó y cuándo. Ninguno bloquea nada. Los botones «Ajustar» y
 * «Aceptar y registrar» llegan con el motor de reglas (Sprint 5.3), que es donde se editan los valores.
 */
export async function PricingHealthPanel({ alerts, locale }: { alerts: ReviewedPricingAlert[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'admin.pricingHealth' });
  const format = await getFormatter({ locale });
  const moneyLocale: MoneyLocale = isLocale(locale) ? locale : 'es';

  if (alerts.length === 0) return <p className="text-ink-soft">{t('none')}</p>;

  return (
    <ul className="flex flex-col gap-3" data-testid="pricing-health">
      {alerts.map((alert) => {
        const accepted = alert.acknowledgement;
        const critical = alert.severity === 'CRITICAL';
        return (
          <li
            key={`${alert.code}:${alert.source ?? ''}`}
            data-pricing-alert={alert.code}
            data-accepted={accepted ? 'true' : 'false'}
            className={`flex flex-col gap-1 rounded-xl border-2 p-3 ${accepted ? 'border-patio-rule-strong bg-slate-50 text-ink-soft' : critical ? 'border-red-700 bg-red-50 text-red-950' : 'border-varsity-gold-deep bg-amber-50 text-amber-950'}`}
          >
            <p className="font-bold">
              <span aria-hidden="true">{critical ? '❗ ' : '⚠️ '}</span>
              <span className="me-2 rounded-full bg-white/70 px-2 py-0.5 text-xs font-extrabold">{t(critical ? 'severity.CRITICAL' : 'severity.WARNING')}</span>
              {t(`message.${alert.code}`, pricingMessageValues(alert, moneyLocale))}
            </p>
            {alert.source ? <p className="text-sm">{t('sourceLabel', { source: t(`source.${alert.source}`) })}</p> : null}
            <p className="text-sm">{accepted ? t('accepted', { date: format.dateTime(new Date(accepted.acknowledgedAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }), note: accepted.note || t('noNote') }) : t('open')}</p>
          </li>
        );
      })}
    </ul>
  );
}
