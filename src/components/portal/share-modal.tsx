'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

export interface ShareGroup {
  slug: string;
  name: string;
}

export interface ShareTarget {
  /** Título de la iniciativa. */
  title: string;
  entityName: string;
  /** URL absoluta y canónica de la ficha (sin parámetros). */
  url: string;
  /** Grupos del reto por curso, equipo o grupo, en el orden de la entidad. Vacío si el reto está desactivado. */
  groups: ShareGroup[];
}

export interface ShareModalProps {
  target: ShareTarget | null;
  onClose: () => void;
}

/** Enlace de la ficha con el grupo elegido: la página sigue teniendo una sola canónica, solo cambia la imagen social. */
export function buildShareUrl(url: string, groupSlug: string): string {
  if (groupSlug === '') return url;
  const target = new URL(url);
  target.searchParams.set('grupo', groupSlug);
  return target.toString();
}

/**
 * Compartir (`id="share-modal"`): WhatsApp, email, el menú de compartir del móvil y copiar el enlace. Diálogo nativo (`<dialog>`): atrapa el foco,
 * se cierra con Escape y devuelve el foco a quien lo abrió. El grupo opcional hace que la tarjeta del enlace celebre a ese curso o equipo, en
 * positivo y sin nombres (Regla 03 §6).
 */
export function ShareModal({ target, onClose }: ShareModalProps) {
  const t = useTranslations('portal.share');
  // El aviso va dentro del diálogo: un aviso global quedaría tapado por el fondo y un lector de pantalla no lo anunciaría.
  const [status, setStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const groupId = useId();
  const [group, setGroup] = useState('');
  // El menú de compartir del móvil existe solo en algunos navegadores: en el servidor se asume que no, y el cliente lo corrige al hidratar.
  const canShare = useSyncExternalStore(
    () => () => undefined,
    () => typeof navigator.share === 'function',
    () => false
  );

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (target && !node.open) {
      setGroup('');
      setStatus('');
      node.showModal();
    }
    if (!target && node.open) node.close();
  }, [target]);

  // Siempre hay un `<dialog>` en el árbol (el navegador lo abre y cierra); su contenido solo existe mientras hay algo que compartir.
  const link = target ? buildShareUrl(target.url, group) : '';
  const message = target ? t('message', { title: target.title, entity: target.entityName }) : '';
  const text = `${message} ${link}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setStatus(`${t('copied')}. ${t('copiedHint')}`);
    } catch {
      setStatus(`${t('copyFailed')}. ${t('copyFailedHint')}`);
    }
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: target?.title, text: message, url: link });
    } catch {
      // Cerrar el menú del móvil sin elegir nada no es un error.
    }
  }

  const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 text-center font-bold';

  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl bg-white p-0 text-ink shadow-2xl backdrop:bg-varsity-navy-deep/70"
    >
      {target ? (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 id={headingId} className="font-joy text-lg font-bold text-varsity-navy">
            <span aria-hidden="true">{'📤 '}</span>
            {t('title')}
          </h2>
          <button type="button" onClick={() => dialog.current?.close()} aria-label={t('close')} className="inline-flex size-11 items-center justify-center rounded-lg text-xl font-bold text-ink-soft hover:bg-patio-rule">
            <span aria-hidden="true">{'✕'}</span>
          </button>
        </div>

        {target.groups.length > 0 ? (
          <div className="space-y-1">
            <label htmlFor={groupId} className="block text-sm font-bold text-varsity-navy">
              {t('groupLabel')}
            </label>
            <select id={groupId} value={group} onChange={(event) => setGroup(event.target.value)} className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold">
              <option value="">{t('groupAll')}</option>
              {target.groups.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
            <p className="text-sm text-ink-soft">{t('groupHint')}</p>
          </div>
        ) : null}

        <div>
          <p className="text-sm font-bold text-ink-soft">{t('previewLabel')}</p>
          <p className="mt-1 rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-sm italic text-ink wrap-anywhere">{text}</p>
        </div>

        <p role="status" aria-live="polite" className={status ? 'rounded-xl bg-emerald-50 p-3 text-sm font-bold text-emerald-950' : 'sr-only'}>
          {status}
        </p>

        <div className="grid grid-cols-2 gap-2.5 text-sm">
          <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer" className={`${buttonClass} bg-[#0f7a40] text-white`}>
            <span aria-hidden="true">{'📲'}</span> {t('whatsapp')}
          </a>
          <a href={`mailto:?subject=${encodeURIComponent(t('emailSubject', { title: target.title, entity: target.entityName }))}&body=${encodeURIComponent(text)}`} className={`${buttonClass} bg-sky-700 text-white`}>
            <span aria-hidden="true">{'✉️'}</span> {t('email')}
          </a>
          {canShare ? (
            <button type="button" onClick={nativeShare} className={`${buttonClass} bg-varsity-navy text-white`}>
              <span aria-hidden="true">{'🌐'}</span> {t('more')}
            </button>
          ) : null}
          <button type="button" onClick={copyLink} className={`${buttonClass} border-2 border-patio-rule-strong text-varsity-navy ${canShare ? '' : 'col-span-2'}`}>
            <span aria-hidden="true">{'🔗'}</span> {t('copy')}
          </button>
        </div>
      </div>
      ) : null}
    </dialog>
  );
}
