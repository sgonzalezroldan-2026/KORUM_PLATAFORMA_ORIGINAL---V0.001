import { getFormatter, getTranslations } from 'next-intl/server';
import { CurrencyText } from '@/components/ui/currency-text';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { ExpiredCampaignView, ExpiredStatus } from '@/repositories/expired-campaigns.repository';
import { ExpiredDecisionForm } from './expired-decision-form';

const BADGE: Record<ExpiredStatus, string> = {
  EXPIRED: 'bg-amber-100 text-amber-950',
  RESIZE_VOTING: 'bg-sky-100 text-sky-950',
  REFUNDING: 'bg-rose-100 text-rose-950',
  REFUNDED: 'bg-stone-200 text-stone-900',
  GOAL_REACHED: 'bg-emerald-100 text-emerald-950',
  CLOSED: 'bg-emerald-100 text-emerald-950'
};

/**
 * Una campaña vencida en el panel (Sprint 4.4b): lo recaudado frente a la meta y, según el momento, la decisión (votar o reembolsar), la votación en curso
 * (cuántas personas han votado y cuántas pidieron su devolución, sin el recuento por opción), el progreso del reembolso con lo devuelto o el resultado.
 * El estado siempre va con texto, no solo con color.
 */
export async function ExpiredCampaignCard({ orgSlug, locale, campaign, canAct }: { orgSlug: string; locale: Locale; campaign: ExpiredCampaignView; canAct: boolean }) {
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'panel.expired' }), getFormatter({ locale })]);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  const poll = campaign.poll;
  // Frente a la meta con la que se recaudó: la de una campaña redimensionada ya es lo recaudado (100 %) y no diría nada.
  const goalCents = poll?.originalGoalCents ?? campaign.goalCents;
  const percent = goalCents > 0 ? Math.floor((campaign.raisedCents * 100) / goalCents) : 0;
  const refund = campaign.refund;
  const refundPercent = refund && refund.total > 0 ? Math.floor((refund.done * 100) / refund.total) : campaign.status === 'REFUNDED' ? 100 : 0;

  return (
    <section aria-labelledby={`expired-${campaign.id}`} className="korum-trust-vault flex flex-col gap-4 rounded-2xl border-2 border-varsity-navy bg-white p-5" data-testid={`expired-card-${campaign.id}`}>
      <div className="flex flex-col gap-1">
        <span className={`self-start rounded-full px-2.5 py-0.5 text-xs font-extrabold uppercase ${BADGE[campaign.status]}`}>{t(`status.${campaign.status}`)}</span>
        <h2 id={`expired-${campaign.id}`} className="wrap-break-word font-joy text-2xl font-bold text-varsity-navy">
          {campaign.title}
        </h2>
        <p className="font-corp text-sm tabular-nums text-ink-soft">{`${campaign.walletEscrowId} · ${t('closedOn', { date: date(campaign.closesAt) })}`}</p>
      </div>
      <p className="font-corp text-lg font-extrabold tabular-nums text-varsity-navy">
        {t('raised', { raised: formatCents(campaign.raisedCents, locale), goal: formatCents(goalCents, locale), percent })}
      </p>

      {campaign.status === 'EXPIRED' ? (
        canAct ? (
          <>
            <p className="text-sm text-ink-soft">{t('decideIntro')}</p>
            <ExpiredDecisionForm orgSlug={orgSlug} initiativeId={campaign.id} title={campaign.title} donors={campaign.donors} voteBlockers={campaign.voteBlockers} />
          </>
        ) : (
          <p className="text-sm text-ink-soft">{t('readOnly')}</p>
        )
      ) : null}

      {poll && campaign.status === 'RESIZE_VOTING' && !poll.tallied ? (
        <div className="flex flex-col gap-2 rounded-xl border-2 border-sky-200 bg-sky-50 p-4" data-testid={`expired-poll-${campaign.id}`}>
          <p className="font-bold text-sky-950">{`🗳️ ${t('poll.open', { date: date(poll.closesAt) })}`}</p>
          <ol className="list-[upper-alpha] ps-6 text-sm text-sky-950">
            {poll.options.map((option) => (
              <li key={option} className="wrap-break-word">
                {option}
              </li>
            ))}
          </ol>
          <p className="text-sm font-semibold tabular-nums text-sky-950">{t('poll.turnout', { votes: poll.votes, refunds: poll.refundVotes })}</p>
          <p className="text-sm text-sky-950">{t('poll.hidden')}</p>
        </div>
      ) : null}

      {poll && (poll.status !== 'OPEN' || poll.tallied) ? (
        <div className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy/15 p-4" data-testid={`expired-result-${campaign.id}`}>
          <p className="font-bold text-varsity-navy">{poll.winner ? `✅ ${t('poll.won', { option: poll.winner })}` : `↩️ ${t('poll.noWinner')}`}</p>
          {poll.tallied ? <p className="text-sm text-varsity-navy" data-testid={`expired-tallied-${campaign.id}`}>{t('poll.refundingNonVoters')}</p> : null}
          {poll.counts ? (
            <ul className="text-sm tabular-nums text-ink-soft">
              {poll.options.map((option, index) => (
                <li key={option} className="wrap-break-word">
                  {t('poll.count', { option, votes: poll.counts?.[index] ?? 0 })}
                </li>
              ))}
              <li>{t('poll.refundCount', { votes: poll.refundVotes })}</li>
            </ul>
          ) : null}
          {poll.winner && poll.newGoalCents !== null ? (
            <p className="font-corp text-sm font-semibold tabular-nums text-varsity-navy">
              {t('poll.newGoal')} <CurrencyText cents={poll.newGoalCents} />
            </p>
          ) : null}
          {poll.winner && campaign.status === 'GOAL_REACHED' ? (
            <Link href={`/panel/${orgSlug}/liquidaciones`} className="tactile-btn self-start" data-testid={`expired-settle-${campaign.id}`}>
              {`🏆 ${t('poll.settle')}`}
            </Link>
          ) : null}
        </div>
      ) : null}

      {refund ? (
        <div className="flex flex-col gap-2" data-testid={`expired-refund-${campaign.id}`}>
          <p className="text-sm font-semibold text-varsity-navy" id={`expired-refund-label-${campaign.id}`}>
            {campaign.status === 'REFUNDED' ? `✅ ${t('refund.done', { count: refund.total, amount: formatCents(refund.totalCents, locale) })}` : t('refund.progress', { done: refund.done, total: refund.total, amount: formatCents(refund.doneCents, locale), totalAmount: formatCents(refund.totalCents, locale) })}
          </p>
          <div role="progressbar" aria-labelledby={`expired-refund-label-${campaign.id}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={refundPercent} className="h-3 w-full overflow-hidden rounded-full bg-stone-200">
            <div className="h-full rounded-full bg-varsity-emerald" style={{ width: `${refundPercent}%` }} />
          </div>
          <p className="text-sm text-ink-soft">{campaign.status === 'REFUNDED' ? (campaign.quotasReleased ? t('refund.quotasBack') : t('refund.closed')) : t('refund.howItWorks')}</p>
        </div>
      ) : null}
    </section>
  );
}
