'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { castResizeVoteAction } from '@/app/[locale]/(public)/[orgSlug]/votacion/actions';
import { useHydrated } from '@/components/ui/use-hydrated';

/**
 * Papeleta de la votación de redimensionamiento (Sprint 4.4b): las opciones de proyecto y, siempre, «Prefiero que me devolváis mi aportación». Un voto por
 * persona que no se cambia, así que antes de enviarlo se confirma (y la devolución dice cuánto se devuelve y adónde). Los errores se anuncian y reciben el
 * foco. Registrado el voto, lo dice aquí mismo (sin recargar la página) y el foco va al aviso.
 */

type Choice = { kind: 'OPTION'; index: number } | { kind: 'REFUND' };

export function ResizeBallotForm({ orgSlug, token, options, refundLabel }: { orgSlug: string; token: string; options: string[]; refundLabel: string }) {
  const t = useTranslations('portal.resizeVote');
  const ready = useHydrated();
  const legend = useId();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Choice | null>(null);
  const [pending, startTransition] = useTransition();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const back = () => {
    setConfirming(false);
    requestAnimationFrame(() => submitRef.current?.focus());
  };

  const value = (option: Choice) => (option.kind === 'REFUND' ? 'refund' : `option-${option.index}`);
  const chosenLabel = choice ? (choice.kind === 'REFUND' ? t('refundOption') : (options[choice.index] ?? '')) : '';

  const send = () => {
    if (!choice) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await castResizeVoteAction({ orgSlug, token, choice });
        if (result.status === 'OK') {
          setDone(choice);
          return;
        }
        setConfirming(false);
        setError(t(`errors.${result.reason}`));
      } catch {
        setConfirming(false);
        setError(t('errors.FAILED'));
      }
      requestAnimationFrame(() => errorRef.current?.focus());
    });
  };

  const choices: Choice[] = [...options.map((_, index) => ({ kind: 'OPTION' as const, index })), { kind: 'REFUND' }];

  if (done) {
    return (
      <div ref={doneRef} tabIndex={-1} role="status" className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4 text-emerald-950" data-testid="resize-ballot-done">
        <p className="font-joy text-xl font-bold">{`${done.kind === 'REFUND' ? '↩️' : '🗳️'} ${t('voted.title')}`}</p>
        <p className="wrap-anywhere">{done.kind === 'REFUND' ? `${t('voted.refund')} ${t('voted.refundNotice')}` : t('voted.option', { option: options[done.index] ?? '' })}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!choice) {
          setError(t('errors.INVALID_CHOICE'));
          requestAnimationFrame(() => errorRef.current?.focus());
          return;
        }
        setConfirming(true);
      }}
      className="flex flex-col gap-4"
      data-testid="resize-ballot"
    >
      <fieldset className="flex flex-col gap-2" aria-labelledby={legend} aria-describedby={error ? `${legend}-error` : undefined}>
        <legend id={legend} className="mb-1 font-bold text-varsity-navy">
          {t('legend')}
        </legend>
        {choices.map((option) => (
          <label key={value(option)} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border-2 border-stone-200 bg-white p-3 has-checked:border-varsity-navy has-checked:bg-varsity-ivory">
            <input
              type="radio"
              name="resize-choice"
              value={value(option)}
              checked={choice !== null && value(choice) === value(option)}
              onChange={() => {
                setChoice(option);
                setConfirming(false);
              }}
              className="mt-1 size-5 shrink-0 accent-varsity-navy"
            />
            <span className="flex flex-col">
              <span className="font-semibold wrap-anywhere">{option.kind === 'REFUND' ? `↩️ ${t('refundOption')}` : `${String.fromCharCode(65 + option.index)}. ${options[option.index] ?? ''}`}</span>
              {option.kind === 'REFUND' ? <span className="text-sm text-ink-soft">{refundLabel}</span> : null}
            </span>
          </label>
        ))}
      </fieldset>
      {!confirming ? (
        <button ref={submitRef} type="submit" disabled={pending || !ready} className="tactile-btn w-full rounded-2xl! py-4! font-joy text-base disabled:opacity-60">
          {`🗳️ ${t('submit')}`}
        </button>
      ) : (
        <div ref={confirmRef} tabIndex={-1} role="alertdialog" aria-labelledby={`${legend}-confirm`} aria-describedby={`${legend}-confirm-text`} onKeyDown={(event) => event.key === 'Escape' && !pending && back()} className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-varsity-ivory p-4" data-testid="resize-ballot-confirm">
          <p id={`${legend}-confirm`} className="font-bold text-varsity-navy wrap-anywhere">
            {t('confirmTitle', { choice: chosenLabel })}
          </p>
          <p id={`${legend}-confirm-text`} className="text-sm text-varsity-navy">
            {choice?.kind === 'REFUND' ? t('confirmRefund', { amount: refundLabel }) : t('confirmOption')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={send} className="tactile-btn disabled:opacity-60">
              {pending ? t('sending') : t('confirm')}
            </button>
            <button type="button" disabled={pending} onClick={back} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy/30 bg-white px-4 font-bold text-varsity-navy">
              {t('back')}
            </button>
          </div>
        </div>
      )}
      {error ? (
        <p ref={errorRef} id={`${legend}-error`} tabIndex={-1} role="alert" className="rounded-lg border-2 border-red-700 bg-red-50 p-2 text-sm font-semibold text-red-900">
          {error}
        </p>
      ) : null}
    </form>
  );
}
