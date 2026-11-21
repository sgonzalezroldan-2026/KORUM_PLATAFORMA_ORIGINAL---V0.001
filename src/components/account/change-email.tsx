'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { confirmEmailChangeAction, requestEmailChangeAction } from '@/app/[locale]/(account)/mi-cuenta/actions';
import { CodeField, FormAlert, linkButton, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { useReauth } from './use-reauth';

/**
 * Cambiar el email de la cuenta (Sprint 5.10b, `L-053`, decisiones 88 y 89). Tres pasos en el mismo bloque: escribir el email nuevo, confirmar la identidad si hace falta
 * (código al email actual o, si la cuenta firma por una entidad, la app de verificación) y escribir el código que llega al email nuevo. Explica antes qué pasa con lo
 * que cuelga del email (pasa al nuevo) y que las demás sesiones se cierran. Cada paso mueve el foco a lo que aparece (WCAG 2.4.3).
 */

type Step = { kind: 'idle' } | { kind: 'email' } | { kind: 'code'; email: string; minutes: number } | { kind: 'done'; email: string };
type Message = { tone: 'error' | 'success' | 'info'; key: string; values?: Record<string, string> };

export function ChangeEmail({ email, twoFactorEnabled, pending, blocked }: { email: string; twoFactorEnabled: boolean; pending: { email: string; minutes: number } | null; blocked: { until: string; afterRevert: boolean } | null }) {
  const t = useTranslations('account.email');
  const format = useFormatter();
  const until = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' });
  const router = useRouter();
  const ids = useId();
  const { request, dialog } = useReauth(email);
  const [step, setStep] = useState<Step>(pending ? { kind: 'code', ...pending } : { kind: 'idle' });
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const focusTarget = useRef<HTMLElement | null>(null);
  // Al cargar la página no se mueve el foco; después, cada paso lo lleva a lo que aparece (también al volver al principio con «Cancelar»).
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) focusTarget.current?.focus();
    mounted.current = true;
  }, [step]);

  /** El error se asocia al campo del paso en que está (`aria-invalid` y `aria-describedby`), además de anunciarse. */
  const fieldError = message?.tone === 'error' && (step.kind === 'email' || step.kind === 'code');
  const errorId = `${ids}-error`;
  /** Cada elemento que puede recibir el foco al cambiar de paso se registra al montarse. */
  const focusable = (node: HTMLElement | null) => {
    if (node) focusTarget.current = node;
  };

  const proof = twoFactorEnabled ? 'second-factor' : 'email';

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await requestEmailChangeAction({ email: newEmail });
      if (result.status === 'CODE_SENT') {
        setCode('');
        setStep({ kind: 'code', email: result.email, minutes: result.minutes });
      } else if (result.status === 'REAUTH_REQUIRED') request(proof, () => void sendCode());
      else if (result.status === 'REJECTED' && result.reason === 'SECOND_FACTOR_REQUIRED') request('second-factor', () => void sendCode());
      else if (result.status === 'REJECTED') setMessage({ tone: 'error', key: `errors.${result.reason}`, values: result.until ? { date: until(result.until) } : undefined });
      else if (result.status === 'LOGIN_REQUIRED') setMessage({ tone: 'error', key: 'errors.LOGIN_REQUIRED' });
      else setMessage({ tone: 'error', key: 'errors.INVALID_EMAIL' });
    } catch {
      setMessage({ tone: 'error', key: 'errors.FAILED' });
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await confirmEmailChangeAction({ code });
      if (result.status === 'CHANGED') {
        setStep({ kind: 'done', email: result.email });
        router.refresh();
      } else if (result.status === 'REAUTH_REQUIRED') request(proof, () => void confirm());
      else if (result.status === 'REJECTED' && result.reason === 'SECOND_FACTOR_REQUIRED') request('second-factor', () => void confirm());
      else if (result.status === 'REJECTED') {
        setMessage({ tone: 'error', key: `errors.${result.reason}`, values: result.until ? { date: until(result.until) } : undefined });
        // Sin código pendiente (caducado, agotado o el email ya tiene cuenta), se vuelve a escribir el email.
        if (result.reason !== 'INVALID_CODE') setStep({ kind: 'email' });
      } else if (result.status === 'LOGIN_REQUIRED') setMessage({ tone: 'error', key: 'errors.LOGIN_REQUIRED' });
      else setMessage({ tone: 'error', key: 'errors.INVALID_CODE' });
    } catch {
      setMessage({ tone: 'error', key: 'errors.FAILED' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="email" aria-labelledby={`${ids}-title`} className="korum-trust-vault flex scroll-mt-4 flex-col gap-4 p-5" data-testid="change-email" aria-busy={busy}>
      <h2 id={`${ids}-title`} className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="wrap-break-word text-ink-soft">{t('current', { email })}</p>
      {step.kind === 'idle' && blocked ? <FormAlert tone="info">{t(blocked.afterRevert ? 'errors.RECENTLY_REVERTED' : 'errors.RECENTLY_CHANGED', { date: until(blocked.until) })}</FormAlert> : null}
      {step.kind === 'idle' && !blocked ? (
        <>
          <p className="text-ink-soft">{t('intro')}</p>
          <button
            type="button"
            ref={focusable}
            className={`${secondaryButton} sm:w-auto sm:self-start`}
            onClick={() => {
              setMessage(null);
              setStep({ kind: 'email' });
            }}
            data-testid="change-email-start"
          >
            {t('start')}
          </button>
        </>
      ) : null}
      {step.kind === 'email' ? (
        <form onSubmit={(event) => void sendCode(event)} className="flex flex-col gap-3" noValidate>
          <p className="text-ink-soft">{t('whatMoves')}</p>
          <label htmlFor={`${ids}-new`} className="font-semibold text-varsity-navy">
            {t('newLabel')}
          </label>
          <input
            id={`${ids}-new`}
            ref={focusable}
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={254}
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            aria-invalid={fieldError && step.kind === 'email' ? true : undefined}
            aria-describedby={fieldError && step.kind === 'email' ? `${ids}-hint ${errorId}` : `${ids}-hint`}
            className="min-h-11 w-full rounded-xl border-2 border-varsity-navy/30 bg-white px-3 text-base"
            data-testid="change-email-input"
          />
          <p id={`${ids}-hint`} className="text-sm text-ink-soft">
            {t(twoFactorEnabled ? 'hintSigner' : 'hint')}
          </p>
          <div className="mobile-stack grid gap-3 sm:flex">
            <button type="submit" className={primaryButton} disabled={busy || newEmail.trim().length < 3} data-testid="change-email-send">
              {busy ? t('sending') : t('send')}
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() => {
                setMessage(null);
                setStep({ kind: 'idle' });
              }}
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : null}
      {step.kind === 'code' ? (
        <form onSubmit={(event) => void confirm(event)} className="flex flex-col gap-3">
          <p
            role="status"
            tabIndex={-1}
            ref={focusable}
            className="wrap-break-word font-semibold text-varsity-navy"
          >
            {t('codeSent', { email: step.email, minutes: step.minutes })}
          </p>
          <CodeField
            label={t('codeLabel')}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            aria-invalid={fieldError && step.kind === 'code' ? true : undefined}
            aria-describedby={fieldError && step.kind === 'code' ? errorId : undefined}
          />
          <p className="text-sm text-ink-soft">{t('sessionsNote')}</p>
          <button type="submit" className={primaryButton} disabled={busy || code.length !== 6} data-testid="change-email-confirm">
            {busy ? t('confirming') : t('confirm')}
          </button>
          <button
            type="button"
            className={linkButton}
            disabled={busy}
            onClick={() => {
              setNewEmail(step.email);
              setStep({ kind: 'email' });
            }}
          >
            {t('again')}
          </button>
        </form>
      ) : null}
      {step.kind === 'done' ? (
        <div
          role="status"
          tabIndex={-1}
          ref={focusable}
          className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4 text-emerald-950"
          data-testid="change-email-done"
        >
          <p className="font-corp text-lg font-extrabold">{t('done.title')}</p>
          <p className="wrap-break-word">{t('done.text', { email: step.email })}</p>
        </div>
      ) : null}
      {message ? (
        <div id={errorId}>
          <FormAlert tone={message.tone}>{t(message.key, message.values)}</FormAlert>
        </div>
      ) : null}
      {dialog}
    </section>
  );
}
