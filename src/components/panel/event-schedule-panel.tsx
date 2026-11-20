'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { cancelEventAction, rescheduleEventAction, type EventChangeResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/taquilla/actions';
import { FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { useRouter } from '@/i18n/navigation';
import type { EventScheduleView } from '@/repositories/gate-admin.repository';

/**
 * Fecha y cancelación de un evento en «Taquilla y portería» (Sprint 5.13, decisión 30 del promotor). Cambiar la fecha avisa a quienes compraron con un
 * enlace para recuperar el 100 % durante 14 días (mientras tanto no se liquida); cancelar devuelve el 100 % a todas las personas y cierra la portería. Las
 * dos cosas piden confirmación, porque avisan por email a quien compró y no se deshacen. Solo quienes firman, con segundo factor.
 *
 * Al confirmar la cancelación, el foco va al aviso (no al botón que cancela): un lector de pantalla lo lee entero y un Intro sin querer no cancela nada. Un
 * evento ya cancelado solo enseña la confirmación de quien acaba de cancelarlo; su estado lo dice la tarjeta.
 */

type Mode = 'idle' | 'reschedule' | 'cancel';

const DANGER_BUTTON = 'inline-flex min-h-11 w-full items-center justify-center rounded-xl border-2 border-red-700 px-4 font-bold text-red-800 hover:bg-red-50 disabled:opacity-60';

interface PanelProps {
  orgSlug: string;
  eventId: number;
  ticketsSold: number;
  schedule: EventScheduleView;
  canAct: boolean;
  /** El evento está cancelado (devolviéndose, devuelto o cerrado sin ventas). */
  closed: boolean;
}

export function EventSchedulePanel({ orgSlug, eventId, ticketsSold, schedule, canAct, closed }: PanelProps) {
  const t = useTranslations('panel.gate.schedule');
  const format = useFormatter();
  const router = useRouter();
  const dateId = useId();
  const hintId = useId();
  const cancelTextId = useId();
  const [mode, setMode] = useState<Mode>('idle');
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EventChangeResult | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const cancelBoxRef = useRef<HTMLDivElement | null>(null);
  const rescheduleRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLParagraphElement | null>(null);

  // Al abrir el cambio de fecha el foco va al selector de día; al abrir la cancelación, al aviso; al cerrarlos vuelve al botón que los abrió.
  useEffect(() => {
    if (mode === 'reschedule') formRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    if (mode === 'cancel') cancelBoxRef.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done, closed]);

  const open = (next: Mode) => {
    setDone(null);
    setError(null);
    setMode(next);
  };

  const close = (back: Mode) => {
    setMode('idle');
    setError(null);
    setTimeout(() => (back === 'cancel' ? cancelRef : rescheduleRef).current?.focus(), 0);
  };

  const longDate = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: 'Europe/Madrid' });

  const run = async (action: () => Promise<EventChangeResult>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await action().catch((): EventChangeResult => ({ status: 'ERROR', reason: 'FORBIDDEN' }));
    setBusy(false);
    if (result.status === 'ERROR') {
      setError(result);
      return;
    }
    setMode('idle');
    if (result.outcome === 'REFUNDING' || result.outcome === 'CANCELLED') setDone(t(result.outcome === 'REFUNDING' ? 'cancelledWithSales' : 'cancelledEmpty'));
    else if (result.newDate && result.refundUntil) setDone(t('rescheduled', { count: ticketsSold, date: longDate(result.newDate), until: longDate(result.refundUntil) }));
    router.refresh();
  };

  const pickedDay = day !== '' ? format.dateTime(new Date(`${day}T12:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' }) : null;
  const doneMessage = done ? (
    <p ref={doneRef} tabIndex={-1} role="status" className="rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-3 font-semibold text-emerald-950" data-testid="event-schedule-done">
      {done}
    </p>
  ) : null;
  const heading = (
    <h3 id={`event-schedule-${eventId}`} className="font-corp text-base font-extrabold text-varsity-navy">
      {t('title')}
    </h3>
  );

  // Cancelado y sin una confirmación reciente: la tarjeta ya dice su estado.
  if (closed && !done) return null;

  return (
    <section className="flex flex-col gap-2 rounded-xl border-2 border-stone-200 p-4" aria-labelledby={`event-schedule-${eventId} gate-event-${eventId}`} data-testid="event-schedule">
      {heading}
      {/* El mismo árbol antes y después de cancelar: al recargarse la pantalla, el aviso de éxito no se vuelve a crear y conserva el foco. */}
      {!closed && schedule.held && schedule.canChange ? <p className="text-sm text-ink-soft">{t('held')}</p> : null}
      {!closed && schedule.refundOpenUntil ? (
        <p className="text-sm font-semibold" data-testid="event-schedule-refund-open">
          {t('refundOpen', { date: format.dateTime(new Date(schedule.refundOpenUntil), { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' }) })}
        </p>
      ) : null}
      {doneMessage}
      {error?.status === 'ERROR' ? <FormAlert>{t(`errors.${error.reason}`)}</FormAlert> : null}

      {closed ? null : !canAct ? (
        <p className="text-sm text-ink-soft">{t('readOnly')}</p>
      ) : !schedule.canChange ? (
        <p className="text-sm text-ink-soft">{t('locked')}</p>
      ) : mode === 'reschedule' ? (
        <div ref={formRef} className="flex flex-col gap-2" data-testid="event-reschedule-form">
          {schedule.latestDay ? (
            <>
              <label htmlFor={dateId} className="font-semibold">
                {t('newDate')}
              </label>
              <input
                id={dateId}
                type="date"
                className="min-h-11 rounded-xl border-2 border-varsity-navy px-3"
                min={schedule.earliestDay}
                max={schedule.latestDay}
                value={day}
                aria-describedby={hintId}
                onChange={(change) => setDay(change.target.value)}
                data-testid="event-reschedule-date"
              />
              <p id={hintId} className="text-sm text-ink-soft">
                {t('rescheduleHint', { count: ticketsSold, latest: format.dateTime(new Date(`${schedule.latestDay}T12:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' }) })}
              </p>
              <button type="button" className={primaryButton} disabled={busy || day === '' || day === schedule.currentDay} onClick={() => void run(() => rescheduleEventAction(orgSlug, { initiativeId: eventId, newDay: day }))} data-testid="event-reschedule-confirm">
                {pickedDay ? t('rescheduleConfirm', { date: pickedDay }) : t('rescheduleChoose')}
              </button>
            </>
          ) : (
            <p role="alert" className="font-semibold">
              {t('tooLate')}
            </p>
          )}
          <button type="button" className={secondaryButton} onClick={() => close('reschedule')}>
            {t('back')}
          </button>
        </div>
      ) : mode === 'cancel' ? (
        <div ref={cancelBoxRef} tabIndex={-1} role="alertdialog" aria-labelledby={cancelTextId} className="flex flex-col gap-2 rounded-xl border-2 border-red-700 p-3" data-testid="event-cancel-confirm">
          <p id={cancelTextId} className="font-semibold">
            {t('cancelWarning', { count: ticketsSold })}
          </p>
          <button type="button" className={DANGER_BUTTON} disabled={busy} onClick={() => void run(() => cancelEventAction(orgSlug, { initiativeId: eventId }))} data-testid="event-cancel-yes">
            {t('cancelYes')}
          </button>
          <button type="button" className={secondaryButton} onClick={() => close('cancel')}>
            {t('cancelNo')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button ref={rescheduleRef} type="button" className={secondaryButton} disabled={busy} onClick={() => open('reschedule')} data-testid="event-reschedule">
            {t('reschedule')}
          </button>
          <button ref={cancelRef} type="button" className={DANGER_BUTTON} disabled={busy} onClick={() => open('cancel')} data-testid="event-cancel">
            {t('cancel')}
          </button>
        </div>
      )}
    </section>
  );
}
