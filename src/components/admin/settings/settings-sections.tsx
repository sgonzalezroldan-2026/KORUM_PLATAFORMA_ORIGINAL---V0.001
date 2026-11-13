'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import type { SecretKey } from '@/services/settings/setting-definitions';
import type { FixedLimit, SettingFieldView } from '@/services/admin/platform-settings-view';
import type { SecretSummary } from '@/services/settings/settings.service';
import { SECTION_SECRETS, type SectionId } from '@/core/admin/settings-model';
import { ConnectionTest, SaveBar, SectionForm, SettingField, useSectionForm } from './settings-kit';
import { SecretField } from './settings-secret-field';

type Fields = Record<string, SettingFieldView>;
type Secrets = Record<string, SecretSummary>;
type PaycometMode = 'mock' | 'sandbox' | 'live';

const GRID = 'mobile-stack grid gap-4 md:grid-cols-2';
const NOTICE = 'rounded-xl border-2 border-amber-600/40 bg-amber-50 p-3 text-sm font-semibold text-amber-950';

/** Los campos sencillos del bloque, en dos columnas (una en móvil). */
function FieldGrid({ form, fields, skip = [] }: { form: ReturnType<typeof useSectionForm>; fields: Fields; skip?: string[] }) {
  return (
    <div className={GRID}>
      {form.specs
        .filter((spec) => !skip.includes(spec.key))
        .map((spec) => (
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
  );
}

/** Las claves del bloque: cada una se guarda con su propio botón (no viajan con el resto del formulario y no se vuelven a mostrar). */
function Secrets({ section, secrets }: { section: SectionId; secrets: Secrets }) {
  const t = useTranslations('admin.settings');
  const keys = SECTION_SECRETS[section] ?? [];
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('secretsTitle')}</h3>
      <p className="text-sm text-ink-soft">{t('secretsHint')}</p>
      <div className={GRID}>
        {keys.map((key: SecretKey) => (
          <SecretField key={key} secretKey={key} summary={secrets[key]} />
        ))}
      </div>
    </div>
  );
}

export function PaymentsSettings({ fields, secrets, mode }: { fields: Fields; secrets: Secrets; mode: PaycometMode }) {
  const t = useTranslations('admin.settings');
  const form = useSectionForm('pagos', fields);
  const needsIp = mode !== 'mock' && (form.values['paycomet.serverIp'] ?? '').trim() === '';
  return (
    <div className="flex flex-col gap-4">
      <SectionForm onSubmit={() => form.submit()}>
        <p className="rounded-xl bg-varsity-navy/5 p-3 text-sm" data-testid="paycomet-mode">
          <span className="font-bold text-varsity-navy">{t('payments.modeLabel', { mode: t(`payments.modes.${mode}`) })}</span> {t(`payments.modeHelp.${mode}`)}
        </p>
        {needsIp ? (
          <p role="note" className={NOTICE}>
            {t('payments.ipMissing')}
          </p>
        ) : null}
        <FieldGrid form={form} fields={fields} />
        <SaveBar pending={form.pending} outcome={form.outcome} failed={form.failed} testId="save-pagos" />
      </SectionForm>
      <Secrets section="pagos" secrets={secrets} />
      <ConnectionTest target="paycomet" />
    </div>
  );
}

export function EmailSettings({ fields, secrets }: { fields: Fields; secrets: Secrets }) {
  const t = useTranslations('admin.settings');
  const form = useSectionForm('email', fields);
  return (
    <div className="flex flex-col gap-4">
      <SectionForm onSubmit={() => form.submit()}>
        <p className="text-sm text-ink-soft">{t('email.smtpNote')}</p>
        <FieldGrid form={form} fields={fields} />
        <SaveBar pending={form.pending} outcome={form.outcome} failed={form.failed} testId="save-email" />
      </SectionForm>
      <Secrets section="email" secrets={secrets} />
      <ConnectionTest target="email" />
    </div>
  );
}

export function InvoicingSettings({ fields, secrets }: { fields: Fields; secrets: Secrets }) {
  const t = useTranslations('admin.settings');
  const form = useSectionForm('facturacion', fields);
  const nif = (form.values['invoicing.issuerNif'] ?? '').trim() !== '';
  const name = (form.values['invoicing.issuerName'] ?? '').trim() !== '';
  return (
    <div className="flex flex-col gap-4">
      <SectionForm onSubmit={() => form.submit()}>
        <p role="note" className={nif && name ? 'rounded-xl bg-varsity-navy/5 p-3 text-sm' : NOTICE} data-testid="invoicing-warning">
          {nif && name ? t('invoicing.complete') : nif !== name ? t('invoicing.pair') : t('invoicing.missing')}
        </p>
        <FieldGrid form={form} fields={fields} />
        <SaveBar pending={form.pending} outcome={form.outcome} failed={form.failed} testId="save-facturacion" />
      </SectionForm>
      <Secrets section="facturacion" secrets={secrets} />
      <ConnectionTest target="invoicing" />
    </div>
  );
}

export function HuchaSettings({ fields, secrets }: { fields: Fields; secrets: Secrets }) {
  const t = useTranslations('admin.settings');
  const form = useSectionForm('hucha', fields);
  const confirmId = useId();
  const initialMode = String(fields['hucha.mode']?.value ?? 'PLEDGE');
  const mode = form.values['hucha.mode'] ?? 'PLEDGE';
  const entering = mode === 'REGULATED_WALLET' && initialMode !== 'REGULATED_WALLET';
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <SectionForm onSubmit={() => form.submit({}, entering && confirmed ? ['walletLegal'] : [])}>
        <div className={GRID}>
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
        <p className="rounded-xl bg-varsity-navy/5 p-3 text-sm" data-testid="hucha-mode-help">
          {t(`hucha.modeHelp.${mode === 'DISABLED' || mode === 'REGULATED_WALLET' ? mode : 'PLEDGE'}`)}
        </p>
        {entering ? (
          <label htmlFor={confirmId} className={`${NOTICE} flex min-h-11 items-start gap-3`}>
            <input id={confirmId} type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 size-5 shrink-0" data-testid="hucha-wallet-confirm" />
            <span>{t('hucha.walletConfirm')}</span>
          </label>
        ) : null}
        <SaveBar pending={form.pending} outcome={form.outcome} failed={form.failed} testId="save-hucha" />
      </SectionForm>
      <Secrets section="hucha" secrets={secrets} />
    </div>
  );
}

export function AutoBoostSettings({ fields }: { fields: Fields }) {
  const form = useSectionForm('autoimpulso', fields);
  return (
    <SectionForm onSubmit={() => form.submit()}>
      <FieldGrid form={form} fields={fields} />
      <SaveBar pending={form.pending} outcome={form.outcome} failed={form.failed} testId="save-autoimpulso" />
    </SectionForm>
  );
}

function windowText(t: ReturnType<typeof useTranslations>, windowMs: number): string {
  if (windowMs <= 0) return t('limits.noWindow');
  return windowMs >= 3_600_000 ? t('limits.hours', { count: Math.round(windowMs / 3_600_000) }) : t('limits.minutes', { count: Math.round(windowMs / 60_000) });
}

export function LimitsSettings({ fields, fixedLimits }: { fields: Fields; fixedLimits: FixedLimit[] }) {
  const t = useTranslations('admin.settings');
  const form = useSectionForm('limites', fields);
  const caption = useId();
  return (
    <div className="flex flex-col gap-4">
      <SectionForm onSubmit={() => form.submit()}>
        <FieldGrid form={form} fields={fields} />
        <SaveBar pending={form.pending} outcome={form.outcome} failed={form.failed} testId="save-limites" />
      </SectionForm>
      <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('limits.fixedTitle')}</h3>
      <p id={caption} className="text-sm text-ink-soft">
        {t('limits.fixedHint')}
      </p>
      <LimitsTable aria={caption} rows={fixedLimits} windowOf={(ms) => windowText(t, ms)} label={(id) => t(`limits.rules.${id}`)} />
    </div>
  );
}

function LimitsTable({ aria, rows, windowOf, label }: { aria: string; rows: FixedLimit[]; windowOf: (windowMs: number) => string; label: (id: string) => string }): ReactNode {
  const t = useTranslations('admin.settings');
  return (
    <div tabIndex={0} role="region" aria-label={t('limits.fixedTitle')} aria-describedby={aria} className="overflow-x-auto rounded-xl border-2 border-varsity-navy/15">
      <table className="w-full min-w-[28rem] text-left text-sm" data-testid="fixed-limits">
        <thead className="bg-varsity-navy/5 text-varsity-navy">
          <tr>
            <th scope="col" className="p-2 font-bold">
              {t('limits.colRule')}
            </th>
            <th scope="col" className="p-2 text-right font-bold">
              {t('limits.colLimit')}
            </th>
            <th scope="col" className="p-2 font-bold">
              {t('limits.colWindow')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-varsity-navy/10">
              <th scope="row" className="p-2 font-semibold">
                {label(row.id)}
              </th>
              <td className="font-corp p-2 text-right tabular-nums">{row.limit}</td>
              <td className="p-2">{windowOf(row.windowMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
