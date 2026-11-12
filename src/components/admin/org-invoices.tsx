import { getFormatter, getTranslations } from 'next-intl/server';
import { CurrencyText } from '@/components/ui/currency-text';
import type { OrgInvoiceView } from '@/services/admin/org-360-data';

const DATE = { dateStyle: 'medium', timeZone: 'Europe/Madrid' } as const;

/**
 * Facturas Veri*factu de la entidad, de la más reciente a la más antigua (las 100 últimas): número, fecha, concepto, total y estado ante el proveedor.
 * Una rectificativa (`R1`) lo dice con texto y su importe puede ser negativo. Solo lectura: reenviar o resolver una factura atascada se hace desde su
 * alerta en la portada.
 */
export async function OrgInvoices({ invoices, locale }: { invoices: OrgInvoiceView[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'admin.org360.invoices' });
  const format = await getFormatter({ locale });

  if (invoices.length === 0) return <p className="text-ink-soft">{t('none')}</p>;
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('region')} data-testid="org-invoices">
      <table className="w-full min-w-[44rem] border-collapse text-start">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="border-b-2 border-varsity-navy/20 text-sm">
            <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
              {t('number')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
              {t('date')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
              {t('concept')}
            </th>
            <th scope="col" className="px-2 py-2 text-end font-corp font-bold">
              {t('total')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
              {t('status')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-patio-rule">
          {invoices.map((invoice) => (
            <tr key={invoice.id} data-invoice={invoice.invoiceNumber}>
              <th scope="row" className="px-2 py-2 text-start font-mono text-sm font-bold">
                {invoice.invoiceNumber}
                {invoice.invoiceType === 'R1' ? <span className="ms-2 rounded bg-amber-100 px-1.5 py-0.5 font-sans text-xs text-amber-950">{t('rectification')}</span> : null}
              </th>
              <td className="px-2 py-2 whitespace-nowrap">{format.dateTime(new Date(invoice.issuedAt), DATE)}</td>
              <td className="px-2 py-2">{invoice.concept}</td>
              <td className={`px-2 py-2 text-end ${invoice.totalAmountCents < 0 ? 'text-red-800' : ''}`}>
                <CurrencyText cents={invoice.totalAmountCents} className="font-bold" />
              </td>
              <td className="px-2 py-2 font-semibold">{t(`state.${invoice.verifactuStatus}` as 'state.PENDING')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
