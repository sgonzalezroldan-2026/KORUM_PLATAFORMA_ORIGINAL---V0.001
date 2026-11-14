'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { resendVoteLinkAction } from '@/app/[locale]/(public)/[orgSlug]/votacion/actions';
import { Field, FormAlert, SubmitButton } from '@/components/auth/auth-ui';

/**
 * «Reenviarme mi enlace de voto» (Sprint 5.5b). La respuesta es la misma haya donado o no ese email (no se revela quién aportó); el enlace llega al email con el
 * que se donó. Un email mal escrito se dice junto al campo; el resultado se anuncia y recibe el foco.
 */
export function ResizeLinkResendForm({ orgSlug }: { orgSlug: string }) {
  const t = useTranslations('portal.resizeVote.resend');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // Al volver con «Usar otro email», el foco va al campo (no se pierde en el documento).
  const [returning, setReturning] = useState(false);
  const sentRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (sent) sentRef.current?.focus();
  }, [sent]);
  useEffect(() => {
    if (fieldError || returning) formRef.current?.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
  }, [fieldError, returning]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFieldError(null);
    setError(null);
    setReturning(false);
    if (!email.includes('@')) return setFieldError(t('invalidEmail'));
    setBusy(true);
    const result = await resendVoteLinkAction({ orgSlug, email }).catch(() => ({ status: 'ERROR' as const, reason: 'FAILED' as const }));
    setBusy(false);
    if (result.status === 'ACCEPTED') return setSent(true);
    if (result.reason === 'INVALID_EMAIL') return setFieldError(t('invalidEmail'));
    setError(result.reason === 'RATE_LIMITED' ? t('rateLimited') : t('failed'));
  };

  if (sent) {
    return (
      <div className="flex flex-col gap-2">
        <div ref={sentRef} tabIndex={-1} role="status" className="rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4 text-emerald-950" data-testid="resize-link-sent">
          <p className="font-bold">{t('sentTitle')}</p>
          <p className="text-sm">{t('sentBody')}</p>
        </div>
        {/* Fuera del aviso anunciado (el lector de pantalla no lo lee como parte del mensaje). Quien se equivocó al escribirlo puede probar con otro sin
            recargar; el aviso no cambia (no dice si ese email donó). */}
        <button
          type="button"
          className="inline-flex min-h-11 items-center self-start font-bold text-varsity-navy underline underline-offset-4"
          onClick={() => {
            setSent(false);
            setEmail('');
            setReturning(true);
          }}
        >
          {t('another')}
        </button>
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={(event) => void submit(event)} className="korum-notebook-sheet flex flex-col gap-4 rounded-2xl p-4 text-start" noValidate aria-labelledby="resize-link-resend-title">
      <h2 id="resize-link-resend-title" className="font-corp text-lg font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="text-sm text-ink-soft">{t('intro')}</p>
      {error ? <FormAlert>{error}</FormAlert> : null}
      <Field label={t('email')} type="email" autoComplete="email" required maxLength={254} value={email} error={fieldError} onChange={(event) => setEmail(event.target.value)} />
      <SubmitButton busy={busy}>{t('submit')}</SubmitButton>
    </form>
  );
}
