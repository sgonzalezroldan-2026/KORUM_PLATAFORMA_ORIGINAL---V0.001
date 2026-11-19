'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';
import { claimEventRefundAction } from '@/app/[locale]/(public)/[orgSlug]/entrada/devolucion/actions';
import { useHydrated } from '@/components/ui/use-hydrated';
import { useFocusPainted } from '@/lib/use-focus-painted';

/**
 * Botón «Quiero que me devolváis el dinero» del enlace de cambio de fecha (Sprint 5.13). Antes de pedirla se confirma (dice cuánto vuelve y que las entradas
 * dejan de valer); hecha, lo dice aquí mismo y el foco va al aviso. Los errores se anuncian y reciben el foco.
 */
export function EventRefundForm({ orgSlug, token, amountLabel }: { orgSlug: string; token: string; amountLabel: string }) {
  const t = useTranslations('portal.eventRefund');
  const ready = useHydrated();
  const focusPainted = useFocusPainted();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const send = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await claimEventRefundAction({ orgSlug, token });
        if (result.status === 'OK') {
          setDone(true);
          return;
        }
        setError(t(`errors.${result.reason}`));
      } catch {
        setError(t('errors.FAILED'));
      }
      setConfirming(false);
      focusPainted(() => errorRef.current);
    });
  };

  if (done) {
    return (
      <div ref={doneRef} tabIndex={-1} role="status" className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4 text-emerald-950" data-testid="event-refund-done">
        <p className="font-corp text-xl font-extrabold">{t('done.title')}</p>
        <p>{t('done.text')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-xl border-2 border-red-700 bg-red-50 p-3 font-semibold text-red-900">
          {error}
        </p>
      ) : null}
      {confirming ? (
        <div ref={confirmRef} tabIndex={-1} role="alertdialog" aria-labelledby="event-refund-confirm-text" className="korum-trust-vault flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-white p-4" data-testid="event-refund-confirm">
          <p id="event-refund-confirm-text" className="font-semibold">
            {t('confirm', { amount: amountLabel })}
          </p>
          <button type="button" className="tactile-btn" disabled={pending} onClick={send} data-testid="event-refund-yes">
            {pending ? t('sending') : t('yes')}
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy"
            disabled={pending}
            onClick={() => {
              setConfirming(false);
              focusPainted(() => askRef.current);
            }}
          >
            {t('no')}
          </button>
        </div>
      ) : (
        <button ref={askRef} type="button" className="tactile-btn" disabled={!ready} onClick={() => setConfirming(true)} data-testid="event-refund-ask">
          {t('ask', { amount: amountLabel })}
        </button>
      )}
    </div>
  );
}
