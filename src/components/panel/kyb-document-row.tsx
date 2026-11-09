'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { FormAlert } from '@/components/auth/auth-ui';
import type { KybDocumentKind } from '@/core/panel/entity-settings-rules';
import type { KybDocumentView } from '@/services/panel/entity-settings-data';

/** Errores de la ruta que tienen su propio texto; cualquier otro se dice de forma genérica. */
const KNOWN_ERRORS = [
  'TOO_LARGE',
  'FILE_TOO_LARGE',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_UNRECOGNIZED_TYPE',
  'FILE_MIME_MISMATCH',
  'FILE_EXTENSION_MISMATCH',
  'LOCKED',
  'NOT_REQUIRED',
  'RATE_LIMITED',
  'FORBIDDEN'
];

const FORMAT_LABEL: Record<string, string> = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WebP' };

/**
 * Un documento del titular (Sprint 4.2c): qué es, si está entregado (fecha, formato y tamaño) y, mientras se pueda cambiar, la subida o la
 * sustitución. «Abrir» lleva a la ruta que redirige a un enlace firmado de 5 minutos, en una pestaña nueva y sin `Referer`. El resultado de una
 * subida se dice en la propia fila y el foco vuelve a su título (revisión de experiencia del 4.2c: en móvil, un aviso arriba haría perder el sitio).
 */
export function KybDocumentRow(props: { orgSlug: string; kind: KybDocumentKind; document: KybDocumentView | null; canEdit: boolean; maxBytes: number }) {
  const { orgSlug, kind, document, canEdit, maxBytes } = props;
  const t = useTranslations('panel.settings.kyb.documents');
  const format = useFormatter();
  const router = useRouter();
  const ids = { title: useId(), file: useId(), help: useId(), error: useId() };
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const max = Math.floor(maxBytes / (1024 * 1024));
  const name = t(`kinds.${kind}.title`);

  useEffect(() => {
    if (saved) titleRef.current?.focus();
  }, [saved]);

  async function submit(form: HTMLFormElement) {
    const file = (form.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0];
    if (!file || file.size === 0) return setError(t('errors.noFile'));
    if (file.size > maxBytes) return setError(t('errors.TOO_LARGE', { max }));
    const data = new FormData();
    data.set('file', file);
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`/api/panel/documentos?${new URLSearchParams({ orgSlug, kind }).toString()}`, { method: 'POST', body: data });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (response.ok && body.ok) {
        form.reset();
        setSaved(t('uploaded', { name }));
        router.refresh();
      } else setError(t(`errors.${KNOWN_ERRORS.includes(body.error ?? '') ? body.error : 'generic'}`, { max }));
    } catch {
      setError(t('errors.generic', { max }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li aria-labelledby={ids.title} className="korum-trust-vault flex flex-col gap-3 p-4" data-testid={`kyb-${kind}`}>
      {/* El estado va debajo del título, no al lado: la pastilla «Entregado el … · PDF, 1 kB» aplastaba el título en móvil (recorrido del 4.2c). */}
      <div className="flex flex-col items-start gap-2">
        <div className="min-w-0">
          <h4 id={ids.title} ref={titleRef} tabIndex={-1} className="font-corp text-base font-extrabold text-varsity-navy">
            {name}
          </h4>
          <p className="text-sm text-ink-soft">{t(`kinds.${kind}.hint`)}</p>
        </div>
        {document ? (
          <p className="inline-flex items-center gap-1 rounded-xl bg-emerald-50 px-3 py-1 text-sm font-bold text-emerald-900">
            <span aria-hidden="true">{'✅ '}</span>
            {t('delivered', {
              date: format.dateTime(new Date(document.uploadedAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }),
              format: FORMAT_LABEL[document.mimeType] ?? document.mimeType,
              size:
                document.sizeBytes >= 1024 * 1024
                  ? format.number(document.sizeBytes / (1024 * 1024), { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1, minimumFractionDigits: 1 })
                  : format.number(Math.max(1, Math.round(document.sizeBytes / 1024)), { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })
            })}
          </p>
        ) : (
          <p className="inline-flex items-center gap-1 rounded-xl bg-amber-50 px-3 py-1 text-sm font-bold text-amber-900">
            <span aria-hidden="true">{'⏳ '}</span>
            {t('missing')}
          </p>
        )}
      </div>

      {document ? (
        <a
          href={`/api/panel/documentos/${document.id}?orgSlug=${encodeURIComponent(orgSlug)}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('openLabel', { name })}
          className="inline-flex min-h-11 items-center self-start font-bold text-varsity-navy underline underline-offset-4"
        >
          <span aria-hidden="true">{'📄 '}</span>
          {t('open')}
        </a>
      ) : null}

      {canEdit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
          className="flex flex-col gap-2"
          noValidate
        >
          <label htmlFor={ids.file} className="text-sm font-bold text-varsity-navy">
            {t('fileLabel', { name })}
          </label>
          <input
            id={ids.file}
            name="file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            aria-describedby={error ? `${ids.help} ${ids.error}` : ids.help}
            aria-invalid={error ? true : undefined}
            className="min-h-11 w-full min-w-0 rounded-xl border-2 border-varsity-navy bg-white px-3 py-2 font-semibold aria-[invalid=true]:border-red-700"
          />
          <p id={ids.help} className="text-sm text-ink-soft">
            {t('help', { max })}
          </p>
          {error ? (
            <div id={ids.error}>
              <FormAlert>{error}</FormAlert>
            </div>
          ) : null}
          {saved ? <FormAlert tone="success">{saved}</FormAlert> : null}
          <button type="submit" disabled={busy} aria-busy={busy} className="inline-flex min-h-11 items-center self-start rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60">
            <span aria-hidden="true">{'📤 '}</span>
            {busy ? t('uploading') : document ? t('replace') : t('upload')}
          </button>
        </form>
      ) : null}
    </li>
  );
}
