'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { cancelVoucherSaleAction, changeVoucherDatesAction, type VoucherSaleResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/taquilla/actions';
import { FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { useRouter } from '@/i18n/navigation';
import type { VoucherSaleView } from '@/repositories/gate-admin.repository';

/**
 * Fechas y cancelación de una venta de vales en «Taquilla y portería» (Sprint 5.14c; decisiones 32, 49, 67, 69 y 71 del promotor).
 *
 * - **Cambiar fechas:** el cierre (solo mientras se vende; nadie recibe aviso) y la validez de los vales (alargarla avisa por email a quien tiene vales sin
 *   gastar; acortarla, además, le abre 14 días para recuperar lo no gastado y la liquidación espera). Ya liquidada, la validez solo se alarga.
 * - **Cancelar:** los vales dejan de valer y nadie más compra. Antes de liquidar, la plataforma devuelve a cada persona lo que no haya gastado y lo gastado se
 *   liquida a la entidad; después, avisamos a quien tiene vales sin gastar de que os pida a vosotros la devolución. Pide confirmación (avisa por email y no se deshace); el foco va al aviso, no al botón que
 *   cancela. Solo quienes firman, con segundo factor.
 */

type Mode = 'idle' | 'dates' | 'cancel';

const DANGER_BUTTON = 'inline-flex min-h-11 w-full items-center justify-center rounded-xl border-2 border-red-700 px-4 font-bold text-red-800 hover:bg-red-50 disabled:opacity-60';
const DATE_INPUT = 'min-h-11 rounded-xl border-2 border-varsity-navy px-3';

interface PanelProps {
  orgSlug: string;
  saleId: number;
  ticketsSold: number;
  sale: VoucherSaleView;
  canAct: boolean;
}

export function VoucherSalePanel({ orgSlug, saleId, ticketsSold, sale, canAct }: PanelProps) {
  const t = useTranslations('panel.gate.vouchers');
  const format = useFormatter();
  const router = useRouter();
  const closeId = useId();
  const validId = useId();
  const datesHintId = useId();
  const cancelTextId = useId();
  const [mode, setMode] = useState<Mode>('idle');
  const [closeDay, setCloseDay] = useState(sale.closeDay);
  const [validDay, setValidDay] = useState(sale.validDay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<VoucherSaleResult | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const cancelBoxRef = useRef<HTMLDivElement | null>(null);
  const datesRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (mode === 'dates') formRef.current?.querySelector<HTMLElement>('input')?.focus();
    if (mode === 'cancel') cancelBoxRef.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done, sale.cancelled]);

  const dayText = (day: string) => format.dateTime(new Date(`${day}T12:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' });
  const instantText = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: 'Europe/Madrid' });

  const open = (next: Mode) => {
    setDone(null);
    setError(null);
    setCloseDay(sale.closeDay);
    setValidDay(sale.validDay);
    setMode(next);
  };

  const close = (back: Mode) => {
    setMode('idle');
    setError(null);
    setTimeout(() => (back === 'cancel' ? cancelRef : datesRef).current?.focus(), 0);
  };

  const run = async (action: () => Promise<VoucherSaleResult>, message: (result: Extract<VoucherSaleResult, { status: 'OK' }>) => string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await action().catch((): VoucherSaleResult => ({ status: 'ERROR', reason: 'FORBIDDEN' }));
    setBusy(false);
    if (result.status === 'ERROR') {
      setError(result);
      return;
    }
    setMode('idle');
    setDone(message(result));
    router.refresh();
  };

  const saveDates = () =>
    run(
      () => changeVoucherDatesAction(orgSlug, { initiativeId: saleId, ...(sale.canChangeClose && closeDay !== sale.closeDay ? { closeDay } : {}), ...(validDay !== sale.validDay ? { validDay } : {}) }),
      (result) => t('datesSaved', { count: ticketsSold, close: result.closesAt ? instantText(result.closesAt) : '', valid: result.validUntil ? instantText(result.validUntil) : '' })
    );
  const cancelSale = () => run(() => cancelVoucherSaleAction(orgSlug, { initiativeId: saleId }), (result) => t(result.settled ? 'cancelledSettled' : ticketsSold > 0 ? 'cancelledWithSales' : 'cancelledEmpty'));

  const unchanged = (closeDay === sale.closeDay || !sale.canChangeClose) && validDay === sale.validDay;
  // El mínimo de la validez sigue al cierre elegido (un vale no caduca mientras se vende).
  const validMin = closeDay > sale.validMinDay ? closeDay : sale.validMinDay;

  if (sale.cancelled && !done) return null;

  return (
    <section className="flex flex-col gap-2 rounded-xl border-2 border-stone-200 p-4" aria-labelledby={`voucher-sale-${saleId} gate-event-${saleId}`} data-testid="voucher-sale-panel">
      <h3 id={`voucher-sale-${saleId}`} className="font-corp text-base font-extrabold text-varsity-navy">
        {t('title')}
      </h3>
      {/* Mientras se vende tampoco se puede liquidar: el aviso solo tiene sentido con la venta cerrada. */}
      {!sale.cancelled && !sale.selling && sale.refundOpenUntil ? (
        <p className="text-sm font-semibold" data-testid="voucher-sale-refund-open">
          {t('refundOpen', { date: format.dateTime(new Date(sale.refundOpenUntil), { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' }) })}
        </p>
      ) : null}
      {done ? (
        <p ref={doneRef} tabIndex={-1} role="status" className="rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-3 font-semibold text-emerald-950" data-testid="voucher-sale-done">
          {done}
        </p>
      ) : null}
      {error?.status === 'ERROR' ? <FormAlert>{t(`errors.${error.reason}`)}</FormAlert> : null}

      {sale.cancelled ? null : !canAct ? (
        <p className="text-sm text-ink-soft">{t('readOnly')}</p>
      ) : !sale.canChange ? (
        <p className="text-sm text-ink-soft">{t('locked')}</p>
      ) : mode === 'dates' ? (
        <div ref={formRef} className="flex flex-col gap-2" data-testid="voucher-dates-form">
          {sale.canChangeClose ? (
            <>
              <label htmlFor={closeId} className="font-semibold">
                {t('closeLabel')}
              </label>
              <input id={closeId} type="date" className={DATE_INPUT} min={sale.closeMinDay} max={sale.closeMaxDay} value={closeDay} aria-describedby={datesHintId} onChange={(change) => setCloseDay(change.target.value)} data-testid="voucher-close-date" />
            </>
          ) : null}
          <label htmlFor={validId} className="font-semibold">
            {t('validLabel')}
          </label>
          <input id={validId} type="date" className={DATE_INPUT} min={validMin} max={sale.validMaxDay} value={validDay} aria-describedby={datesHintId} onChange={(change) => setValidDay(change.target.value)} data-testid="voucher-valid-date" />
          <p id={datesHintId} className="text-sm text-ink-soft">
            {t(sale.settled ? 'datesHintSettled' : sale.canChangeClose ? 'datesHint' : 'datesHintClosed', { count: ticketsSold, closeMax: dayText(sale.closeMaxDay), validMax: dayText(sale.validMaxDay) })}
          </p>
          <button type="button" className={primaryButton} disabled={busy || unchanged || closeDay === '' || validDay === ''} onClick={() => void saveDates()} data-testid="voucher-dates-confirm">
            {unchanged ? t('datesChoose') : t('datesConfirm')}
          </button>
          <button type="button" className={secondaryButton} onClick={() => close('dates')}>
            {t('back')}
          </button>
        </div>
      ) : mode === 'cancel' ? (
        <div ref={cancelBoxRef} tabIndex={-1} role="alertdialog" aria-labelledby={cancelTextId} className="flex flex-col gap-2 rounded-xl border-2 border-red-700 p-3" data-testid="voucher-cancel-confirm">
          <p id={cancelTextId} className="font-semibold">
            {t(sale.settled ? 'cancelWarningSettled' : 'cancelWarning', { count: ticketsSold })}
          </p>
          <button type="button" className={DANGER_BUTTON} disabled={busy} onClick={() => void cancelSale()} data-testid="voucher-cancel-yes">
            {t('cancelYes')}
          </button>
          <button type="button" className={secondaryButton} onClick={() => close('cancel')}>
            {t('cancelNo')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button ref={datesRef} type="button" className={secondaryButton} disabled={busy} onClick={() => open('dates')} data-testid="voucher-dates">
            {t('changeDates')}
          </button>
          <button ref={cancelRef} type="button" className={DANGER_BUTTON} disabled={busy} onClick={() => open('cancel')} data-testid="voucher-cancel">
            {t('cancel')}
          </button>
        </div>
      )}
    </section>
  );
}
