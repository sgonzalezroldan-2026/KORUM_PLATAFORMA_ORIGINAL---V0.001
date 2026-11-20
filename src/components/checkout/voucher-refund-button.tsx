'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { claimVoucherRefundAction, type VoucherRefundResult } from '@/app/[locale]/(public)/[orgSlug]/entrada/[passUuid]/actions';
import { FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { formatCents } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';
import { useRouter } from '@/i18n/navigation';

/**
 * Devolución de una compra de vales (Sprint 5.14c, QA-VAL04): la de 14 días (el 100 %, sin haber gastado nada) o, si la entidad acortó la validez, la de lo no
 * gastado. Un clic y una confirmación, porque los vales dejan de valer y no se deshace. El foco pasa
 * a la confirmación al abrirla y vuelve al botón al cerrarla. Al terminar, la página se recarga y el pase dice que la compra se ha devuelto.
 */
export function VoucherRefundButton({ orgSlug, passUuid, sig, amountCents, vouchers, kind, until }: { orgSlug: string; passUuid: string; sig: string; amountCents: number; vouchers: number; kind: 'FULL' | 'UNSPENT'; until: string }) {
  const t = useTranslations('portal.pass.refund');
  const format = useFormatter();
  const router = useRouter();
  const textId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Extract<VoucherRefundResult, { status: 'ERROR' }>['reason'] | 'FAILED' | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming) boxRef.current?.focus();
  }, [confirming]);

  const locale = useLocale();
  const amount = formatCents(amountCents, isLocale(locale) ? locale : 'es');
  const date = format.dateTime(new Date(until), { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' });

  const claim = async () => {
    setBusy(true);
    setError(null);
    const result = await claimVoucherRefundAction({ orgSlug, passUuid, sig }).catch((): { status: 'ERROR'; reason: 'FAILED' } => ({ status: 'ERROR', reason: 'FAILED' }));
    setBusy(false);
    if (result.status === 'ERROR') {
      setError(result.reason);
      setConfirming(false);
      return;
    }
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy/30 p-4 text-start" aria-labelledby={`${textId}-title`} data-testid="voucher-refund">
      <h2 id={`${textId}-title`} className="font-corp text-base font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="text-sm">
        {t(kind === 'FULL' ? 'text' : 'textUnspent', { date, amount, count: vouchers })}
      </p>
      {error ? <FormAlert>{t(`errors.${error}`)}</FormAlert> : null}
      {confirming ? (
        <div ref={boxRef} tabIndex={-1} role="alertdialog" aria-labelledby={textId} className="flex flex-col gap-2 rounded-xl border-2 border-red-700 p-3">
          <p id={textId} className="font-semibold">
            {t(kind === 'FULL' ? 'confirmText' : 'confirmTextUnspent', { amount, count: vouchers })}
          </p>
          <button type="button" className={primaryButton} disabled={busy} onClick={() => void claim()} data-testid="voucher-refund-yes">
            {busy ? t('sending') : t('confirmYes')}
          </button>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              setTimeout(() => openRef.current?.focus(), 0);
            }}
          >
            {t('confirmNo')}
          </button>
        </div>
      ) : (
        <button ref={openRef} type="button" className={secondaryButton} onClick={() => setConfirming(true)} data-testid="voucher-refund-open">
          {t('button')}
        </button>
      )}
    </section>
  );
}
