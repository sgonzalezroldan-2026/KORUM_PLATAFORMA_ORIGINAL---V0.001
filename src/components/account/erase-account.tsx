'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { eraseAccountAction } from '@/app/[locale]/(account)/mi-cuenta/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { authClient } from '@/lib/auth/auth-client';
import { Link } from '@/i18n/navigation';

/**
 * Suprimir la cuenta (QA-REG03). Antes de pedir nada explica qué se borra y qué se **conserva por ley** (las donaciones con certificado fiscal, con
 * el NIF, el nombre y la provincia que la entidad debe poder acreditar durante 6 años; los importes de todas las aportaciones, sin nadie
 * identificable). Exige marcar que se entiende que no se puede deshacer y confirmar la identidad con un código. Si algo lo impide (firmar por una
 * entidad, ser Super-Admin, saldo en el monedero), lo dice y no pide el código.
 */

export type ErasureBlockReason = 'SUPERADMIN_ACCOUNT' | 'ACTIVE_SIGNER' | 'WALLET_BALANCE';

type Message = { tone: 'error' | 'success'; key: string; values?: Record<string, number> };

export function EraseAccount({
  block,
  ensureFresh,
  request
}: {
  block: ErasureBlockReason | null;
  ensureFresh: (then: () => void) => Promise<void>;
  request: (proof: 'email', then: () => void) => void;
}) {
  const t = useTranslations('account.erase');
  const checkboxId = useId();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [erased, setErased] = useState<number | null>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  // Tras suprimir, el bloque se sustituye por la confirmación: el foco va a su título y no se pierde al principio de la página.
  useEffect(() => {
    if (erased !== null) doneHeading.current?.focus();
  }, [erased]);

  async function erase() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await eraseAccountAction({ confirm: true });
      if (result.status === 'ERASED') {
        setErased(result.retainedFiscalRecords);
        // Las sesiones ya no existen: la cabecera vuelve a preguntar y pasa a «Iniciar sesión».
        authClient.$store.notify('$sessionSignal');
      }
      else if (result.status === 'REAUTH_REQUIRED') request('email', () => void erase());
      else if (result.status === 'BLOCKED') setMessage({ tone: 'error', key: `blocked.${result.reason}` });
      else if (result.status === 'RATE_LIMITED') setMessage({ tone: 'error', key: 'rateLimited' });
      else setMessage({ tone: 'error', key: 'failed' });
    } catch {
      setMessage({ tone: 'error', key: 'failed' });
    } finally {
      setBusy(false);
    }
  }

  if (erased !== null) {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4">
        <h3 ref={doneHeading} tabIndex={-1} className="font-corp text-lg font-extrabold text-emerald-950">
          {t('done.title')}
        </h3>
        <p className="text-emerald-950">{erased > 0 ? t('done.retained', { count: erased }) : t('done.text')}</p>
        <Link href="/" className="tactile-btn self-start">
          {t('done.home')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-red-200 bg-white p-4" data-testid="erase-account" aria-busy={busy}>
      <h3 className="font-corp text-lg font-extrabold text-red-900">{t('title')}</h3>
      <p className="text-ink-soft">{t('deleted')}</p>
      <p className="text-ink-soft">{t('kept')}</p>
      <p className="text-ink-soft">{t('signIn')}</p>
      {block ? (
        <FormAlert tone="info">{t(`blocked.${block}`)}</FormAlert>
      ) : (
        <>
          {/* Toda la fila es la etiqueta: la zona que se puede pulsar mide al menos 44 px de alto (WCAG 2.5.8). */}
          <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-start gap-3 py-1 font-semibold text-ink">
            <input
              id={checkboxId}
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
              className="mt-0.5 size-6 shrink-0 accent-red-800"
            />
            <span>{t('understand')}</span>
          </label>
          <button
            type="button"
            disabled={!understood || busy}
            onClick={() => void ensureFresh(() => void erase())}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-red-800 px-4 font-bold text-white hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-60 sm:self-start"
          >
            {busy ? t('erasing') : t('button')}
          </button>
        </>
      )}
      {message ? <FormAlert tone={message.tone}>{t(message.key, message.values)}</FormAlert> : null}
    </div>
  );
}
