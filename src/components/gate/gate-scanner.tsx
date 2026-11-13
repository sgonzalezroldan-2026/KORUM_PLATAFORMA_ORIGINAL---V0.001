'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { leaveGateAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/actions';
import { scanPassAction, type GateSummaryView } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/scan-actions';
import { Field, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import type { ScanOutcome } from '@/core/ticketing/gate-offline';
import { useRouter } from '@/i18n/navigation';
import { playGateFeedback, unlockGateAudio } from './gate-feedback';
import { clearGateState, newClientScanId } from './gate-offline-store';
import { GateResultPanel, isRedOutcome, outcomeKey } from './gate-result-panel';
import { useGateSync } from './use-gate-sync';
import { useQrReader } from './use-qr-reader';

/**
 * Lector de entradas de la portería (Sprint 4.5, QA-S04). Cámara (o código escrito, o lector con teclado), veredicto a pantalla completa en verde, ámbar o
 * rojo con sonido y vibración, pases de varias plazas con «¿cuántas entran ahora?», aforo en directo y, sin cobertura, validación contra la lista descargada
 * con la cola de lecturas que se envía sola al volver la red. Los móviles con iOS usan el lector de respaldo (jsQR). Tras cada lectura el foco vuelve al
 * lector (el campo del código, o el botón de la cámara) para que un lector de códigos con teclado siga funcionando sin tocar la pantalla.
 */

type Shown = { outcome: ScanOutcome; serial: string | null; offline: boolean; payload: string; key: number };

const AUTO_CLEAR_MS = 2_500;

export function GateScanner({ eventId, initialSummary }: { eventId: number; initialSummary: GateSummaryView }) {
  const t = useTranslations('gate.scanner');
  const format = useFormatter();
  const router = useRouter();
  const [summary, setSummary] = useState(initialSummary);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(true);
  const [problem, setProblem] = useState<'BUSY' | 'FAILED' | 'QUEUE_FULL' | null>(null);
  const [code, setCode] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [ended, setEnded] = useState(false);
  const counter = useRef(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const leaveRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const hadResult = useRef(false);

  const sync = useGateSync(eventId, setSummary, useCallback(() => setEnded(true), []));

  const show = useCallback(
    (outcome: ScanOutcome, payload: string, offline: boolean) => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      counter.current += 1;
      const serial = 'serial' in outcome ? outcome.serial : null;
      setShown({ outcome, serial, offline, payload, key: counter.current });
      playGateFeedback(isRedOutcome(outcome) ? 'alert' : outcome.status === 'CHOOSE' || outcome.status === 'UNKNOWN' ? 'ask' : 'ok', sound);
      // Un pase bueno se despeja solo para no frenar la cola; lo que pide decidir o es una alerta espera a que alguien lo vea y pulse «Siguiente».
      if (outcome.status === 'ACCEPTED') clearTimer.current = setTimeout(() => setShown((current) => (current?.key === counter.current ? null : current)), AUTO_CLEAR_MS);
    },
    [sound]
  );

  /** Lee un pase: con red, lo decide el servidor; sin ella (o si la red falla a mitad), la lista descargada. */
  const check = useCallback(
    async (payload: string, quantity: number | 'ASK') => {
      setBusy(true);
      setProblem(null);
      try {
        if (sync.online) {
          try {
            const result = await scanPassAction(eventId, { payload, quantity });
            if (result.status === 'OK') {
              // Con lecturas aún sin enviar (la red acaba de volver), el aforo las incluye: el servidor todavía no las cuenta.
              setSummary(sync.withQueued(result.summary));
              show(result.outcome, payload, false);
              return;
            }
            if (result.reason === 'NO_SESSION') return setEnded(true);
            // Un código ajeno (un QR de otra cosa, demasiado largo) no es un fallo del servidor: es un «esto no es una entrada» en rojo.
            if (result.reason === 'INVALID_INPUT') return show({ status: 'INVALID_FORMAT' }, payload, false);
            // Con la red saturada la puerta no se para: este pase se valida con la lista descargada (y, si entra, espera en la cola).
            if (result.reason !== 'BUSY') {
              setProblem('FAILED');
              return;
            }
          } catch {
            // La red falló a mitad: este pase se valida contra la lista, y el móvil queda «sin conexión» hasta que vuelva.
            sync.setOnline(false);
          }
        }
        const outcome = await sync.decide(payload, quantity);
        if (outcome.status === 'ACCEPTED') {
          const queued = sync.enqueue({ clientScanId: newClientScanId(), payload, quantity: outcome.entered, scannedAt: Date.now(), serial: outcome.serial });
          if (!queued) return setProblem('QUEUE_FULL');
          setSummary((current) => ({ ...current, checkedIn: current.checkedIn + outcome.entered }));
        }
        show(outcome, payload, true);
      } finally {
        setBusy(false);
      }
    },
    [eventId, show, sync]
  );

  const { videoRef, status: cameraStatus, start: startCamera, stop: stopCamera, forget: forgetLastCode } = useQrReader(
    useCallback((value: string) => void check(value, 'ASK'), [check]),
    busy || shown !== null || ended
  );

  /** Tras un veredicto el foco vuelve al lector: a la cámara si está encendida (sin abrir el teclado del móvil) y al campo del código si no. */
  useEffect(() => {
    if (shown !== null) {
      hadResult.current = true;
      return;
    }
    if (!hadResult.current) return;
    hadResult.current = false;
    (cameraStatus === 'scanning' ? stopRef.current : formRef.current?.querySelector('input'))?.focus();
  }, [shown, cameraStatus]);

  // Al pedir confirmación para salir, el foco pasa a ella; al cancelar, vuelve al botón que la abrió.
  useEffect(() => {
    if (confirmLeave) confirmRef.current?.querySelector('button')?.focus();
  }, [confirmLeave]);

  const next = () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setShown(null);
    setProblem(null);
    forgetLastCode();
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    // El botón no se desactiva (al vaciar el campo el foco caería a la página): un envío vacío o con otra comprobación en curso simplemente no hace nada.
    if (!value || busy) return;
    setCode('');
    unlockGateAudio();
    void check(value, 'ASK');
  };

  /** Salir de la portería de este móvil: borra también lo guardado (lista y lecturas sin enviar). */
  const leave = async () => {
    clearGateState(eventId);
    await leaveGateAction().catch(() => undefined);
    router.refresh();
  };

  /** La sesión ya no vale: se cierra la cookie, pero **las lecturas sin enviar se conservan** en este móvil y se envían al entrar de nuevo con el PIN. */
  const reenter = async () => {
    await leaveGateAction().catch(() => undefined);
    router.refresh();
  };

  if (ended) {
    return (
      <section className="flex flex-col gap-4 rounded-2xl bg-varsity-ivory p-5 text-ink" role="alert" data-testid="gate-ended">
        <h2 className="font-corp text-xl font-extrabold text-varsity-navy">{t('ended.title')}</h2>
        <p>{t('ended.text')}</p>
        {sync.pending > 0 ? (
          <p className="font-bold" data-testid="gate-ended-pending">
            {t('ended.pending', { count: sync.pending })}
          </p>
        ) : null}
        <button type="button" className={primaryButton} onClick={() => void reenter()}>
          {t('ended.again')}
        </button>
      </section>
    );
  }

  const cameraMessage = cameraStatus === 'denied' ? t('camera.denied') : cameraStatus === 'unsupported' ? t('camera.unsupported') : cameraStatus === 'error' ? t('camera.error') : null;
  const listTime = sync.list ? format.dateTime(new Date(sync.list.generatedAt), { hour: '2-digit', minute: '2-digit' }) : null;
  const full = summary.capacity > 0 && summary.checkedIn >= summary.capacity;

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="gate-capacity" className="flex flex-col gap-1 rounded-2xl bg-varsity-ivory p-5 text-ink">
        <h2 id="gate-capacity" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('capacityTitle')}
        </h2>
        <p className="font-corp text-3xl font-extrabold tabular-nums text-varsity-emerald" data-testid="gate-capacity">
          <span aria-hidden="true">{full ? '🔵 ' : '🟢 '}</span>
          {t('capacity', { checkedIn: summary.checkedIn, capacity: summary.capacity })}
        </p>
        {full ? <p className="text-sm font-bold text-varsity-navy">{t('capacityFull')}</p> : null}
      </section>

      {sync.conflicts.length > 0 ? (
        <section aria-labelledby="gate-conflicts" role="alert" className="flex flex-col gap-2 rounded-2xl bg-red-700 p-5 text-white" data-testid="gate-conflicts">
          <h2 id="gate-conflicts" className="font-corp text-xl font-extrabold">
            {t('conflicts.title')}
          </h2>
          <p>{t('conflicts.intro')}</p>
          <ul className="flex list-disc flex-col gap-1 ps-5">
            {sync.conflicts.map((conflict) => (
              <li key={conflict.clientScanId}>{t('conflicts.item', { serial: conflict.serial, verdict: t(`result.${outcomeKey(conflict.outcome)}`) })}</li>
            ))}
          </ul>
          <button type="button" className="min-h-11 rounded-xl border-2 border-white px-4 font-bold" onClick={sync.dismissConflicts}>
            {t('conflicts.dismiss')}
          </button>
        </section>
      ) : null}

      {!sync.online ? (
        <p role="status" className="rounded-2xl bg-varsity-gold p-4 font-bold text-varsity-navy" data-testid="gate-offline">
          <span aria-hidden="true">{'📴 '}</span>
          {t('offline.banner')}
        </p>
      ) : null}
      {sync.pending > 0 ? (
        <p role="status" className="rounded-2xl bg-varsity-ivory p-3 text-sm font-semibold text-ink" data-testid="gate-pending">
          {t('offline.pending', { count: sync.pending })}
          {sync.syncing ? ` · ${t('offline.syncing')}` : ''}
        </p>
      ) : null}
      {!sync.storageOk ? (
        <p role="alert" className="rounded-2xl bg-red-700 p-3 text-sm font-bold text-white">
          {t('offline.storageBlocked')}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="rounded-2xl bg-red-700 p-3 font-bold text-white" data-testid="gate-problem">
          {t(`problem.${problem}`)}
        </p>
      ) : null}

      {shown ? <GateResultPanel key={shown.key} outcome={shown.outcome} serial={shown.serial} offline={shown.offline} onNext={next} onChoose={(people) => void check(shown.payload, people)} /> : null}

      <section aria-labelledby="gate-camera" className="flex flex-col gap-3 rounded-2xl bg-varsity-ivory p-5 text-ink">
        <h2 id="gate-camera" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('camera.title')}
        </h2>
        <div className="aspect-4/3 w-full overflow-hidden rounded-xl bg-varsity-navy-deep" hidden={cameraStatus !== 'scanning'}>
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" aria-label={t('camera.videoLabel')} />
        </div>
        {cameraStatus === 'scanning' ? <p className="text-sm text-ink-soft">{t('camera.hint')}</p> : null}
        {cameraMessage ? (
          <p role="status" className="text-sm font-semibold">
            {cameraMessage}
          </p>
        ) : null}
        {cameraStatus !== 'scanning' ? (
          <button
            type="button"
            className={primaryButton}
            disabled={cameraStatus === 'starting'}
            onClick={() => {
              unlockGateAudio();
              void startCamera();
            }}
            data-testid="gate-camera-start"
          >
            {cameraStatus === 'starting' ? t('camera.starting') : t('camera.start')}
          </button>
        ) : (
          <button ref={stopRef} type="button" className={secondaryButton} onClick={stopCamera}>
            {t('camera.stop')}
          </button>
        )}
      </section>

      <form ref={formRef} onSubmit={submitCode} className="flex flex-col gap-3 rounded-2xl bg-varsity-ivory p-5 text-ink">
        <p className="text-sm text-ink-soft">{t('manual.hint')}</p>
        <Field label={t('manual.label')} value={code} onChange={(event) => setCode(event.target.value)} inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={200} />
        <button type="submit" className={secondaryButton} aria-disabled={busy} data-testid="gate-manual-submit">
          {t('manual.submit')}
        </button>
      </form>

      <section className="flex flex-col gap-2 rounded-2xl bg-varsity-ivory p-5 text-sm text-ink">
        <p data-testid="gate-list-info">{sync.list && listTime ? t('list.info', { count: sync.list.passes.length, time: listTime }) : t('list.missing')}</p>
        <label className="flex min-h-11 items-center gap-3 font-semibold">
          <input type="checkbox" className="size-5" checked={sound} onChange={(event) => setSound(event.target.checked)} />
          {t('sound')}
        </label>
        {confirmLeave && sync.pending > 0 ? (
          <div ref={confirmRef} role="alert" className="flex flex-col gap-2 rounded-xl border-2 border-red-700 p-3">
            <p className="font-bold">{t('leave.warning', { count: sync.pending })}</p>
            {/* Lo seguro (no salir) es lo destacado y lo primero; lo que destruye datos, secundario. */}
            <button
              type="button"
              className={primaryButton}
              onClick={() => {
                setConfirmLeave(false);
                setTimeout(() => leaveRef.current?.focus(), 0);
              }}
            >
              {t('leave.cancel')}
            </button>
            <button type="button" className={clsx(secondaryButton, 'border-red-700 text-red-800')} onClick={() => void leave()}>
              {t('leave.confirm')}
            </button>
          </div>
        ) : (
          <button ref={leaveRef} type="button" className={secondaryButton} onClick={() => (sync.pending > 0 ? setConfirmLeave(true) : void leave())} data-testid="gate-leave">
            {t('leave.button')}
          </button>
        )}
      </section>
    </div>
  );
}
