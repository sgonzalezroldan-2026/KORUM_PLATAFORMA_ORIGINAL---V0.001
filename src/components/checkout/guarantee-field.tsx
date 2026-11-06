'use client';

import clsx from 'clsx';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { GUARANTEE_MAX_CENTS } from '@/core/checkout/checkout-limits';
import { isLocale } from '@/i18n/routing';
import { useMoney } from '@/components/portal/use-money';
import { parseTypedCents, type CheckoutDraft, type CheckoutOffer } from './checkout-draft';
import { FieldError } from './checkout-fields';

/**
 * Aportación voluntaria a KORUM (Regla 03 §3, QA-F04): el check va **desmarcado** al abrir y el título muestra el importe que se sumaría. El
 * texto del punto (3) depende de si la entidad puede emitir certificado fiscal. El selector manual va desde 0 €: elegir un importe marca el
 * check y elegir 0 € lo desmarca, así que lo que se ve es siempre lo que se cobra.
 */
export function GuaranteeField({ offer, draft, update }: { offer: CheckoutOffer; draft: CheckoutDraft; update: (patch: Partial<CheckoutDraft>) => void }) {
  const t = useTranslations('portal.checkout.guarantee');
  const money = useMoney();
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const checkId = useId();
  const descriptionId = useId();
  const otherId = useId();
  const errorId = useId();
  const [adjusting, setAdjusting] = useState(draft.customGuarantee !== '' || draft.guaranteeCents !== offer.guarantee.suggestedCents);
  const typed = parseTypedCents(draft.customGuarantee, locale);
  const typedInvalid = draft.customGuarantee !== '' && (typed === null || typed > GUARANTEE_MAX_CENTS);

  function choose(cents: number) {
    update({ guaranteeCents: cents, guaranteeOn: cents > 0, customGuarantee: '' });
  }

  function type(text: string) {
    const cents = parseTypedCents(text, locale);
    if (cents === null || cents > GUARANTEE_MAX_CENTS) update({ customGuarantee: text, guaranteeOn: false });
    else update({ customGuarantee: text, guaranteeCents: cents, guaranteeOn: cents > 0 });
  }

  return (
    <div className="space-y-2.5 rounded-2xl border border-emerald-300 bg-emerald-50 p-3.5">
      <div className="flex items-start gap-3">
        <label htmlFor={checkId} className="-mx-2.5 -my-2 flex size-11 shrink-0 cursor-pointer items-center justify-center">
        <input
          id={checkId}
          type="checkbox"
          checked={draft.guaranteeOn}
          onChange={(event) => update({ guaranteeOn: event.target.checked, guaranteeCents: event.target.checked && draft.guaranteeCents === 0 ? offer.guarantee.suggestedCents : draft.guaranteeCents })}
          aria-describedby={descriptionId}
          className="size-5 accent-emerald-700"
          data-testid="guarantee-check"
        />
        </label>
        <div className="space-y-1">
          <label htmlFor={checkId} className="block cursor-pointer font-extrabold text-varsity-navy" data-testid="guarantee-title">
            {t('title', { amount: money(draft.guaranteeCents) })}
          </label>
          <p id={descriptionId} className="text-sm leading-relaxed text-ink" data-testid="guarantee-description">
            {offer.certificate ? t('descriptionCertificate') : t('descriptionReceipt')}
          </p>
        </div>
      </div>

      <div className="border-t border-emerald-200 pt-2">
        <button type="button" onClick={() => setAdjusting((open) => !open)} aria-expanded={adjusting} className="min-h-11 text-start text-sm font-bold text-emerald-900 underline underline-offset-2">
          <span aria-hidden="true">{'⚙️ '}</span>
          {t('adjust')}
        </button>
        {adjusting ? (
          <div className="space-y-2 pt-1">
            <fieldset>
              <legend className="sr-only">{t('legend')}</legend>
              <div className="grid grid-cols-4 gap-1.5">
                {offer.guarantee.choicesCents.map((cents) => {
                  const selected = draft.customGuarantee === '' && (draft.guaranteeOn ? draft.guaranteeCents === cents : cents === 0);
                  return (
                    <label
                      key={cents}
                      className={clsx(
                        'flex min-h-11 cursor-pointer items-center justify-center rounded-lg border-2 px-1 font-corp text-sm font-extrabold tabular-nums has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-varsity-navy',
                        selected ? 'border-varsity-emerald bg-white text-emerald-950' : 'border-emerald-200 bg-white/70 text-varsity-navy'
                      )}
                    >
                      <input type="radio" name="guarantee-amount" className="sr-only" checked={selected} onChange={() => choose(cents)} />
                      {money(cents)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label htmlFor={otherId} className="block text-sm font-bold text-varsity-navy">
              {t('otherLabel')}
            </label>
            <input
              id={otherId}
              inputMode="decimal"
              autoComplete="off"
              value={draft.customGuarantee}
              onChange={(event) => type(event.target.value)}
              aria-invalid={typedInvalid || undefined}
              aria-describedby={typedInvalid ? errorId : undefined}
              className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold aria-invalid:border-red-700"
            />
            <FieldError id={errorId} message={typedInvalid ? t('error', { max: money(GUARANTEE_MAX_CENTS) }) : null} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
