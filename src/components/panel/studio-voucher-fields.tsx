'use client';

import { useLocale, useTranslations } from 'next-intl';
import { CheckboxField, Field, SelectField } from '@/components/auth/auth-ui';
import { formatBps, formatCents } from '@/core/finance/money';
import type { StudioContext, VoucherBoard } from '@/core/studio/studio-board';
import { latestVoucherValidOn, STUDIO_LIMITS, type StudioDraft } from '@/core/studio/studio-draft';
import { isLocale } from '@/i18n/routing';
import { MoneyField } from './studio-money-field';

/**
 * Campos de una venta de vales en el Estudio (Sprint 5.14b; decisión 32). Sin lista de artículos: lo que se puede canjear lo explica la descripción libre de
 * la campaña. Precio único por vale; tope o sin tope (con un objetivo orientativo, decisión del promotor del 2026-11-20); validez que fija la entidad, desde el
 * día de cierre hasta 12 meses después y, por defecto, hasta el inicio del curso siguiente; gastos de gestión por compra, sumados o incluidos; y, al agotarse,
 * la aportación «sin producto», que no se ofrece a un colegio con ánimo de lucro (decisión 65).
 */

export interface StudioVoucherFieldsProps {
  draft: StudioDraft;
  context: StudioContext;
  board: VoucherBoard;
  disabled: boolean;
  onChange: (patch: Partial<StudioDraft>) => void;
  errors: { ticketMax?: string; ticketPrice?: string; voucherValidOn?: string };
}

const clampCount = (value: string) => Math.max(0, Math.min(STUDIO_LIMITS.maxTicketMax, Math.trunc(Number(value)) || 0));

export function StudioVoucherFields({ draft, context, board, disabled, onChange, errors }: StudioVoucherFieldsProps) {
  const t = useTranslations('panel.studio.vouchers');
  const tFields = useTranslations('panel.studio.fields');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const money = (cents: number) => formatCents(cents, locale);

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-4 rounded-2xl border-2 border-sky-300 bg-sky-50 p-4" data-testid="studio-voucher-fields">
      <legend className="px-2 font-corp font-extrabold text-sky-950">{t('title')}</legend>
      <p className="text-sm text-ink-soft">{t('intro')}</p>
      <div className="mobile-stack grid gap-4 sm:grid-cols-2">
        <MoneyField label={t('price')} valueCents={draft.ticketPriceCents} maxCents={STUDIO_LIMITS.maxTicketPriceCents} onChange={(cents) => onChange({ ticketPriceCents: cents })} disabled={disabled} error={errors.ticketPrice} />
        <SelectField
          label={t('capMode')}
          value={draft.voucherCapped ? 'CAPPED' : 'OPEN'}
          onChange={(event) => onChange({ voucherCapped: event.target.value === 'CAPPED' })}
          options={[
            { value: 'CAPPED', label: t('capped') },
            { value: 'OPEN', label: t('open') }
          ]}
        />
      </div>
      <div className="mobile-stack grid gap-4 sm:grid-cols-2">
        {draft.voucherCapped ? (
          <Field type="number" inputMode="numeric" min={1} max={STUDIO_LIMITS.maxTicketMax} label={t('max')} hint={t('maxHint')} error={errors.ticketMax} value={draft.ticketMax === 0 ? '' : draft.ticketMax} onChange={(event) => onChange({ ticketMax: clampCount(event.target.value) })} />
        ) : (
          <Field
            type="number"
            inputMode="numeric"
            min={1}
            max={STUDIO_LIMITS.maxTicketMax}
            label={t('target')}
            hint={t('targetHint')}
            error={errors.ticketMax}
            value={draft.voucherTargetCount === 0 ? '' : draft.voucherTargetCount}
            onChange={(event) => onChange({ voucherTargetCount: clampCount(event.target.value) })}
            data-testid="studio-voucher-target"
          />
        )}
        <Field
          type="date"
          label={t('validOn')}
          hint={t('validOnHint')}
          value={draft.voucherValidOn ?? ''}
          min={draft.closesOn}
          max={latestVoucherValidOn(draft.closesOn) || undefined}
          error={errors.voucherValidOn}
          onChange={(event) => onChange({ voucherValidOn: event.target.value === '' ? null : event.target.value })}
          data-testid="studio-voucher-valid-on"
        />
      </div>
      <div className="mobile-stack grid gap-4 sm:grid-cols-2">
        <SelectField
          label={tFields('feeMode')}
          value={draft.ticketFeeMode}
          onChange={(event) => onChange({ ticketFeeMode: event.target.value === 'INC' ? 'INC' : 'ADD' })}
          options={[
            { value: 'ADD', label: t('feeModeAdd') },
            { value: 'INC', label: t('feeModeInc') }
          ]}
        />
        <div className="flex flex-col gap-1" data-testid="studio-voucher-fee">
          <p className="font-semibold text-varsity-navy">{tFields('digitalFee')}</p>
          <p className="font-corp font-bold tabular-nums text-varsity-navy">{t('feeValue', { fixed: money(context.voucherFee.fixedCents), pct: formatBps(context.voucherFee.pctBps, locale) })}</p>
          <p className="text-sm text-ink-soft">{t('feeExamples', { one: money(board.feeOneCents), count: board.largestQuantity, largest: money(board.feeLargestCents) })}</p>
        </div>
      </div>
      {context.forProfitSchool ? (
        <p className="rounded-xl bg-white p-3 text-sm text-ink-soft" data-testid="studio-voucher-no-product-unavailable">
          {t('noProductForProfit')}
        </p>
      ) : draft.voucherCapped ? (
        <CheckboxField label={t('noProduct')} hint={t('noProductHint')} checked={draft.voucherNoProductEnabled} onChange={(event) => onChange({ voucherNoProductEnabled: event.target.checked })} data-testid="studio-voucher-no-product" />
      ) : (
        <p className="rounded-xl bg-white p-3 text-sm text-ink-soft">{t('noProductOpen')}</p>
      )}
    </fieldset>
  );
}
