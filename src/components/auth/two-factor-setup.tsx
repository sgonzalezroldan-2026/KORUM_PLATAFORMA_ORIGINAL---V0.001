'use client';

import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authClient, authErrorCode } from '@/lib/auth/auth-client';
import { CodeField, Field, FormAlert, primaryButton } from './auth-ui';
import { SecondFactorForm } from './second-factor-form';

/**
 * Doble factor de firmantes y Super-Admin (DECISIONES_TECNICAS §5). Sin TOTP configurado: se confirma la contraseña, se escanea el código QR
 * con una app de verificación, se guardan los códigos de respaldo y se introduce el primer código (hasta entonces el secreto no vale).
 * Con TOTP ya configurado (p. ej. tras entrar con un enlace mágico): solo se pide el código.
 */

const KNOWN = new Set(['INVALID_PASSWORD', 'INVALID_CODE', 'TOTP_ALREADY_ENABLED', 'RATE_LIMITED', 'KORUM_SECOND_FACTOR_LIMIT', 'CREDENTIAL_ACCOUNT_NOT_FOUND']);

export function TwoFactorSetup({ enabled, nextUrl }: { enabled: boolean; nextUrl: string }) {
  const t = useTranslations('auth.twoFactor');
  const te = useTranslations('auth.errors');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanHeading = useRef<HTMLHeadingElement>(null);
  const router = useRouter();
  const done = () => router.push(nextUrl);

  useEffect(() => {
    if (!setup) return;
    let active = true;
    void import('qrcode').then(({ toDataURL }) => toDataURL(setup.uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' })).then((url) => {
      if (active) setQr(url);
    });
    scanHeading.current?.focus();
    return () => {
      active = false;
    };
  }, [setup]);

  if (enabled) return <SecondFactorForm onDone={done} />;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError('UNKNOWN');
    } finally {
      setBusy(false);
    }
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.twoFactor.enable({ password, issuer: 'KORUM', method: 'totp' });
      if (result.error || !result.data || !('totpURI' in result.data)) return setError(authErrorCode(result.error));
      setSetup({ uri: result.data.totpURI, backupCodes: result.data.backupCodes });
      setPassword('');
    });
  };
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.twoFactor.verifyTotp({ code });
      if (result.error) return setError(authErrorCode(result.error));
      done();
    });
  };

  const alert = error ? <FormAlert>{te(KNOWN.has(error) ? error : 'UNKNOWN')}</FormAlert> : null;

  if (!setup) {
    return (
      <form onSubmit={start} className="flex flex-col gap-4">
        <p className="text-ink-soft">{t('intro')}</p>
        {alert}
        <Field label={t('password')} type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        <button type="submit" className={primaryButton} disabled={busy || password === ''}>
          {t('start')}
        </button>
      </form>
    );
  }

  const secret = new URL(setup.uri).searchParams.get('secret') ?? '';
  return (
    <form onSubmit={confirm} className="flex flex-col gap-5">
      <h2 ref={scanHeading} tabIndex={-1} className="font-corp text-xl font-extrabold text-varsity-navy">
        {t('scanTitle')}
      </h2>
      <p className="text-ink-soft">{t('scanIntro')}</p>
      <div className="mobile-stack grid items-start gap-4 md:grid-cols-[auto_1fr]">
        <div className="flex size-[236px] items-center justify-center rounded-xl border-2 border-varsity-navy bg-white p-2">
          {qr ? <Image src={qr} unoptimized width={220} height={220} alt={t('qrAlt')} /> : <span className="text-sm text-ink-soft">{t('qrLoading')}</span>}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="font-bold text-varsity-navy">{t('manualKey')}</p>
          <code className="break-all rounded-lg bg-varsity-navy/5 p-2 font-mono text-sm">{secret}</code>
        </div>
      </div>
      <section aria-labelledby="backup-codes" className="korum-trust-vault flex flex-col gap-3 p-4">
        <h3 id="backup-codes" className="font-corp font-extrabold text-varsity-navy">
          {t('backupTitle')}
        </h3>
        <p className="text-sm text-ink-soft">{t('backupIntro')}</p>
        <ol className="grid grid-cols-2 gap-2 font-mono text-sm tabular-nums">
          {setup.backupCodes.map((backupCode) => (
            <li key={backupCode} className="rounded bg-white px-2 py-1">
              {backupCode}
            </li>
          ))}
        </ol>
        <label className="flex min-h-11 items-center gap-3 font-semibold text-varsity-navy">
          <input type="checkbox" className="size-5 accent-varsity-emerald" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
          {t('backupSaved')}
        </label>
      </section>
      {alert}
      <CodeField label={t('firstCode')} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
      <button type="submit" className={primaryButton} disabled={busy || !saved || code.length !== 6}>
        {t('confirm')}
      </button>
    </form>
  );
}
