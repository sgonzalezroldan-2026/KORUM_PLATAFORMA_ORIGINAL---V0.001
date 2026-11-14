'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { acceptInvitationAction, acceptInvitationWithSessionAction, inspectInvitationAction, type InvitationPageView } from '@/app/[locale]/(auth)/invitacion/actions';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { Locale } from '@/i18n/routing';
import { Field, focusFirstInvalid, FormAlert, SubmitButton } from './auth-ui';

/**
 * Activación de la cuenta de la segunda persona firmante (o del primer Super-Admin). Lee el token del fragmento (`#t=`) y lo quita de la
 * barra de direcciones al momento: no queda en el historial ni se envía en el `Referer`.
 */
export function InvitationForm() {
  const t = useTranslations('auth.invitation');
  const locale = useLocale() as Locale;
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<InvitationPageView | null | 'loading'>('loading');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // El aviso de que no coinciden sale al salir del campo o al enviar, no al primer carácter (Sprint 5.5b, heredado del 3.2).
  const [checkRepeat, setCheckRepeat] = useState(false);
  const [checkPassword, setCheckPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  // El token se lee del fragmento una sola vez y se guarda aquí: en desarrollo React ejecuta el efecto dos veces y, como la primera pasada
  // ya ha borrado el fragmento de la barra de direcciones, la segunda lo encontraría vacío (fallo visto en la certificación del 3.2).
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (tokenRef.current === null) {
      tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
      window.history.replaceState(null, '', window.location.pathname);
    }
    const fromHash = tokenRef.current;
    let active = true;
    // Sin token, el servidor responde `null` al momento: la página muestra «invitación no válida».
    inspectInvitationAction(fromHash).then(
      (found) => {
        if (!active) return;
        setToken(fromHash || null);
        setView(found);
      },
      () => {
        if (active) setView(null);
      }
    );
    return () => {
      active = false;
    };
  }, []);

  if (view === 'loading') return <p role="status">{t('checking')}</p>;
  if (view === null || token === null) return <FormAlert>{t('invalid')}</FormAlert>;
  const destination = view.purpose === 'SUPERADMIN' ? '/admin' : view.organizationSlug ? `/panel/${view.organizationSlug}` : '/';
  if (view.hasPassword) {
    // Ya tiene cuenta: acepta el cargo con su propia sesión. Si no la ha iniciado (o es otra cuenta), entra y vuelve a abrir el enlace.
    if (!view.signedInAsInvitee) {
      return (
        <FormAlert tone="info">
          {t(view.signedInAsOther ? 'otherAccount' : 'alreadyActive', { email: view.email })}{' '}
          <a href={localizedPath(locale, '/login')} className="underline underline-offset-4">
            {t('goToLogin')}
          </a>
        </FormAlert>
      );
    }
    const acceptWithSession = async () => {
      setBusy(true);
      setError(null);
      const result = await acceptInvitationWithSessionAction(token).catch(() => ({ ok: false as const, reason: 'UNKNOWN' as const }));
      setBusy(false);
      if (!result.ok) return setError(t('invalid'));
      router.push(`${localizedPath(locale, '/acceso/doble-factor')}?next=${encodeURIComponent(localizedPath(locale, destination))}`);
    };
    return (
      <div className="flex flex-col gap-4">
        <p className="text-lg text-ink">{t('intro', { email: view.email, organization: view.organizationName ?? '', role: view.roleLabel ?? '' })}</p>
        {error ? <FormAlert>{error}</FormAlert> : null}
        <SubmitButton type="button" busy={busy} onClick={() => void acceptWithSession()}>
          {t('acceptRole')}
        </SubmitButton>
      </div>
    );
  }

  const tooShort = password.length < 12;
  const mismatch = repeat !== password;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mismatch || tooShort) {
      setCheckPassword(true);
      setCheckRepeat(true);
      focusFirstInvalid(formRef.current);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInvitationAction(token, password);
      if (!result.ok) {
        setError(result.reason === 'WEAK_PASSWORD' ? t('weak') : t('invalid'));
        return;
      }
      router.push(`${localizedPath(locale, '/acceso/doble-factor')}?next=${encodeURIComponent(localizedPath(locale, destination))}`);
    } catch {
      setError(t('unknown'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      <p className="text-lg text-ink">
        {view.purpose === 'SUPERADMIN' ? t('platformIntro', { email: view.email }) : t('intro', { email: view.email, organization: view.organizationName ?? '', role: view.roleLabel ?? '' })}
      </p>
      <p className="text-ink-soft">{t('nextSteps')}</p>
      {error ? <FormAlert>{error}</FormAlert> : null}
      <Field
        label={t('password')}
        hint={t('passwordHint')}
        type="password"
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
        value={password}
        error={checkPassword && tooShort ? t('weak') : null}
        onBlur={() => setCheckPassword(password !== '')}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Field
        label={t('repeat')}
        type="password"
        autoComplete="new-password"
        required
        value={repeat}
        error={checkRepeat && mismatch ? t('mismatch') : null}
        onBlur={() => setCheckRepeat(repeat !== '')}
        onChange={(event) => setRepeat(event.target.value)}
      />
      <SubmitButton busy={busy}>{t('submit')}</SubmitButton>
    </form>
  );
}
