'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import type { managePledgeAction } from '@/app/[locale]/(account)/mi-hucha/actions';
import { useMoney } from '@/components/portal/use-money';
import { CurrencyText } from '@/components/ui/currency-text';
import { Link } from '@/i18n/navigation';
import { portalPath } from '@/lib/seo/portal-routes';

/**
 * Una aportación mensual de Mi Hucha (Sprint 3.8): cuánto y cuándo se cobra, a qué campaña va, cuánto ha llegado ya y sus meses. Pausar,
 * reanudar, cambiar de campaña y cancelar con un clic (cancelar pide confirmarlo en el sitio, sin ventanas del navegador). Nunca enseña un
 * saldo: no existe. Cada estado se dice con texto, nunca solo con color.
 */

export interface PledgeCardData {
  id: number;
  status: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'FINISHED';
  statusReason: string | null;
  monthlyAmountCents: number;
  feePerMonthCents: number;
  totalMonths: number;
  executedMonths: number;
  skippedMonths: number;
  nextChargeAt: string;
  initiativeId: number | null;
  contributedCents: number;
  organization: { name: string; slug: string; initiatives: Array<{ id: number; title: string }> };
  card: { brand: string | null; last4: string | null; revoked: boolean } | null;
  months: Array<{ cycle: number; status: string; amountCents: number; date: string; campaign: string }>;
}

const DATE = { dateStyle: 'long', timeZone: 'Europe/Madrid' } as const;
const STATUS_CLASS: Record<PledgeCardData['status'], string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-950',
  PAUSED: 'bg-amber-100 text-amber-950',
  PENDING: 'bg-sky-100 text-sky-950',
  CANCELLED: 'bg-stone-200 text-stone-900',
  FINISHED: 'bg-varsity-ivory text-varsity-navy'
};
const REASONS_SHOWN = new Set(['CHARGE_FAILED', 'CARD_UNAVAILABLE', 'CARD_NOT_SAVED', 'ACCOUNT_ERASED', 'CHARGEBACK', 'PAUSE_EXPIRED']);

export function PledgeCard({ pledge, manage }: { pledge: PledgeCardData; manage: typeof managePledgeAction }) {
  const t = useTranslations('hucha.pledge');
  const format = useFormatter();
  const money = useMoney();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const campaignId = useId();
  const live = pledge.status === 'ACTIVE' || pledge.status === 'PAUSED';

  /** Abrir la confirmación lleva el foco a la opción segura; cerrarla lo devuelve al botón que la abrió (QA de experiencia del 3.8). */
  function openConfirm() {
    setMessage(null);
    setConfirming(true);
    requestAnimationFrame(() => confirmRef.current?.focus());
  }

  function closeConfirm() {
    setConfirming(false);
    requestAnimationFrame(() => cancelRef.current?.focus());
  }

  function run(payload: Parameters<typeof managePledgeAction>[0], done: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await manage(payload);
      const ok = result.status === 'DONE';
      setConfirming(false);
      setMessage({ tone: ok ? 'ok' : 'error', text: ok ? t(`done.${done}`) : t(`errors.${result.status}`) });
      if (ok) router.refresh();
      // El resultado recibe el foco: el botón pulsado puede haber desaparecido (pausar → reanudar).
      requestAnimationFrame(() => messageRef.current?.focus());
    });
  }

  const cardText = pledge.card ? [pledge.card.brand ?? t('cardGeneric'), pledge.card.last4 ? `•••• ${pledge.card.last4}` : null].filter(Boolean).join(' ') : null;

  return (
    <article aria-labelledby={titleId} className="korum-trust-vault flex flex-col gap-4 p-5" data-testid="pledge-card" data-status={pledge.status}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="font-corp text-xl font-extrabold text-varsity-navy">
            <Link href={portalPath(pledge.organization.slug)} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-varsity-emerald">
              {pledge.organization.name}
            </Link>
          </h3>
          <p className="font-corp font-bold text-ink tabular-nums">{t('monthly', { amount: money(pledge.monthlyAmountCents) })}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-extrabold ${STATUS_CLASS[pledge.status]}`}>{t(`status.${pledge.status}`)}</span>
      </header>

      {pledge.statusReason && REASONS_SHOWN.has(pledge.statusReason) ? <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-950">{t(`reason.${pledge.statusReason}`)}</p> : null}

      <dl className="mobile-stack grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-sm font-bold text-ink-soft">{t('progress')}</dt>
          <dd className="font-corp font-extrabold text-varsity-navy tabular-nums">{t('progressValue', { done: pledge.executedMonths, total: pledge.totalMonths })}</dd>
        </div>
        <div>
          <dt className="text-sm font-bold text-ink-soft">{t('contributed')}</dt>
          <dd>
            <CurrencyText cents={pledge.contributedCents} className="font-extrabold text-varsity-emerald" />
          </dd>
        </div>
        <div>
          <dt className="text-sm font-bold text-ink-soft">{t('charge')}</dt>
          <dd className="font-semibold text-ink tabular-nums">
            {t('chargeValue', {
              amount: money(pledge.monthlyAmountCents),
              fee: money(pledge.feePerMonthCents)
            })}
          </dd>
        </div>
        {pledge.status === 'ACTIVE' ? (
          <div>
            <dt className="text-sm font-bold text-ink-soft">{t('next')}</dt>
            <dd className="font-semibold text-ink">{format.dateTime(new Date(pledge.nextChargeAt), DATE)}</dd>
          </div>
        ) : null}
        {cardText && live ? (
          <div>
            <dt className="text-sm font-bold text-ink-soft">{t('card')}</dt>
            <dd className="font-semibold text-ink">{cardText}</dd>
          </div>
        ) : null}
        {pledge.skippedMonths > 0 ? (
          <div>
            <dt className="text-sm font-bold text-ink-soft">{t('skipped')}</dt>
            <dd className="font-semibold text-ink">{t('skippedValue', { count: pledge.skippedMonths })}</dd>
          </div>
        ) : null}
      </dl>

      {live ? (
        <div className="space-y-1">
          <label htmlFor={campaignId} className="block font-bold text-varsity-navy">
            {t('campaignLabel')}
          </label>
          <select
            id={campaignId}
            value={pledge.initiativeId ?? ''}
            disabled={pending}
            aria-busy={pending || undefined}
            onChange={(event) => run({ action: 'campaign', pledgeId: pledge.id, initiativeId: event.target.value === '' ? null : Number(event.target.value) }, 'campaign')}
            className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold text-ink"
          >
            <option value="">{t('campaignSoonest')}</option>
            {pledge.organization.initiatives.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {live ? (
        <div className="flex flex-wrap gap-2">
          {pledge.status === 'ACTIVE' ? (
            <button type="button" className="tactile-btn" disabled={pending} onClick={() => run({ action: 'pause', pledgeId: pledge.id }, 'pause')}>
              <span aria-hidden="true">{'⏸️ '}</span>
              {t('pause')}
            </button>
          ) : (
            <button type="button" className="tactile-btn" disabled={pending} onClick={() => run({ action: 'resume', pledgeId: pledge.id }, 'resume')}>
              <span aria-hidden="true">{'▶️ '}</span>
              {t('resume')}
            </button>
          )}
          {confirming ? null : (
            <button ref={cancelRef} type="button" className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/10" disabled={pending} onClick={openConfirm}>
              {t('cancel')}
            </button>
          )}
        </div>
      ) : null}

      {confirming ? (
        <div role="group" aria-label={t('cancelConfirmTitle')} className="space-y-3 rounded-2xl border-2 border-red-800 bg-red-50 p-4">
          <p className="font-semibold text-red-950">{t('cancelConfirm')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="inline-flex min-h-11 items-center rounded-xl bg-red-800 px-4 font-bold text-white hover:bg-red-900" disabled={pending} onClick={() => run({ action: 'cancel', pledgeId: pledge.id, confirm: true }, 'cancel')}>
              {pending ? t('cancelling') : t('cancelYes')}
            </button>
            <button ref={confirmRef} type="button" className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy bg-white px-4 font-semibold text-varsity-navy" disabled={pending} onClick={closeConfirm}>
              {t('cancelNo')}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p ref={messageRef} tabIndex={-1} role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'rounded-xl bg-red-50 p-3 font-bold text-red-900' : 'rounded-xl bg-emerald-50 p-3 font-bold text-emerald-950'}>
          {message.text}
        </p>
      ) : null}

      {pledge.months.length > 0 ? (
        <details className="rounded-2xl bg-white p-3">
          <summary className="flex min-h-11 cursor-pointer items-center font-bold text-varsity-navy">{t('history', { count: pledge.months.length })}</summary>
          <ul className="mt-2 flex flex-col divide-y divide-varsity-navy/10">
            {pledge.months.map((month) => (
              <li key={month.cycle} className="mobile-stack grid gap-1 py-2 md:grid-cols-[1fr_auto] md:items-center">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{t('historyLine', { cycle: month.cycle, campaign: month.campaign })}</p>
                  <p className="text-sm text-ink-soft">{format.dateTime(new Date(month.date), DATE)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <CurrencyText cents={month.amountCents} className="font-extrabold text-varsity-navy" />
                  <span className="rounded-full bg-varsity-ivory px-3 py-1 text-sm font-bold text-varsity-navy">{t(`monthStatus.${month.status}`)}</span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
