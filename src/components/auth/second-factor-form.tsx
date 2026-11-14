'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authClient, authErrorCode } from '@/lib/auth/auth-client';
import { CodeField, Field, focusFirstInvalid, FormAlert, linkButton, SubmitButton } from './auth-ui';

/** Segundo factor: código de la app de verificación o, si se ha perdido el móvil, uno de los códigos de respaldo (cada uno sirve una vez). */

const KNOWN = new Set(['INVALID_CODE', 'INVALID_BACKUP_CODE', 'ACCOUNT_TEMPORARILY_LOCKED', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE', 'INVALID_TWO_FACTOR_COOKIE', 'RATE_LIMITED', 'KORUM_SECOND_FACTOR_LIMIT']);

export function SecondFactorForm({ onDone, onBack }: { onDone: () => void; /** Volver a la contraseña (si caduca el desafío o se bloquea). */ onBack?: () => void }) {
  const t = useTranslations('auth.secondFactor');
  const te = useTranslations('auth.errors');
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Un código que no vale se dice junto a su campo y le devuelve el foco (revisión de experiencia del 5.5b); lo demás (bloqueo, límite) va en el aviso general.
  const codeError = error === 'INVALID_CODE' || error === 'INVALID_BACKUP_CODE' ? te(error) : null;
  useEffect(() => {
    if (error === 'INVALID_CODE' || error === 'INVALID_BACKUP_CODE') focusFirstInvalid(formRef.current);
  }, [error]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = backup ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() }) : await authClient.twoFactor.verifyTotp({ code });
      if (result.error) setError(authErrorCode(result.error));
      else onDone();
    } catch {
      setError('UNKNOWN');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <p className="text-ink-soft">{backup ? t('backupIntro') : t('intro')}</p>
      {error && !codeError ? <FormAlert>{te(KNOWN.has(error) ? error : 'UNKNOWN')}</FormAlert> : null}
      {backup ? (
        <Field label={t('backupCode')} autoComplete="one-time-code" required value={code} error={codeError} onChange={(event) => setCode(event.target.value)} />
      ) : (
        <CodeField label={t('code')} value={code} error={codeError} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
      )}
      <SubmitButton busy={busy} disabled={backup ? code.trim().length < 6 : code.length !== 6}>
        {t('verify')}
      </SubmitButton>
      <button
        type="button"
        className={linkButton}
        onClick={() => {
          setBackup(!backup);
          setCode('');
          setError(null);
        }}
      >
        {backup ? t('useApp') : t('useBackup')}
      </button>
      {onBack ? (
        <button type="button" className={linkButton} onClick={onBack}>
          {t('back')}
        </button>
      ) : null}
    </form>
  );
}
