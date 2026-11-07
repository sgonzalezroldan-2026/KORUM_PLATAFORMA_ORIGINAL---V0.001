'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { deletePasskeyAction } from '@/app/[locale]/(account)/mi-cuenta/actions';
import { Field, FormAlert, secondaryButton } from '@/components/auth/auth-ui';
import { useHydrated } from '@/components/ui/use-hydrated';
import { authClient } from '@/lib/auth/auth-client';
import { useReauth } from './use-reauth';

/**
 * Llaves de acceso (passkeys) en *Mi cuenta* (Sprint 3.7): entrar con la huella, la cara o el PIN del móvil u ordenador, sin esperar un email.
 * Añadir una exige haber confirmado la identidad en los últimos 10 minutos (el servidor lo comprueba y responde `KORUM_REAUTH_REQUIRED` o, en
 * cuentas con doble factor, `KORUM_SECOND_FACTOR_REQUIRED`): entonces se pide el código y se vuelve a intentar.
 */

export interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: string | null;
  synced: boolean;
}

type Message = { tone: 'success' | 'error' | 'info'; key: string };

const NAME_MAX = 40;

export function PasskeysPanel({ email, twoFactorEnabled, passkeys }: { email: string; twoFactorEnabled: boolean; passkeys: PasskeyRow[] }) {
  const t = useTranslations('account.passkeys');
  const format = useFormatter();
  const router = useRouter();
  const { request, dialog } = useReauth(email);
  // Solo se sabe en el navegador: hasta hidratar, el botón espera (`null`) y no aparece un aviso que luego desaparezca.
  const hydrated = useHydrated();
  const supported = hydrated ? 'PublicKeyCredential' in window : null;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // Tras quitar o añadir una llave la lista cambia: el foco va al aviso del resultado, no al principio de la página.
  const messageBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message && message.tone !== 'error') messageBox.current?.focus();
  }, [message]);

  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await authClient.passkey.addPasskey({ name: name.trim().slice(0, NAME_MAX) || undefined });
      const code = result?.error && 'code' in result.error ? result.error.code : undefined;
      if (!result?.error) {
        setName('');
        setMessage({ tone: 'success', key: 'added' });
        router.refresh();
      } else if (code === 'KORUM_REAUTH_REQUIRED' || code === 'SESSION_NOT_FRESH') request('email', () => void add());
      else if (code === 'KORUM_TWO_FACTOR_SETUP_REQUIRED') setMessage({ tone: 'info', key: 'twoFactorFirst' });
      else if (code === 'KORUM_SECOND_FACTOR_REQUIRED') request('second-factor', () => void add());
      else if (code === 'AUTH_CANCELLED' || code === 'ERROR_CEREMONY_ABORTED') setMessage({ tone: 'info', key: 'cancelled' });
      else if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') setMessage({ tone: 'info', key: 'alreadyRegistered' });
      else setMessage({ tone: 'error', key: 'failed' });
    } catch {
      setMessage({ tone: 'error', key: 'failed' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await deletePasskeyAction({ id });
      setMessage(result.status === 'DELETED' ? { tone: 'success', key: 'removed' } : { tone: 'error', key: 'failed' });
      router.refresh();
    } catch {
      setMessage({ tone: 'error', key: 'failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="security" aria-labelledby="security-title" className="korum-trust-vault flex scroll-mt-4 flex-col gap-4 p-5">
      <h2 id="security-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="text-ink-soft">{t('intro')}</p>
      {twoFactorEnabled ? <p className="text-sm text-ink-soft">{t('signerNote')}</p> : null}

      {passkeys.length === 0 ? (
        <p className="font-semibold text-varsity-navy">{t('none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {passkeys.map((key) => (
            <li key={key.id} className="mobile-stack grid gap-2 rounded-xl bg-white p-3 md:grid-cols-[1fr_auto] md:items-center">
              <div className="min-w-0">
                <p className="break-words font-bold text-varsity-navy">{key.name || t('unnamed')}</p>
                <p className="text-sm text-ink-soft">
                  {key.createdAt ? t('added', { date: format.dateTime(new Date(key.createdAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) }) : null}
                  {key.synced ? ` · ${t('synced')}` : ''}
                </p>
              </div>
              <button type="button" className={`${secondaryButton} md:w-auto`} disabled={busy} onClick={() => void remove(key.id)} aria-label={t('removeLabel', { name: key.name || t('unnamed') })}>
                {t('remove')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {supported === false ? (
        <FormAlert tone="info">{t('unsupported')}</FormAlert>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Field label={t('nameLabel')} hint={t('nameHint')} maxLength={NAME_MAX} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="tactile-btn justify-center sm:self-start" disabled={busy || supported !== true}>
            {t('add')}
          </button>
        </form>
      )}
      {message ? (
        <div ref={messageBox} tabIndex={-1}>
          <FormAlert tone={message.tone}>{t(`messages.${message.key}`)}</FormAlert>
        </div>
      ) : null}
      {dialog}
    </section>
  );
}
