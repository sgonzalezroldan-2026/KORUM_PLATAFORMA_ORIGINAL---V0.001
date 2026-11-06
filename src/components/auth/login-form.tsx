'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { authClient, authErrorCode, localeHeaders } from '@/lib/auth/auth-client';
import { CodeField, Field, FormAlert, linkButton, primaryButton, secondaryButton } from './auth-ui';
import { SecondFactorForm } from './second-factor-form';

/**
 * Acceso por rol (ARQUITECTURA_LANDING §2). Familias y comercios: enlace mágico o código por email, sin contraseña. Firmantes y Super-Admin:
 * contraseña y, después, el código de su app de verificación. Tras entrar se va a `/acceso/continuar`, que lleva a cada persona a su sitio.
 */

type Mode = 'email' | 'password';
type Step = 'enter' | 'link-sent' | 'code' | 'second-factor' | 'reset-request' | 'reset-code';

const KNOWN_ERRORS = new Set([
  'INVALID_EMAIL_OR_PASSWORD',
  'EMAIL_NOT_VERIFIED',
  'INVALID_OTP',
  'OTP_EXPIRED',
  'TOO_MANY_ATTEMPTS',
  'INVALID_EMAIL',
  'PASSWORD_TOO_SHORT',
  'RATE_LIMITED',
  'KORUM_SAME_INBOX',
  'KORUM_DISPOSABLE_EMAIL',
  'KORUM_INVALID_EMAIL',
  'KORUM_ACCOUNT_CLOSED'
]);

export function LoginForm({ continueUrl, loginUrl, initialError }: { continueUrl: string; loginUrl: string; initialError: string | null }) {
  const t = useTranslations('auth.login');
  const te = useTranslations('auth.errors');
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>('email');
  const [step, setStep] = useState<Step>('enter');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError && KNOWN_ERRORS.has(initialError) ? initialError : initialError ? 'LINK_INVALID' : null);
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const router = useRouter();

  const message = (key: string | null) => (key ? te(KNOWN_ERRORS.has(key) || key === 'LINK_INVALID' ? key : 'UNKNOWN') : null);
  const go = (next: Step) => {
    setStep(next);
    setCode('');
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  const finish = () => router.push(continueUrl);

  async function run(action: () => Promise<{ error: { code?: string; status?: number } | null } | void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result && result.error) setError(authErrorCode(result.error));
    } catch {
      setError('UNKNOWN');
    } finally {
      setBusy(false);
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    go('enter');
  };

  const sendLink = (event?: FormEvent) => {
    event?.preventDefault();
    void run(async () => {
      const result = await authClient.signIn.magicLink({ email, callbackURL: continueUrl, errorCallbackURL: loginUrl }, localeHeaders(locale));
      if (!result.error) go('link-sent');
      return result;
    });
  };
  const sendCode = () =>
    run(async () => {
      const result = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }, localeHeaders(locale));
      if (!result.error) go('code');
      return result;
    });
  const verifyCode = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.signIn.emailOtp({ email, otp: code }, localeHeaders(locale));
      if (!result.error) finish();
      return result;
    });
  };
  const signInWithPassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) return result;
      if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) go('second-factor');
      else finish();
    });
  };
  const requestReset = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.emailOtp.requestPasswordReset({ email }, localeHeaders(locale));
      if (!result.error) go('reset-code');
      return result;
    });
  };
  const resetPassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.emailOtp.resetPassword({ email, otp: code, password });
      if (!result.error) {
        setPassword('');
        go('enter');
        setNotice(t('resetDone'));
      }
      return result;
    });
  };

  const emailField = <Field label={t('email')} type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />;

  return (
    <div className="flex flex-col gap-5">
      <div role="group" aria-label={t('modeLabel')} className="grid grid-cols-2 gap-2 rounded-2xl bg-varsity-navy/5 p-1">
        {(['email', 'password'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            onClick={() => switchMode(option)}
            className={`min-h-11 rounded-xl px-3 text-sm font-bold ${mode === option ? 'bg-varsity-navy text-varsity-ivory' : 'text-varsity-navy hover:bg-varsity-navy/10'}`}
          >
            {t(`mode.${option}`)}
          </button>
        ))}
      </div>

      <h2 ref={headingRef} tabIndex={-1} className="font-corp text-xl font-extrabold text-varsity-navy">
        {t(`steps.${mode === 'email' && step === 'enter' ? 'emailEnter' : step === 'enter' ? 'passwordEnter' : step}`)}
      </h2>
      {notice ? <FormAlert tone="success">{notice}</FormAlert> : null}
      {error ? <FormAlert>{message(error)}</FormAlert> : null}

      {mode === 'email' && step === 'enter' ? (
        <form onSubmit={sendLink} className="flex flex-col gap-4" noValidate={false}>
          <p className="text-ink-soft">{t('emailIntro')}</p>
          {emailField}
          <button type="submit" className={primaryButton} disabled={busy}>
            {t('sendLink')}
          </button>
          <button type="button" className={secondaryButton} disabled={busy || email === ''} onClick={() => void sendCode()}>
            {t('sendCode')}
          </button>
        </form>
      ) : null}

      {step === 'link-sent' ? (
        <div className="flex flex-col gap-4">
          <FormAlert tone="info">{t('linkSent', { email, minutes: 15 })}</FormAlert>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void sendCode()}>
            {t('useCodeInstead')}
          </button>
          <button type="button" className={linkButton} onClick={() => go('enter')}>
            {t('changeEmail')}
          </button>
        </div>
      ) : null}

      {step === 'code' ? (
        <form onSubmit={verifyCode} className="flex flex-col gap-4">
          <p className="text-ink-soft">{t('codeSent', { email, minutes: 10 })}</p>
          <CodeField label={t('code')} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
          <button type="submit" className={primaryButton} disabled={busy || code.length !== 6}>
            {t('enter')}
          </button>
          <button type="button" className={linkButton} onClick={() => go('enter')}>
            {t('changeEmail')}
          </button>
        </form>
      ) : null}

      {mode === 'password' && step === 'enter' ? (
        <form onSubmit={signInWithPassword} className="flex flex-col gap-4">
          <p className="text-ink-soft">{t('passwordIntro')}</p>
          {emailField}
          <Field label={t('password')} type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="submit" className={primaryButton} disabled={busy}>
            {t('enter')}
          </button>
          <button type="button" className={linkButton} onClick={() => {
              setError(null);
              setNotice(null);
              setPassword('');
              go('reset-request');
            }}>
            {t('forgot')}
          </button>
        </form>
      ) : null}

      {step === 'second-factor' ? <SecondFactorForm onDone={finish} onBack={() => go('enter')} /> : null}

      {step === 'reset-request' ? (
        <form onSubmit={requestReset} className="flex flex-col gap-4">
          <p className="text-ink-soft">{t('resetIntro')}</p>
          {emailField}
          <button type="submit" className={primaryButton} disabled={busy}>
            {t('sendResetCode')}
          </button>
          <button type="button" className={linkButton} onClick={() => go('enter')}>
            {t('back')}
          </button>
        </form>
      ) : null}

      {step === 'reset-code' ? (
        <form onSubmit={resetPassword} className="flex flex-col gap-4">
          <p className="text-ink-soft">{t('codeSent', { email, minutes: 10 })}</p>
          <CodeField label={t('code')} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
          <Field label={t('newPassword')} hint={t('passwordHint')} type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="submit" className={primaryButton} disabled={busy || code.length !== 6 || password.length < 12}>
            {t('savePassword')}
          </button>
        </form>
      ) : null}
    </div>
  );
}
