'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { CRAWLER_USER_AGENT, SECTION_SECRETS } from '@/core/admin/settings-model';
import type { SecretSummary } from '@/services/settings/settings.service';
import type { SettingFieldView } from '@/services/admin/platform-settings-view';
import { FIELD, fieldId, OUTLINE, SaveBar, SectionForm, SettingField, useSectionForm, useUnsaved } from './settings-kit';
import { SecretField } from './settings-secret-field';

interface CrawlerRule {
  userAgent: string;
  allow: boolean;
}
export interface CrawlerPolicyValue {
  search: CrawlerRule[];
  training: CrawlerRule[];
}

type Group = keyof CrawlerPolicyValue;
const GROUPS: readonly Group[] = ['search', 'training'];

const isPolicy = (value: unknown): value is CrawlerPolicyValue => typeof value === 'object' && value !== null && GROUPS.every((group) => Array.isArray((value as Record<string, unknown>)[group]));

/** Una lista de rastreadores (búsqueda o entrenamiento): cada uno con su casilla «permitido» y su botón de quitar, y un alta con comprobación del nombre. */
function CrawlerGroup({ group, rules, onChange, others }: { group: Group; rules: CrawlerRule[]; onChange: (rules: CrawlerRule[]) => void; others: CrawlerRule[] }) {
  const t = useTranslations('admin.settings.seo');
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const headingId = useId();
  const errorId = useId();
  const inputId = `${headingId}-new`;
  const name = draft.trim();
  const taken = [...rules, ...others].some((rule) => rule.userAgent.toLowerCase() === name.toLowerCase());
  const error = name === '' ? null : !CRAWLER_USER_AGENT.test(name) ? t('nameInvalid') : taken ? t('nameTaken') : null;
  const add = () => {
    if (name === '' || error) return;
    onChange([...rules, { userAgent: name, allow: true }]);
    setNote(t('added', { name }));
    setDraft('');
  };
  const remove = (index: number, userAgent: string) => {
    onChange(rules.filter((_, position) => position !== index));
    // La fila desaparece: se dice qué pasó y el foco pasa al campo de alta de la misma lista (si no, caería al principio de la página).
    setNote(t('removed', { name: userAgent }));
    document.getElementById(inputId)?.focus();
  };
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2 rounded-xl border-2 border-varsity-navy/15 p-3" data-testid={`crawlers-${group}`}>
      <h3 id={headingId} className="font-bold text-varsity-navy">
        {t(`groups.${group}.title`)}
      </h3>
      <p className="text-sm text-ink-soft">{t(`groups.${group}.hint`)}</p>
      <ul className="flex flex-col gap-2">
        {rules.map((rule, index) => (
          <li key={`${rule.userAgent}-${index}`} className="flex flex-col gap-1 rounded-lg bg-varsity-navy/5 p-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            <span className="font-corp min-w-0 [overflow-wrap:anywhere] font-semibold sm:flex-1">{rule.userAgent}</span>
            <div className="flex flex-wrap items-center gap-3">
              <label className="relative inline-flex min-h-11 items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={rule.allow}
                  onChange={(event) => onChange(rules.map((item, position) => (position === index ? { ...item, allow: event.target.checked } : item)))}
                />
                {rule.allow ? t('allowed') : t('blocked')}
                <span className="sr-only">{` ${rule.userAgent}`}</span>
              </label>
              <button type="button" className={OUTLINE} aria-label={t('removeAria', { name: rule.userAgent })} onClick={() => remove(index, rule.userAgent)}>
                {t('remove')}
              </button>
            </div>
          </li>
        ))}
        {rules.length === 0 ? <li className="text-sm text-ink-soft">{t('empty')}</li> : null}
      </ul>
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="font-semibold text-varsity-navy">
          {t('addLabel')}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={100}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setNote('');
            }}
            onKeyDown={(event) => {
              // Intro añade el rastreador: no envía todo el bloque.
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorId}
            className={`${FIELD} aria-invalid:border-red-700 sm:flex-1`}
          />
          <button type="button" className={OUTLINE} aria-disabled={name === '' || error !== null} onClick={add}>
            {t('add')}
          </button>
        </div>
        <p id={errorId} role="status" className={`min-h-5 text-sm font-semibold ${error ? 'text-red-900' : 'text-ink-soft'}`}>
          {error ?? note}
        </p>
      </div>
    </section>
  );
}

/** Rastreadores de asistentes de IA, códigos de verificación de los buscadores y clave de IndexNow. Un cambio tarda hasta unos 12 minutos en verse en `robots.txt`, `llms.txt` y la web pública. */
export function SeoSettings({ fields, secrets, defaultPolicy }: { fields: Record<string, SettingFieldView>; secrets: Record<string, SecretSummary>; defaultPolicy: CrawlerPolicyValue }) {
  const t = useTranslations('admin.settings');
  const form = useSectionForm('seo', fields);
  const stored = fields['seo.aiCrawlers']?.value;
  const initial = isPolicy(stored) ? stored : defaultPolicy;
  const [policy, setPolicy] = useState<CrawlerPolicyValue>(initial);
  // «Sin guardar» se mide contra lo que había al abrir (o al guardar esta persona), no contra lo guardado ahora: un cambio de otra persona no convierte esta pantalla en «con cambios».
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const dirty = JSON.stringify(policy) !== baseline;
  const isDefault = JSON.stringify(policy) === JSON.stringify(defaultPolicy);
  // Al volver a la lista inicial se recrean los grupos: sus avisos («quitado», «añadido») no sobreviven a un estado que ya no existe.
  const [resetCount, setResetCount] = useState(0);
  useUnsaved('seo-crawlers', dirty);
  return (
    <div className="flex flex-col gap-4">
      <SectionForm onSubmit={() => form.submit(dirty ? { 'seo.aiCrawlers': policy } : {}, [], () => setBaseline(JSON.stringify(policy)))}>
        <p className="rounded-xl bg-varsity-navy/5 p-3 text-sm">{t('seo.delay')}</p>
        <fieldset id={fieldId('seo.aiCrawlers')} tabIndex={-1} className="flex min-w-0 flex-col gap-3 outline-offset-4">
          <legend className="font-corp text-lg font-extrabold text-varsity-navy">{t('seo.crawlersTitle')}</legend>
          <p className="text-sm text-ink-soft">{t('seo.crawlersHint', { source: stored === null || stored === undefined ? t('seo.sourceDefault') : t('seo.sourceConsole') })}</p>
          <div className="mobile-stack grid gap-3 md:grid-cols-2">
            {GROUPS.map((group) => (
              <CrawlerGroup
                key={`${group}-${resetCount}`}
                group={group}
                rules={policy[group]}
                others={policy[group === 'search' ? 'training' : 'search']}
                onChange={(rules) => setPolicy((current) => ({ ...current, [group]: rules }))}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {dirty ? (
              <p role="status" className="text-sm font-semibold text-amber-900" data-testid="crawlers-dirty">
                {t('seo.unsaved')}
              </p>
            ) : null}
            <button
              type="button"
              className={OUTLINE}
              aria-disabled={isDefault}
              onClick={() => {
                if (isDefault) return;
                setPolicy(defaultPolicy);
                setResetCount((count) => count + 1);
              }}
              data-testid="crawlers-reset"
            >
              {t('seo.reset')}
            </button>
          </div>
        </fieldset>
        <div className="mobile-stack grid gap-4 md:grid-cols-2">
          {form.specs.map((spec) => (
            <SettingField
              key={spec.key}
              spec={spec}
              value={form.values[spec.key] ?? ''}
              onChange={(next) => form.setValue(spec.key, next)}
              source={fields[spec.key]?.source ?? 'none'}
              error={form.errorOf(spec.key)}
            />
          ))}
        </div>
        <SaveBar pending={form.pending} outcome={form.outcome} failed={form.failed} testId="save-seo" />
      </SectionForm>
      <div className="flex flex-col gap-2">
        <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('secretsTitle')}</h3>
        <div className="mobile-stack grid gap-4 md:grid-cols-2">
          {(SECTION_SECRETS.seo ?? []).map((key) => (
            <SecretField key={key} secretKey={key} summary={secrets[key]} />
          ))}
        </div>
      </div>
    </div>
  );
}
