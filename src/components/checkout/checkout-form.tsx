'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { CurrencyText } from '@/components/ui/currency-text';
import { useHydrated } from '@/components/ui/use-hydrated';
import { useMoney } from '@/components/portal/use-money';
import type { CheckoutMethod } from '@/core/checkout/checkout-limits';
import { donationSummary, maxSelectableTickets, ticketSummary } from '@/core/checkout/checkout-summary';
import { isLocale } from '@/i18n/routing';
import type { CheckoutStart } from '@/services/checkout/checkout.service';
import { buildCheckoutPayload, clampQuantity, donationCents, guaranteeCents, saveDraft, type CheckoutDraft, type CheckoutOffer } from './checkout-draft';
import { DonationAmountField, EmailField, GroupField, TicketQuantityField } from './checkout-fields';
import { FiscalFields, type FiscalError } from './fiscal-fields';
import { GuaranteeField } from './guarantee-field';

/**
 * Formulario del checkout: donación o taquilla, sin registro (solo el email), con la aportación voluntaria **desmarcada** (QA-F04 · QA-F07). Al
 * pagar se guarda lo elegido (sin el NIF) y se va a la página segura de Paycomet; cualquier problema se explica dentro del diálogo, junto al
 * botón, para que un lector de pantalla lo anuncie.
 */

type FormError =
  | { kind: 'email' | 'amount' | 'form' | 'closed' | 'rateLimited' | 'unavailable' | 'network' | 'quantity' }
  | { kind: 'soldOut'; available: number }
  | { kind: 'fiscal'; detail: Exclude<FiscalError, null> };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CheckoutFormProps {
  offer: CheckoutOffer;
  initial: CheckoutDraft;
  /** Se vuelve de un pago rechazado con el certificado pedido: el NIF se vuelve a pedir. */
  askTaxIdAgain: boolean;
  startAction: (payload: unknown) => Promise<CheckoutStart>;
}

export function CheckoutForm({ offer: initialOffer, initial, askTaxIdAgain, startAction }: CheckoutFormProps) {
  const t = useTranslations('portal.checkout');
  const money = useMoney();
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const summaryId = useId();
  const [offer, setOffer] = useState(initialOffer);
  const [draft, setDraft] = useState<CheckoutDraft>(initial);
  const [taxId, setTaxId] = useState('');
  const [error, setError] = useState<FormError | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = useHydrated();
  const form = useRef<HTMLFormElement>(null);

  const update = (patch: Partial<CheckoutDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setError(null);
  };

  const ticketing = offer.kind === 'TICKET' && offer.ticket !== null;
  const maxTickets = maxSelectableTickets(offer.ticket?.available ?? 0);
  const summary = ticketing && offer.ticket ? ticketSummary(draft.quantity, offer.ticket.pricing, offer.ticket.available) : donationSummary(donationCents(offer, draft, locale), guaranteeCents(draft));

  function validate(): FormError | null {
    if (summary.kind === 'DONATION' && !summary.valid) return { kind: 'amount' };
    if (summary.kind === 'TICKET' && !summary.valid) return { kind: 'quantity' };
    if (!offer.sessionEmail && !EMAIL_SHAPE.test(draft.email.trim())) return { kind: 'email' };
    if (offer.kind === 'DONATION' && offer.certificate && draft.wantsCertificate) {
      if (taxId.trim().length < 5) return { kind: 'fiscal', detail: 'taxId' };
      if (draft.fullName.trim().length < 3 || draft.provinceCode === '') return { kind: 'fiscal', detail: 'fields' };
    }
    return null;
  }

  function handleResult(result: CheckoutStart) {
    switch (result.status) {
      case 'REDIRECT':
        window.location.assign(result.url);
        return;
      case 'INVALID':
        if (result.field === 'taxId') setError({ kind: 'fiscal', detail: 'taxId' });
        else if (result.field === 'fiscal') setError({ kind: 'fiscal', detail: 'fields' });
        else setError({ kind: result.field });
        return;
      case 'SOLD_OUT':
        setError({ kind: 'soldOut', available: result.available });
        setOffer((previous) => (previous.ticket ? { ...previous, ticket: { ...previous.ticket, available: result.available } } : previous));
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
    const next = { ...draft, method };
    setDraft(next);
    saveDraft(offer.initiativeId, next);
    startTransition(async () => {
      try {
        handleResult(await startAction(buildCheckoutPayload(offer, next, taxId, locale, method)));
      } catch {
        setError({ kind: 'network' });
      }
    });
  }

  // Un error de un campo lleva el foco a ese campo (en el móvil puede quedar varias pantallas más arriba del botón): WCAG 3.3.1.
  useEffect(() => {
    if (!error || !['email', 'amount', 'fiscal', 'quantity'].includes(error.kind)) return;
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    invalid?.focus();
    invalid?.scrollIntoView({ block: 'center' });
  }, [error]);
  const fieldError = error !== null && ['email', 'amount', 'fiscal'].includes(error.kind);

  function formMessage(): string | null {
    if (error === null) return null;
    if (error.kind === 'email' || error.kind === 'amount' || error.kind === 'fiscal' || error.kind === 'form') return t('errors.form');
    if (error.kind === 'soldOut') return t('ticket.soldOut', { count: error.available });
    if (error.kind === 'quantity') return t('errors.quantity', { max: maxTickets });
    return t(`errors.${error.kind}`);
  }
  const message = formMessage();

  return (
    <form ref={form} onSubmit={submit} noValidate className="space-y-4">
      {ticketing ? (
        <TicketQuantityField offer={offer} draft={draft} update={update} error={error?.kind === 'quantity' ? t('errors.quantity', { max: maxTickets }) : null} />
      ) : (
        <DonationAmountField offer={offer} draft={draft} update={update} error={error?.kind === 'amount'} />
      )}
      <GroupField offer={offer} draft={draft} update={update} />
      {offer.plaque && !ticketing ? (
        <p className="rounded-xl bg-amber-100 p-3 text-sm font-semibold text-amber-950">
          <span aria-hidden="true">{'🏅 '}</span>
          {t('plaque')}
        </p>
      ) : null}
      {ticketing ? null : <GuaranteeField offer={offer} draft={draft} update={update} />}
      <EmailField offer={offer} draft={draft} update={update} error={error?.kind === 'email'} />
      {ticketing ? null : (
        <FiscalFields
          offer={offer}
          draft={draft}
          update={update}
          taxId={taxId}
          onTaxIdChange={(value) => {
            setTaxId(value);
            setError(null);
          }}
          error={error?.kind === 'fiscal' ? error.detail : null}
          askAgain={askTaxIdAgain}
        />
      )}

      <p className="text-center text-sm italic text-ink-soft">{ticketing ? t('refundNoteTickets') : t('refundNote')}</p>

      {/* Barra fija al pie del diálogo: el total y los botones de pago siempre a la vista, también en el móvil (pago en 10 segundos). */}
      <div className="sticky bottom-0 z-10 -mx-5 -mb-5 space-y-2 border-t border-patio-rule bg-white px-5 pb-4 pt-3 shadow-[0_-10px_16px_-14px_rgb(16_31_56/0.45)] sm:-mx-6 sm:-mb-6 sm:px-6">
      <div id={summaryId} aria-live="polite" className="flex flex-wrap items-center justify-between gap-x-2 rounded-2xl bg-patio-cream px-3.5 py-2" data-testid="checkout-summary">
        <p className="text-sm text-ink-soft">
          <span className="sr-only">{`${t('summary.label')}: `}</span>
          {summary.kind === 'TICKET'
            ? offer.ticket?.pricing.mode === 'ADD'
              ? t('summary.ticketsAdd', { count: summary.quantity, price: money(offer.ticket.pricing.priceCents), fee: money(summary.feeCents) })
              : t('summary.ticketsInc', { count: summary.quantity, price: money(offer.ticket?.pricing.priceCents ?? 0) })
            : summary.guaranteeCents > 0
              ? t('summary.donation', { donation: money(summary.donationCents), guarantee: money(summary.guaranteeCents) })
              : t('summary.donationOnly', { donation: money(summary.donationCents) })}
        </p>
        <p className="font-corp text-lg font-extrabold text-varsity-navy">
          {`${t('summary.total')}: `}
          <CurrencyText cents={summary.totalCents} />
        </p>
      </div>

      {message ? (
        <div role={fieldError ? 'status' : 'alert'} className="space-y-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
          <p>{message}</p>
          {error?.kind === 'soldOut' && error.available > 0 ? (
            <button type="button" onClick={() => update({ quantity: clampQuantity(error.available, error.available) })} className="min-h-11 rounded-lg bg-white px-3 font-extrabold text-varsity-navy underline">
              {t('ticket.useAvailable', { count: error.available })}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <button type="submit" name="method" value="BIZUM" disabled={pending || !ready} aria-describedby={summaryId} className="tactile-btn w-full rounded-2xl! py-4! font-joy text-base">
          <span aria-hidden="true">{'📲 '}</span>
          {t('pay.bizum', { total: money(summary.totalCents) })}
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
