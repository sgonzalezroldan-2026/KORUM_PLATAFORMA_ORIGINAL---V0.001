'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CodeField, FormAlert, linkButton, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { SecondFactorForm } from '@/components/auth/second-factor-form';
import { authClient, authErrorCode, localeHeaders } from '@/lib/auth/auth-client';

/**
 * Confirmar que es la propia persona antes de exportar sus datos, suprimir su cuenta o añadir una llave de acceso (Sprint 3.7). Por defecto con
 * un código de 6 dígitos al email de la cuenta (`/sign-in/email-otp`, que marca `reauthenticatedAt`); si la operación exige el segundo factor
 * (añadir una llave en una cuenta con 2FA), con la app de verificación. Vale 10 minutos: dentro de ese plazo no se vuelve a pedir.
 */

const KNOWN = new Set(['INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS', 'RATE_LIMITED']);

export interface ReauthDialogProps {
  open: boolean;
  email: string;
  /** `second-factor`: solo vale la app de verificación (cuentas con 2FA que añaden una llave). */
  proof: 'email' | 'second-factor';
  onVerified: () => void;
  onClose: () => void;
}

export function ReauthDialog({ open, email, proof, onVerified, onClose }: ReauthDialogProps) {
  const t = useTranslations('account.reauth');
  const te = useTranslations('auth.errors');
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [step, setStep] = useState<'send' | 'code'>('send');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeForm = useRef<HTMLFormElement>(null);

  // Al pasar al paso del código, el botón «Enviar código» desaparece: el foco va al campo (WCAG 2.4.3) y el aviso se anuncia (role=status).
  useEffect(() => {
    if (step === 'code') codeForm.current?.querySelector('input')?.focus();
  }, [step]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      setStep('send');
      setCode('');
      setError(null);
      node.showModal();
    }
    if (!open && node.open) node.close();
  }, [open]);

  async function run(action: () => Promise<{ error: { code?: string; status?: number } | null }>, next: () => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.error) setError(authErrorCode(result.error));
      else next();
    } catch {
      setError('UNKNOWN');
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    void run(
      () => authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }, localeHeaders(locale)),
      () => {
        setCode('');
        setStep('code');
      }
    );

  const verify = (event: FormEvent) => {
    event.preventDefault();
    void run(() => authClient.signIn.emailOtp({ email, otp: code }, localeHeaders(locale)), onVerified);
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      onClose={onClose}
      className="m-auto w-[min(100%-2rem,28rem)] rounded-3xl border-2 border-varsity-navy bg-white p-0 text-ink backdrop:bg-varsity-navy/60"
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id={headingId} className="font-corp text-xl font-extrabold text-varsity-navy">
          {t('title')}
        </h2>
        {error ? <FormAlert>{te(KNOWN.has(error) ? error : 'UNKNOWN')}</FormAlert> : null}
        {proof === 'second-factor' ? (
          <SecondFactorForm onDone={onVerified} />
        ) : step === 'send' ? (
          <>
            <p className="text-ink-soft">{t('intro', { email })}</p>
            <button type="button" className={primaryButton} disabled={busy} onClick={sendCode}>
              {t('send')}
            </button>
          </>
        ) : (
          <form ref={codeForm} onSubmit={verify} className="flex flex-col gap-4">
            <p role="status" className="text-ink-soft">
              {t('codeSent', { email, minutes: 10 })}
            </p>
            <CodeField label={t('code')} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
            <button type="submit" className={primaryButton} disabled={busy || code.length !== 6}>
              {t('confirm')}
            </button>
            <button type="button" className={linkButton} disabled={busy} onClick={sendCode}>
              {t('resend')}
            </button>
          </form>
        )}
        <button type="button" className={secondaryButton} onClick={() => dialog.current?.close()}>
          {t('cancel')}
        </button>
      </div>
    </dialog>
  );
}
