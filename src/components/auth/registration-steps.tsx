'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatCents } from '@/core/finance/money';
import { PROVINCES } from '@/core/onboarding/provinces';
import { CONTENT_LOCALES, LEGAL_FORMS_BY_VERTICAL, VERTICALS } from '@/core/onboarding/registration-rules';
import type { Locale } from '@/i18n/routing';
import { CheckboxField, Field, SelectField } from './auth-ui';

/**
 * Los tres pasos del alta (ARQUITECTURA_LANDING §3). Solo dibujan y avisan: las reglas viven en `registration-rules.ts` y el servidor las
 * vuelve a aplicar. Los errores llegan por campo (`errors['director.email']`).
 */

export interface SignerDraft {
  name: string;
  email: string;
  phone: string;
  roleLabel: string;
}

export interface RegistrationDraft {
  vertical: (typeof VERTICALS)[number];
  name: string;
  slug: string;
  provinceCode: string;
  city: string;
  postalCode: string;
  legalName: string;
  legalForm: string;
  centerOwnership: string;
  ley49: boolean;
  contentLocale: (typeof CONTENT_LOCALES)[number];
  publicIndexing: boolean;
  director: SignerDraft & { password: string; passwordRepeat: string };
  cosigner: SignerDraft;
  representationDeclared: boolean;
}

export interface StepProps {
  draft: RegistrationDraft;
  errors: Readonly<Record<string, string>>;
  update: (patch: Partial<RegistrationDraft>) => void;
}

const VERTICAL_ICON = { SCHOOL: '🏫', SPORTS_CLUB: '⚽', CULTURAL: '🎭' } as const;

export function CommunityStep({ draft, errors, update, appHost }: StepProps & { appHost: string }) {
  const t = useTranslations('registration');
  const school = draft.vertical === 'SCHOOL';
  const ownerLocked = draft.legalForm === 'SCHOOL_OWNER';
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-bold text-varsity-navy">{t('vertical.label')}</legend>
        <div className="mobile-stack grid gap-2 md:grid-cols-3">
          {VERTICALS.map((vertical) => (
            <label key={vertical} className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border-2 p-3 font-semibold ${draft.vertical === vertical ? 'border-varsity-emerald bg-emerald-50' : 'border-varsity-navy/30 bg-white'}`}>
              <input type="radio" name="vertical" value={vertical} checked={draft.vertical === vertical} onChange={() => update({ vertical })} className="size-5 accent-varsity-emerald" />
              <span aria-hidden="true">{VERTICAL_ICON[vertical]}</span>
              {t(`vertical.${vertical}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mobile-stack grid gap-4 md:grid-cols-2">
        <Field label={t('fields.name')} hint={t('hints.name')} value={draft.name} error={errors.name} onChange={(event) => update({ name: event.target.value })} required maxLength={80} />
        <Field label={t('fields.slug')} hint={t('hints.slug', { url: `${appHost}/${draft.slug || '…'}` })} value={draft.slug} error={errors.slug} onChange={(event) => update({ slug: event.target.value.toLowerCase() })} required maxLength={40} autoCapitalize="none" spellCheck={false} />
        <SelectField
          label={t('fields.province')}
          value={draft.provinceCode}
          error={errors.provinceCode}
          onChange={(event) => update({ provinceCode: event.target.value })}
          options={[{ value: '', label: t('choose') }, ...PROVINCES.map((province) => ({ value: province.code, label: province.name }))]}
          required
        />
        <Field label={t('fields.city')} value={draft.city} error={errors.city} onChange={(event) => update({ city: event.target.value })} required maxLength={60} autoComplete="address-level2" />
        <Field label={t('fields.postalCode')} value={draft.postalCode} error={errors.postalCode} onChange={(event) => update({ postalCode: event.target.value.replace(/\D/g, '').slice(0, 5) })} required inputMode="numeric" autoComplete="postal-code" />
      </div>

      <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('legalTitle')}</h3>
      <p className="text-sm text-ink-soft">{t('legalIntro')}</p>
      <div className="mobile-stack grid gap-4 md:grid-cols-2">
        <Field label={t('fields.legalName')} hint={t('hints.legalName')} value={draft.legalName} error={errors.legalName} onChange={(event) => update({ legalName: event.target.value })} required maxLength={120} />
        <SelectField
          label={t('fields.legalForm')}
          value={draft.legalForm}
          error={errors.legalForm}
          onChange={(event) => update({ legalForm: event.target.value, ...(event.target.value === 'SCHOOL_OWNER' ? { ley49: false } : {}) })}
          options={LEGAL_FORMS_BY_VERTICAL[draft.vertical].map((form) => ({ value: form, label: t(`legalForm.${form}`) }))}
        />
        {school ? (
          <SelectField
            label={t('fields.centerOwnership')}
            hint={draft.centerOwnership === 'PUBLIC' ? t('hints.publicSchool') : undefined}
            value={draft.centerOwnership}
            error={errors.centerOwnership}
            onChange={(event) => update({ centerOwnership: event.target.value })}
            options={['PUBLIC', 'CONCERTED', 'PRIVATE'].map((ownership) => ({ value: ownership, label: t(`ownership.${ownership}`) }))}
          />
        ) : null}
      </div>
      <CheckboxField label={t('fields.ley49')} hint={ownerLocked ? t('hints.ley49Owner') : t('hints.ley49')} checked={draft.ley49} disabled={ownerLocked} error={errors.ley49} onChange={(event) => update({ ley49: event.target.checked })} />

      <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('publicTitle')}</h3>
      <div className="mobile-stack grid gap-4 md:grid-cols-2">
        <SelectField label={t('fields.contentLocale')} hint={t('hints.contentLocale')} value={draft.contentLocale} onChange={(event) => update({ contentLocale: event.target.value as RegistrationDraft['contentLocale'] })} options={CONTENT_LOCALES.map((locale) => ({ value: locale, label: t(`contentLocale.${locale}`) }))} />
        <CheckboxField label={t('fields.publicIndexing')} hint={t('hints.publicIndexing')} checked={draft.publicIndexing} onChange={(event) => update({ publicIndexing: event.target.checked })} />
      </div>
    </div>
  );
}

function SignerFields({ who, draft, errors, update }: { who: 'director' | 'cosigner' } & StepProps) {
  const t = useTranslations('registration');
  const signer = draft[who];
  const set = (patch: Partial<RegistrationDraft['director']>) => update({ [who]: { ...signer, ...patch } } as Partial<RegistrationDraft>);
  const error = (field: string) => errors[`${who}.${field}`];
  return (
    <fieldset className="korum-notebook-sheet flex flex-col gap-4">
      <legend className="font-corp text-lg font-extrabold text-varsity-navy">{t(`signers.${who}Title`)}</legend>
      <p className="text-sm text-ink-soft">{t(`signers.${who}Intro`)}</p>
      <Field label={t('fields.roleLabel')} hint={t('hints.roleLabel')} value={signer.roleLabel} error={error('roleLabel')} onChange={(event) => set({ roleLabel: event.target.value })} required maxLength={60} />
      <Field label={t('fields.personName')} value={signer.name} error={error('name')} onChange={(event) => set({ name: event.target.value })} required maxLength={80} autoComplete={who === 'director' ? 'name' : 'off'} />
      <Field label={t('fields.email')} type="email" value={signer.email} error={error('email')} onChange={(event) => set({ email: event.target.value })} required autoComplete={who === 'director' ? 'email' : 'off'} />
      <Field label={t('fields.phone')} type="tel" value={signer.phone} error={error('phone')} onChange={(event) => set({ phone: event.target.value })} required autoComplete={who === 'director' ? 'tel' : 'off'} />
      {who === 'director' ? (
        <>
          <Field label={t('fields.password')} hint={t('hints.password')} type="password" value={draft.director.password} error={error('password')} onChange={(event) => set({ password: event.target.value })} required minLength={12} maxLength={128} autoComplete="new-password" />
          <Field label={t('fields.passwordRepeat')} type="password" value={draft.director.passwordRepeat} error={error('passwordRepeat')} onChange={(event) => set({ passwordRepeat: event.target.value })} required autoComplete="new-password" />
        </>
      ) : null}
    </fieldset>
  );
}

export function SignersStep(props: StepProps) {
  const t = useTranslations('registration');
  return (
    <div className="flex flex-col gap-5">
      <p className="text-ink-soft">{t('signers.intro')}</p>
      <div className="mobile-stack grid gap-5 lg:grid-cols-2">
        <SignerFields who="director" {...props} />
        <SignerFields who="cosigner" {...props} />
      </div>
    </div>
  );
}

export function ActivationStep({ draft, errors, update, exemptLimitCents, groupCount }: StepProps & { exemptLimitCents: number; groupCount: number }) {
  const t = useTranslations('registration');
  const locale = useLocale() as Locale;
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="activation-summary" className="korum-trust-vault flex flex-col gap-3 p-5">
        <h3 id="activation-summary" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('activation.title', { name: draft.name })}
        </h3>
        <ul className="flex list-disc flex-col gap-2 ps-5">
          <li>{t.rich('activation.exempt', { amount: formatCents(exemptLimitCents, locale), strong: (chunks) => <strong className="font-corp tabular-nums text-varsity-emerald">{chunks}</strong> })}</li>
          <li>{t('activation.groups', { count: groupCount, vertical: t(`vertical.${draft.vertical}`) })}</li>
          <li>{t('activation.signers', { director: draft.director.roleLabel, cosigner: draft.cosigner.roleLabel })}</li>
          <li>{t('activation.kyb')}</li>
        </ul>
        <p className="text-sm text-ink-soft">{t('activation.money')}</p>
      </section>
      <CheckboxField label={t('fields.representationDeclared', { legalName: draft.legalName })} checked={draft.representationDeclared} error={errors.representationDeclared} onChange={(event) => update({ representationDeclared: event.target.checked })} required />
    </div>
  );
}
