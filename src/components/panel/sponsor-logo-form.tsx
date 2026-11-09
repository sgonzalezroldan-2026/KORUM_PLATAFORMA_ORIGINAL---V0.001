'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { FormAlert } from '@/components/auth/auth-ui';

/** Errores de la ruta que tienen su propio texto; cualquier otro se dice de forma genérica. */
const KNOWN_ERRORS = ['TOO_LARGE', 'UNREADABLE_IMAGE', 'SPONSOR_NOT_ACTIVE', 'FORBIDDEN', 'NOT_FOUND', 'FILE_TYPE_NOT_ALLOWED', 'FILE_UNRECOGNIZED_TYPE', 'FILE_MIME_MISMATCH', 'FILE_EXTENSION_MISMATCH', 'FILE_TOO_LARGE'];

/**
 * Subida del logotipo de un comercio amigo (Sprint 4.2b). El comercio lo envía al centro y quien firma lo sube aquí; se publica sin metadatos y se ve
 * en el directorio y en el cartel del escaparate. El resultado se anuncia junto al formulario.
 */
export function SponsorLogoForm({ orgSlug, sponsorId, sponsorName, hasLogo, maxBytes }: { orgSlug: string; sponsorId: number; sponsorName: string; hasLogo: boolean; maxBytes: number }) {
  const t = useTranslations('panel.sponsors.logo');
  const router = useRouter();
  const ids = { file: useId(), help: useId() };
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const max = Math.floor(maxBytes / (1024 * 1024));

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) return setFeedback({ tone: 'error', text: t('errors.noFile') });
    if (file.size > maxBytes) return setFeedback({ tone: 'error', text: t('errors.TOO_LARGE', { max }) });
    data.set('orgSlug', orgSlug);
    data.set('sponsorId', String(sponsorId));
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/panel/comercios/logo', { method: 'POST', body: data });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (response.ok && body.ok) {
        setFeedback({ tone: 'success', text: t('saved') });
        form.reset();
        router.refresh();
      } else setFeedback({ tone: 'error', text: t(`errors.${KNOWN_ERRORS.includes(body.error ?? '') ? body.error : 'generic'}`, { max }) });
    } catch {
      setFeedback({ tone: 'error', text: t('errors.generic', { max }) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
      className="flex flex-col gap-2"
      noValidate
    >
      <label htmlFor={ids.file} className="text-sm font-bold text-varsity-navy">
        {t(hasLogo ? 'replaceLabel' : 'label', { name: sponsorName })}
      </label>
      <input id={ids.file} name="file" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby={ids.help} className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 font-semibold" />
      <p id={ids.help} className="text-sm text-ink-soft">
        {t('help', { max })}
      </p>
      {feedback ? <FormAlert tone={feedback.tone}>{feedback.text}</FormAlert> : null}
      <button type="submit" disabled={busy} aria-busy={busy} className="inline-flex min-h-11 items-center self-start rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60">
        <span aria-hidden="true">{'🖼️ '}</span>
        {busy ? t('uploading') : t('upload')}
      </button>
    </form>
  );
}
