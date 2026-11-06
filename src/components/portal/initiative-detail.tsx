import { useFormatter, useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import type { InitiativeDetailData } from '@/core/public/view-model';
import { Link } from '@/i18n/navigation';
import { checkoutPath, portalPath } from '@/lib/seo/portal-routes';
import { CourseChallenge, HiddenBreakdownNotice, PublicBreakdown, TicketDetails } from './detail-sections';
import { ctaKey } from './initiative-card';
import { ProgressBar } from './progress-bar';
import { ShareButton } from './share-button';
import type { ShareGroup } from './share-modal';
import { useMoney } from './use-money';

export interface InitiativeDetailProps {
  orgSlug: string;
  entityName: string;
  vertical: string;
  detail: InitiativeDetailData;
  /** URL absoluta y canónica de esta ficha (la que se comparte). */
  shareUrl: string;
  groups: ShareGroup[];
  contentLang?: string;
}

/**
 * Ficha de una iniciativa (`id="fview-detail"`). Dos columnas en escritorio y **una sola en móvil** (`.mobile-stack`, QA-F06). Sin la barra de 6
 * estados de la entidad: solo la hucha de la iniciativa y la fecha límite (QA-F03). El reto por curso y la placa son bloques independientes.
 */
export function InitiativeDetail({ orgSlug, entityName, vertical, detail, shareUrl, groups, contentLang }: InitiativeDetailProps) {
  const t = useTranslations('portal');
  const format = useFormatter();
  const money = useMoney();
  const { card } = detail;
  const ticketing = card.format === 'TICKETING';
  const deadline = format.dateTime(new Date(detail.closesAtIso), { dateStyle: 'long', timeZone: 'Europe/Madrid' });

  return (
    <article id="fview-detail" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={portalPath(orgSlug)} className="inline-flex min-h-11 items-center rounded-xl border-2 border-patio-rule-strong bg-white px-4 font-extrabold text-varsity-navy hover:bg-patio-cream">
          <span aria-hidden="true">{'← '}</span>
          {t('detail.back')}
        </Link>
        <ShareButton target={{ title: card.title, entityName, url: shareUrl, groups }} />
      </div>

      <div className="korum-trust-vault flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex flex-wrap items-center gap-2 font-extrabold text-varsity-navy">
            <span aria-hidden="true">{'🛡️'}</span>
            <span>{`${t('detail.vault.label')}:`}</span>
            <code className="rounded border border-patio-rule-strong bg-slate-100 px-2 py-0.5 font-mono font-extrabold" data-testid="wallet-escrow-id">
              {detail.walletEscrowId}
            </code>
          </p>
          <span className="rounded-full border border-emerald-700 bg-emerald-50 px-2.5 py-0.5 text-sm font-extrabold text-emerald-900">
            <span aria-hidden="true">{'🔒 '}</span>
            {t('detail.vault.refund')}
          </span>
          <span className="rounded-full border border-amber-600 bg-amber-50 px-2.5 py-0.5 text-sm font-bold text-amber-950">{t('detail.vault.independence')}</span>
        </div>
        <p className="font-bold text-ink-soft">
          <span aria-hidden="true">{'📅 '}</span>
          {`${t('detail.vault.deadline')}: `}<strong className="text-varsity-navy">{deadline}</strong>
        </p>
      </div>

      <div className="mobile-stack grid gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7">
          <div className="space-y-4 rounded-3xl border border-patio-rule-strong bg-white p-6">
            <div className="flex flex-wrap gap-2">
              <span lang={contentLang} className="rounded-full bg-amber-100 px-3 py-0.5 text-sm font-bold text-amber-950">
                {card.category}
              </span>
              {card.zeroCommission ? <span className="rounded-full bg-emerald-800 px-3 py-0.5 text-sm font-bold text-white">{`💚 ${t('card.zeroCommission')}`}</span> : null}
              {detail.plaque ? <span className="rounded-full bg-sky-100 px-3 py-0.5 text-sm font-bold text-sky-950">{`🏅 ${t('detail.plaque')}`}</span> : null}
              {card.matching ? <span className="die-cut-sticker px-3! text-sm">{`✨ ${t('card.matching')}`}</span> : null}
            </div>
            <h1 lang={contentLang} className="font-joy text-2xl font-bold text-varsity-navy wrap-anywhere">
              {card.title}
            </h1>
            <p lang={contentLang} className="whitespace-pre-line leading-relaxed text-ink wrap-anywhere">
              {detail.description}
            </p>
            {card.matching ? (
              <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                {detail.matchingSponsorName ? t('detail.matchingBy', { sponsor: detail.matchingSponsorName }) : t('detail.matching')}
              </p>
            ) : null}
          </div>

          {detail.challenge.enabled ? <CourseChallenge lines={detail.challenge.lines} rewardText={detail.challenge.rewardText} target={detail.challenge.target} vertical={vertical} /> : null}
        </div>

        <div className="space-y-6 lg:col-span-5">
          <div className="korum-trust-vault space-y-4 p-6">
            {ticketing ? (
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-joy text-2xl font-bold text-sky-900 tabular-nums">
                  <span aria-hidden="true">{'🎟️ '}</span>
                  {t('detail.ticketsOf', { sold: card.ticketsSold, max: card.ticketMax })}
                </span>
                <span className="text-sm font-bold text-ink-soft">
                  {t('detail.ticketsAvailable', { count: card.ticketsAvailable })}{' ('}
                  <CurrencyText cents={card.ticketBuyerCents} />
                  {')'}
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <CurrencyText cents={card.raisedCents} className="font-joy text-2xl font-bold text-emerald-800" />
                <span className="font-corp text-sm font-bold tabular-nums text-ink-soft">{t('detail.goal', { goal: money(card.goalCents), pct: card.pct })}</span>
              </div>
            )}
            <ProgressBar pct={card.pct} label={t('card.progress', { title: card.title })} size="lg" tone={card.achieved ? 'emerald' : 'brand'} />
            <div className="flex flex-wrap justify-between gap-2 text-sm text-ink-soft">
              <span>
                <span aria-hidden="true">{'💛 '}</span>
                {t('detail.contributionsDone', { count: card.contributions })}
              </span>
              <span>
                <span aria-hidden="true">{'⏳ '}</span>
                {card.achieved ? t('detail.completedFull') : card.closed ? t('card.closed') : t('card.daysLeft', { count: card.daysLeft })}
              </span>
            </div>

            {card.achieved || card.closed ? (
              <p className="flex min-h-12 items-center justify-center rounded-2xl bg-emerald-100 px-4 text-center font-joy font-bold text-emerald-950">
                {card.achieved ? (ticketing ? t('detail.ticketsSoldOut') : t('detail.closed')) : t('detail.contributionsClosed')}
              </p>
            ) : (
              <Link href={checkoutPath(orgSlug, card.id)} prefetch={false} className="tactile-btn w-full rounded-2xl! py-4! font-joy text-base">
                <span aria-hidden="true">{ticketing ? '🎟️' : '💛'}</span>
                {t(`detail.cta.${ctaKey(card)}`)}
              </Link>
            )}

            {ticketing && detail.ticket ? <TicketDetails ticket={detail.ticket} /> : null}
            {detail.breakdown.kind === 'shown' ? <PublicBreakdown breakdown={detail.breakdown.data} /> : null}
            {detail.breakdown.kind === 'hidden' ? <HiddenBreakdownNotice goalCents={card.goalCents} /> : null}
          </div>
        </div>
      </div>
    </article>
  );
}
