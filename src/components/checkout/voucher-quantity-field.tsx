'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId } from 'react';
import { NoProductNotice } from '@/components/portal/voucher-sections';
import { useMoney } from '@/components/portal/use-money';
import { formatBps } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';
import type { CheckoutDraft, CheckoutOffer } from './checkout-draft';
import { FieldError } from './checkout-fields';

/**
 * Cuántos vales se compran (Sprint 5.14b, QA-VAL03), con el precio, la validez y los que quedan **antes de pagar**. Con la venta agotada y «sin producto»
 * activado, el mismo selector elige a cuántos vales equivale la aportación, y el aviso de que no da vale, ni certificado, ni se devuelve va encima, visible
 * sin desplegar nada (decisiones 49 y 64).
 */
export function VoucherQuantityField({ offer, draft, update, max, error }: { offer: CheckoutOffer; draft: CheckoutDraft; update: (patch: Partial<CheckoutDraft>) => void; max: number; error: string | null }) {
  const t = useTranslations('portal.checkout.voucher');
  const money = useMoney();
  const format = useFormatter();
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const valueId = useId();
  const errorId = useId();
  const voucher = offer.voucher;
  if (!voucher) return null;
  const { pricing } = voucher;
  const validUntil = format.dateTime(new Date(voucher.validUntilIso), { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  const fee = t('fee', { fixed: money(pricing.fee.fixedCents), pct: formatBps(pricing.fee.pctBps, locale) });

  return (
    <div className="space-y-3">
      {voucher.noProduct ? <NoProductNotice compact /> : null}
      {voucher.noProduct ? null : (
      <div className="space-y-1 rounded-2xl border border-sky-300 bg-sky-50 p-3.5" data-testid="checkout-voucher-info">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-full bg-sky-800 px-2.5 py-0.5 text-sm font-extrabold text-white">
            <span aria-hidden="true">{'🧾 '}</span>
            {t(voucher.noProduct ? 'badgeNoProduct' : 'badge')}
          </span>
          <span className="font-corp font-extrabold tabular-nums text-sky-950">
            {voucher.noProduct ? t('soldOut') : voucher.capped ? t('available', { available: voucher.available ?? 0, max: voucher.units }) : t('unlimited')}
          </span>
        </div>
        <p className="text-sm text-ink-soft">{t('validUntil', { date: validUntil })}</p>
      </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-patio-rule-strong bg-patio-cream p-3.5">
        <div>
          <p id={valueId} className="font-extrabold text-varsity-navy">
            {t(voucher.noProduct ? 'quantityNoProduct' : 'quantity')}
          </p>
          <p className="text-sm text-ink-soft">{t(pricing.mode === 'ADD' ? 'unitAdd' : 'unitInc', { price: money(pricing.priceCents), fee })}</p>
        </div>
        <div className="flex items-center gap-2" role="group" aria-labelledby={valueId}>
          <button
            type="button"
            onClick={() => update({ quantity: Math.max(1, draft.quantity - 1) })}
            disabled={draft.quantity <= 1}
            aria-label={t('less')}
            className="inline-flex size-11 items-center justify-center rounded-xl border-2 border-patio-rule-strong bg-white text-xl font-extrabold text-varsity-navy disabled:opacity-50"
          >
            <span aria-hidden="true">{'−'}</span>
          </button>
          <output aria-live="polite" aria-labelledby={valueId} className="min-w-10 text-center font-corp text-2xl font-extrabold tabular-nums text-varsity-navy" data-testid="voucher-quantity">
            {draft.quantity}
          </output>
          <button
            type="button"
            onClick={() => update({ quantity: Math.min(max, draft.quantity + 1) })}
            disabled={draft.quantity >= max}
            aria-label={t('more')}
            aria-describedby={draft.quantity >= max ? errorId : undefined}
            className="inline-flex size-11 items-center justify-center rounded-xl bg-varsity-navy text-xl font-extrabold text-white disabled:opacity-50"
          >
            <span aria-hidden="true">{'+'}</span>
          </button>
        </div>
      </div>
      {draft.quantity >= max && max > 0 && !error ? (
        <p id={errorId} className="text-sm font-semibold text-ink-soft">
          {t('limit', { max })}
        </p>
      ) : null}
      <FieldError id={errorId} message={error} />
    </div>
  );
}
