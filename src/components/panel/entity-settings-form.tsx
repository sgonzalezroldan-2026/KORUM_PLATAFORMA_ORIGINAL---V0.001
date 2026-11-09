'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { saveEntitySettingsAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/actions';
import { CheckboxField, Field, FormAlert, SelectField } from '@/components/auth/auth-ui';
import { SETTINGS_LIMITS, settingsFieldIssues, type EntitySettingsInput } from '@/core/panel/entity-settings-rules';
import { useApprovalsNotice } from './approvals-notice';

type Trio = [number, number, number];
const TIERS = ['bronze', 'silver', 'gold'] as const;
const LOCALES = ['es', 'ca', 'en'] as const;
const L = SETTINGS_LIMITS;

/**
 * Ajustes generales de la entidad (Sprint 4.2c; «Valores de donación por defecto, firmas y patrocinios» del prototipo, más el teléfono de la entidad,
 * el idioma del contenido y la indexación). En euros enteros; el servidor guarda céntimos. Los errores se dicen junto a cada campo (o grupo) y el
 * foco va al primero; sin permiso (Super-Admin) todo queda en solo lectura (`readOnly` en los campos, que siguen en el orden del teclado; los
 * desplegables y la casilla, que no lo admiten, desactivados).
 */
export function EntitySettingsForm({ orgSlug, initial, canEdit }: { orgSlug: string; initial: EntitySettingsInput; canEdit: boolean }) {
  const t = useTranslations('panel.settings.general');
  const router = useRouter();
  const notify = useApprovalsNotice();
  const ids = { donations: useId(), donationsHint: useId(), donationsError: useId(), tiers: useId(), tiersHint: useId(), tiersError: useId() };
  const [values, setValues] = useState(initial);
  const [fields, setFields] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (fields.length > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fields]);

  const set = <K extends keyof EntitySettingsInput>(key: K, value: EntitySettingsInput[K]) => setValues((current) => ({ ...current, [key]: value }));
  const setTrio = (key: 'donationPresetsEuros' | 'sponsorTiersEuros', index: number, raw: string) => {
    const next = [...values[key]] as Trio;
    next[index] = raw === '' ? Number.NaN : Number(raw);
    set(key, next);
  };
  const invalid = (key: string) => (fields.includes(key) ? true : undefined);
  const error = (key: string, limits: Record<string, number> = {}) => (fields.includes(key) ? t(`errors.${key}`, limits) : null);
  const numberValue = (value: number) => (Number.isNaN(value) ? '' : String(value));
  const describedBy = (key: string, hint: string, errorId: string) => (fields.includes(key) ? `${hint} ${errorId}` : hint);

  async function submit() {
    const issues = settingsFieldIssues(values);
    if (issues.length > 0) {
      setFields(issues);
      setFormError(t('errors.form'));
      return;
    }
    setBusy(true);
    setFields([]);
    setFormError(null);
    try {
      const result = await saveEntitySettingsAction(orgSlug, values);
      if (result.status === 'OK') {
        const moved = result.ideasToDoubleCheck ?? 0;
        notify(moved > 0 ? t('savedQuorum', { count: moved }) : t('saved'));
        router.refresh();
      } else if (result.reason === 'INVALID') {
        setFields(result.fields ?? []);
        setFormError(t('errors.form'));
      } else setFormError(t(`errors.${result.reason === 'FORBIDDEN' ? 'FORBIDDEN' : 'generic'}`));
    } catch {
      setFormError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  const trioInputs = (key: 'donationPresetsEuros' | 'sponsorTiersEuros', label: (index: number) => string, min: number, max: number, describedById: string) =>
    values[key].map((value, index) => (
      <div key={index} className="flex flex-col gap-1">
        <label htmlFor={`${ids[key === 'donationPresetsEuros' ? 'donations' : 'tiers']}-${index}`} className="text-sm font-bold text-varsity-navy">
          {label(index)}
        </label>
        <input
          id={`${ids[key === 'donationPresetsEuros' ? 'donations' : 'tiers']}-${index}`}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          readOnly={!canEdit}
          value={numberValue(value)}
          onChange={(event) => setTrio(key, index, event.target.value)}
          aria-invalid={invalid(key)}
          aria-describedby={describedById}
          className="min-h-12 w-full rounded-xl border-2 border-varsity-navy bg-white px-3 text-center font-corp text-lg font-extrabold tabular-nums aria-[invalid=true]:border-red-700 read-only:bg-stone-100"
        />
      </div>
    ));

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-5"
      noValidate
    >
      <fieldset className="korum-trust-vault flex min-w-0 flex-col gap-3 p-4">
        <legend className="px-1 font-corp text-lg font-extrabold text-varsity-navy">{t('donations.legend')}</legend>
        <p id={ids.donationsHint} className="text-sm text-ink-soft">
          {t('donations.hint', { min: L.donationMinEuros, max: L.donationMaxEuros })}
        </p>
        <div className="grid grid-cols-3 gap-2">{trioInputs('donationPresetsEuros', (index) => t('donations.amount', { n: index + 1 }), L.donationMinEuros, L.donationMaxEuros, describedBy('donationPresetsEuros', ids.donationsHint, ids.donationsError))}</div>
        {fields.includes('donationPresetsEuros') ? (
          <p id={ids.donationsError} role="alert" className="text-sm font-semibold text-red-800">
            {error('donationPresetsEuros', { min: L.donationMinEuros, max: L.donationMaxEuros })}
          </p>
        ) : null}
        <SelectField
          label={t('donations.defaultLegend')}
          disabled={!canEdit}
          value={String(values.defaultDonationIdx)}
          onChange={(event) => set('defaultDonationIdx', Number(event.target.value))}
          error={error('defaultDonationIdx')}
          options={values.donationPresetsEuros.map((amount, index) => ({ value: String(index), label: t('donations.defaultOption', { n: index + 1, amount: numberValue(amount) }) }))}
        />
      </fieldset>

      <fieldset className="korum-trust-vault mobile-stack grid min-w-0 gap-3 p-4 md:grid-cols-2">
        <legend className="px-1 font-corp text-lg font-extrabold text-varsity-navy">{t('ideas.legend')}</legend>
        <Field
          label={t('ideas.minVotes')}
          hint={t('ideas.minVotesHint', { min: L.minVotesMin, max: L.minVotesMax })}
          error={error('minVotes', { min: L.minVotesMin, max: L.minVotesMax })}
          type="number"
          inputMode="numeric"
          min={L.minVotesMin}
          max={L.minVotesMax}
          readOnly={!canEdit}
          value={numberValue(values.minVotes)}
          onChange={(event) => set('minVotes', event.target.value === '' ? Number.NaN : Number(event.target.value))}
        />
        <Field
          label={t('ideas.maxIdeaDays')}
          hint={t('ideas.maxIdeaDaysHint', { min: L.ideaDaysMin, max: L.ideaDaysMax })}
          error={error('maxIdeaDays', { min: L.ideaDaysMin, max: L.ideaDaysMax })}
          type="number"
          inputMode="numeric"
          min={L.ideaDaysMin}
          max={L.ideaDaysMax}
          readOnly={!canEdit}
          value={numberValue(values.maxIdeaDays)}
          onChange={(event) => set('maxIdeaDays', event.target.value === '' ? Number.NaN : Number(event.target.value))}
        />
      </fieldset>

      <fieldset className="korum-trust-vault flex min-w-0 flex-col gap-3 p-4">
        <legend className="px-1 font-corp text-lg font-extrabold text-varsity-navy">{t('sponsors.legend')}</legend>
        <p id={ids.tiersHint} className="text-sm text-ink-soft">
          {t('sponsors.hint', { min: L.sponsorMinEuros, max: L.sponsorMaxEuros })}
        </p>
        <div className="grid grid-cols-3 gap-2">{trioInputs('sponsorTiersEuros', (index) => t(`sponsors.tier.${TIERS[index]!}`), L.sponsorMinEuros, L.sponsorMaxEuros, describedBy('sponsorTiersEuros', ids.tiersHint, ids.tiersError))}</div>
        {fields.includes('sponsorTiersEuros') ? (
          <p id={ids.tiersError} role="alert" className="text-sm font-semibold text-red-800">
            {error('sponsorTiersEuros', { min: L.sponsorMinEuros, max: L.sponsorMaxEuros })}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="korum-trust-vault flex min-w-0 flex-col gap-3 p-4">
        <legend className="px-1 font-corp text-lg font-extrabold text-varsity-navy">{t('contact.legend')}</legend>
        <Field label={t('contact.phone')} hint={t('contact.phoneHint')} error={error('phone')} type="tel" autoComplete="tel" maxLength={30} readOnly={!canEdit} value={values.phone} onChange={(event) => set('phone', event.target.value)} />
      </fieldset>

      <fieldset className="korum-trust-vault flex min-w-0 flex-col gap-3 p-4">
        <legend className="px-1 font-corp text-lg font-extrabold text-varsity-navy">{t('portal.legend')}</legend>
        <SelectField
          label={t('portal.contentLocale')}
          hint={t('portal.contentLocaleHint')}
          disabled={!canEdit}
          value={values.contentLocale}
          onChange={(event) => set('contentLocale', event.target.value as (typeof LOCALES)[number])}
          options={LOCALES.map((locale) => ({ value: locale, label: t(`portal.locales.${locale}`) }))}
        />
        <CheckboxField label={t('portal.publicIndexing')} hint={t('portal.publicIndexingHint')} disabled={!canEdit} checked={values.publicIndexing} onChange={(event) => set('publicIndexing', event.target.checked)} />
      </fieldset>

      {formError ? <FormAlert>{formError}</FormAlert> : null}
      {canEdit ? (
        <button type="submit" disabled={busy} aria-busy={busy} className="tactile-btn self-start disabled:opacity-60">
          <span aria-hidden="true">{'💾 '}</span>
          {busy ? t('saving') : t('save')}
        </button>
      ) : null}
    </form>
  );
}
