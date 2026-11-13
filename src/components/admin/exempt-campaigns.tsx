import { getFormatter, getTranslations } from 'next-intl/server';
import { CurrencyText } from '@/components/ui/currency-text';
import { Link } from '@/i18n/navigation';
import type { ExemptCampaignRow } from '@/services/admin/exempt-campaigns';

/**
 * Campañas de presupuesto en una categoría al 0 % (aplazado del 5.1): el candado semántico es un filtro de buena fe, así que el Super-Admin las revisa. Cada fila lleva
 * el nombre de la entidad (enlace a su ficha 360º), la campaña, su categoría, el estado, la meta y una marca con texto si el candado saltó alguna vez (el texto
 * parecía de equipamiento). Solo se lee: lo que se hace con una campaña dudosa se decide en la ficha de la entidad (categorías y tarifas).
 */
export async function ExemptCampaigns({ rows, locale }: { rows: ExemptCampaignRow[]; locale: string }) {
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'admin.rules.exempt' }), getFormatter({ locale })]);
  if (rows.length === 0) return <p className="text-ink-soft">{t('none')}</p>;
  return (
    <>
      <p className="text-sm text-ink-soft xl:hidden">{t('scrollHint')}</p>
      <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={t('region')} data-testid="exempt-campaigns">
        <table className="w-full min-w-3xl border-collapse text-start">
          <caption className="sr-only">{t('caption')}</caption>
          <thead>
            <tr className="border-b-2 border-varsity-navy/20 text-sm">
              <th scope="col" className="p-2 text-start">
                {t('columns.organization')}
              </th>
              <th scope="col" className="p-2 text-start">
                {t('columns.campaign')}
              </th>
              <th scope="col" className="p-2 text-start">
                {t('columns.category')}
              </th>
              <th scope="col" className="p-2 text-start">
                {t('columns.status')}
              </th>
              <th scope="col" className="p-2 text-end">
                {t('columns.goal')}
              </th>
              <th scope="col" className="p-2 text-start">
                {t('columns.saved')}
              </th>
              <th scope="col" className="p-2 text-start">
                {t('columns.lock')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.initiativeId} className="border-b border-patio-rule" data-lock={row.lockTriggered ? 'true' : 'false'}>
                <td className="p-2">
                  <Link href={`/admin/entidades/${row.organizationId}`} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline">
                    {row.organizationName}
                  </Link>
                </td>
                <td className="p-2 font-semibold">{row.title}</td>
                <td className="p-2">{row.category}</td>
                <td className="p-2">{t(`status.${row.status}` as 'status.FUNDRAISING')}</td>
                <td className="p-2 text-end">
                  <CurrencyText cents={row.goalCents} />
                </td>
                <td className="p-2">{format.dateTime(new Date(row.lastSavedAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' })}</td>
                <td className="p-2">
                  {row.lockTriggered ? (
                    <span className="rounded-full bg-amber-100 px-2 py-1 text-sm font-bold text-amber-950">
                      <span aria-hidden="true">{'⚠️ '}</span>
                      {t('lockYes')}
                    </span>
                  ) : (
                    <span className="text-ink-soft">{t('lockNo')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
