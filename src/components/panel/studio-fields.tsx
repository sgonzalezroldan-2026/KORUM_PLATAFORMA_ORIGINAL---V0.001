'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { CheckboxField, Field, SelectField, fieldClass } from '@/components/auth/auth-ui';
import { formatBps, formatCents } from '@/core/finance/money';
import { effectiveMaxCampaignDays, type StudioContext } from '@/core/studio/studio-board';
import { REWARD_PRESETS, STUDIO_LIMITS, STUDIO_STAGES, TICKETING_CATEGORY, type RewardPreset, type StudioDraft } from '@/core/studio/studio-draft';
import { isLocale } from '@/i18n/routing';
import { IntField, MoneyField } from './studio-money-field';

/**
 * Campos del Estudio (`sch-sub-studio`): qué se escribe en cada formato. Con la campaña ya publicada solo se pueden tocar los que no mueven dinero
 * (`lock = 'SOFT'`); una campaña cerrada se enseña sin poder cambiar nada (`lock = 'ALL'`). Los importes se escriben en euros y se guardan en céntimos.
 */

export type StudioLock = 'NONE' | 'SOFT' | 'ALL';

/** Avisos junto a cada campo: lo que falta para guardar o publicar se dice donde se arregla, no solo en la lista del panel. */
export type StudioFieldErrors = Partial<Record<'title' | 'category' | 'stage' | 'closesOn' | 'description' | 'costMat' | 'ticketMax' | 'ticketPrice' | 'rafflePrizeCount' | 'raffleNotice', string>>;

export interface StudioFieldsProps {
  draft: StudioDraft;
  context: StudioContext;
  lock: StudioLock;
  /** Premios del reto, ya traducidos al idioma en que escribe la entidad. */
  rewardPresets: Record<RewardPreset, string>;
  /** Gastos de gestión digital por entrada, ya calculados con el precio actual. */
  ticketFeeUnitCents: number;
  /** Hoy en hora de España (`AAAA-MM-DD`), para limitar el selector de fecha. */
  today: string;
  maxCloseOn: string;
  onChange: (patch: Partial<StudioDraft>) => void;
  /** Motivos del servidor o de la pizarra asociados a un campo, para anunciarlos junto a él. */
  errors?: StudioFieldErrors;
}

export function StudioFields({ draft, context, lock, rewardPresets, ticketFeeUnitCents, today, maxCloseOn, onChange, errors = {} }: StudioFieldsProps) {
  const t = useTranslations('panel.studio.fields');
  const tStage = useTranslations('panel.studio.stages');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const ids = { description: useId(), reward: useId() };
  const moneyLocked = lock !== 'NONE';
  const allLocked = lock === 'ALL';
  const ticketing = draft.format === 'TICKETING';
  const [customReward, setCustomReward] = useState(() => draft.rewardText !== null && !Object.values(rewardPresets).includes(draft.rewardText));
  const rewardChoice = customReward ? 'CUSTOM' : (REWARD_PRESETS.find((key) => rewardPresets[key] === draft.rewardText) ?? REWARD_PRESETS[0]);
  const categories = context.categories.filter((category) => category.name !== TICKETING_CATEGORY);
  const maxDays = effectiveMaxCampaignDays(context.maxCampaignDays);

  function chooseReward(value: string) {
    if (value === 'CUSTOM') {
      setCustomReward(true);
      return onChange({ rewardText: '' });
    }
    setCustomReward(false);
    onChange({ rewardText: rewardPresets[value as RewardPreset] });
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label={t('title')} value={draft.title} maxLength={STUDIO_LIMITS.titleMax} disabled={moneyLocked} error={errors.title} onChange={(event) => onChange({ title: event.target.value })} />
      <div className="mobile-stack grid gap-4 sm:grid-cols-3">
        {ticketing ? (
          <Field label={t('category')} value={t('ticketingCategory')} disabled readOnly />
        ) : (
          <SelectField
            label={t('category')}
            value={draft.category}
            disabled={moneyLocked}
            error={errors.category}
            onChange={(event) => onChange({ category: event.target.value })}
            options={[{ value: '', label: t('categoryChoose') }, ...categories.map((category) => ({ value: category.name, label: `${category.icon} ${category.name}` }))]}
          />
        )}
        <SelectField
          label={t('stage')}
          value={draft.stage}
          disabled={moneyLocked}
          error={errors.stage}
          onChange={(event) => onChange({ stage: event.target.value })}
          options={[...(draft.stage === '' ? [{ value: '', label: t('stageChoose') }] : []), ...STUDIO_STAGES[context.vertical].map((stage) => ({ value: stage.value, label: tStage(stage.key) }))]}
        />
        <Field
          type="date"
          label={t('closesOn')}
          hint={t('closesOnHint', { days: maxDays })}
          value={draft.closesOn}
          min={today}
          max={maxCloseOn}
          disabled={moneyLocked}
          error={errors.closesOn}
          onChange={(event) => onChange({ closesOn: event.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.description} className="font-bold text-varsity-navy">
          {t('description')}
        </label>
        <textarea
          id={ids.description}
          rows={3}
          maxLength={STUDIO_LIMITS.descriptionMax}
          className={`${fieldClass} py-2`}
          disabled={allLocked}
          value={draft.description}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? `${ids.description}-error` : undefined}
          onChange={(event) => onChange({ description: event.target.value })}
        />
        {errors.description ? (
          <p id={`${ids.description}-error`} role="alert" className="text-sm font-semibold text-red-800">
            {errors.description}
          </p>
        ) : null}
      </div>

      {ticketing ? (
        <fieldset disabled={moneyLocked} className="flex flex-col gap-4 rounded-2xl border-2 border-sky-300 bg-sky-50 p-4">
          <legend className="px-2 font-corp font-extrabold text-sky-950">{t('ticketingTitle')}</legend>
          <SelectField
            label={t('ticketSubtype')}
            value={draft.ticketSubtype}
            onChange={(event) => onChange({ ticketSubtype: event.target.value === 'RAFFLE' ? 'RAFFLE' : 'EVENT', raffleNoticeConfirmed: false })}
            options={[
              { value: 'EVENT', label: t('subtypeEvent') },
              { value: 'RAFFLE', label: t('subtypeRaffle') }
            ]}
          />
          <div className="mobile-stack grid gap-4 sm:grid-cols-3">
            <MoneyField label={t('ticketPrice')} valueCents={draft.ticketPriceCents} maxCents={STUDIO_LIMITS.maxTicketPriceCents} onChange={(cents) => onChange({ ticketPriceCents: cents })} disabled={moneyLocked} error={errors.ticketPrice} />
            <Field
              type="number"
              inputMode="numeric"
              min={1}
              max={STUDIO_LIMITS.maxTicketMax}
              label={t('ticketMax')}
              error={errors.ticketMax}
              value={draft.ticketMax === 0 ? '' : draft.ticketMax}
              onChange={(event) => onChange({ ticketMax: Math.max(0, Math.min(STUDIO_LIMITS.maxTicketMax, Math.trunc(Number(event.target.value)) || 0)) })}
            />
            <Field
              label={t('digitalFee')}
              hint={t('digitalFeeHint')}
              readOnly
              value={t('digitalFeeValue', { fixed: formatCents(context.ticketFee.fixedCents, locale), pct: formatBps(context.ticketFee.pctBps, locale), unit: formatCents(ticketFeeUnitCents, locale) })}
            />
          </div>
          <div className="mobile-stack grid gap-4 sm:grid-cols-2">
            <Field label={t('venue')} hint={t('venueHint')} value={draft.ticketVenue ?? ''} maxLength={STUDIO_LIMITS.venueMax} onChange={(event) => onChange({ ticketVenue: event.target.value === '' ? null : event.target.value })} />
            <SelectField
              label={t('feeMode')}
              value={draft.ticketFeeMode}
              onChange={(event) => onChange({ ticketFeeMode: event.target.value === 'INC' ? 'INC' : 'ADD' })}
              options={[
                { value: 'ADD', label: t('feeModeAdd') },
                { value: 'INC', label: t('feeModeInc') }
              ]}
            />
          </div>
          {draft.ticketSubtype === 'RAFFLE' ? (
            <div className="flex flex-col gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-3" data-testid="raffle-notice">
              <p className="text-sm font-semibold text-amber-950">{t('raffleNotice')}</p>
              <Field
                type="number"
                inputMode="numeric"
                min={1}
                max={STUDIO_LIMITS.maxRafflePrizes}
                label={t('rafflePrizes')}
                hint={t('rafflePrizesHint')}
                error={errors.rafflePrizeCount}
                value={draft.rafflePrizeCount ?? ''}
                onChange={(event) => onChange({ rafflePrizeCount: event.target.value === '' ? null : Math.min(STUDIO_LIMITS.maxRafflePrizes, Math.max(1, Math.trunc(Number(event.target.value)) || 1)) })}
              />
              <CheckboxField label={t('raffleConfirm')} checked={draft.raffleNoticeConfirmed} error={errors.raffleNotice} onChange={(event) => onChange({ raffleNoticeConfirmed: event.target.checked })} />
            </div>
          ) : null}
        </fieldset>
      ) : (
        <fieldset disabled={moneyLocked} className="flex flex-col gap-4 rounded-2xl border-2 border-varsity-navy/30 bg-patio-cream p-4">
          <legend className="px-2 font-corp font-extrabold text-varsity-navy">{t('budgetTitle')}</legend>
          <div className="mobile-stack grid gap-4 sm:grid-cols-3">
            <MoneyField label={t('costMat')} hint={t('costMatHint')} valueCents={draft.costMatCents} maxCents={STUDIO_LIMITS.maxBudgetCents} onChange={(cents) => onChange({ costMatCents: cents })} disabled={moneyLocked} error={errors.costMat} />
            <MoneyField label={t('costInst')} valueCents={draft.costInstCents} maxCents={STUDIO_LIMITS.maxBudgetCents} onChange={(cents) => onChange({ costInstCents: cents })} disabled={moneyLocked} />
            <Field
              type="number"
              inputMode="numeric"
              min={0}
              max={STUDIO_LIMITS.maxContingencyBps / 100}
              label={t('contingency')}
              value={draft.contingencyBps / 100}
              onChange={(event) => onChange({ contingencyBps: Math.max(0, Math.min(STUDIO_LIMITS.maxContingencyBps, Math.round(Number(event.target.value) * 100) || 0)) })}
            />
          </div>
        </fieldset>
      )}

      {!ticketing ? (
        <fieldset disabled={allLocked} className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy/30 bg-white p-4">
          <legend className="px-2 font-corp font-extrabold text-varsity-navy">{t('publicTitle')}</legend>
          <CheckboxField label={t('showBreakdown')} checked={draft.showPublicBreakdown} onChange={(event) => onChange({ showPublicBreakdown: event.target.checked })} />
        </fieldset>
      ) : null}

      <fieldset disabled={allLocked} className="flex flex-col gap-3 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4">
        <legend className="px-2 font-corp font-extrabold text-amber-950">{t('rewardTitle')}</legend>
        <CheckboxField label={t('rewardEnabled')} hint={t('rewardHint')} checked={draft.rewardEnabled} onChange={(event) => onChange({ rewardEnabled: event.target.checked })} />
        <CheckboxField label={t('plaque')} checked={draft.plaqueEnabled} onChange={(event) => onChange({ plaqueEnabled: event.target.checked })} />
        {draft.rewardEnabled ? (
          <div className="mobile-stack grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-3 sm:col-span-2">
              <SelectField
                label={t('rewardPreset')}
                value={rewardChoice}
                onChange={(event) => chooseReward(event.target.value)}
                options={[...REWARD_PRESETS.map((key) => ({ value: key, label: rewardPresets[key] })), { value: 'CUSTOM', label: t('rewardCustom') }]}
              />
              {customReward ? <Field label={t('rewardCustomLabel')} maxLength={STUDIO_LIMITS.rewardMax} value={draft.rewardText ?? ''} onChange={(event) => onChange({ rewardText: event.target.value })} /> : null}
            </div>
            <IntField label={t('targetFamilies')} value={draft.targetFamiliesPerCourse} min={STUDIO_LIMITS.minFamiliesPerCourse} max={STUDIO_LIMITS.maxFamiliesPerCourse} onChange={(value) => onChange({ targetFamiliesPerCourse: value })} />
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}
