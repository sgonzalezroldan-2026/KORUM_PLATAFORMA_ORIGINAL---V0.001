'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { proposeIdeaAction } from '@/app/[locale]/(public)/[orgSlug]/ideas/actions';
import { IDEA_DESCRIPTION_MAX, IDEA_DESCRIPTION_MIN, IDEA_TITLE_MAX, IDEA_TITLE_MIN } from '@/core/ideas/idea-rules';

export interface ProposeIdeaDialogProps {
  open: boolean;
  onClose: () => void;
  onProposed: () => void;
  orgSlug: string;
  locale: string;
  categories: { name: string; icon: string }[];
}

type FieldErrors = Partial<Record<'title' | 'category' | 'description', string>>;

const fieldClass = (invalid: boolean) => clsx('min-h-11 w-full rounded-xl border-2 bg-white px-3 py-2 font-semibold', invalid ? 'border-red-700' : 'border-patio-rule-strong');

/**
 * Proponer una idea (`id="new-idea-modal"` del prototipo). Diálogo nativo: atrapa el foco, se cierra con Escape y devuelve el foco. Los errores van
 * junto a su campo, con `aria-describedby`, y un resumen con `role="alert"` mueve el foco al primer campo inválido. Al enviar, la persona recibe su
 * código anónimo `#FAM-XXXX`: es lo único que verán las demás.
 */
export function ProposeIdeaDialog({ open, onClose, onProposed, orgSlug, locale, categories }: ProposeIdeaDialogProps) {
  const t = useTranslations('portal.ideas.dialog');
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const ids = { title: useId(), category: useId(), description: useId(), privacy: useId(), error: useId() };
  const titleField = useRef<HTMLInputElement>(null);
  const categoryField = useRef<HTMLSelectElement>(null);
  const descriptionField = useRef<HTMLTextAreaElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [alias, setAlias] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [pending, startTransition] = useTransition();
  const doneButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      setErrors({});
      setFormError('');
      setAlias(null);
      setDescription('');
      node.showModal();
    }
    if (!open && node.open) node.close();
  }, [open]);

  // Al enviarse, el formulario se desmonta: el foco pasa al botón «Entendido» y no se pierde al principio del documento (WCAG 2.4.3).
  useEffect(() => {
    if (alias) doneButton.current?.focus();
  }, [alias]);

  const clearError = (field: keyof FieldErrors) => setErrors((previous) => (previous[field] ? { ...previous, [field]: undefined } : previous));

  function validate(form: FormData): FieldErrors {
    const found: FieldErrors = {};
    const title = String(form.get('title') ?? '').trim();
    const text = String(form.get('description') ?? '').trim();
    if (title.length < IDEA_TITLE_MIN) found.title = t('errors.titleShort', { min: IDEA_TITLE_MIN });
    if (!String(form.get('category') ?? '')) found.category = t('errors.category');
    if (text.length < IDEA_DESCRIPTION_MIN) found.description = t('errors.descriptionShort', { min: IDEA_DESCRIPTION_MIN });
    return found;
  }

  function focusFirstInvalid(found: FieldErrors) {
    if (found.title) titleField.current?.focus();
    else if (found.category) categoryField.current?.focus();
    else if (found.description) descriptionField.current?.focus();
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const found = validate(form);
    setErrors(found);
    setFormError('');
    if (Object.keys(found).length > 0) {
      setFormError(t('errors.summary'));
      focusFirstInvalid(found);
      return;
    }
    startTransition(async () => {
      const outcome = await proposeIdeaAction({ orgSlug, locale, title: form.get('title'), category: form.get('category'), description: form.get('description') });
      if (outcome.status === 'PROPOSED') {
        setAlias(outcome.alias);
        onProposed();
        return;
      }
      setFormError(outcome.status === 'LOGIN_REQUIRED' ? t('errors.LOGIN_REQUIRED') : t(`errors.${outcome.reason}`));
    });
  }

  const describedBy = (field: keyof FieldErrors, extra?: string) => [errors[field] ? `${ids[field]}-error` : '', extra ?? ''].filter(Boolean).join(' ') || undefined;

  return (
    <dialog
      ref={dialog}
      id="new-idea-modal"
      aria-labelledby={headingId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-3xl bg-white p-0 text-ink shadow-2xl backdrop:bg-varsity-navy-deep/70"
    >
      {open ? (
        <div className="space-y-4 p-6">
          {/* Región viva siempre montada: el anuncio llega al inyectar el texto, no al montarla ya rellena. */}
          <p role="status" aria-live="polite" className="sr-only">
            {alias ? `${t('doneTitle')} ${t('doneBody', { alias })}` : ''}
          </p>
          <div className="flex items-start justify-between gap-3">
            <h2 id={headingId} className="font-joy text-xl font-bold text-varsity-navy">
              <span aria-hidden="true">{'💡 '}</span>
              {alias ? t('doneTitle') : t('title')}
            </h2>
            <button type="button" onClick={() => dialog.current?.close()} aria-label={t('close')} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xl font-bold text-ink-soft hover:bg-patio-rule">
              <span aria-hidden="true">{'✕'}</span>
            </button>
          </div>

          {alias ? (
            <div className="space-y-4">
              <p className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 font-bold text-emerald-950">{t('doneBody', { alias })}</p>
              <p className="text-sm text-ink-soft">{t('doneNext')}</p>
              <button ref={doneButton} type="button" onClick={() => dialog.current?.close()} className="tactile-btn w-full rounded-2xl!">
                {t('doneClose')}
              </button>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="space-y-4">
              {formError ? (
                <p id={ids.error} role="alert" className="rounded-xl border-2 border-red-700 bg-red-50 p-3 text-sm font-bold text-red-900">
                  {formError}
                </p>
              ) : null}
              <p id={ids.privacy} className="rounded-xl bg-amber-50 p-3 text-sm text-ink">
                <span aria-hidden="true">{'🔒 '}</span>
                {t('privacy')}
              </p>

              <div className="space-y-1">
                <label htmlFor={ids.title} className="block text-sm font-bold text-varsity-navy">
                  {t('titleLabel')}
                </label>
                <input
                  ref={titleField}
                  id={ids.title}
                  name="title"
                  type="text"
                  maxLength={IDEA_TITLE_MAX}
                  autoComplete="off"
                  onChange={() => clearError('title')}
                  placeholder={t('titlePlaceholder')}
                  aria-invalid={errors.title ? true : undefined}
                  aria-describedby={describedBy('title')}
                  className={fieldClass(Boolean(errors.title))}
                />
                {errors.title ? (
                  <p id={`${ids.title}-error`} className="text-sm font-bold text-red-800">
                    {errors.title}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1">
                <label htmlFor={ids.category} className="block text-sm font-bold text-varsity-navy">
                  {t('categoryLabel')}
                </label>
                <select ref={categoryField} id={ids.category} name="category" defaultValue="" onChange={() => clearError('category')} aria-invalid={errors.category ? true : undefined} aria-describedby={describedBy('category')} className={fieldClass(Boolean(errors.category))}>
                  <option value="" disabled>
                    {t('categoryPlaceholder')}
                  </option>
                  {categories.map((category) => (
                    <option key={category.name} value={category.name}>
                      {`${category.icon} ${category.name}`}
                    </option>
                  ))}
                </select>
                {errors.category ? (
                  <p id={`${ids.category}-error`} className="text-sm font-bold text-red-800">
                    {errors.category}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1">
                <label htmlFor={ids.description} className="block text-sm font-bold text-varsity-navy">
                  {t('descriptionLabel')}
                </label>
                <textarea
                  ref={descriptionField}
                  id={ids.description}
                  name="description"
                  rows={4}
                  maxLength={IDEA_DESCRIPTION_MAX}
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    clearError('description');
                  }}
                  placeholder={t('descriptionPlaceholder')}
                  aria-invalid={errors.description ? true : undefined}
                  aria-describedby={describedBy('description', `${ids.description}-count`)}
                  className={fieldClass(Boolean(errors.description))}
                />
                <p id={`${ids.description}-count`} className="text-right text-sm text-ink-soft tabular-nums">
                  {t('counter', { count: description.length, max: IDEA_DESCRIPTION_MAX })}
                </p>
                {errors.description ? (
                  <p id={`${ids.description}-error`} className="text-sm font-bold text-red-800">
                    {errors.description}
                  </p>
                ) : null}
              </div>

              <button type="submit" disabled={pending} aria-busy={pending} className="tactile-btn w-full rounded-2xl! py-3! font-joy text-base disabled:opacity-60">
                <span aria-hidden="true">{'🚀 '}</span>
                {pending ? t('sending') : t('submit')}
              </button>
            </form>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
