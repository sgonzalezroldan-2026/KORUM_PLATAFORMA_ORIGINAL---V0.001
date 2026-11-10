import { getFormatter, getTranslations } from 'next-intl/server';
import { CurrencyText } from '@/components/ui/currency-text';
import type { Locale } from '@/i18n/routing';
import type { FundPayoutView } from '@/services/panel/activity-fund-data';
import { FundRetryButton } from './activity-fund-actions';

const STATUS_STYLE: Record<FundPayoutView['status'], string> = {
  PENDING_DOUBLE_CHECK: 'bg-amber-100 text-amber-950',
  APPROVED: 'bg-sky-100 text-sky-950',
  PROCESSING: 'bg-sky-100 text-sky-950',
  EXECUTED: 'bg-emerald-100 text-emerald-950',
  FAILED: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-stone-200 text-stone-800'
};

/**
 * Historial de liquidaciones del Fondo de actividades (Sprint 4.2f): estado con texto, destino, importe y, cuando el dinero ya se envió, el justificante
 * en PDF (con los comercios de los que salió, el destino y las firmas). Las que Paycomet no terminó se pueden reintentar.
 */
export async function ActivityFundHistory({ orgSlug, locale, history, canAct }: { orgSlug: string; locale: Locale; history: FundPayoutView[]; canAct: boolean }) {
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'panel.fund.history' }), getFormatter({ locale })]);
  const date = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeZone: 'Europe/Madrid'
    });

  return (
    <section aria-labelledby="fund-history" className="flex flex-col gap-3">
      <h2 id="fund-history" className="font-corp text-xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      {history.length === 0 ? (
        <p className="text-ink-soft">{t('none')}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="fund-history">
          {history.map((payout) => (
            <li key={payout.id} className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy/15 bg-white p-3">
              <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <span className="flex flex-wrap items-center gap-2 font-bold text-varsity-navy">
                  <span>{payout.reference}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-extrabold ${STATUS_STYLE[payout.status]}`}>
                    {payout.status === 'CANCELLED' && payout.cancelReason ? t(`cancelReason.${payout.cancelReason}`) : t(`status.${payout.status}`)}
                  </span>
                </span>
                <CurrencyText cents={payout.amountCents} className="font-extrabold text-varsity-navy" />
              </div>
              <p className="whitespace-pre-line wrap-break-word text-sm">{payout.purpose}</p>
              <p className="text-xs text-ink-soft">
                {payout.executedAt
                  ? t('executedOn', { date: date(payout.executedAt) })
                  : t('requestedOn', {
                      date: date(payout.createdAt),
                      name: payout.requestedBy || t('someone')
                    })}
              </p>
              {payout.status === 'EXECUTED' ? (
                <a
                  href={`/api/panel/fondo/${payout.id}/justificante?org=${encodeURIComponent(orgSlug)}&lang=${locale}`}
                  className="min-h-11 self-start py-2 font-semibold text-varsity-navy underline underline-offset-4"
                  data-testid="fund-receipt"
                >
                  {`📄 ${t('receipt')}`}
                </a>
              ) : null}
              {canAct && payout.status === 'FAILED' ? <FundRetryButton orgSlug={orgSlug} payoutId={payout.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
