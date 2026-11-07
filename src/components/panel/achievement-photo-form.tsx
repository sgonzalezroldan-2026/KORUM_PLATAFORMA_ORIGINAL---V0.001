'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';

export interface AchievementPhotoFormProps {
  orgSlug: string;
  initiativeId: number;
  title: string;
  hasBefore: boolean;
  hasAfter: boolean;
  thanksMessage: string;
  maxBytes: number;
  thanksMax: number;
}

type Feedback = { tone: 'ok' | 'error'; text: string } | null;

const field = 'min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 font-semibold';

/**
 * Fotos Antes / Después y agradecimiento de un logro, en el panel de la entidad. La casilla de que **no aparecen menores identificables** es
 * obligatoria y el servidor la vuelve a exigir; la imagen se reescribe sin metadatos antes de publicarse. Los errores se anuncian junto al
 * formulario y el foco se queda donde estaba.
 */
export function AchievementPhotoForm({ orgSlug, initiativeId, title, hasBefore, hasAfter, thanksMessage, maxBytes, thanksMax }: AchievementPhotoFormProps) {
  const t = useTranslations('panel.achievements');
  const router = useRouter();
  const ids = { slot: useId(), file: useId(), minors: useId(), thanks: useId(), minorsHelp: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [photoFeedback, setPhotoFeedback] = useState<Feedback>(null);
  const [thanksFeedback, setThanksFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<'photo' | 'thanks' | null>(null);

  async function send(intent: 'photo' | 'thanks', form: HTMLFormElement, setFeedback: (feedback: Feedback) => void) {
    const data = new FormData(form);
    data.set('intent', intent);
    data.set('orgSlug', orgSlug);
    data.set('initiativeId', String(initiativeId));
    if (intent === 'photo') {
      const file = data.get('file');
      if (!(file instanceof File) || file.size === 0) return setFeedback({ tone: 'error', text: t('errors.noFile') });
      if (file.size > maxBytes) return setFeedback({ tone: 'error', text: t('errors.TOO_LARGE', { max: Math.floor(maxBytes / (1024 * 1024)) }) });
      if (data.get('noMinors') !== 'on') return setFeedback({ tone: 'error', text: t('errors.CONFIRMATION_REQUIRED') });
    }
    setBusy(intent);
    setFeedback(null);
    try {
      const response = await fetch('/api/panel/logros', { method: 'POST', body: data });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (response.ok && body.ok) {
        setFeedback({ tone: 'ok', text: t(intent === 'photo' ? 'photoSaved' : 'thanksSaved') });
        if (intent === 'photo') form.reset();
        router.refresh();
      } else {
        const known = ['TOO_LARGE', 'CONFIRMATION_REQUIRED', 'UNREADABLE_IMAGE', 'INITIATIVE_NOT_EDITABLE', 'FORBIDDEN', 'NOT_FOUND', 'FILE_TYPE_NOT_ALLOWED', 'FILE_UNRECOGNIZED_TYPE', 'FILE_MIME_MISMATCH', 'FILE_EXTENSION_MISMATCH', 'FILE_TOO_LARGE'];
        setFeedback({ tone: 'error', text: t(`errors.${known.includes(body.error ?? '') ? body.error : 'generic'}`, { max: Math.floor(maxBytes / (1024 * 1024)) }) });
      }
    } catch {
      setFeedback({ tone: 'error', text: t('errors.generic') });
    } finally {
      setBusy(null);
    }
  }

  const tone = (feedback: Feedback) => (feedback?.tone === 'error' ? 'border-red-700 bg-red-50 text-red-900' : 'border-emerald-300 bg-emerald-50 text-emerald-950');

  return (
    <article className="korum-trust-vault space-y-5 p-5" data-testid="achievement-workbench-item">
      <header className="space-y-1">
        <h2 className="font-corp text-lg font-extrabold text-varsity-navy wrap-anywhere">{title}</h2>
        <p className="text-sm font-semibold text-ink-soft">
          <span aria-hidden="true">{hasBefore ? '✅ ' : '⏳ '}</span>
          {t(hasBefore ? 'beforeDone' : 'beforeMissing')}
          {' · '}
          <span aria-hidden="true">{hasAfter ? '✅ ' : '⏳ '}</span>
          {t(hasAfter ? 'afterDone' : 'afterMissing')}
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send('photo', event.currentTarget, setPhotoFeedback);
        }}
        className="space-y-3"
        noValidate
      >
        <div className="mobile-stack grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={ids.slot} className="block text-sm font-bold text-varsity-navy">
              {t('slotLabel')}
            </label>
            <select id={ids.slot} name="slot" defaultValue={hasBefore ? 'AFTER' : 'BEFORE'} className={field}>
              <option value="BEFORE">{t('slotBefore')}</option>
              <option value="AFTER">{t('slotAfter')}</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor={ids.file} className="block text-sm font-bold text-varsity-navy">
              {t('fileLabel')}
            </label>
            <input ref={fileInput} id={ids.file} name="file" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby={`${ids.file}-help`} className={field} />
          </div>
        </div>
        <p id={`${ids.file}-help`} className="text-sm text-ink-soft">
          {t('fileHelp', { max: Math.floor(maxBytes / (1024 * 1024)) })}
        </p>
        <label htmlFor={ids.minors} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3">
          <input id={ids.minors} name="noMinors" type="checkbox" required aria-required="true" aria-describedby={ids.minorsHelp} className="mt-0.5 size-6 shrink-0 accent-varsity-emerald" />
          <span>
            <span className="font-bold text-varsity-navy">{`${t('minorsLabel')} (${t('required')})`}</span>
            <span id={ids.minorsHelp} className="block text-sm text-ink-soft">
              {t('minorsHelp')}
            </span>
          </span>
        </label>
        <p role={photoFeedback?.tone === 'error' ? 'alert' : 'status'} aria-live="polite" className={photoFeedback ? `rounded-xl border-2 p-3 text-sm font-bold ${tone(photoFeedback)}` : 'sr-only'}>
          {photoFeedback?.text ?? ''}
        </p>
        <button type="submit" disabled={busy !== null} aria-busy={busy === 'photo'} className="tactile-btn rounded-2xl! disabled:opacity-60">
          <span aria-hidden="true">{'📷 '}</span>
          {busy === 'photo' ? t('uploading') : t('upload')}
        </button>
      </form>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send('thanks', event.currentTarget, setThanksFeedback);
        }}
        className="space-y-3 border-t-2 border-patio-rule pt-4"
        noValidate
      >
        <div className="space-y-1">
          <label htmlFor={ids.thanks} className="block text-sm font-bold text-varsity-navy">
            {t('thanksLabel')}
          </label>
          <textarea id={ids.thanks} name="message" rows={3} maxLength={thanksMax} defaultValue={thanksMessage} placeholder={t('thanksPlaceholder')} className={field} />
          <p className="text-sm text-ink-soft">{t('thanksHelp', { max: thanksMax })}</p>
        </div>
        <p role={thanksFeedback?.tone === 'error' ? 'alert' : 'status'} aria-live="polite" className={thanksFeedback ? `rounded-xl border-2 p-3 text-sm font-bold ${tone(thanksFeedback)}` : 'sr-only'}>
          {thanksFeedback?.text ?? ''}
        </p>
        <button type="submit" disabled={busy !== null} aria-busy={busy === 'thanks'} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-5 font-bold text-varsity-navy disabled:opacity-60">
          {busy === 'thanks' ? t('saving') : t('saveThanks')}
        </button>
      </form>
    </article>
  );
}
