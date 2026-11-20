import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import { formatBps } from '@/core/finance/money';
import type { VoucherCardData } from '@/core/public/view-model';
import { isLocale } from '@/i18n/routing';
import { useMoney } from './use-money';

/**
 * Bloques de una venta de vales en la ficha pública (Sprint 5.14b, QA-VAL03): **antes de comprar** se ven el precio, la validez y las existencias, los gastos de
 * gestión digital por compra y cómo se gastan (en el puesto de la entidad, con el QR). Sin lista de artículos: lo que se canjea lo explica la descripción. Con
 * la venta agotada y «sin producto» activado, el aviso de que esa aportación no da vale, ni certificado, ni se devuelve (decisiones 49 y 64).
 */

/** Cifras de la venta junto a la barra: con tope, vendidos y los que quedan; sin tope, vendidos y el objetivo orientativo. */
export function VoucherStock({ voucher, sold }: { voucher: VoucherCardData; sold: number }) {
  const t = useTranslations('portal.voucher');
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2" data-testid="voucher-stock">
      <span className="font-joy text-2xl font-bold text-sky-900 tabular-nums">
        <span aria-hidden="true">{'🧾 '}</span>
        {voucher.capped ? t('soldOf', { sold, max: voucher.units }) : t('sold', { sold })}
      </span>
      <span className="text-sm font-bold text-ink-soft">
        {voucher.capped ? t('left', { count: voucher.available ?? 0 }) : t('target', { count: voucher.units })}
        {' · '}
        <CurrencyText cents={voucher.priceCents} />
        {` ${t(voucher.feeMode === 'ADD' ? 'perVoucherAdd' : 'perVoucherInc')}`}
      </span>
    </div>
  );
}

export function VoucherDetails({ voucher }: { voucher: VoucherCardData }) {
  const t = useTranslations('portal.voucher');
  const format = useFormatter();
  const money = useMoney();
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const validUntil = format.dateTime(new Date(voucher.validUntilIso), { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  const fee = t('feeValue', { fixed: money(voucher.feeFixedCents), pct: formatBps(voucher.feeBps, locale) });

  return (
    <section aria-labelledby="vouchers-heading" className="space-y-3 border-t border-patio-rule pt-4 text-sm" data-testid="voucher-details">
      <h2 id="vouchers-heading" className="font-extrabold text-varsity-navy">
        <span aria-hidden="true">{'🧾 '}</span>
        {t('heading')}
      </h2>
      <dl className="space-y-2 tabular-nums">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-soft">{t(voucher.feeMode === 'ADD' ? 'price' : 'priceInc')}</dt>
          <dd className="font-corp font-bold text-varsity-navy">{money(voucher.priceCents)}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-ink-soft">{t(voucher.feeMode === 'ADD' ? 'fee' : 'feeInc')}</dt>
          <dd className="font-corp font-bold text-varsity-navy">{fee}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-ink-soft">{t('validUntil')}</dt>
          <dd className="font-bold text-varsity-navy" data-testid="voucher-valid-until">{validUntil}</dd>
        </div>
      </dl>
      <p className="text-ink-soft">{t('howToUse')}</p>
      <p className="text-ink-soft">{t('refund')}</p>
      {voucher.noProduct ? <NoProductNotice /> : null}
    </section>
  );
}

/** Aviso de la aportación «sin producto» (decisiones 49 y 64): claro y **antes de pagar**, en la ficha y en el pago. */
export function NoProductNotice({ compact = false }: { compact?: boolean }) {
  const t = useTranslations('portal.voucher.noProduct');
  return (
    <div role="note" className={`space-y-1 rounded-xl border-2 border-amber-500 bg-amber-50 text-amber-950 ${compact ? 'p-2.5 text-sm' : 'p-3'}`} data-testid="no-product-notice">
      <p className="font-extrabold">
        <span aria-hidden="true">{'💛 '}</span>
        {t('title')}
      </p>
      {compact ? null : <p>{t('body')}</p>}
      <ul className="ms-5 list-disc">
        <li>{t('noVoucher')}</li>
        <li>{t('noCertificate')}</li>
        <li>{t('noRefund')}</li>
      </ul>
    </div>
  );
}
