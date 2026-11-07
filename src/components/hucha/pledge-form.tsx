'use client';

import clsx from 'clsx';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useRef, useState, useTransition, type FormEvent } from 'react';
import type { startPledgeAction } from '@/app/[locale]/(account)/mi-hucha/actions';
import { FieldError } from '@/components/checkout/checkout-fields';
import { parseTypedCents } from '@/components/checkout/checkout-draft';
import { FiscalFields, type FiscalDraft, type FiscalError } from '@/components/checkout/fiscal-fields';
import { useMoney } from '@/components/portal/use-money';
import {
  chargeDayOf,
  PLEDGE_AMOUNT_PRESETS,
  PLEDGE_DEFAULT_CENTS,
  PLEDGE_DEFAULT_MONTHS,
  PLEDGE_MAX_CENTS,
  PLEDGE_MIN_CENTS,
  PLEDGE_MONTH_OPTIONS,
  pledgeCommitmentCents,
  pledgeFeeCents
} from '@/core/pledges/pledge-limits';
import type { MoneyLocale } from '@/core/finance/money';
import type { PledgeOffer } from '@/repositories/hucha.repository';

/**
 * Alta de la aportación mensual (Mi Hucha `PLEDGE`, ancla `id="fview-mihucha"` del prototipo, recarga mensual programada). Importe, duración,
 * campaña preferida y, si la entidad emite certificado, los datos fiscales. El resumen dice antes de pagar cuánto se cobra cada mes, qué día y
 * cuánto como mucho en total. El primer mes se paga en la página segura de Paycomet, que guarda la tarjeta: KORUM nunca la ve.
 */

type FormError = { kind: 'amount' | 'campaign' | 'noCampaign' | 'alreadyActive' | 'rateLimited' | 'unavailable' | 'disabled' | 'login' | 'form' } | { kind: 'fiscal'; detail: FiscalError };

const inputClass = 'min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold text-ink aria-invalid:border-red-700';

export function PledgeForm({ offer, provinces, start }: { offer: PledgeOffer; provinces: Array<{ code: string; name: string }>; start: typeof startPledgeAction }) {
  const t = useTranslations('hucha.form');
  const locale = useLocale() as MoneyLocale;
  const money = useMoney();
  const [presetCents, setPresetCents] = useState<number | null>(PLEDGE_DEFAULT_CENTS);
  const [customAmount, setCustomAmount] = useState('');
  const [months, setMonths] = useState<number>(PLEDGE_DEFAULT_MONTHS);
  const [campaign, setCampaign] = useState('');
  const [fiscal, setFiscal] = useState<FiscalDraft>({ wantsCertificate: false, fullName: '', provinceCode: '' });
  const [taxId, setTaxId] = useState('');
  const [error, setError] = useState<FormError | null>(null);
  const [pending, startTransition] = useTransition();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const ids = { amount: useId(), amountHint: useId(), amountError: useId(), months: useId(), campaign: useId(), campaignHint: useId(), summary: useId() };
  const amountRef = useRef<HTMLInputElement>(null);

  const amountCents = presetCents ?? parseTypedCents(customAmount, locale);
  const amountValid = amountCents !== null && Number.isSafeInteger(amountCents) && amountCents >= PLEDGE_MIN_CENTS && amountCents <= PLEDGE_MAX_CENTS;
  const feeCents = amountValid ? pledgeFeeCents(amountCents, offer.feeRules) : 0;
  const chargeDay = useMemo(() => chargeDayOf(new Date()), []);

  function showError(next: FormError) {
    setError(next);
    // El error general se anuncia y recibe el foco; los de campo ya van junto a su campo (`role="alert"`).
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!amountValid || amountCents === null) {
      setError({ kind: 'amount' });
      // El foco va al campo con el error, que ya lo describe (QA de experiencia del 3.8).
      requestAnimationFrame(() => amountRef.current?.focus());
      return;
    }
    if (offer.certificate && fiscal.wantsCertificate) {
      if (taxId.trim().length < 5) return setError({ kind: 'fiscal', detail: 'taxId' });
      if (fiscal.fullName.trim().length < 3 || fiscal.provinceCode === '') return setError({ kind: 'fiscal', detail: 'fields' });
    }
    setError(null);
    startTransition(async () => {
      const result = await start({
        orgSlug: offer.slug,
        initiativeId: campaign === '' ? null : Number(campaign),
        amountCents,
        months,
        fiscal: offer.certificate && fiscal.wantsCertificate ? { taxId: taxId.trim(), fullName: fiscal.fullName.trim(), provinceCode: fiscal.provinceCode } : null,
        locale
      });
      switch (result.status) {
        case 'REDIRECT':
          window.location.assign(result.url);
          return;
        case 'INVALID':
          if (result.field === 'taxId') return setError({ kind: 'fiscal', detail: 'taxId' });
          if (result.field === 'fiscal') return setError({ kind: 'fiscal', detail: 'fields' });
          if (result.field === 'amount') return setError({ kind: 'amount' });
          if (result.field === 'campaign') return setError({ kind: 'campaign' });
          return showError({ kind: 'form' });
        case 'NO_CAMPAIGN':
          return showError({ kind: 'noCampaign' });
        case 'ALREADY_ACTIVE':
          return showError({ kind: 'alreadyActive' });
        case 'RATE_LIMITED':
          return showError({ kind: 'rateLimited' });
        case 'DISABLED':
          return showError({ kind: 'disabled' });
        case 'LOGIN_REQUIRED':
          return showError({ kind: 'login' });
        case 'NOT_FOUND':
        case 'UNAVAILABLE':
          return showError({ kind: 'unavailable' });
      }
    });
  }

  const general = error && error.kind !== 'amount' && error.kind !== 'fiscal' && error.kind !== 'campaign' ? t(`errors.${error.kind}`) : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <fieldset className="space-y-2">
        <legend className="mb-1 font-extrabold text-varsity-navy">{t('amountLegend')}</legend>
        <div className="grid grid-cols-3 gap-2">
          {PLEDGE_AMOUNT_PRESETS.map((cents) => {
            const checked = presetCents === cents;
            return (
              <label
                key={cents}
                className={clsx(
                  'flex min-h-12 cursor-pointer items-center justify-center rounded-xl border-2 px-2 py-1 text-center font-corp font-extrabold tabular-nums has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-varsity-navy',
                  checked ? 'border-varsity-emerald bg-emerald-50 text-emerald-950' : 'border-patio-rule-strong bg-white text-varsity-navy'
                )}
              >
                <input type="radio" name="pledge-amount" className="sr-only" checked={checked} onChange={() => {
                    setPresetCents(cents);
                    setCustomAmount('');
                  }} />
                <span>{t('perMonth', { amount: money(cents) })}</span>
              </label>
            );
          })}
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.amount} className="block text-sm font-bold text-varsity-navy">
            {t('otherLabel')}
          </label>
          <input
            ref={amountRef}
            id={ids.amount}
            inputMode="decimal"
            autoComplete="off"
            value={customAmount}
            onChange={(event) => {
              setCustomAmount(event.target.value);
              setPresetCents(event.target.value === '' ? PLEDGE_DEFAULT_CENTS : null);
            }}
            aria-invalid={error?.kind === 'amount' || undefined}
            aria-describedby={error?.kind === 'amount' ? `${ids.amountHint} ${ids.amountError}` : ids.amountHint}
            className={inputClass}
          />
          <p id={ids.amountHint} className="text-sm text-ink-soft">
            {t('otherHint', { min: money(PLEDGE_MIN_CENTS), max: money(PLEDGE_MAX_CENTS) })}
          </p>
          <FieldError id={ids.amountError} message={error?.kind === 'amount' ? t('errors.amount', { min: money(PLEDGE_MIN_CENTS), max: money(PLEDGE_MAX_CENTS) }) : null} />
        </div>
      </fieldset>

      <div className="mobile-stack grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={ids.months} className="block font-extrabold text-varsity-navy">
            {t('monthsLabel')}
          </label>
          <select id={ids.months} value={months} onChange={(event) => setMonths(Number(event.target.value))} className={inputClass}>
            {PLEDGE_MONTH_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t(`months.${option}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.campaign} className="block font-extrabold text-varsity-navy">
            {t('campaignLabel')}
          </label>
          <select
            id={ids.campaign}
            value={campaign}
            onChange={(event) => setCampaign(event.target.value)}
            aria-describedby={ids.campaignHint}
            aria-invalid={error?.kind === 'campaign' || undefined}
            className={inputClass}
          >
            <option value="">{t('campaignSoonest')}</option>
            {offer.campaigns.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <p id={ids.campaignHint} className="text-sm text-ink-soft">
            {error?.kind === 'campaign' ? t('errors.campaign') : t('campaignHint')}
          </p>
        </div>
      </div>

      <FiscalFields offer={{ certificate: offer.certificate, provinces }} draft={fiscal} update={(patch) => setFiscal((previous) => ({ ...previous, ...patch }))} taxId={taxId} onTaxIdChange={setTaxId} error={error?.kind === 'fiscal' ? error.detail : null} askAgain={false} />

      <div id={ids.summary} aria-live="polite" className="korum-trust-vault space-y-1 p-4" data-testid="pledge-summary">
        {amountValid && amountCents !== null ? (
          <>
            <p className="font-corp font-extrabold text-varsity-navy tabular-nums">{t('summary.monthly', { amount: money(amountCents), fee: money(feeCents), total: money(amountCents + feeCents) })}</p>
            <p className="text-sm text-ink-soft">{t('summary.schedule', { day: chargeDay, months })}</p>
            <p className="text-sm text-ink-soft tabular-nums">{t('summary.commitment', { total: money(pledgeCommitmentCents(amountCents, feeCents, months)) })}</p>
          </>
        ) : (
          <p className="text-sm text-ink-soft">{t('summary.pickAmount')}</p>
        )}
      </div>

      <p className="text-sm text-ink-soft">
        <span aria-hidden="true">{'🔒 '}</span>
        {t('cardNotice')}
      </p>

      {general ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-xl bg-red-50 p-3 font-bold text-red-900">
          {general}
        </p>
      ) : null}

      <button type="submit" className="tactile-btn self-start" disabled={pending} aria-busy={pending || undefined}>
        <span aria-hidden="true">{'💳 '}</span>
        {pending ? t('submitting') : t('submit')}
      </button>
    </form>
  );
}
