'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { saveEntityAccentAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/brand-actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { ENTITY_ACCENTS, NAVY, type EntityAccentId } from '@/core/brand/entity-palette';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Color de la entidad (Sprint 4.2e, ancla `applySchoolTheme`; decisión del promotor: paleta cerrada). Cada muestra se dibuja sobre el azul marino de
 * la cabecera del portal, como se verá, y lleva su nombre en texto (el color no es la única pista). Con un color antiguo fuera de la paleta no hay
 * ninguno marcado hasta elegir uno.
 */
export function EntityAccentForm({ orgSlug, current, canEdit }: { orgSlug: string; current: EntityAccentId | null; canEdit: boolean }) {
  const t = useTranslations('panel.settings.brand.accent');
  const router = useRouter();
  const notify = useApprovalsNotice();
  const [accent, setAccent] = useState<EntityAccentId | null>(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!accent) return setError(t('errors.choose'));
    setBusy(true);
    setError(null);
    try {
      const result = await saveEntityAccentAction(orgSlug, { accent });
      if (result.status === 'OK') {
        notify(t('saved'));
        router.refresh();
      } else setError(t(result.reason === 'FORBIDDEN' ? 'errors.FORBIDDEN' : 'errors.generic'));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="font-bold text-varsity-navy">{t('legend')}</legend>
        <p className="text-sm text-ink-soft">{t('hint')}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ENTITY_ACCENTS.map((option) => (
            <label key={option.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-varsity-navy/20 bg-white px-2 py-2 has-checked:border-varsity-navy has-checked:ring-2 has-checked:ring-varsity-gold">
              <input type="radio" name="accent" value={option.id} checked={accent === option.id} disabled={!canEdit} onChange={() => setAccent(option.id)} className="size-5 shrink-0 accent-varsity-navy" />
              <span aria-hidden="true" className="flex size-8 shrink-0 items-end overflow-hidden rounded-lg" style={{ background: NAVY }}>
                <span className="block h-2 w-full" style={{ background: option.hex }} />
              </span>
              <span className="text-sm font-semibold text-varsity-navy">{t(`names.${option.id}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error ? <FormAlert>{error}</FormAlert> : null}
      {canEdit ? (
        <button type="submit" disabled={busy} aria-busy={busy} className="tactile-btn self-start disabled:opacity-60">
          {t('save')}
        </button>
      ) : null}
    </form>
  );
}
