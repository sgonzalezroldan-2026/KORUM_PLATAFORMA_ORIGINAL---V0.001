'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { saveMedalsAction } from '@/app/[locale]/(superadmin)/admin/reglas/actions';
import { MEDAL_KEYS, MEDAL_LIMITS, medalsSchema, type MedalKey } from '@/core/admin/global-rules';
import { MoneyParseError, parseEurosToCents } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';
import { FIELD, PRIMARY } from './entity-action';
import { toInputText } from './global-rules-model';
import { RulesOutcome, useRulesAction } from './rules-action';

export interface MedalsFormProps {
  tiers: Array<{ key: string; icon: string; campaignsRequired: number; grantCents: number }>;
  updatedAt: string;
}

type Texts = Record<MedalKey, { campaigns: string; grant: string }>;

/**
 * Medallas y becas de exención (prototipo `saveMedalsConfiguration`): por cada nivel, cuántas campañas cerradas en el curso hacen falta y qué beca exenta (al 0 %)
 * da. Cada nivel pide más campañas que el anterior. **Se aplica desde la próxima renovación de cupos (cambio de curso) y a las medallas que se ganen a partir de
 * ahora**: la beca disponible este curso puede estar ya en parte reservada por una campaña.
 */
export function MedalsForm({ tiers, updatedAt }: MedalsFormProps) {
  const t = useTranslations('admin.rules.medals');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const decimal = locale === 'en' ? '.' : ',';
  const id = useId();
  const action = useRulesAction({ failureFocusId: 'medals-save' });
  const [texts, setTexts] = useState<Texts>(() => Object.fromEntries(MEDAL_KEYS.map((key) => {
    const tier = tiers.find((candidate) => candidate.key === key);
    return [key, { campaigns: String(tier?.campaignsRequired ?? ''), grant: toInputText(tier?.grantCents ?? 0, decimal) }];
  })) as Texts);
  const [showInvalid, setShowInvalid] = useState(false);

  const parseGrant = (text: string): number | null => {
    try {
      const value = parseEurosToCents(text, locale);
      return value >= 0 && value <= MEDAL_LIMITS.grantCents ? value : null;
    } catch (error) {
      if (error instanceof MoneyParseError) return null;
      throw error;
    }
  };
  const parseCampaigns = (text: string): number | null => (/^\d{1,2}$/.test(text.trim()) && Number(text) >= 1 ? Number(text) : null);

  const wrongFields = MEDAL_KEYS.flatMap((key) => [parseCampaigns(texts[key].campaigns) === null ? `${key}:campaigns` : null, parseGrant(texts[key].grant) === null ? `${key}:grant` : null]).filter((entry): entry is string => entry !== null);
  const payload = MEDAL_KEYS.map((key) => ({ key, campaignsRequired: parseCampaigns(texts[key].campaigns) ?? 0, grantCents: parseGrant(texts[key].grant) ?? 0 }));
  const orderWrong = wrongFields.length === 0 && !medalsSchema.safeParse(payload).success;

  const save = () => {
    if (wrongFields.length > 0 || orderWrong) {
      setShowInvalid(true);
      const first = wrongFields[0];
      requestAnimationFrame(() => document.getElementById(first ? `${id}-${first.replace(':', '-')}` : `${id}-bronze-campaigns`)?.focus());
      return;
    }
    setShowInvalid(false);
    action.run(
      () => saveMedalsAction({ medals: payload, expectedUpdatedAt: updatedAt }),
      () => t('saved')
    );
  };

  const set = (key: MedalKey, part: 'campaigns' | 'grant', value: string) => setTexts((previous) => ({ ...previous, [key]: { ...previous[key], [part]: value } }));

  return (
    <div className="flex flex-col gap-4" data-testid="medals-form">
      <div className="grid gap-3 md:grid-cols-3">
        {MEDAL_KEYS.map((key) => {
          const icon = tiers.find((tier) => tier.key === key)?.icon ?? '';
          return (
            <fieldset key={key} className="flex flex-col gap-2 rounded-xl border-2 border-varsity-gold-deep/50 bg-amber-50 p-3">
              <legend className="px-1 font-extrabold text-varsity-navy">
                <span aria-hidden="true">{`${icon} `}</span>
                {t(`name.${key}`)}
              </legend>
              {(['campaigns', 'grant'] as const).map((part) => {
                const fieldId = `${id}-${key}-${part}`;
                const wrong = showInvalid && wrongFields.includes(`${key}:${part}`);
                return (
                  <div key={part} className="flex flex-col gap-1">
                    <label htmlFor={fieldId} className="text-sm font-semibold text-ink-soft">
                      {t(part === 'campaigns' ? 'campaigns' : 'grant')}
                    </label>
                    <input
                      id={fieldId}
                      type="text"
                      inputMode={part === 'campaigns' ? 'numeric' : 'decimal'}
                      value={texts[key][part]}
                      disabled={action.pending}
                      aria-invalid={wrong}
                      aria-describedby={wrong ? `${fieldId}-error` : undefined}
                      onChange={(event) => set(key, part, event.target.value)}
                      className={`${FIELD} tabular-nums`}
                      autoComplete="off"
                    />
                    {wrong ? (
                      <p id={`${fieldId}-error`} role="alert" className="text-sm font-semibold text-red-900">
                        {t(part === 'campaigns' ? 'campaignsError' : 'grantError')}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          );
        })}
      </div>
      {showInvalid && orderWrong ? (
        <p role="alert" className="text-sm font-semibold text-red-900">
          {t('orderError')}
        </p>
      ) : null}
      <p className="text-sm text-ink-soft">{t('applies')}</p>
      <button id="medals-save" type="button" onClick={save} disabled={action.pending} className={`${PRIMARY} self-start`} data-testid="medals-save">
        {action.pending ? t('saving') : t('save')}
      </button>
      <RulesOutcome outcome={action.outcome} failed={action.failed} />
    </div>
  );
}
