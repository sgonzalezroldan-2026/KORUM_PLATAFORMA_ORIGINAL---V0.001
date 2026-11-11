'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { ScanOutcome } from '@/core/ticketing/gate-offline';

/**
 * Resultado de leer un pase, con el color y el texto del veredicto (nunca solo color: Regla 03 §8). Verde = entra; ámbar = decidir cuántas personas
 * entran o no se puede comprobar; rojo = no entra, con aviso inmediato a los lectores de pantalla (`role="alert"`). El pase ya usado dice la hora
 * del primer acceso. Ocupa **toda la pantalla** (EXPERIENCIA §39: se ve de un vistazo con sol y a la altura de la cintura) y el foco pasa a su título al
 * aparecer, para que un lector de pantalla lo lea y el teclado no se pierda; al cerrarlo, el lector devuelve el foco al campo del código.
 */

const RED: ReadonlySet<ScanOutcome['status']> = new Set(['EXHAUSTED', 'INSUFFICIENT', 'INVALID_SIGNATURE', 'OTHER_EVENT', 'REVOKED', 'NOT_PAID', 'NOT_APPLICABLE', 'EVENT_CLOSED', 'INVALID_FORMAT']);

export const isRedOutcome = (outcome: ScanOutcome): boolean => RED.has(outcome.status);

/** Clave de texto de cada veredicto (en `gate.scanner.result.*`). */
const KEY: Record<ScanOutcome['status'], string> = {
  ACCEPTED: 'accepted',
  CHOOSE: 'choose',
  INSUFFICIENT: 'insufficient',
  EXHAUSTED: 'exhausted',
  UNKNOWN: 'unknown',
  INVALID_FORMAT: 'invalidFormat',
  INVALID_SIGNATURE: 'invalidSignature',
  OTHER_EVENT: 'otherEvent',
  REVOKED: 'revoked',
  NOT_PAID: 'notPaid',
  NOT_APPLICABLE: 'notApplicable',
  EVENT_CLOSED: 'eventClosed',
  DUPLICATE_SCAN: 'duplicate'
};

export const outcomeKey = (outcome: ScanOutcome): string => KEY[outcome.status];

export function useOutcomeDetail() {
  const t = useTranslations('gate.scanner.result');
  const format = useFormatter();
  return (outcome: ScanOutcome): string => {
    const time = 'firstAccessAt' in outcome && outcome.firstAccessAt !== null ? format.dateTime(new Date(outcome.firstAccessAt), { hour: '2-digit', minute: '2-digit' }) : null;
    switch (outcome.status) {
      case 'ACCEPTED':
        return t('acceptedDetail', { entered: outcome.entered, quantity: outcome.quantity, remaining: outcome.remaining });
      case 'EXHAUSTED':
        return time ? t('exhaustedDetail', { time }) : t('exhaustedDetailNoTime');
      case 'INSUFFICIENT':
        return time ? t('insufficientDetailAt', { remaining: outcome.remaining, time }) : t('insufficientDetail', { remaining: outcome.remaining });
      default:
        return t(`${outcomeKey(outcome)}Detail`);
    }
  };
}

export function GateResultPanel({ outcome, serial, offline, onNext, onChoose }: { outcome: ScanOutcome; serial: string | null; offline: boolean; onNext: () => void; onChoose: (people: number) => void }) {
  const t = useTranslations('gate.scanner');
  const detail = useOutcomeDetail();
  const red = isRedOutcome(outcome);
  const ask = outcome.status === 'CHOOSE';
  const [people, setPeople] = useState(ask ? outcome.remaining : 1);
  const title = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => title.current?.focus(), []);
  const tone = red ? 'bg-red-700 text-white' : ask || outcome.status === 'UNKNOWN' ? 'bg-varsity-gold text-varsity-navy' : 'bg-emerald-700 text-white';
  const symbol = red ? '⛔ ' : ask || outcome.status === 'UNKNOWN' ? '❓ ' : '✅ ';

  return (
    <section aria-labelledby="gate-result-title" role={red ? 'alert' : 'status'} data-testid="gate-result" data-outcome={outcome.status} className={clsx('fixed inset-0 z-50 flex flex-col justify-center gap-4 overflow-y-auto p-6 sm:p-10', tone)}>
      <h2 id="gate-result-title" ref={title} tabIndex={-1} className="font-corp text-4xl font-extrabold outline-none sm:text-5xl">
        <span aria-hidden="true">{symbol}</span>
        {t(`result.${outcomeKey(outcome)}`)}
      </h2>
      {ask ? (
        <>
          <p className="text-xl">{t('result.chooseDetail', { quantity: outcome.quantity, remaining: outcome.remaining })}</p>
          <div className="flex items-center gap-3">
            <button type="button" className="min-h-11 min-w-11 rounded-xl border-2 border-current text-2xl font-extrabold" aria-label={t('result.fewer')} disabled={people <= 1} onClick={() => setPeople((value) => Math.max(1, value - 1))}>
              {'−'}
            </button>
            <output aria-live="polite" aria-label={t('result.peopleLabel')} className="font-corp min-w-16 text-center text-6xl font-extrabold tabular-nums" data-testid="gate-people">
              {people}
            </output>
            <button type="button" className="min-h-11 min-w-11 rounded-xl border-2 border-current text-2xl font-extrabold" aria-label={t('result.more')} disabled={people >= outcome.remaining} onClick={() => setPeople((value) => Math.min(outcome.remaining, value + 1))}>
              {'+'}
            </button>
          </div>
          <button type="button" className="min-h-14 rounded-xl bg-varsity-navy px-4 font-corp text-xl font-extrabold text-varsity-ivory" onClick={() => onChoose(people)} data-testid="gate-confirm-people">
            {t('result.chooseConfirm', { count: people })}
          </button>
          <button type="button" className="min-h-11 rounded-xl border-2 border-current px-4 font-bold" onClick={onNext}>
            {t('result.chooseCancel')}
          </button>
        </>
      ) : (
        <>
          <p className="text-xl">{detail(outcome)}</p>
          {serial ? <p className="text-sm font-semibold tabular-nums opacity-90">{serial}</p> : null}
          {offline && outcome.status === 'ACCEPTED' ? <p className="text-sm font-semibold">{t('result.savedOffline')}</p> : null}
          <button type="button" className="min-h-14 rounded-xl bg-varsity-navy px-4 font-corp text-xl font-extrabold text-varsity-ivory" onClick={onNext} data-testid="gate-next">
            {t('result.next')}
          </button>
        </>
      )}
    </section>
  );
}
