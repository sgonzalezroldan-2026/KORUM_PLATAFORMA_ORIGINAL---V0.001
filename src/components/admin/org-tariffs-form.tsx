'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { saveTariffsAction } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { TARIFF_LIMITS, type TariffValues } from '@/core/admin/org-360-rules';
import { MoneyParseError, parseEurosToCents } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';
import { ActionOutcome, FIELD, PRIMARY, useEntityAction } from './entity-action';

type NumericField = Exclude<keyof TariffValues, 'maintActive'>;
const FIELDS: ReadonlyArray<{ key: NumericField; kind: 'eur' | 'pct'; max: number }> = [
  { key: 'exemptLimitCents', kind: 'eur', max: TARIFF_LIMITS.exemptLimitCents },
  { key: 't1Bps', kind: 'pct', max: 10_000 },
  { key: 't2Bps', kind: 'pct', max: 10_000 },
  { key: 't3Bps', kind: 'pct', max: 10_000 },
  { key: 'sponsorFeeBps', kind: 'pct', max: 10_000 },
  { key: 'fullIntegrityCheckCents', kind: 'eur', max: TARIFF_LIMITS.fullIntegrityCheckCents },
  { key: 'ticketFeeFixedCents', kind: 'eur', max: TARIFF_LIMITS.ticketFeeFixedCents },
  { key: 'ticketFeeBps', kind: 'pct', max: 10_000 },
  { key: 'maintPerInitCents', kind: 'eur', max: TARIFF_LIMITS.maintPerInitCents },
  { key: 'maintAnnualCapCents', kind: 'eur', max: TARIFF_LIMITS.maintAnnualCapCents }
];

/** Céntimos (o centésimas de punto porcentual) como los escribiría una persona: `4900` → `49`, `180` → `1,80` (o `1.80` en inglés). */
export function toInputText(hundredths: number, decimal: ',' | '.'): string {
  const whole = Math.floor(hundredths / 100);
  const fraction = hundredths % 100;
  return fraction === 0 ? String(whole) : `${whole}${decimal}${String(fraction).padStart(2, '0')}`;
}

type Texts = Record<NumericField, string>;
const textsOf = (values: TariffValues, decimal: ',' | '.'): Texts => Object.fromEntries(FIELDS.map((field) => [field.key, toInputText(values[field.key], decimal)])) as Texts;

/** Lee lo escrito: un entero ≥ 0 dentro de su rango, o `null` si es imposible (decimales de más, negativo, no numérico, demasiado grande). */
export function parseTariffText(text: string, locale: 'es' | 'ca' | 'en', max: number): number | null {
  try {
    const value = parseEurosToCents(text.replace('%', ''), locale);
    return value >= 0 && value <= max ? value : null;
  } catch (error) {
    if (error instanceof MoneyParseError) return null;
    throw error;
  }
}

/**
 * Condiciones económicas individuales de la entidad (`Aplicar tarifa personalizada`): once valores, en euros y porcentajes en pantalla y en céntimos y puntos
 * básicos enteros en el servidor. Apagada, la entidad usa las globales (se ven, sin poder editarse). Solo afecta a campañas futuras. Ninguna combinación se
 * bloquea por «perder dinero» (lo avisa la salud de precios), pero lo imposible se rechaza aquí y en el servidor.
 */
export function OrgTariffsForm({ organizationId, customRules, tariffs, globalTariffs }: { organizationId: string; customRules: boolean; tariffs: TariffValues; globalTariffs: TariffValues }) {
  const t = useTranslations('admin.org360.tariffs');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const decimal = locale === 'en' ? '.' : ',';
  const groupId = useId();
  const action = useEntityAction();
  const [custom, setCustom] = useState(customRules);
  const [texts, setTexts] = useState<Texts>(() => textsOf(tariffs, decimal));
  const [maintActive, setMaintActive] = useState(tariffs.maintActive);
  const [invalid, setInvalid] = useState<NumericField[]>([]);

  const shown = custom ? texts : textsOf(globalTariffs, decimal);
  const shownMaint = custom ? maintActive : globalTariffs.maintActive;

  const toggleCustom = (next: boolean) => {
    setCustom(next);
    setInvalid([]);
    // Al encender, se parte de los valores globales: es lo que la entidad aplica hasta entonces.
    if (next && !customRules) {
      setTexts(textsOf(globalTariffs, decimal));
      setMaintActive(globalTariffs.maintActive);
    }
  };

  const save = () => {
    if (!custom) {
      action.run(() => saveTariffsAction({ organizationId, tariffs: { customRules: false } }), t('doneGlobal'));
      return;
    }
    const parsed: Partial<Record<NumericField, number>> = {};
    const wrong: NumericField[] = [];
    for (const field of FIELDS) {
      const value = parseTariffText(texts[field.key], locale, field.max);
      if (value === null) wrong.push(field.key);
      else parsed[field.key] = value;
    }
    setInvalid(wrong);
    if (wrong.length > 0) {
      // El error se anuncia junto al campo y el foco va al primero que está mal.
      const first = wrong[0];
      requestAnimationFrame(() => document.getElementById(`${groupId}-${first}`)?.focus());
      return;
    }
    action.run(() => saveTariffsAction({ organizationId, tariffs: { customRules: true, maintActive, ...parsed } }), t('doneCustom'));
  };

  return (
    <div className="flex flex-col gap-4" data-testid="tariffs-form">
      <label className="flex min-h-11 items-center gap-2 font-bold text-varsity-navy">
        <input type="checkbox" checked={custom} onChange={(event) => toggleCustom(event.target.checked)} className="size-5" data-testid="tariffs-custom" />
        <span>{t('custom')}</span>
      </label>
      <p className="text-sm font-semibold" data-testid="tariffs-mode">
        {custom ? t('modeCustom') : t('modeGlobal')}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {FIELDS.map((field) => {
          const id = `${groupId}-${field.key}`;
          const wrong = invalid.includes(field.key);
          return (
            <div key={field.key} className="flex flex-col gap-1">
              <label htmlFor={id} className="text-sm font-semibold text-ink-soft">
                {t(`field.${field.key}`)} <span className="font-normal">{`(${field.kind === 'eur' ? t('unitEur') : t('unitPct')})`}</span>
              </label>
              <input
                id={id}
                type="text"
                inputMode="decimal"
                value={shown[field.key]}
                disabled={!custom || action.pending}
                aria-invalid={wrong}
                aria-describedby={wrong ? `${id}-error` : undefined}
                onChange={(event) => setTexts((previous) => ({ ...previous, [field.key]: event.target.value }))}
                className={`${FIELD} tabular-nums ${custom ? '' : 'bg-patio-soft text-ink-soft'}`}
                autoComplete="off"
              />
              {wrong ? (
                <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-red-900">
                  {t('fieldError')}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={shownMaint} disabled={!custom || action.pending} onChange={(event) => setMaintActive(event.target.checked)} className="size-5" />
        <span>{t('maintActive')}</span>
      </label>
      <p className="text-sm text-ink-soft">{t('futureOnly')}</p>
      <button type="button" onClick={save} disabled={action.pending} className={`${PRIMARY} self-start`} data-testid="tariffs-save">
        {action.pending ? t('saving') : custom ? t('saveCustom') : t('saveGlobal')}
      </button>
      <ActionOutcome outcome={action.outcome} failed={action.failed} />
    </div>
  );
}
