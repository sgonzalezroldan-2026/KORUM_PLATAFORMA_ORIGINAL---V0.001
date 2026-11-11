'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { drawRaffleAction, loadRaffleActAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/raffle-actions';
import { Field, FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import type { RaffleRoundView, RaffleView } from '@/core/ticketing/raffle-state.service';
import type { RaffleDrawBlock } from '@/core/ticketing/raffle-draw.service';
import { useRouter } from '@/i18n/navigation';

/**
 * Pantalla proyectable del sorteo certificado (Sprint 4.5). Letra enorme, alto contraste y pantalla completa. El sorteo lo hace el servidor con
 * `crypto.randomInt` entre las papeletas pagadas y no anuladas; aquí solo se pide y se enseña. La clave de idempotencia se genera al preparar cada ronda:
 * un doble toque o un corte de red devuelven la misma acta, nunca otro ganador. De cada ronda queda un acta con las dos huellas SHA-256, que se puede
 * descargar o imprimir. Los números salen sin pausas ni efectos si la persona pide menos movimiento.
 */

const newKey = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `rifa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

const BLOCK_KEY: Record<RaffleDrawBlock, string> = {
  NOT_A_RAFFLE: 'notRaffle',
  SALES_OPEN: 'salesOpen',
  TOO_EARLY: 'tooEarly',
  PRIZES_NOT_SET: 'prizesNotSet',
  PRIZES_EXHAUSTED: 'done',
  NOT_ENOUGH_ENTRIES: 'notEnough',
  EXTRA_NOT_JUSTIFIED: 'extraNotAllowed',
  EXTRA_TOO_SOON: 'extraNotAllowed',
  REPLACED_INVALID: 'extraNotAllowed',
  KEY_REUSED: 'keyReused'
};

export function RaffleStage({ eventId, initial }: { eventId: number; initial: RaffleView }) {
  const t = useTranslations('gate.raffle');
  const format = useFormatter();
  const router = useRouter();
  const [view, setView] = useState(initial);
  // Se escribe como texto: con un número el «1» no se podría borrar para escribir otra cifra.
  const [winnersText, setWinnersText] = useState('1');
  const canFullscreen = useSyncExternalStore(
    () => () => undefined,
    () => document.fullscreenEnabled,
    () => false
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [latest, setLatest] = useState<number | null>(initial.rounds.length > 0 ? initial.rounds[initial.rounds.length - 1]!.round : null);
  const [fullscreen, setFullscreen] = useState(false);
  const keyRef = useRef(newKey());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLHeadingElement | null>(null);

  const left = view.prizeCount === null ? 0 : Math.max(0, view.prizeCount - view.drawnPrizes);
  const opensAt = useMemo(() => new Date(view.opensAt), [view.opensAt]);
  // Parte de la hora del servidor y avanza con el reloj del móvil: así «el sorteo se abre hoy» no exige recargar la pantalla a medianoche.
  const [clock, setClock] = useState(view.now);
  const early = clock < view.opensAt;
  const closedSales = view.status === 'GOAL_REACHED';
  const stateNotice = !view.isRaffle
    ? t('blocked.notRaffle')
    : view.status === 'FUNDRAISING'
      ? t('blocked.salesOpen')
      : view.status === 'CLOSED'
        ? t('blocked.closed')
        : !closedSales
          ? t('blocked.notAvailable')
          : early
            ? t('blocked.tooEarly', { date: format.dateTime(opensAt, { dateStyle: 'long' }) })
            : view.prizeCount === null
              ? t('blocked.prizesNotSet')
              : left > 0 && view.validEntries === 0
                ? t('blocked.notEnough')
                : null;
  const canDraw = view.isRaffle && closedSales && !early && left > 0 && view.validEntries > 0;
  const pending = Math.min(left || 1, Math.max(1, Math.trunc(Number(winnersText)) || 1));

  useEffect(() => {
    const timer = setInterval(() => setClock((value) => Math.max(value, Date.now())), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  const draw = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await drawRaffleAction(eventId, { winnersCount: pending, idempotencyKey: keyRef.current });
      if (result.status === 'OK') {
        setView(result.view);
        setLatest(result.round);
        keyRef.current = newKey();
        setWinnersText('1');
        // El foco pasa al resultado para quien usa lector de pantalla; la proyección lo muestra enseguida.
        setTimeout(() => resultRef.current?.focus(), 0);
      } else if (result.status === 'BLOCKED') setProblem(t(`blocked.${BLOCK_KEY[result.reason]}`, { date: format.dateTime(opensAt, { dateStyle: 'long' }) }));
      else if (result.reason === 'NO_SESSION') router.refresh();
      else setProblem(t(result.reason === 'BUSY' ? 'blocked.busy' : 'blocked.failed'));
    } catch {
      // Con la clave sin cambiar, repetir el toque devuelve el sorteo ya hecho si el servidor llegó a hacerlo.
      setProblem(t('blocked.failed'));
    } finally {
      setBusy(false);
    }
  }, [eventId, format, opensAt, pending, router, t]);

  const act = async (round: RaffleRoundView, kind: 'download' | 'print') => {
    const result = await loadRaffleActAction(eventId, round.round);
    if (result.status !== 'OK') return setProblem(t('blocked.failed'));
    if (kind === 'print') return window.print();
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.act, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `acta-sorteo-${view.title.replace(/[^\w-]+/g, '-').slice(0, 40)}-ronda-${round.round}.json`;
    link.click();
    // Con retraso: si se libera al instante, Safari y Firefox pueden abortar la descarga.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const shown = view.rounds.find((round) => round.round === latest) ?? null;

  return (
    <div ref={stageRef} className={clsx('flex flex-col gap-5', fullscreen && 'min-h-dvh justify-center bg-varsity-navy-deep p-6')} data-testid="raffle-stage">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h1 className="font-corp text-2xl font-extrabold">{t('title')}</h1>
        {canFullscreen ? (
          <button type="button" className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-ivory px-4 font-bold" onClick={toggleFullscreen} data-testid="raffle-fullscreen">
            {fullscreen ? t('exitFullscreen') : t('fullscreen')}
          </button>
        ) : null}
      </div>
      <p className="break-words text-lg font-bold print:text-black">{view.title}</p>

      {stateNotice ? <FormAlert tone="info">{stateNotice}</FormAlert> : null}

      {view.isRaffle ? (
        <dl className="grid grid-cols-2 gap-3 print:hidden">
          <div className="rounded-2xl bg-varsity-ivory p-4 text-ink">
            <dt className="text-sm font-semibold">{t('entries')}</dt>
            <dd className="font-corp text-3xl font-extrabold tabular-nums text-varsity-navy" data-testid="raffle-entries">
              {view.validEntries}
            </dd>
          </div>
          <div className="rounded-2xl bg-varsity-ivory p-4 text-ink">
            <dt className="text-sm font-semibold">{t('prizesLeft')}</dt>
            <dd className="font-corp text-3xl font-extrabold tabular-nums text-varsity-navy" data-testid="raffle-left">
              {view.prizeCount === null ? '—' : left}
            </dd>
          </div>
        </dl>
      ) : null}

      {canDraw ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-varsity-ivory p-5 text-ink print:hidden">
          {left > 1 ? <Field label={t('winnersLabel', { left })} hint={t('winnersHint')} inputMode="numeric" autoComplete="off" maxLength={3} value={winnersText} onChange={(event) => setWinnersText(event.target.value.replace(/D/g, ''))} onBlur={() => setWinnersText(String(pending))} /> : null}
          <button type="button" className={clsx(primaryButton, 'min-h-16 text-2xl')} disabled={busy} onClick={() => void draw()} data-testid="raffle-draw">
            {busy ? t('drawing') : pending > 1 ? t('drawMany', { count: pending }) : t('drawOne')}
          </button>
        </div>
      ) : null}
      {view.isRaffle && closedSales && !early && left === 0 && view.prizeCount !== null ? <FormAlert tone="success">{t('blocked.done')}</FormAlert> : null}
      {problem ? <FormAlert>{problem}</FormAlert> : null}

      {shown ? (
        <section aria-labelledby="raffle-result" className="flex flex-col gap-4 rounded-2xl bg-varsity-gold p-6 text-varsity-navy print:bg-white print:text-black" data-testid="raffle-result">
          <h2 id="raffle-result" ref={resultRef} tabIndex={-1} className="font-corp text-2xl font-extrabold">
            {shown.extra ? t('resultExtra', { round: shown.round, count: shown.winningNumbers.length }) : t('result', { round: shown.round, count: shown.winningNumbers.length })}
            <span className="sr-only">{`: ${shown.winningNumbers.map((number) => `#${String(number).padStart(4, '0')}`).join(', ')}`}</span>
          </h2>
          <ul className="flex flex-wrap gap-3" aria-label={t('numbersLabel')}>
            {shown.winningNumbers.map((number) => (
              <li key={number} className="rounded-2xl bg-varsity-navy px-6 py-3 font-corp text-6xl font-extrabold md:text-8xl tabular-nums text-varsity-ivory motion-safe:animate-[korum-reveal_700ms_ease-out_both] print:bg-white print:text-black print:ring-2 print:ring-black" data-testid="raffle-number">
                {`#${String(number).padStart(4, '0')}`}
              </li>
            ))}
          </ul>
          <dl className="grid gap-2 text-sm font-semibold">
            <div>
              <dt className="opacity-80">{t('act.time')}</dt>
              <dd>{format.dateTime(new Date(shown.drawnAt), { dateStyle: 'long', timeStyle: 'medium' })}</dd>
            </div>
            <div>
              <dt className="opacity-80">{t('act.participants')}</dt>
              <dd data-testid="raffle-participants">{shown.participantCount}</dd>
            </div>
            <div>
              <dt className="opacity-80">{t('act.listHash')}</dt>
              <dd className="break-all font-mono text-xs" data-testid="raffle-list-hash">{shown.participantsSha256}</dd>
            </div>
            <div>
              <dt className="opacity-80">{t('act.actHash')}</dt>
              <dd className="break-all font-mono text-xs" data-testid="raffle-act-hash">{shown.actSha256}</dd>
            </div>
          </dl>
          <p className="text-sm print:text-black">{t('act.verify')}</p>
          <div className="flex flex-wrap gap-3 print:hidden">
            <button type="button" className={clsx(secondaryButton, 'w-auto bg-white')} onClick={() => void act(shown, 'download')} data-testid="raffle-download">
              {t('act.download')}
            </button>
            <button type="button" className={clsx(secondaryButton, 'w-auto bg-white')} onClick={() => void act(shown, 'print')}>
              {t('act.print')}
            </button>
          </div>
        </section>
      ) : null}

      {view.rounds.length > 1 ? (
        <section aria-labelledby="raffle-rounds" className="flex flex-col gap-2 rounded-2xl bg-varsity-ivory p-5 text-ink print:hidden">
          <h2 id="raffle-rounds" className="font-corp text-lg font-extrabold text-varsity-navy">
            {t('rounds')}
          </h2>
          <ul className="flex flex-col gap-2">
            {view.rounds.map((round) => (
              <li key={round.round}>
                <button type="button" className={clsx(secondaryButton, round.round === latest && 'bg-varsity-navy text-varsity-ivory hover:bg-varsity-navy')} aria-pressed={round.round === latest} onClick={() => setLatest(round.round)}>
                  {t('roundButton', { round: round.round, numbers: round.winningNumbers.map((number) => `#${String(number).padStart(4, '0')}`).join(', ') })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
