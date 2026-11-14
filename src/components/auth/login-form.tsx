'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useHydrated } from '@/components/ui/use-hydrated';
import { authClient, authErrorCode, localeHeaders } from '@/lib/auth/auth-client';
import { CodeField, Field, focusFirstInvalid, FormAlert, linkButton, secondaryButton, SubmitButton } from './auth-ui';
import { SecondFactorForm } from './second-factor-form';

/**
 * Acceso por rol (ARQUITECTURA_LANDING §2). Familias y comercios: enlace mágico o código por email, sin contraseña. Firmantes y Super-Admin:
 * contraseña y, después, el código de su app de verificación. Cualquiera que haya registrado una llave de acceso en *Mi cuenta* (Sprint 3.7) puede
 * entrar con ella, sin email ni contraseña. Tras entrar se va a `/acceso/continuar`, que lleva a cada persona a su sitio.
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
  'KORUM_ACCOUNT_CLOSED',
  'PASSKEY_FAILED'
]);

/** Errores de un campo concreto: se dicen junto a él (`aria-invalid` + `aria-describedby`), no en el aviso general (Sprint 5.5b, heredado del 3.2). */
const EMAIL_FIELD_ERRORS = new Set(['INVALID_EMAIL', 'KORUM_INVALID_EMAIL', 'KORUM_DISPOSABLE_EMAIL']);
const CODE_FIELD_ERRORS = new Set(['INVALID_OTP', 'OTP_EXPIRED']);

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
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const hydrated = useHydrated();
  // Un error de campo devuelve el foco a ese campo (el botón que lo provocó estaba deshabilitado mientras se enviaba).
  useEffect(() => {
    if (error !== null && (EMAIL_FIELD_ERRORS.has(error) || CODE_FIELD_ERRORS.has(error))) focusFirstInvalid(rootRef.current);
  }, [error]);
  const passkeysSupported = hydrated && 'PublicKeyCredential' in window;

  const message = (key: string | null) => (key ? te(KNOWN_ERRORS.has(key) || key === 'LINK_INVALID' ? key : 'UNKNOWN') : null);
  const go = (next: Step, options: { focusHeading?: boolean } = {}) => {
    setStep(next);
    setCode('');
    if (options.focusHeading !== false) requestAnimationFrame(() => headingRef.current?.focus());
  };
  const finish = () => router.push(continueUrl);

  async function run(action: () => Promise<{ error: { code?: string; status?: number } | null } | void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result && result.error) {
        const code = authErrorCode(result.error);
        // En los pasos donde solo se escribe el email, el servidor rechaza con `VALIDATION_ERROR` lo que el navegador da por bueno (`a@b`): es un email no válido
        // y se dice junto a su campo (revisión de experiencia del 5.5b).
        setError(code === 'VALIDATION_ERROR' && (step === 'enter' || step === 'reset-request' || step === 'link-sent') ? 'INVALID_EMAIL' : code);
      }
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
    // Al cambiar de modo el foco se queda en el botón pulsado: saltar al título obligaría a volver con el teclado (revisión de experiencia del 3.2).
    go('enter', { focusHeading: false });
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
  const signInWithPasskey = () =>
    run(async () => {
      const result = await authClient.signIn.passkey();
      if (!result?.error) return finish();
      // Cerrar el diálogo del sistema no es un error que haya que explicar.
      const code = 'code' in result.error ? result.error.code : undefined;
      if (code === 'AUTH_CANCELLED' || code === 'ERROR_CEREMONY_ABORTED') return;
      return { error: code === 'KORUM_ACCOUNT_CLOSED' || code === 'RATE_LIMITED' ? result.error : { code: 'PASSKEY_FAILED' } };
    });
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

  const fieldError = error !== null && (EMAIL_FIELD_ERRORS.has(error) || CODE_FIELD_ERRORS.has(error)) ? error : null;
  const emailError = fieldError !== null && EMAIL_FIELD_ERRORS.has(fieldError) ? message(fieldError) : null;
  const codeError = fieldError !== null && CODE_FIELD_ERRORS.has(fieldError) ? message(fieldError) : null;
  const emailField = <Field label={t('email')} type="email" autoComplete="email" required value={email} error={emailError} onChange={(event) => setEmail(event.target.value)} />;
  const codeField = <CodeField label={t('code')} value={code} error={codeError} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />;

  return (
    <div ref={rootRef} className="flex flex-col gap-5">
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
      {error && !fieldError ? <FormAlert>{message(error)}</FormAlert> : null}

      {mode === 'email' && step === 'enter' ? (
        <form onSubmit={sendLink} className="flex flex-col gap-4" noValidate={false}>
          <p className="text-ink-soft">{t('emailIntro')}</p>
          {emailField}
          <SubmitButton busy={busy}>{t('sendLink')}</SubmitButton>
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
          {codeField}
          <SubmitButton busy={busy} disabled={code.length !== 6}>
            {t('enter')}
          </SubmitButton>
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
          <SubmitButton busy={busy}>{t('enter')}</SubmitButton>
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

      {step === 'enter' && passkeysSupported ? (
        <div className="flex flex-col gap-2 border-t-2 border-varsity-navy/10 pt-4">
          <p className="text-sm text-ink-soft">{t('passkeyIntro')}</p>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void signInWithPasskey()} data-testid="passkey-sign-in">
            <span aria-hidden="true">{'🔑 '}</span>
            {t('passkey')}
          </button>
        </div>
      ) : null}

      {step === 'second-factor' ? <SecondFactorForm onDone={finish} onBack={() => go('enter')} /> : null}

      {step === 'reset-request' ? (
        <form onSubmit={requestReset} className="flex flex-col gap-4">
          <p className="text-ink-soft">{t('resetIntro')}</p>
          {emailField}
          <SubmitButton busy={busy}>{t('sendResetCode')}</SubmitButton>
          <button type="button" className={linkButton} onClick={() => go('enter')}>
            {t('back')}
          </button>
        </form>
      ) : null}

      {step === 'reset-code' ? (
        <form onSubmit={resetPassword} className="flex flex-col gap-4">
          <p className="text-ink-soft">{t('codeSent', { email, minutes: 10 })}</p>
          {codeField}
          <Field label={t('newPassword')} hint={t('passwordHint')} type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} />
          <SubmitButton busy={busy} disabled={code.length !== 6 || password.length < 12}>
            {t('savePassword')}
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
