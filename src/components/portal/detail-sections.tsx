import { useLocale, useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import { formatBps, type MoneyLocale } from '@/core/finance/money';
import type { CourseChallengeLine } from '@/core/public/course-challenge';
import type { BreakdownData, TicketInfoData } from '@/core/public/view-model';
import { isLocale } from '@/i18n/routing';
import { ProgressBar } from './progress-bar';
import { useMoney } from './use-money';

function Row({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? 'border-t border-patio-rule-strong pt-2 text-base font-extrabold text-varsity-navy' : 'text-ink-soft'}`}>
      <dt>{label}</dt>
      <dd className="shrink-0">
        <CurrencyText cents={cents} className={strong ? 'text-varsity-emerald' : 'font-bold text-varsity-navy'} />
      </dd>
    </div>
  );
}

/**
 * Desglose público de la iniciativa: **4 líneas que suman exactamente la meta** (QA-F03, Regla 02 §1). Sin tramos internos ni comisiones. El pie
 * es el texto oficial (Regla 03 §3) y no se cambia sin aprobación.
 */
export function PublicBreakdown({ breakdown }: { breakdown: BreakdownData }) {
  const t = useTranslations('portal.detail.breakdown');
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';

  return (
    <section aria-labelledby="breakdown-heading" className="space-y-2 border-t border-patio-rule pt-4 text-sm" data-testid="public-breakdown">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="breakdown-heading" className="font-extrabold text-varsity-navy">
          <span aria-hidden="true">{'🔍 '}</span>
          {t('heading')}
        </h3>
        <span className="rounded-full border border-emerald-700 bg-emerald-50 px-2 py-0.5 text-sm font-extrabold text-emerald-900">{t('exact')}</span>
      </div>
      <dl className="space-y-2 tabular-nums">
        <Row label={t('provider')} cents={breakdown.providerCents} />
        <Row label={t('install')} cents={breakdown.installCents} />
        <Row label={t('contingency', { percent: formatBps(breakdown.contingencyBps, locale) })} cents={breakdown.contingencyCents} />
        <Row label={t('gateway')} cents={breakdown.escrowAndGuaranteeCents} />
        <Row label={t('total')} cents={breakdown.totalGoalCents} strong />
      </dl>
      <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 leading-relaxed text-ink">{t('footnote')}</p>
    </section>
  );
}

export function HiddenBreakdownNotice({ goalCents }: { goalCents: number }) {
  const t = useTranslations('portal.detail.breakdown');
  const money = useMoney();
  return (
    <p className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm leading-relaxed text-emerald-950" data-testid="hidden-breakdown">
      <span aria-hidden="true">{'✔️ '}</span>
      {t('hidden', { goal: money(goalCents) })}
    </p>
  );
}

/** Taquilla: lo que paga quien compra y lo que recibe la entidad, con la misma fórmula que el Estudio. */
export function TicketDetails({ ticket }: { ticket: TicketInfoData }) {
  const t = useTranslations('portal.detail');

  return (
    <section aria-labelledby="tickets-heading" className="space-y-2 border-t border-patio-rule pt-4 text-sm">
      <h3 id="tickets-heading" className="font-extrabold text-varsity-navy">
        <span aria-hidden="true">{'🎟️ '}</span>
        {t('ticketsHeading')}
      </h3>
      <dl className="space-y-2 tabular-nums">
        {ticket.mode === 'ADD' ? (
          <>
            <Row label={t('ticketLines.price')} cents={ticket.priceCents} />
            <Row label={t('ticketLines.fee')} cents={ticket.feeUnitCents} />
            <Row label={t('ticketLines.total')} cents={ticket.buyerUnitCents} strong />
          </>
        ) : (
          <>
            <Row label={t('ticketLines.priceInc')} cents={ticket.priceCents} />
            <Row label={t('ticketLines.feeInc')} cents={ticket.feeUnitCents} />
            <Row label={t('ticketLines.center')} cents={ticket.centerUnitCents} strong />
          </>
        )}
      </dl>
      {ticket.venue ? <p className="text-ink-soft">{t('ticketLines.venue', { venue: ticket.venue })}</p> : null}
    </section>
  );
}

/**
 * Reto colectivo por curso, equipo o grupo, **solo en positivo** (Regla 03 §6): «3º de Primaria ya suma 28 familias · reto: 35». Sin
 * ranking, sin importes y sin señalar a nadie; el orden es el de la entidad, no el de avance.
 */
export function CourseChallenge({ lines, rewardText, target, vertical }: { lines: CourseChallengeLine[]; rewardText: string | null; target: number; vertical: string }) {
  const t = useTranslations('portal.detail.challenge');
  const unit = vertical === 'SPORTS_CLUB' || vertical === 'CULTURAL' ? vertical : 'SCHOOL';

  return (
    <section aria-labelledby="challenge-heading" className="space-y-3 rounded-3xl border border-patio-rule-strong bg-white p-6" data-testid="course-challenge">
      <h3 id="challenge-heading" className="font-joy text-lg font-bold text-varsity-navy">
        <span aria-hidden="true">{'🏆 '}</span>
        {rewardText ? t('heading', { reward: rewardText }) : t('headingNoReward')}
      </h3>
      <p className="text-sm leading-relaxed text-ink-soft">{t('intro', { unit: t(`unit.${unit}`), target })}</p>
      {lines.length === 0 ? (
        <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-950">{t('empty')}</p>
      ) : (
        <ul className="space-y-3 pt-1">
          {lines.map((line) => (
            <li key={line.slug} className="space-y-1" data-group={line.slug}>
              <p className="text-sm font-bold text-varsity-navy">{t('line', { group: line.groupName, count: line.familiesCount, target: line.target })}</p>
              <ProgressBar pct={line.pct} label={t('progress', { group: line.groupName })} tone={line.reached ? 'emerald' : 'amber'} />
              <p className={`text-sm font-semibold ${line.reached ? 'text-emerald-900' : 'text-amber-900'}`}>{line.reached ? t('reached') : t('missing', { missing: line.missing })}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
