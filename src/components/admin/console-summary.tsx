import { useTranslations } from 'next-intl';

export interface ConsoleSummaryData {
  openAlerts: number;
  criticalAlerts: number;
  boostCampaigns: number;
  negativeCampaigns: number;
  openPricingAlerts: number;
  /** Hay filtros de negocio activos: las dos cifras de campañas los siguen. */
  filtered: boolean;
}

/**
 * Franja «de un vistazo» bajo el título de la consola: lo que pide atención, con su número y un enlace a su sección (EXPERIENCIA §3: saber en dos
 * minutos cómo va todo). Lleva texto además de color y todas las cifras salen de las mismas lecturas que las secciones a las que enlazan.
 */
export function ConsoleSummary({ data }: { data: ConsoleSummaryData }) {
  const t = useTranslations('admin.summary');
  const items = [
    { href: '#avisos', label: t('alerts'), value: data.openAlerts, detail: t('alertsCritical', { count: data.criticalAlerts }), hot: data.criticalAlerts > 0, testId: 'summary-alerts' },
    { href: '#iniciativas', label: t('boost'), value: data.boostCampaigns, detail: null, hot: false, testId: 'summary-boost' },
    { href: '#iniciativas', label: t('negative'), value: data.negativeCampaigns, detail: null, hot: data.negativeCampaigns > 0, testId: 'summary-negative' },
    { href: '#salud-de-precios', label: t('pricing'), value: data.openPricingAlerts, detail: null, hot: data.openPricingAlerts > 0, testId: 'summary-pricing' }
  ];

  return (
    <section aria-labelledby="summary-title" className="flex flex-col gap-2" data-testid="console-summary">
      <h2 id="summary-title" className="font-corp text-lg font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <ul className="mobile-stack grid gap-3 md:grid-cols-4">
        {items.map((item) => (
          <li key={item.testId}>
            <a href={item.href} data-testid={item.testId} className={`flex min-h-11 flex-col gap-1 rounded-xl border-2 p-3 ${item.hot ? 'border-red-700 bg-red-50 text-red-950' : 'border-varsity-navy/20 bg-white text-varsity-navy'}`}>
              <span className="text-sm font-semibold">{item.label}</span>
              <span className="font-corp text-2xl font-extrabold tabular-nums">{item.value}</span>
              {item.detail ? <span className="text-sm">{item.detail}</span> : null}
            </a>
          </li>
        ))}
      </ul>
      {data.filtered ? <p className="text-sm text-ink-soft">{t('filtered')}</p> : null}
    </section>
  );
}
