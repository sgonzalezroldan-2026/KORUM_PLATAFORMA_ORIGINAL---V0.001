'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { revertEmailChangeAction } from '@/app/[locale]/(auth)/cuenta/recuperar-email/actions';
import { legalPathOf } from '@/core/legal/legal-catalog';
import { Link } from '@/i18n/navigation';
import { FormAlert, primaryButton } from './auth-ui';

/**
 * «No he sido yo» (Sprint 5.10b). Lee el token del fragmento (`#t=`) una sola vez y lo quita de la barra de direcciones; explica qué va a pasar y lo hace solo cuando la
 * persona pulsa el botón (un enlace que abra un antivirus del correo no deshace nada). El resultado se anuncia y recibe el foco (WCAG 2.4.3).
 */
export function EmailRevertForm() {
  const t = useTranslations('auth.emailRevert');
  const tokenRef = useRef<string | null>(null);
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: 'REVERTED'; email: string; removed: { passkeys: number; password: boolean; twoFactor: boolean } } | { status: 'INVALID' | 'EXPIRED' | 'EMAIL_TAKEN' | 'FAILED' } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tokenRef.current === null) {
      tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
      window.history.replaceState(null, '', window.location.pathname);
    }
    setHasToken(tokenRef.current !== '');
  }, []);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  async function revert() {
    setBusy(true);
    try {
      setResult(await revertEmailChangeAction(tokenRef.current ?? ''));
    } catch {
      setResult({ status: 'FAILED' });
    } finally {
      setBusy(false);
    }
  }

  if (result?.status === 'REVERTED') {
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="flex flex-col gap-3" data-testid="email-revert-done">
        <p className="wrap-break-word text-ink">{t('done', { email: result.email })}</p>
        {result.removed.passkeys > 0 || result.removed.password || result.removed.twoFactor ? <p className="text-ink">{t('removed')}</p> : null}
        <Link href="/login" className="tactile-btn self-start">
          {t('signIn')}
        </Link>
      </div>
    );
  }
  if (hasToken === false || (result && result.status !== 'FAILED')) {
    const key = result && result.status !== 'FAILED' ? `errors.${result.status}` : 'errors.INVALID';
    return (
      <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-3">
        <FormAlert>{t(key)}</FormAlert>
        <Link href={legalPathOf('privacidad')} className="inline-flex min-h-11 items-center self-start font-semibold text-varsity-navy underline underline-offset-4">
          {t('help')}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-soft">{t('intro')}</p>
      <button type="button" className={primaryButton} disabled={busy || hasToken !== true} onClick={() => void revert()} data-testid="email-revert-confirm">
        {busy ? t('working') : t('confirm')}
      </button>
      {result?.status === 'FAILED' ? (
        <div ref={resultRef} tabIndex={-1}>
          <FormAlert>{t('errors.FAILED')}</FormAlert>
        </div>
      ) : null}
    </div>
  );
}
