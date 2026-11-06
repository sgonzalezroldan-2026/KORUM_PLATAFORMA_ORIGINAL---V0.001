'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { DONATION_MAX_CENTS, DONATION_MIN_CENTS } from '@/core/checkout/checkout-limits';
import { maxSelectableTickets } from '@/core/checkout/checkout-summary';
import { useMoney } from '@/components/portal/use-money';
import type { CheckoutDraft, CheckoutOffer } from './checkout-draft';

/**
 * Campos del checkout: importe de la donación, cantidad de entradas, grupo del reto y email del invitado. Cada error va junto a su campo
 * (`aria-describedby` + `role="alert"`), dentro del diálogo, para que un lector de pantalla lo anuncie (skill de interfaz §4).
 */

type Update = (patch: Partial<CheckoutDraft>) => void;
const inputClass = 'min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold text-ink aria-invalid:border-red-700';

export function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm font-bold text-red-800">
      {message}
    </p>
  );
}

export function DonationAmountField({ offer, draft, update, error }: { offer: CheckoutOffer; draft: CheckoutDraft; update: Update; error: boolean }) {
  const t = useTranslations('portal.checkout.donation');
  const money = useMoney();
  const otherId = useId();
  const errorId = useId();
  const presets = offer.donation?.presetsCents ?? [];

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 font-extrabold text-varsity-navy">{t('legend')}</legend>
      <div className="grid grid-cols-3 gap-2">
        {presets.map((cents, index) => {
          const checked = draft.presetIdx === index;
          return (
            <label
              key={cents}
              className={clsx(
                'flex min-h-12 cursor-pointer flex-col items-center justify-center rounded-xl border-2 px-2 py-1 text-center font-corp font-extrabold tabular-nums has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-varsity-navy',
                checked ? 'border-varsity-emerald bg-emerald-50 text-emerald-950' : 'border-patio-rule-strong bg-white text-varsity-navy'
              )}
            >
              <input type="radio" name="donation-amount" className="sr-only" checked={checked} onChange={() => update({ presetIdx: index, customAmount: '' })} />
              <span>{money(cents)}</span>
              {index === offer.donation?.defaultIdx ? (
                <span className="text-xs font-bold text-amber-900">
                  <span aria-hidden="true">{'⭐ '}</span>
                  {t('suggested')}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="space-y-1">
        <label htmlFor={otherId} className="block text-sm font-bold text-varsity-navy">
          {t('otherLabel')}
        </label>
        <input
          id={otherId}
          inputMode="decimal"
          autoComplete="off"
          value={draft.customAmount}
          onChange={(event) => update({ customAmount: event.target.value, presetIdx: event.target.value === '' ? (offer.donation?.defaultIdx ?? 0) : null })}
          aria-invalid={error || undefined}
          aria-describedby={error ? errorId : undefined}
          className={inputClass}
        />
        <p className="text-sm text-ink-soft">{t('otherHint', { min: money(DONATION_MIN_CENTS), max: money(DONATION_MAX_CENTS) })}</p>
        <FieldError id={errorId} message={error ? t('error', { min: money(DONATION_MIN_CENTS), max: money(DONATION_MAX_CENTS) }) : null} />
      </div>
    </fieldset>
  );
}

export function TicketQuantityField({ offer, draft, update, error }: { offer: CheckoutOffer; draft: CheckoutDraft; update: Update; error: string | null }) {
  const t = useTranslations('portal.checkout.ticket');
  const money = useMoney();
  const valueId = useId();
  const errorId = useId();
  const ticket = offer.ticket;
  if (!ticket) return null;
  const max = maxSelectableTickets(ticket.available);
  const { pricing } = ticket;

  return (
    <div className="space-y-3">
      <div className="space-y-1 rounded-2xl border border-sky-300 bg-sky-50 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-full bg-sky-800 px-2.5 py-0.5 text-sm font-extrabold text-white">
            <span aria-hidden="true">{ticket.subtype === 'RAFFLE' ? '🍀 ' : '🎭 '}</span>
            {t(`badge.${ticket.subtype}`)}
          </span>
          <span className="font-corp font-extrabold tabular-nums text-sky-950">{t('available', { available: ticket.available, max: ticket.max })}</span>
        </div>
        {ticket.venue ? (
          <p className="text-sm text-ink-soft">
            <span aria-hidden="true">{'📍 '}</span>
            {t('venue', { venue: ticket.venue })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-patio-rule-strong bg-patio-cream p-3.5">
        <div>
          <p id={valueId} className="font-extrabold text-varsity-navy">
            {t(`quantity.${ticket.subtype}`)}
          </p>
          <p className="text-sm text-ink-soft">
            {pricing.mode === 'ADD' ? t('unitAdd', { price: money(pricing.priceCents), fee: money(pricing.feeUnitCents) }) : t('unitInc', { price: money(pricing.priceCents) })}
          </p>
        </div>
        <div className="flex items-center gap-2" role="group" aria-labelledby={valueId}>
          <button
            type="button"
            onClick={() => update({ quantity: Math.max(1, draft.quantity - 1) })}
            disabled={draft.quantity <= 1}
            aria-label={t('less')}
            className="inline-flex size-11 items-center justify-center rounded-xl border-2 border-patio-rule-strong bg-white text-xl font-extrabold text-varsity-navy disabled:opacity-50"
          >
            <span aria-hidden="true">{'−'}</span>
          </button>
          <output aria-live="polite" aria-labelledby={valueId} className="min-w-10 text-center font-corp text-2xl font-extrabold tabular-nums text-varsity-navy" data-testid="ticket-quantity">
            {draft.quantity}
          </output>
          <button
            type="button"
            onClick={() => update({ quantity: Math.min(max, draft.quantity + 1) })}
            disabled={draft.quantity >= max}
            aria-label={t('more')}
            aria-describedby={draft.quantity >= max ? errorId : undefined}
            className="inline-flex size-11 items-center justify-center rounded-xl bg-varsity-navy text-xl font-extrabold text-white disabled:opacity-50"
          >
            <span aria-hidden="true">{'+'}</span>
          </button>
        </div>
      </div>
      {draft.quantity >= max && max > 0 && !error ? (
        <p id={errorId} className="text-sm font-semibold text-ink-soft">
          {t('limit', { max })}
        </p>
      ) : null}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function GroupField({ offer, draft, update }: { offer: CheckoutOffer; draft: CheckoutDraft; update: Update }) {
  const t = useTranslations('portal.checkout.group');
  const selectId = useId();
  const hintId = useId();
  if (offer.groups.length === 0) return null;
  const vertical = offer.vertical === 'SPORTS_CLUB' || offer.vertical === 'CULTURAL' ? offer.vertical : 'SCHOOL';

  return (
    <div className="space-y-1 rounded-2xl border border-amber-300 bg-amber-50 p-3.5">
      <label htmlFor={selectId} className="block font-extrabold text-varsity-navy">
        {t(`label.${vertical}`)}
      </label>
      <select id={selectId} value={draft.groupName} onChange={(event) => update({ groupName: event.target.value })} aria-describedby={hintId} className={inputClass}>
        <option value="">{t('none')}</option>
        {offer.groups.map((cluster) => (
          <optgroup key={cluster.group} label={cluster.group}>
            {cluster.items.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p id={hintId} className="text-sm text-ink-soft">
        {t('hint')}
      </p>
    </div>
  );
}

export function EmailField({ offer, draft, update, error }: { offer: CheckoutOffer; draft: CheckoutDraft; update: Update; error: boolean }) {
  const t = useTranslations('portal.checkout.email');
  const inputId = useId();
  const errorId = useId();
  if (offer.sessionEmail) {
    return <p className="rounded-xl bg-patio-cream p-3 text-sm font-semibold text-ink">{t('signedIn', { email: offer.sessionEmail })}</p>;
  }
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block font-extrabold text-varsity-navy">
        {t('label')}
      </label>
      <input
        id={inputId}
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        value={draft.email}
        onChange={(event) => update({ email: event.target.value })}
        aria-invalid={error || undefined}
        aria-describedby={error ? errorId : undefined}
        className={inputClass}
      />
      <FieldError id={errorId} message={error ? t('error') : null} />
    </div>
  );
}
