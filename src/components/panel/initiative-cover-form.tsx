'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { removeInitiativeCoverAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/estudio/actions';
import { CheckboxField, FormAlert } from '@/components/auth/auth-ui';

const KNOWN_ERRORS = ['TOO_LARGE', 'UNREADABLE_IMAGE', 'FORBIDDEN', 'NOT_FOUND', 'NOT_EDITABLE', 'RATE_LIMITED', 'MINORS_NOT_CONFIRMED', 'FILE_TYPE_NOT_ALLOWED', 'FILE_UNRECOGNIZED_TYPE', 'FILE_MIME_MISMATCH', 'FILE_EXTENSION_MISMATCH', 'FILE_TOO_LARGE'];

/**
 * Imagen representativa de la campaña (Sprint 4.4c, prototipo `handleInitiativeCoverUpload`): la foto de su ficha, de su tarjeta y de la tarjeta de
 * WhatsApp. Se sube por `/api/panel/campana-imagen` (reducida y sin metadatos en el servidor). El éxito se anuncia en una región con foco (al quitar la
 * imagen, su botón desaparece); los errores van junto al formulario y se vuelven a anunciar aunque se repitan. Es una foto pública: sin confirmar que
 * no salen menores reconocibles no se sube.
 */
export function InitiativeCoverForm({ orgSlug, initiativeId, coverFileId, maxBytes, canEdit, canRemove }: { orgSlug: string; initiativeId: number; coverFileId: string | null; maxBytes: number; canEdit: boolean; canRemove: boolean }) {
  const t = useTranslations('panel.studio.cover');
  const router = useRouter();
  const ids = { file: useId(), help: useId(), fileError: useId() };
  const fileField = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  /** `field`: el campo al que se liga el error (y al que va el foco); `null`, un error general que se anuncia en el aviso del formulario. */
  const [error, setErrorText] = useState<{ text: string; field: 'file' | 'minors' | null; at: number } | null>(null);
  const setError = (text: string | null, field: 'file' | 'minors' | null = null) => setErrorText(text === null ? null : { text, field, at: Date.now() });
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = Math.floor(maxBytes / (1024 * 1024));

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  /** Error de un campo: el aviso va junto a él (`aria-describedby`) y el foco se le lleva. */
  function failOn(field: 'file' | 'minors', text: string, form?: HTMLFormElement) {
    setError(text, field);
    if (field === 'file') fileField.current?.focus();
    else (form?.elements.namedItem('noMinors') as HTMLInputElement | null)?.focus();
  }

  async function upload(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) return failOn('file', t('errors.noFile'));
    if (file.size > maxBytes) return failOn('file', t('errors.TOO_LARGE', { max }));
    if (data.get('noMinors') !== 'true') return failOn('minors', t('errors.MINORS_NOT_CONFIRMED'), form);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(`/api/panel/campana-imagen?${new URLSearchParams({ orgSlug, initiativeId: String(initiativeId) }).toString()}`, { method: 'POST', body: data });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (response.ok && body.ok) {
        setDone(t('saved'));
        form.reset();
        router.refresh();
      } else {
        const key = KNOWN_ERRORS.includes(body.error ?? '') ? (body.error as string) : 'generic';
        const fileProblem = key === 'TOO_LARGE' || key.startsWith('FILE_') || key === 'UNREADABLE_IMAGE';
        if (fileProblem) failOn('file', t(`errors.${key}`, { max }));
        else setError(t(`errors.${key}`, { max }), key === 'MINORS_NOT_CONFIRMED' ? 'minors' : null);
      }
    } catch {
      setError(t('errors.generic', { max }));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await removeInitiativeCoverAction(orgSlug, initiativeId);
      if (result.status === 'OK') {
        setDone(t('removed'));
        router.refresh();
      } else setError(t(`errors.${result.reason === 'FORBIDDEN' || result.reason === 'NOT_EDITABLE' ? result.reason : 'generic'}`, { max }));
    } catch {
      setError(t('errors.generic', { max }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${ids.file}-title`} className="korum-trust-vault flex flex-col gap-3 p-5 sm:p-6" data-testid="initiative-cover">
      <h2 id={`${ids.file}-title`} className="font-corp text-xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      <p ref={doneRef} tabIndex={-1} role="status" className={done ? 'rounded-xl border-2 border-emerald-700 bg-emerald-50 p-3 font-bold text-emerald-950' : 'sr-only'} data-testid="initiative-cover-done">
        {done ?? ''}
      </p>
      {coverFileId ? (
        <figure className="flex flex-col gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- imagen pública servida por /api/files/public, ya reducida en el servidor */}
          <img src={`/api/files/public/${coverFileId}`} alt={t('currentAlt')} width={640} height={360} className="max-h-60 w-full max-w-xl rounded-2xl border-2 border-varsity-navy/15 object-cover" data-testid="initiative-cover-preview" />
          <figcaption className="text-sm text-ink-soft">{t('currentCaption')}</figcaption>
        </figure>
      ) : (
        <p className="text-ink-soft" data-testid="initiative-cover-empty">
          {t('none')}
        </p>
      )}
      <form
        noValidate
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void upload(event.currentTarget);
        }}
      >
        <label htmlFor={ids.file} className="font-bold text-varsity-navy">
          {t(coverFileId ? 'replaceLabel' : 'label')}
        </label>
        <input id={ids.file} ref={fileField} name="file" type="file" accept="image/jpeg,image/png,image/webp" disabled={!canEdit} aria-invalid={error?.field === 'file' ? true : undefined} aria-describedby={error?.field === 'file' ? `${ids.help} ${ids.fileError}` : ids.help} className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 font-semibold aria-invalid:border-red-700" />
        <p id={ids.help} className="text-sm text-ink-soft">
          {t('help', { max })}
        </p>
        {error?.field === 'file' ? (
          <p id={ids.fileError} role="alert" className="text-sm font-semibold text-red-800">
            {error.text}
          </p>
        ) : null}
        {canEdit ? <CheckboxField name="noMinors" value="true" required label={t('noMinors')} error={error?.field === 'minors' ? error.text : null} /> : null}
        {error && error.field === null ? <FormAlert key={error.at}>{error.text}</FormAlert> : null}
        {canEdit ? (
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={busy} aria-busy={busy} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60">
              {busy ? t('uploading') : t('upload')}
            </button>
            {canRemove ? (
              <button type="button" disabled={busy} onClick={() => void remove()} className="min-h-11 font-semibold text-red-800 underline underline-offset-4 disabled:opacity-60">
                {t('remove')}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-bold text-ink-soft">{t('readOnly')}</p>
            {canRemove ? (
              <button type="button" disabled={busy} onClick={() => void remove()} className="min-h-11 self-start font-semibold text-red-800 underline underline-offset-4 disabled:opacity-60">
                {t('remove')}
              </button>
            ) : null}
          </div>
        )}
      </form>
    </section>
  );
}
