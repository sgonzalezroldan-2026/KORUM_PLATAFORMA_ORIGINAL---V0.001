'use client';

import clsx from 'clsx';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { CurrencyText } from '@/components/ui/currency-text';
import { useHydrated } from '@/components/ui/use-hydrated';
import { useMoney } from '@/components/portal/use-money';
import type { CheckoutMethod } from '@/core/checkout/checkout-limits';
import { calculateSponsorCharge, sponsorLevelOf, type SponsorshipInvalidField } from '@/core/sponsors/sponsorship-rules';
import { isLocale } from '@/i18n/routing';
import type { SponsorshipStart } from '@/services/checkout/sponsorship.service';
import { buildSponsorPayload, initialSponsorDraft, saveSponsorDraft, type SponsorDraft, type SponsorOffer } from './sponsor-draft';

/**
 * Pestaña «Soy comercio local» del checkout (`chk-form-comercio` del prototipo; QA-F05): nivel, bolsa Matching 2x opcional, datos fiscales,
 * ventaja para las familias y aviso de renovación. El fee y el IVA se enseñan **encima** del importe íntegro, pero los recalcula el servidor.
 * Cada error va junto a su campo y dentro del diálogo, para que un lector de pantalla lo anuncie.
 */

type TextField = 'businessName' | 'taxId' | 'contactPerson' | 'phone' | 'email';
type FormError = { kind: SponsorshipInvalidField | 'closed' | 'rateLimited' | 'unavailable' | 'network'; field?: TextField };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPE = /^[+\d][\d\s().-]{5,}$/;
const inputClass = 'min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold text-ink aria-invalid:border-red-700';

export interface SponsorFormProps {
  orgSlug: string;
  initiativeId: number;
  offer: SponsorOffer;
  initial: SponsorDraft | null;
  startAction: (payload: unknown) => Promise<SponsorshipStart>;
  /** CIF o NIF con el que se vuelve a abrir la pestaña (solo en memoria: nunca se guarda en el navegador). */
  initialTaxId?: string;
  /** Avisa de cada cambio para que quien tiene el diálogo conserve lo escrito al cambiar de pestaña. */
  onChange?: (draft: SponsorDraft, taxId: string) => void;
}

interface FieldProps {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  errorText?: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  inputMode?: 'text' | 'tel' | 'email';
  maxLength?: number;
  optional?: boolean;
  /** Ayuda permanente bajo el campo (formato esperado). */
  hint?: string;
}

function Field({ name, label, value, onChange, invalid = false, errorText, type = 'text', autoComplete, placeholder, inputMode, maxLength, optional = false, hint }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-bold text-ink">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={!optional}
        aria-required={!optional}
        aria-invalid={invalid}
        aria-describedby={[invalid ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        autoComplete={autoComplete}
        inputMode={inputMode}
        placeholder={placeholder}
        maxLength={maxLength}
        className={inputClass}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {invalid && errorText ? (
        <p id={errorId} role="alert" className="text-sm font-bold text-red-800">
          {errorText}
        </p>
      ) : null}
    </div>
  );
}

export function SponsorForm({ orgSlug, initiativeId, offer, initial, startAction, initialTaxId = '', onChange }: SponsorFormProps) {
  const t = useTranslations('portal.checkout');
  const money = useMoney();
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const summaryId = useId();
  const [draft, setDraft] = useState<SponsorDraft>(initial ?? initialSponsorDraft(offer));
  const [taxId, setTaxId] = useState(initialTaxId);
  const [error, setError] = useState<FormError | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = useHydrated();
  const form = useRef<HTMLFormElement>(null);

  const update = (patch: Partial<SponsorDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange?.(next, taxId);
    setError(null);
  };
  const changeTaxId = (value: string) => {
    setTaxId(value);
    onChange?.(draft, value);
    setError(null);
  };
  const charge = calculateSponsorCharge(draft.tierCents, offer.feeBps);
  const feePercent = new Intl.NumberFormat(locale).format(offer.feeBps / 100);

  function validate(): FormError | null {
    if (draft.businessName.trim().length < 2) return { kind: 'form', field: 'businessName' };
    if (taxId.trim().length < 5) return { kind: 'taxId', field: 'taxId' };
    if (draft.contactPerson.trim().length < 2) return { kind: 'form', field: 'contactPerson' };
    if (!PHONE_SHAPE.test(draft.phone.trim())) return { kind: 'phone', field: 'phone' };
    if (!EMAIL_SHAPE.test(draft.email.trim())) return { kind: 'email', field: 'email' };
    return null;
  }

  function handleResult(result: SponsorshipStart) {
    switch (result.status) {
      case 'REDIRECT':
        window.location.assign(result.url);
        return;
      case 'INVALID':
        setError({ kind: result.field, field: result.field === 'email' || result.field === 'taxId' || result.field === 'phone' ? result.field : undefined });
        return;
      case 'CLOSED':
        setError({ kind: 'closed' });
        return;
      case 'RATE_LIMITED':
        setError({ kind: 'rateLimited' });
        return;
      case 'UNAVAILABLE':
        setError({ kind: 'unavailable' });
        return;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const method: CheckoutMethod = submitter?.value === 'CARD' ? 'CARD' : 'BIZUM';
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    saveSponsorDraft(initiativeId, draft);
    startTransition(async () => {
      try {
        handleResult(await startAction(buildSponsorPayload({ orgSlug, initiativeId, locale, method, draft, taxId })));
      } catch {
        setError({ kind: 'network' });
      }
    });
  }

  // Un error de un campo lleva el foco a ese campo (en el móvil puede quedar varias pantallas más arriba del botón): WCAG 3.3.1.
  useEffect(() => {
    if (!error?.field) return;
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    invalid?.focus();
    invalid?.scrollIntoView({ block: 'center' });
  }, [error]);

  const invalid = (field: TextField) => error?.field === field;
  const fieldMessage = (field: TextField) => (field === 'taxId' ? t('sponsor.errors.taxId') : field === 'email' ? t('sponsor.errors.email') : field === 'phone' ? t('sponsor.errors.phone') : t('sponsor.errors.required'));
  const formMessage = error && !error.field ? t(`sponsor.errors.${error.kind}`) : null;
  const sortedTiers = [...offer.tiersCents].sort((a, b) => a - b);

  return (
    <form ref={form} onSubmit={submit} noValidate className="space-y-4" id="chk-form-comercio">
      <div className="space-y-1 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        <p className="font-extrabold">
          <span aria-hidden="true">{'💛 '}</span>
          {t('sponsor.intro.title')}
        </p>
        <p>{t('sponsor.intro.body')}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 font-extrabold text-varsity-navy">{t('sponsor.tier.legend')}</legend>
        <div className="grid grid-cols-3 gap-2">
          {sortedTiers.map((cents) => {
            const { level } = sponsorLevelOf(cents, sortedTiers);
            const checked = draft.tierCents === cents;
            return (
              <label
                key={cents}
                className={clsx(
                  'flex min-h-14 cursor-pointer flex-col items-center justify-center rounded-xl border-2 px-1 py-1 text-center has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-varsity-gold',
                  checked ? 'border-amber-600 bg-amber-50 text-ink' : 'border-patio-rule-strong bg-white text-ink-soft'
                )}
              >
                <input type="radio" name="sponsor-tier" className="sr-only" checked={checked} onChange={() => update({ tierCents: cents })} />
                <span className="text-xs font-bold">
                  <span aria-hidden="true">{level === 'ORO' ? '🥇 ' : level === 'PLATA' ? '🥈 ' : '🥉 '}</span>
                  {t(`sponsor.tier.${level}`)}
                </span>
                <span className="font-corp font-extrabold tabular-nums">{money(cents)}</span>
              </label>
            );
          })}
        </div>
        <p className="text-sm text-ink-soft">{t('sponsor.tier.whole')}</p>
      </fieldset>

      {offer.matchingAvailable ? (
        <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border border-patio-rule-strong bg-white p-3 text-sm">
          <input type="checkbox" checked={draft.matchingPool} onChange={(event) => update({ matchingPool: event.target.checked })} className="mt-0.5 size-5 shrink-0 accent-emerald-700" />
          <span>
            <span className="block font-bold text-ink">
              <span aria-hidden="true">{'✨ '}</span>
              {t('sponsor.matching.label')}
            </span>
            <span className="block text-ink-soft">{t('sponsor.matching.help')}</span>
          </span>
        </label>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="businessName" label={t('sponsor.fields.businessName')} value={draft.businessName} onChange={(value) => update({ businessName: value })} invalid={invalid('businessName')} errorText={fieldMessage('businessName')} autoComplete="organization" maxLength={120} />
        <Field name="taxId" label={t('sponsor.fields.taxId')} value={taxId} onChange={changeTaxId} invalid={invalid('taxId')} errorText={fieldMessage('taxId')} maxLength={20} />
        <Field name="contactPerson" label={t('sponsor.fields.contactPerson')} value={draft.contactPerson} onChange={(value) => update({ contactPerson: value })} invalid={invalid('contactPerson')} errorText={fieldMessage('contactPerson')} autoComplete="name" maxLength={120} />
        <Field name="phone" label={t('sponsor.fields.phone')} value={draft.phone} onChange={(value) => update({ phone: value })} invalid={invalid('phone')} errorText={fieldMessage('phone')} type="tel" inputMode="tel" autoComplete="tel" maxLength={30} />
        <div className="sm:col-span-2">
          <Field name="email" label={t('sponsor.fields.email')} value={draft.email} onChange={(value) => update({ email: value })} invalid={invalid('email')} errorText={fieldMessage('email')} type="email" inputMode="email" autoComplete="email" maxLength={254} />
        </div>
        <div className="sm:col-span-2">
          <Field name="sector" label={t('sponsor.fields.sector')} value={draft.sector} onChange={(value) => update({ sector: value })} placeholder={t('sponsor.fields.sectorPlaceholder')} maxLength={80} optional />
        </div>
      </div>

      <fieldset className="space-y-3 rounded-2xl bg-patio-cream p-3">
        <legend className="px-1 font-extrabold text-varsity-navy">
          <span aria-hidden="true">{'🎁 '}</span>
          {t('sponsor.perk.legend')}
        </legend>
        <Field name="promo" label={t('sponsor.fields.promo')} value={draft.promo} onChange={(value) => update({ promo: value })} placeholder={t('sponsor.fields.promoPlaceholder')} maxLength={140} optional />
        <Field name="promoCode" label={t('sponsor.fields.promoCode')} value={draft.promoCode} onChange={(value) => update({ promoCode: value.replace(/[^A-Za-z0-9_-]/g, '') })} placeholder={t('sponsor.fields.promoCodePlaceholder')} hint={t('sponsor.fields.promoCodeHint')} maxLength={30} optional />
      </fieldset>

      <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">
        <input type="checkbox" checked={draft.autoRenew} onChange={(event) => update({ autoRenew: event.target.checked })} className="mt-0.5 size-5 shrink-0 accent-emerald-700" />
        <span>
          <span aria-hidden="true">{'🔄 '}</span>
          {t('sponsor.renewal')}
        </span>
      </label>

      <p className="rounded-xl bg-patio-cream p-3 text-sm text-ink-soft">{t('sponsor.legal')}</p>

      {/* Fijo al pie solo en pantallas altas: en una de ~667 px tapaba casi la mitad del formulario. */}
      <div className="z-10 -mx-5 -mb-5 space-y-2 border-t border-patio-rule bg-white px-5 pb-4 pt-3 shadow-[0_-10px_16px_-14px_rgb(16_31_56/0.45)] sm:-mx-6 sm:-mb-6 sm:px-6 [@media(min-height:760px)]:sticky [@media(min-height:760px)]:bottom-0">
        <div id={summaryId} aria-live="polite" className="flex flex-wrap items-center justify-between gap-x-2 rounded-2xl bg-patio-cream px-3.5 py-2" data-testid="sponsor-summary">
          <p className="text-sm text-ink-soft">
            <span className="sr-only">{`${t('summary.label')}: `}</span>
            {t('sponsor.summary', { amount: money(charge.amountCents), fee: money(charge.feeCents), pct: feePercent, vat: money(charge.vatCents) })}
          </p>
          <p className="font-corp text-lg font-extrabold text-varsity-navy">
            {`${t('summary.total')}: `}
            <CurrencyText cents={charge.totalChargedCents} />
          </p>
        </div>

        {formMessage ? (
          <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
            <p>{formMessage}</p>
          </div>
        ) : null}

        <div className="space-y-2">
          <button type="submit" name="method" value="BIZUM" disabled={pending || !ready} aria-describedby={summaryId} className="tactile-btn w-full rounded-2xl! py-4! font-joy text-base">
            <span aria-hidden="true">{'📲 '}</span>
            {t('pay.bizum', { total: money(charge.totalChargedCents) })}
          </button>
          <button
            type="submit"
            name="method"
            value="CARD"
            disabled={pending || !ready}
            aria-describedby={summaryId}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-varsity-navy px-4 font-extrabold text-white hover:bg-varsity-navy-deep disabled:opacity-60"
          >
            <span aria-hidden="true">{'💳 '}</span>
            {t('pay.card')}
          </button>
          <p role="status" className="text-center text-sm text-ink-soft">
            {pending ? t('pay.pending') : t('pay.secure')}
          </p>
        </div>
      </div>
    </form>
  );
}
