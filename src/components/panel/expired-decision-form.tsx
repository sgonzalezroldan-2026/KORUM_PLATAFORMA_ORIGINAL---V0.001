'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { decideRefundAction, launchResizeVoteAction, type ExpiredActionResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/vencidas/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { RESIZE_OPTION_MAX_LENGTH, RESIZE_OPTION_MIN_LENGTH, RESIZE_OPTIONS_MAX, RESIZE_OPTIONS_MIN, RESIZE_POLL_DAYS, hasDuplicateOptions } from '@/core/resize/resize-limits';
import type { VoteBlocker } from '@/repositories/expired-campaigns.repository';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Qué hacer con una campaña vencida (Sprint 4.4b, prototipo `sendResizePollToDonors` y `executeAutomaticRefundAndSponsorReassign`): preguntar a quienes
 * donaron con 2 a 4 opciones de proyecto, o devolver el 100 % a todas las personas. Las dos piden una confirmación con lo que va a pasar, porque no se
 * pueden deshacer. Los errores van junto a su campo y se anuncian; el resultado, en el aviso de la página (la tarjeta cambia al recargar).
 */

type Step = 'idle' | 'confirmVote' | 'confirmRefund';

export function ExpiredDecisionForm({ orgSlug, initiativeId, title, donors, voteBlockers }: { orgSlug: string; initiativeId: number; title: string; donors: number; voteBlockers: VoteBlocker[] }) {
  const t = useTranslations('panel.expired.decide');
  const tErrors = useTranslations('panel.expired.errors');
  const announce = useApprovalsNotice();
  const format = useFormatter();
  const router = useRouter();
  const base = useId();
  const [options, setOptions] = useState<string[]>(['', '']);
  const [optionErrors, setOptionErrors] = useState<Record<number, string>>({});
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmRef = useRef<HTMLDivElement>(null);
  const voteButton = useRef<HTMLButtonElement>(null);
  const refundButton = useRef<HTMLButtonElement>(null);
  const canVote = voteBlockers.length === 0;

  useEffect(() => {
    if (step !== 'idle') confirmRef.current?.focus();
  }, [step]);

  const cancel = () => {
    const back = step === 'confirmVote' ? voteButton : refundButton;
    setStep('idle');
    requestAnimationFrame(() => back.current?.focus());
  };

  const send = (action: () => Promise<ExpiredActionResult>) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.status === 'ERROR') {
          setStep('idle');
          setError(tErrors(result.reason));
          return;
        }
        announce(result.decision === 'RESIZE_VOTING' ? t('voteLaunched', { date: format.dateTime(new Date(result.closesAt ?? Date.now()), { dateStyle: 'long', timeZone: 'Europe/Madrid' }) }) : t('refundStarted'));
        router.refresh();
      } catch {
        setStep('idle');
        setError(tErrors('failed'));
      }
    });
  };

  const checkOptions = (): boolean => {
    const found: Record<number, string> = {};
    options.forEach((option, index) => {
      const length = option.trim().length;
      if (length < RESIZE_OPTION_MIN_LENGTH || length > RESIZE_OPTION_MAX_LENGTH) found[index] = t('optionLength', { min: RESIZE_OPTION_MIN_LENGTH, max: RESIZE_OPTION_MAX_LENGTH });
    });
    if (Object.keys(found).length === 0 && hasDuplicateOptions(options.map((option) => option.trim()))) found[options.length - 1] = tErrors('DUPLICATE_OPTIONS');
    setOptionErrors(found);
    const first = Object.keys(found).map(Number)[0];
    if (first !== undefined) document.getElementById(`${base}-option-${first}`)?.focus();
    return first === undefined;
  };

  return (
    <div className="flex flex-col gap-4" data-testid={`expired-decision-${initiativeId}`}>
      <section aria-labelledby={`${base}-vote`} className="korum-notebook-sheet flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy/20 bg-white p-4 ps-12">
        <h3 id={`${base}-vote`} className="font-joy text-lg font-bold text-varsity-navy">{`🗳️ ${t('voteTitle')}`}</h3>
        <p className="text-sm text-ink-soft">{t('voteRules', { days: RESIZE_POLL_DAYS, donors })}</p>
        {canVote ? (
          <>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 font-bold text-varsity-navy">{t('optionsLegend', { min: RESIZE_OPTIONS_MIN, max: RESIZE_OPTIONS_MAX })}</legend>
              {options.map((option, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <label htmlFor={`${base}-option-${index}`} className="text-sm font-bold text-varsity-navy">
                    {t('optionLabel', { letter: String.fromCharCode(65 + index) })}
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={`${base}-option-${index}`}
                      value={option}
                      maxLength={RESIZE_OPTION_MAX_LENGTH}
                      onChange={(event) => setOptions(options.map((value, position) => (position === index ? event.target.value : value)))}
                      placeholder={t(index === 0 ? 'optionPlaceholderA' : 'optionPlaceholderB')}
                      aria-required="true"
                      aria-invalid={optionErrors[index] ? true : undefined}
                      aria-describedby={optionErrors[index] ? `${base}-option-${index}-error` : undefined}
                      className="min-h-11 w-full rounded-xl border-2 border-varsity-navy/30 bg-white px-3 focus-visible:border-varsity-navy aria-invalid:border-red-700"
                    />
                    {options.length > RESIZE_OPTIONS_MIN ? (
                      <button type="button" onClick={() => setOptions(options.filter((_, position) => position !== index))} className="min-h-11 min-w-11 rounded-xl border-2 border-varsity-navy/30 px-3 text-sm font-bold text-varsity-navy" aria-label={t('removeOption', { letter: String.fromCharCode(65 + index) })}>
                        <span aria-hidden="true">{'✕'}</span>
                      </button>
                    ) : null}
                  </div>
                  {optionErrors[index] ? (
                    <p id={`${base}-option-${index}-error`} role="alert" className="text-sm font-semibold text-red-800">
                      {optionErrors[index]}
                    </p>
                  ) : null}
                </div>
              ))}
              <p className="rounded-xl border-2 border-dashed border-varsity-navy/30 p-3 text-sm text-varsity-navy">{`↩️ ${t('refundOptionAlways')}`}</p>
            </fieldset>
            {options.length < RESIZE_OPTIONS_MAX ? (
              <button type="button" onClick={() => setOptions([...options, ''])} className="inline-flex min-h-11 w-fit items-center rounded-xl border-2 border-varsity-navy/30 px-4 text-sm font-bold text-varsity-navy">
                {`+ ${t('addOption')}`}
              </button>
            ) : null}
            <button ref={voteButton} type="button" disabled={pending || step !== 'idle'} onClick={() => checkOptions() && setStep('confirmVote')} className="tactile-btn self-start disabled:opacity-60">
              {`🗳️ ${t('launchVote')}`}
            </button>
          </>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t('voteBlockedLabel')} data-testid={`expired-vote-blocked-${initiativeId}`}>
            {voteBlockers.map((blocker) => (
              <li key={blocker} className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                {t(`voteBlocked.${blocker}`)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${base}-refund`} className="flex flex-col gap-3 rounded-2xl border-2 border-rose-200 bg-rose-50 p-4">
        <h3 id={`${base}-refund`} className="font-corp text-lg font-extrabold text-rose-950">{`↩️ ${t('refundTitle')}`}</h3>
        <p className="text-sm text-rose-950">{t('refundText')}</p>
        <button ref={refundButton} type="button" disabled={pending || step !== 'idle'} onClick={() => setStep('confirmRefund')} className="inline-flex min-h-11 w-fit items-center rounded-xl border-2 border-rose-800 bg-white px-4 font-corp font-extrabold text-rose-950 disabled:opacity-60">
          {t('refundButton')}
        </button>
      </section>

      {step !== 'idle' ? (
        <div ref={confirmRef} tabIndex={-1} role="alertdialog" aria-labelledby={`${base}-confirm`} aria-describedby={`${base}-confirm-text`} onKeyDown={(event) => event.key === 'Escape' && !pending && cancel()} className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-varsity-ivory p-4" data-testid={`expired-confirm-${initiativeId}`}>
          <h3 id={`${base}-confirm`} className="font-corp text-lg font-extrabold text-varsity-navy">
            {t(step === 'confirmVote' ? 'confirmVoteTitle' : 'confirmRefundTitle', { title })}
          </h3>
          <p id={`${base}-confirm-text`} className="text-sm text-varsity-navy">
            {t(step === 'confirmVote' ? 'confirmVoteText' : 'confirmRefundText', { days: RESIZE_POLL_DAYS, donors })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => send(() => (step === 'confirmVote' ? launchResizeVoteAction(orgSlug, { initiativeId, options: options.map((option) => option.trim()) }) : decideRefundAction(orgSlug, { initiativeId })))}
              className="tactile-btn disabled:opacity-60"
            >
              {pending ? t('sending') : t(step === 'confirmVote' ? 'confirmVote' : 'confirmRefund')}
            </button>
            <button type="button" disabled={pending} onClick={cancel} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy/30 bg-white px-4 font-bold text-varsity-navy">
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </div>
  );
}
