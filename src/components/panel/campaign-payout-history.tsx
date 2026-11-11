import { getFormatter, getTranslations } from 'next-intl/server';
import { CurrencyText } from '@/components/ui/currency-text';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { HistoryStatus, PayoutHistoryView } from '@/services/panel/campaign-payouts-data';
import { PayoutRetryButton } from './campaign-payout-pending';

const STATUS_STYLE: Record<HistoryStatus, string> = {
  APPROVED: 'bg-sky-100 text-sky-950',
  PROCESSING: 'bg-sky-100 text-sky-950',
  EXECUTED: 'bg-emerald-100 text-emerald-950',
  FAILED: 'bg-red-100 text-red-900'
};

/**
 * Historial de liquidaciones de campañas (Sprint 4.4a): estado con texto, destino, importe enviado y, ya hecha, el siguiente paso (fotos del Después).
 * Las que Paycomet no terminó se pueden reintentar; las que tienen un reparto en revisión las resuelve KORUM (la entidad no tiene que hacer nada).
 */
export async function CampaignPayoutHistory({ orgSlug, locale, history, canAct }: { orgSlug: string; locale: Locale; history: PayoutHistoryView[]; canAct: boolean }) {
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'panel.payouts.history' }), getFormatter({ locale })]);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Madrid' });
  if (history.length === 0) return null;

  return (
    <section aria-labelledby="payout-history" className="flex flex-col gap-3">
      <h2 id="payout-history" className="font-corp text-xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <ul className="flex flex-col gap-3" data-testid="payout-history">
        {history.map((payout) => (
          <li key={payout.id} className="korum-trust-vault flex flex-col gap-2 rounded-xl border-2 border-varsity-navy/15 bg-white p-4" data-testid={`payout-history-${payout.initiativeId}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="wrap-break-word font-corp font-extrabold text-varsity-navy">{`${payout.reference} · ${payout.title}`}</span>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-extrabold ${STATUS_STYLE[payout.status]}`}>{t(`status.${payout.status}`)}</span>
            </div>
            <p className="font-corp tabular-nums text-sm text-ink-soft">{`${payout.walletEscrowId} · ${payout.destinationType === 'PROVIDER' ? t('toProvider', { name: payout.beneficiaryName, bank: payout.ibanBank ?? '····', last4: payout.ibanLast4 ?? '' }) : t('toOrganization', { name: payout.beneficiaryName })}`}</p>
            <p className="font-corp text-lg font-extrabold tabular-nums text-varsity-navy">
              <CurrencyText cents={payout.netPaidCents} />
            </p>
            {payout.status === 'EXECUTED' && payout.executedAt ? (
              <p className="text-sm text-emerald-950">{`✅ ${t('executed', { date: date(payout.executedAt) })}`}</p>
            ) : (
              <p className="text-sm text-ink-soft">
                {t('progress', {
                  done: formatCents(payout.doneCents, locale),
                  total: formatCents(payout.netPaidCents, locale)
                })}
              </p>
            )}
            {payout.underReview ? <p className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">{t('underReview')}</p> : null}
            {canAct && !payout.underReview && (payout.status === 'FAILED' || payout.status === 'APPROVED' || payout.status === 'PROCESSING') ? <PayoutRetryButton orgSlug={orgSlug} initiativeId={payout.initiativeId} /> : null}
            {payout.photosMissing ? (
              <Link href={`/panel/${orgSlug}/logros`} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4" data-testid={`payout-photos-${payout.initiativeId}`}>
                {`📷 ${t('photosCta')}`}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
