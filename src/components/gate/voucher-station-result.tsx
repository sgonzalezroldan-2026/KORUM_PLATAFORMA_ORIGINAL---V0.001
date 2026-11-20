'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { VoucherLookupView, VoucherRedeemView } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/voucher-actions';
import { primaryButton, secondaryButton } from '@/components/auth/auth-ui';

/**
 * Lo que ve quien atiende el puesto de vales al leer un QR (Sprint 5.14c). Ocupa la pantalla y se lee de un vistazo, con el veredicto en texto y no solo en color
 * (Regla 03 §8): en verde, los vales que quedan y cuántos se gastan ahora (se teclean o con −/+, nunca más que los que quedan); en verde también, lo que se acaba de
 * gastar; en rojo, por qué no se puede gastar nada. El foco pasa a su título al aparecer.
 */

export type StationShown = { kind: 'lookup'; payload: string; view: VoucherLookupView } | { kind: 'redeem'; view: VoucherRedeemView };

interface ResultProps {
  shown: StationShown;
  busy: boolean;
  onRedeem: (quantity: number) => void;
  onNext: () => void;
}

const panel = (tone: 'green' | 'red') => clsx('flex flex-col gap-3 rounded-2xl p-5', tone === 'green' ? 'bg-emerald-800 text-white' : 'bg-red-700 text-white');

export function VoucherStationResult({ shown, busy, onRedeem, onNext }: ResultProps) {
  const t = useTranslations('gate.vouchers.result');
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const inputId = useId();
  const balance = shown.kind === 'lookup' && shown.view.status === 'OK' ? shown.view.balance : 0;
  const [quantity, setQuantity] = useState(1);

  useEffect(() => headingRef.current?.focus(), []);

  if (shown.kind === 'lookup' && shown.view.status === 'OK') {
    const view = shown.view;
    const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= balance;
    return (
      <section className={panel('green')} role="status" aria-labelledby={`${inputId}-title`} data-testid="voucher-station-balance">
        <h2 id={`${inputId}-title`} ref={headingRef} tabIndex={-1} className="font-corp text-3xl font-extrabold tabular-nums">
          {t('balance', { balance: view.balance, total: view.quantity })}
        </h2>
        <p className="font-mono text-sm">{t('serial', { serial: view.serial })}</p>
        <label htmlFor={inputId} className="text-lg font-bold">
          {t('howMany')}
        </label>
        <div className="flex items-center gap-2">
          <button type="button" className="min-h-14 min-w-14 rounded-xl border-2 border-white text-2xl font-extrabold" onClick={() => setQuantity((current) => (Number.isNaN(current) ? 1 : Math.max(1, current - 1)))} aria-label={t('less')} disabled={busy || !(quantity > 1)}>
            {'−'}
          </button>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={1}
            max={balance}
            value={Number.isNaN(quantity) ? '' : quantity}
            onChange={(change) => setQuantity(Number.parseInt(change.target.value, 10))}
            className="min-h-14 w-24 rounded-xl border-2 border-white bg-white text-center font-corp text-3xl font-extrabold tabular-nums text-ink"
            aria-invalid={!valid}
            aria-describedby={!valid ? `${inputId}-error` : undefined}
            data-testid="voucher-station-quantity"
          />
          <button type="button" className="min-h-14 min-w-14 rounded-xl border-2 border-white text-2xl font-extrabold" onClick={() => setQuantity((current) => Math.min(balance, (Number.isNaN(current) ? 0 : current) + 1))} aria-label={t('more')} disabled={busy || quantity >= balance}>
            {'+'}
          </button>
        </div>
        {!valid ? (
          <p id={`${inputId}-error`} role="alert" className="font-bold">
            {t('quantityInvalid', { balance })}
          </p>
        ) : null}
        <button type="button" className={clsx(primaryButton, 'text-lg')} disabled={busy || !valid} onClick={() => onRedeem(quantity)} data-testid="voucher-station-redeem">
          {busy ? t('redeeming') : t('redeem', { count: valid ? quantity : 0 })}
        </button>
        <button type="button" className={clsx(secondaryButton, 'border-white bg-transparent text-white hover:bg-white/10')} disabled={busy} onClick={onNext}>
          {t('cancel')}
        </button>
      </section>
    );
  }

  const view = shown.view;
  const green = view.status === 'REDEEMED' || (view.status === 'DUPLICATE' && view.accepted);
  const message =
    view.status === 'REDEEMED'
      ? t('redeemed', { spent: view.spent, balance: view.balance })
      : view.status === 'DUPLICATE'
        ? t(view.accepted ? 'duplicateAccepted' : 'duplicateRejected', { balance: view.balance })
        : view.status === 'INSUFFICIENT'
          ? t('insufficient', { balance: view.balance })
          : t(`blocked.${view.status}`);
  return (
    <section className={panel(green ? 'green' : 'red')} role={green ? 'status' : 'alert'} data-testid={green ? 'voucher-station-done' : 'voucher-station-error'}>
      <h2 ref={headingRef} tabIndex={-1} className="font-corp text-2xl font-extrabold">
        <span aria-hidden="true">{green ? '✅ ' : '⛔ '}</span>
        {message}
      </h2>
      {view.status === 'REDEEMED' ? <p className="font-mono text-sm">{t('serial', { serial: view.serial })}</p> : null}
      <button type="button" className={clsx(secondaryButton, 'border-white bg-transparent text-white hover:bg-white/10')} onClick={onNext} data-testid="voucher-station-next">
        {t('next')}
      </button>
    </section>
  );
}
