'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { saveLegalTextAction, saveSectionAction } from '@/app/[locale]/(superadmin)/admin/ajustes/actions';
import { focusLater } from '@/components/admin/rules-action';
import { LEGAL_DOCUMENTS, LEGAL_LOCALES, legalKeyOf, legalToday, nextLegalVersion, parseLegalVersion } from '@/core/admin/settings-model';
import { Link } from '@/i18n/navigation';
import type { LegalOverviewRow, LegalSelected, SettingFieldView } from '@/services/admin/platform-settings-view';
import { FIELD, fieldErrorId, fieldId, OUTLINE, PRIMARY, SaveBar, SectionForm, SettingsOutcome, useFieldError, useSettingsAction, useUnsaved } from './settings-kit';

type Company = { legalName: string; taxId: string; address: string; supportEmail: string; privacyEmail: string };
const COMPANY_FIELDS = ['legalName', 'taxId', 'address', 'supportEmail', 'privacyEmail'] as const;
const EMPTY_COMPANY: Company = { legalName: '', taxId: '', address: '', supportEmail: '', privacyEmail: '' };
const companyKey = (field: (typeof COMPANY_FIELDS)[number]) => `platform.company.${field}`;

const companyOf = (value: unknown): Company => {
  if (typeof value !== 'object' || value === null) return EMPTY_COMPANY;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(COMPANY_FIELDS.map((key) => [key, typeof record[key] === 'string' ? record[key] : ''])) as Company;
};

/** Datos de la empresa. Todavía no los usa ninguna página, email ni factura (se conectan antes de abrir al público); con todos los campos vacíos se borran. */
export function CompanySettings({ field }: { field: SettingFieldView | undefined }) {
  const t = useTranslations('admin.settings');
  const [company, setCompany] = useState<Company>(() => companyOf(field?.value));
  const action = useSettingsAction({ failureFocusId: fieldId('platform.company') });
  const errorOf = useFieldError(action.outcome);
  const empty = COMPANY_FIELDS.every((key) => company[key].trim() === '');
  const generic = errorOf('platform.company');
  // Se mide contra lo que había al abrir o al guardar esta persona (no contra lo guardado ahora: el cambio de otra persona no convierte la pantalla en «con cambios»).
  const [baseline, setBaseline] = useState(() => JSON.stringify(company));
  useUnsaved('company', JSON.stringify(company) !== baseline);
  return (
    <SectionForm
      testId="company-form"
      onSubmit={() =>
        action.run(
          () => saveSectionAction({ section: 'empresa', values: { 'platform.company': empty ? null : company }, versions: { 'platform.company': field?.version ?? 0 }, confirmations: [] }),
          (result) => (result.detail === '0' ? t('savedNoChanges') : t('saved')),
          () => setBaseline(JSON.stringify(company))
        )
      }
    >
      <fieldset id={fieldId('platform.company')} tabIndex={-1} className="flex min-w-0 flex-col gap-3 outline-offset-4">
        <legend className="font-corp text-lg font-extrabold text-varsity-navy">{t('company.title')}</legend>
        <p className="text-sm text-ink-soft">{t('company.hint')}</p>
        {generic ? <p className="text-sm font-semibold text-red-900">{generic}</p> : null}
        <div className="mobile-stack grid gap-4 md:grid-cols-2">
          {COMPANY_FIELDS.map((key) => {
            const id = fieldId(companyKey(key));
            // Vacío: «Escribe…»; con algo escrito pero mal: qué revisar.
            const error = errorOf(companyKey(key)) ? (company[key].trim() === '' ? t(`company.required.${key}`) : t(`company.errors.${key}`)) : null;
            return (
              <div key={key} className={`flex flex-col gap-1 ${key === 'address' ? 'md:col-span-2' : ''}`}>
                <label htmlFor={id} className="font-semibold text-varsity-navy">
                  {t(`company.fields.${key}`)}
                </label>
                <input
                  id={id}
                  type="text"
                  inputMode={key.endsWith('Email') ? 'email' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={key === 'address' ? 300 : key === 'supportEmail' || key === 'privacyEmail' ? 254 : 200}
                  value={company[key]}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? fieldErrorId(companyKey(key)) : undefined}
                  onChange={(event) => setCompany((current) => ({ ...current, [key]: event.target.value }))}
                  className={`${FIELD} aria-invalid:border-red-700`}
                />
                {error ? (
                  <p id={fieldErrorId(companyKey(key))} className="text-sm font-semibold text-red-900">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        <SaveBar pending={action.pending} outcome={action.outcome} failed={action.failed} testId="save-empresa" />
      </fieldset>
    </SectionForm>
  );
}

const textHref = (document: string, locale: string) => ({ pathname: '/admin/ajustes' as const, query: { texto: `${document}.${locale}` }, hash: 'editor-texto' });

/** La matriz de textos legales (documento × idioma): qué versión y estado tiene cada uno, y cuál se está editando. */
function LegalMatrix({ overview, selected }: { overview: LegalOverviewRow[]; selected: LegalSelected }) {
  const t = useTranslations('admin.settings.legal');
  return (
    <div tabIndex={0} role="region" aria-label={t('matrixTitle')} className="overflow-x-auto rounded-xl border-2 border-varsity-navy/15">
      <table className="w-full min-w-[34rem] text-left text-sm" data-testid="legal-matrix">
        <caption className="sr-only">{t('matrixTitle')}</caption>
        <thead className="bg-varsity-navy/5 text-varsity-navy">
          <tr>
            <th scope="col" className="p-2 font-bold">
              {t('colDocument')}
            </th>
            {LEGAL_LOCALES.map((locale) => (
              <th key={locale} scope="col" className="p-2 font-bold">
                {t(`locales.${locale}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LEGAL_DOCUMENTS.map((document) => (
            <tr key={document} className="border-t border-varsity-navy/10">
              <th scope="row" className="p-2 font-semibold">
                {t(`documents.${document}`)}
              </th>
              {LEGAL_LOCALES.map((locale) => {
                const row = overview.find((item) => item.document === document && item.locale === locale);
                const current = selected.document === document && selected.locale === locale;
                return (
                  <td key={locale} className="p-1">
                    <Link
                      href={textHref(document, locale)}
                      aria-current={current ? 'true' : undefined}
                      data-testid={`legal-${document}-${locale}`}
                      className={`relative inline-flex min-h-11 flex-col justify-center rounded-lg px-3 py-1 hover:bg-varsity-navy/5 ${current ? 'border-2 border-varsity-navy bg-varsity-navy/5' : 'border-2 border-transparent'}`}
                    >
                      <span className="sr-only">{t('openAria', { document: t(`documents.${document}`), locale: t(`locales.${locale}`) })}</span>
                      {row?.version ? (
                        <>
                          <span className="font-corp font-bold tabular-nums">{row.version}</span> <span className="text-xs text-ink-soft">{row.status ? t(`status.${row.status}`) : ''}</span>
                        </>
                      ) : (
                        <span className="text-xs text-ink-soft">{t('statusNone')}</span>
                      )}
                    </Link>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Status = 'BORRADOR' | 'PUBLICADO';

/** El editor del texto elegido. Un texto publicado no se edita bajo su versión ni vuelve a borrador: se publica una versión nueva (el servidor lo vuelve a comprobar). */
function LegalEditor({ selected, suggestedVersion }: { selected: LegalSelected; suggestedVersion: string }) {
  const t = useTranslations('admin.settings.legal');
  const common = useTranslations('admin.settings');
  const locale = useLocale();
  const ids = useId();
  const published = selected.text?.status === 'PUBLICADO';
  const [version, setVersion] = useState(published ? suggestedVersion : (selected.text?.version ?? suggestedVersion));
  const [status, setStatus] = useState<Status>(published ? 'PUBLICADO' : (selected.text?.status ?? 'BORRADOR'));
  const [markdown, setMarkdown] = useState(selected.text?.markdown ?? '');
  const [confirming, setConfirming] = useState(false);
  const action = useSettingsAction({ failureFocusId: fieldId('markdown') });
  const errorOf = useFieldError(action.outcome);
  const versionError = errorOf('version');
  const markdownError = errorOf('markdown');
  // Publicar un texto igual que el vigente (con otra versión) no aporta nada: se pide cambiarlo.
  const nothingToPublish = published && markdown === selected.text?.markdown;

  const initial = useState({ version, status, markdown })[0];
  useUnsaved('legal-text', version !== initial.version || status !== initial.status || markdown !== initial.markdown);
  // Al llegar desde la matriz (o tras guardar, que vuelve a montar el editor) el foco va al título del editor: la vista ya está ahí y quien usa teclado no se queda en el enlace de la tabla.
  useEffect(() => {
    if (window.location.hash === '#editor-texto') document.getElementById('editor-texto')?.focus();
  }, []);
  const closeConfirmation = () => setConfirming(false);
  const afterSave = () => {
    closeConfirmation();
    focusLater('editor-texto');
  };
  const cancel = () => {
    closeConfirmation();
    focusLater('legal-save');
  };
  const submit = () =>
    action.run(
      () => saveLegalTextAction({ document: selected.document, locale: selected.locale, version, status, markdown, expectedVersion: selected.settingVersion }),
      (result) => t(status === 'PUBLICADO' ? 'published' : 'saved', { version: result.detail ?? version }),
      afterSave,
      closeConfirmation
    );

  return (
    <SectionForm
      testId="legal-editor"
      className="flex scroll-mt-4 flex-col gap-4"
      onSubmit={() => {
        if (status === 'PUBLICADO' && !confirming) {
          if (nothingToPublish) return;
          setConfirming(true);
          focusLater('legal-confirm-cancel');
          return;
        }
        submit();
      }}
    >
      <h3 className="font-corp scroll-mt-24 text-lg font-extrabold text-varsity-navy outline-offset-4" id="editor-texto" tabIndex={-1}>
        {t('editing', { document: t(`documents.${selected.document}`), locale: t(`locales.${selected.locale}`) })}
      </h3>
      <p className="text-sm text-ink-soft">{published ? t('publishedHint', { version: selected.text?.version ?? '' }) : t('draftHint')}</p>
      <div className="mobile-stack grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('version')} className="font-semibold text-varsity-navy">
            {t('version')}
          </label>
          <input
            id={fieldId('version')}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            value={version}
            aria-describedby={versionError ? `${ids}-version-help ${fieldErrorId('version')}` : `${ids}-version-help`}
            onChange={(event) => setVersion(event.target.value)}
            aria-invalid={versionError ? true : undefined}
            className={`${FIELD} aria-invalid:border-red-700`}
            data-testid="legal-version"
          />
          {versionError ? (
            <p id={fieldErrorId('version')} className="text-sm font-semibold text-red-900">
              {versionError}
            </p>
          ) : null}
          <p id={`${ids}-version-help`} className="text-sm text-ink-soft">
            {t('versionHelp')}
          </p>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="font-semibold text-varsity-navy">{t('statusLabel')}</legend>
          {(['BORRADOR', 'PUBLICADO'] as const).map((value) => (
            <label key={value} className="inline-flex min-h-11 items-center gap-2 font-semibold">
              <input
                type="radio"
                name={`${ids}-status`}
                className="size-5"
                value={value}
                checked={status === value}
                disabled={published && value === 'BORRADOR'}
                onChange={() => {
                  setStatus(value);
                  setConfirming(false);
                  // Un texto se publica con la fecha de hoy: si el borrador llevaba otra, se propone la de hoy (se puede cambiar).
                  if (value === 'PUBLICADO' && parseLegalVersion(version)?.date !== legalToday(new Date())) setVersion(nextLegalVersion(null, new Date()));
                }}
              />
              {t(`status.${value}`)}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('markdown')} className="font-semibold text-varsity-navy">
          {t('text')}
        </label>
        <textarea
          id={fieldId('markdown')}
          lang={locale === selected.locale ? undefined : selected.locale}
          rows={16}
          maxLength={200_000}
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
          aria-describedby={markdownError ? `${ids}-count ${fieldErrorId('markdown')}` : `${ids}-count`}
          aria-invalid={markdownError ? true : undefined}
          className="min-h-48 w-full scroll-mt-24 rounded-lg border-2 border-varsity-navy/30 bg-white px-3 py-2 font-mono text-sm aria-invalid:border-red-700"
          data-testid="legal-markdown"
        />
        {markdownError ? (
          <p id={fieldErrorId('markdown')} className="text-sm font-semibold text-red-900">
            {markdownError}
          </p>
        ) : null}
        <p id={`${ids}-count`} className="text-sm text-ink-soft">
          {t('characters', { count: markdown.length })}
        </p>
      </div>
      {confirming ? (
        <div
          role="group"
          aria-labelledby={`${ids}-confirm`}
          className="flex flex-col gap-2 rounded-xl border-2 border-amber-600/40 bg-amber-50 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel();
          }}
        >
          <p id={`${ids}-confirm`} className="text-sm font-semibold text-amber-950">
            {t('confirmPublish', { version, locale: t(`locales.${selected.locale}`) })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" id="legal-confirm-cancel" className={OUTLINE} onClick={cancel}>
              {common('cancel')}
            </button>
            <button type="submit" aria-disabled={action.pending} aria-busy={action.pending} className={PRIMARY} data-testid="legal-confirm">
              {action.pending ? common('saving') : t('confirmYes', { version })}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <button
            type="submit"
            id="legal-save"
            aria-disabled={action.pending || markdown.trim() === '' || nothingToPublish}
            aria-busy={action.pending}
            className={`${PRIMARY} w-fit`}
            data-testid="legal-save"
          >
            {status === 'PUBLICADO' ? (published ? t('publish') : t('publishFirst')) : t('saveDraft')}
          </button>
          {nothingToPublish ? <p className="text-sm text-ink-soft">{t('nothingToPublish')}</p> : null}
        </div>
      )}
      <SettingsOutcome outcome={action.outcome} failed={action.failed} />
    </SectionForm>
  );
}

export function LegalSettings({ overview, selected, policyVersion, suggestedVersion }: { overview: LegalOverviewRow[]; selected: LegalSelected; policyVersion: string; suggestedVersion: string }) {
  const t = useTranslations('admin.settings.legal');
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft">{t('intro')}</p>
      <p className="rounded-xl bg-varsity-navy/5 p-3 text-sm" data-testid="policy-version">
        {t('policyVersion', { version: policyVersion })}
      </p>
      <LegalMatrix overview={overview} selected={selected} />
      <LegalEditor key={`${legalKeyOf(selected.document, selected.locale)}:${selected.settingVersion}`} selected={selected} suggestedVersion={suggestedVersion} />
    </div>
  );
}
