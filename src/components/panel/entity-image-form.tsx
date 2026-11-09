'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { removeEntityImageAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/brand-actions';
import { CheckboxField, FormAlert } from '@/components/auth/auth-ui';
import { useApprovalsNotice } from './approvals-notice';

const KNOWN_ERRORS = ['TOO_LARGE', 'UNREADABLE_IMAGE', 'FORBIDDEN', 'CONFLICT', 'RATE_LIMITED', 'MINORS_NOT_CONFIRMED', 'FILE_TYPE_NOT_ALLOWED', 'FILE_UNRECOGNIZED_TYPE', 'FILE_MIME_MISMATCH', 'FILE_EXTENSION_MISMATCH', 'FILE_TOO_LARGE'];

/**
 * Subir o quitar el logotipo o la portada de la entidad (Sprint 4.2e, anclas `handleSchoolLogoUpload`, `handleSchoolBannerUpload` y «Sin logo»). Se
 * publica sin metadatos por `/api/panel/marca`. El éxito va al aviso de la sección, que recibe el foco (al quitar la imagen, el botón desaparece); los
 * errores, junto al formulario, y se vuelven a anunciar aunque se repitan.
 */
export function EntityImageForm({ orgSlug, kind, hasImage, maxBytes, canEdit }: { orgSlug: string; kind: 'logo' | 'banner'; hasImage: boolean; maxBytes: number; canEdit: boolean }) {
  const t = useTranslations(`panel.settings.brand.${kind}`);
  const te = useTranslations('panel.settings.brand.errors');
  const router = useRouter();
  const notify = useApprovalsNotice();
  const ids = { file: useId(), help: useId() };
  const [error, setErrorText] = useState<{ text: string; at: number } | null>(null);
  const setError = (text: string | null) => setErrorText(text === null ? null : { text, at: Date.now() });
  const [busy, setBusy] = useState(false);
  const max = Math.floor(maxBytes / (1024 * 1024));

  async function upload(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) return setError(te('noFile'));
    if (file.size > maxBytes) return setError(te('TOO_LARGE', { max }));
    // La portada es una foto pública: sin confirmar que no salen menores reconocibles no se sube (como las fotos de logros).
    if (kind === 'banner' && data.get('noMinors') !== 'true') return setError(te('MINORS_NOT_CONFIRMED'));
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/panel/marca?${new URLSearchParams({ orgSlug, kind }).toString()}`, { method: 'POST', body: data });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (response.ok && body.ok) {
        notify(t('saved'));
        form.reset();
        router.refresh();
      } else setError(te(KNOWN_ERRORS.includes(body.error ?? '') ? (body.error as string) : 'generic', { max }));
    } catch {
      setError(te('generic', { max }));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const result = await removeEntityImageAction(orgSlug, kind);
      if (result.status === 'OK') {
        notify(t('removed'));
        router.refresh();
      } else setError(te(result.reason === 'FORBIDDEN' ? 'FORBIDDEN' : 'generic', { max }));
    } catch {
      setError(te('generic', { max }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void upload(event.currentTarget);
      }}
    >
      <label htmlFor={ids.file} className="font-bold text-varsity-navy">
        {t(hasImage ? 'replaceLabel' : 'label')}
      </label>
      <input id={ids.file} name="file" type="file" accept="image/jpeg,image/png,image/webp" disabled={!canEdit} aria-describedby={ids.help} className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 font-semibold" />
      <p id={ids.help} className="text-sm text-ink-soft">
        {t('help', { max })}
      </p>
      {kind === 'banner' && canEdit ? <CheckboxField name="noMinors" value="true" required label={t('noMinors')} /> : null}
      {error ? <FormAlert key={error.at}>{error.text}</FormAlert> : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} aria-busy={busy} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60">
            {busy ? t('uploading') : t('upload')}
          </button>
          {hasImage ? (
            <button type="button" disabled={busy} onClick={() => void remove()} className="min-h-11 font-semibold text-red-800 underline underline-offset-4 disabled:opacity-60">
              {t('remove')}
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
