import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { DelayedTooltip } from '@/components/ui/delayed-tooltip';
import { Link } from '@/i18n/navigation';
import { checkoutPath, initiativePath } from '@/lib/seo/portal-routes';
import type { InitiativeCardData } from '@/core/public/view-model';
import { ProgressBar } from './progress-bar';
import { useMoney } from './use-money';

export interface InitiativeCardProps {
  orgSlug: string;
  card: InitiativeCardData;
  /** Idioma del texto de la entidad si no es el de la página (`lang` del título). */
  contentLang?: string;
  /** Botón de compartir: lo gestiona quien pinta el listado (un único diálogo para todas las tarjetas). */
  shareButton?: ReactNode;
}

/** Texto del botón principal según el tipo de campaña. */
export function ctaKey(card: Pick<InitiativeCardData, 'format' | 'subtype'>): 'contribute' | 'buyTickets' | 'buyRaffle' {
  if (card.format !== 'TICKETING') return 'contribute';
  return card.subtype === 'RAFFLE' ? 'buyRaffle' : 'buyTickets';
}

/**
 * Tarjeta de una iniciativa abierta (`FUNDRAISING`). Un único enlace por tarjeta (el título) abre la ficha; el botón de aportar es otro
 * enlace distinto, así que cada elemento interactivo tiene un nombre claro y ninguno está anidado dentro de otro.
 */
export function InitiativeCard({ orgSlug, card, contentLang, shareButton }: InitiativeCardProps) {
  const t = useTranslations('portal.card');
  const money = useMoney();
  const ticketing = card.format === 'TICKETING';
  const href = initiativePath(orgSlug, card.id);

  return (
    <article className="relative flex flex-col justify-between overflow-hidden rounded-3xl border border-patio-rule-strong bg-white shadow-sm motion-safe:transition-shadow hover:shadow-md" data-testid="initiative-card" data-initiative-id={card.id}>
      <div>
        {card.coverFileId ? (
          // Imagen representativa de la campaña (Sprint 4.4c): decorativa (el título va justo debajo), reducida en el servidor y cargada al hacer scroll.
          // eslint-disable-next-line @next/next/no-img-element -- imagen pública servida por /api/files/public, ya reducida a 1.600 px
          <img src={`/api/files/public/${card.coverFileId}`} alt="" width={640} height={360} loading="lazy" decoding="async" className="h-32 w-full object-cover" data-testid="initiative-card-cover" />
        ) : null}
        <div
          className={clsx(
            'flex min-h-36 flex-col justify-between gap-4 p-5',
            ticketing ? 'bg-gradient-to-br from-sky-100 via-indigo-50 to-amber-50' : 'bg-gradient-to-br from-amber-100 via-orange-50 to-sky-100'
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span lang={contentLang} className="die-cut-sticker px-3! text-sm">
              {card.category}
            </span>
            <div className="flex items-center gap-2">
              {card.matching ? (
                <DelayedTooltip content={t('matchingTip')}>
                  <span tabIndex={0} className="die-cut-sticker relative z-10 px-3! text-sm">
                    <span aria-hidden="true">{'✨'}</span> {t('matching')}
                  </span>
                </DelayedTooltip>
              ) : null}
              {ticketing ? (
                <span className="font-corp rounded-full bg-sky-800 px-3 py-1 text-sm font-extrabold tabular-nums text-white">
                  <span aria-hidden="true">{'🎟️ '}</span>
                  {t('price', { price: money(card.ticketBuyerCents) })}
                </span>
              ) : card.zeroCommission ? (
                <span className="rounded-full bg-emerald-800 px-3 py-1 text-sm font-extrabold text-white">
                  <span aria-hidden="true">{'💚 '}</span>
                  {t('zeroCommission')}
                </span>
              ) : null}
              <span className="relative z-10">{shareButton}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-bold text-varsity-navy">
            <p>
              <span aria-hidden="true">{'🎒 '}</span>
              <span lang={contentLang}>{t('stage', { stage: card.stage })}</span>
            </p>
            <span aria-hidden="true" className="underline underline-offset-4">
              {`${t('viewDetails')} →`}
            </span>
          </div>
        </div>

        <div className="space-y-3 p-5 pb-3">
          <h3 lang={contentLang} className="font-joy text-lg font-bold leading-snug text-varsity-navy wrap-anywhere">
            <Link href={href} className="rounded underline-offset-4 after:absolute after:inset-0 after:content-[''] hover:underline" aria-label={t('open', { title: card.title })}>
              {card.title}
            </Link>
          </h3>
          <div className="space-y-1.5">
            <div className="flex justify-between gap-2 text-sm font-extrabold tabular-nums">
              {ticketing ? (
                <>
                  <span className="text-sky-900">{t('ticketsSold', { sold: card.ticketsSold, max: card.ticketMax })}</span>
                  <span className="text-varsity-navy">{t('ticketsLeft', { count: card.ticketsAvailable })}</span>
                </>
              ) : (
                <>
                  <span className="font-corp text-emerald-900">{t('raisedOf', { raised: money(card.raisedCents), goal: money(card.goalCents) })}</span>
                  <span className="text-varsity-navy">{t('percent', { pct: card.pct })}</span>
                </>
              )}
            </div>
            <ProgressBar pct={card.pct} label={t('progress', { title: card.title })} tone={card.achieved ? 'emerald' : ticketing ? 'sky' : 'brand'} />
            <div className="flex justify-between gap-2 text-sm text-ink-soft tabular-nums">
              <span>
                <span aria-hidden="true">{'💛 '}</span>
                {t('contributions', { count: card.contributions })}
              </span>
              <span>{card.achieved ? t('completed') : t('daysLeft', { count: card.daysLeft })}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2 px-5 pb-5 pt-1">
        <p className="px-1 text-sm font-bold text-emerald-900">
          <span aria-hidden="true">{'🛡️ '}</span>
          {t('refund')}
        </p>
        {card.achieved || card.closed ? (
          <p className="flex min-h-11 items-center justify-center rounded-2xl bg-emerald-100 px-3 text-center font-joy text-sm font-bold text-emerald-950">
            {card.achieved ? (ticketing ? t('soldOut') : t('goalReached')) : t('closed')}
          </p>
        ) : (
          <Link href={checkoutPath(orgSlug, card.id)} prefetch={false} className="tactile-btn relative z-10 w-full rounded-2xl! font-joy">
            <span aria-hidden="true">{ticketing ? '🎟️' : '💛'}</span>
            {t(ctaKey(card))}
          </Link>
        )}
      </div>
    </article>
  );
}
