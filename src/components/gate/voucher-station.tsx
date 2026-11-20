'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { leaveGateAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/actions';
import { lookupVoucherAction, redeemVoucherAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/voucher-actions';
import { Field, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { useRouter } from '@/i18n/navigation';
import { playGateFeedback, unlockGateAudio } from './gate-feedback';
import { newClientScanId } from './gate-offline-store';
import { useQrReader } from './use-qr-reader';
import { VoucherStationResult, type StationShown } from './voucher-station-result';

/**
 * Puesto de canje de vales (Sprint 5.14c, QA-VAL05). Quien atiende entra con el PIN de la venta, lee el QR de la compra (cámara, código escrito o lector con
 * teclado), ve cuántos vales le quedan y teclea cuántos se gastan; se descuentan del mismo código y el resto sigue en él. **Solo con red**: sin conexión lo dice y no
 * gasta nada (un vale es una cuenta que solo lleva el servidor). Cada gasto lleva su identificador: si la red falla a mitad y se vuelve a pulsar, no se gasta dos
 * veces. Lleva la cuenta de lo gastado en este móvil desde que se abrió. Sin importes ni datos de quien compró.
 */

type Problem = 'OFFLINE' | 'OFFLINE_REDEEM' | 'BUSY' | 'FAILED' | 'FAILED_REDEEM' | 'INVALID_INPUT';

/** Sin red de verdad o un fallo del servidor: no son lo mismo para quien atiende el puesto. */
const failureOf = (redeeming: boolean): Problem => (typeof navigator !== 'undefined' && navigator.onLine === false ? (redeeming ? 'OFFLINE_REDEEM' : 'OFFLINE') : redeeming ? 'FAILED_REDEEM' : 'FAILED');

export function VoucherStation({ saleId, validUntil }: { saleId: number; validUntil: string }) {
  const t = useTranslations('gate.vouchers');
  const format = useFormatter();
  const router = useRouter();
  const [shown, setShown] = useState<StationShown | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [ended, setEnded] = useState(false);
  const [code, setCode] = useState('');
  const [spentHere, setSpentHere] = useState(0);
  const [sound, setSound] = useState(true);
  // Cada resultado nuevo es otro panel (su cantidad empieza en 1 y el foco vuelve a su título).
  const [shownKey, setShownKey] = useState(0);
  const scanIdRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const hadResult = useRef(false);
  const endedRef = useRef<HTMLHeadingElement | null>(null);

  const fail = useCallback((reason: Problem | 'NO_SESSION') => {
    if (reason === 'NO_SESSION') setEnded(true);
    else setProblem(reason);
  }, []);

  /** Lee un QR: el servidor dice cuántos vales le quedan. Sin red no se intenta. Devuelve si hubo respuesta (para no borrar el código tecleado si falló). */
  const lookup = useCallback(
    async (payload: string): Promise<boolean> => {
      setProblem(null);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        fail('OFFLINE');
        return false;
      }
      setBusy(true);
      try {
        const result = await lookupVoucherAction(saleId, { payload });
        if (result.status === 'ERROR') {
          fail(result.reason);
          return false;
        }
        // Un identificador nuevo por cada lectura: si al gastar se corta la red y se vuelve a pulsar, el servidor reconoce el mismo canje.
        scanIdRef.current = newClientScanId();
        setShown({ kind: 'lookup', payload, view: result.result });
        setShownKey((current) => current + 1);
        playGateFeedback(result.result.status === 'OK' ? 'ask' : 'alert', sound);
        return true;
      } catch {
        fail(failureOf(false));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fail, saleId, sound]
  );

  const redeem = async (quantity: number) => {
    if (shown?.kind !== 'lookup' || !scanIdRef.current) return;
    setProblem(null);
    setBusy(true);
    try {
      const result = await redeemVoucherAction(saleId, { payload: shown.payload, quantity, clientScanId: scanIdRef.current });
      if (result.status === 'ERROR') return fail(result.reason);
      const view = result.result;
      if (view.status === 'REDEEMED') setSpentHere((current) => current + view.spent);
      setShown({ kind: 'redeem', view });
      setShownKey((current) => current + 1);
      playGateFeedback(view.status === 'REDEEMED' || (view.status === 'DUPLICATE' && view.accepted) ? 'ok' : 'alert', sound);
    } catch {
      // La red falló a mitad: el mismo identificador se reenvía al volver a pulsar, y el servidor no gasta dos veces.
      fail(failureOf(true));
    } finally {
      setBusy(false);
    }
  };

  const { videoRef, status: cameraStatus, start: startCamera, stop: stopCamera, forget } = useQrReader(
    useCallback((value: string) => void lookup(value), [lookup]),
    busy || shown !== null || ended
  );

  // Tras un resultado el foco vuelve al campo del código (con la cámara encendida, la siguiente lectura llega sola).
  useEffect(() => {
    if (shown !== null) {
      hadResult.current = true;
      return;
    }
    if (!hadResult.current) return;
    hadResult.current = false;
    if (cameraStatus !== 'scanning') formRef.current?.querySelector('input')?.focus();
  }, [shown, cameraStatus]);

  // Al terminar la sesión el botón que tenía el foco desaparece: el foco pasa al aviso.
  useEffect(() => {
    if (ended) endedRef.current?.focus();
  }, [ended]);

  const next = () => {
    setShown(null);
    setProblem(null);
    scanIdRef.current = null;
    forget();
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (!value || busy) return;
    unlockGateAudio();
    // El código (unos 100 caracteres) solo se borra si el servidor respondió: con un fallo de red se puede volver a intentar sin teclearlo.
    void lookup(value).then((answered) => {
      if (answered) setCode('');
    });
  };

  const leave = async () => {
    await leaveGateAction().catch(() => undefined);
    router.refresh();
  };

  if (ended) {
    return (
      <section className="flex flex-col gap-4 rounded-2xl bg-varsity-ivory p-5 text-ink" role="alert" data-testid="voucher-station-ended">
        <h2 ref={endedRef} tabIndex={-1} className="font-corp text-xl font-extrabold text-varsity-navy">
          {t('ended.title')}
        </h2>
        <p>{t('ended.text')}</p>
        <button type="button" className={primaryButton} onClick={() => void leave()}>
          {t('ended.again')}
        </button>
      </section>
    );
  }

  const cameraMessage = cameraStatus === 'denied' ? t('camera.denied') : cameraStatus === 'unsupported' ? t('camera.unsupported') : cameraStatus === 'error' ? t('camera.error') : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1 rounded-2xl bg-varsity-ivory p-5 text-ink" aria-labelledby="voucher-station-info">
        <h2 id="voucher-station-info" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('title')}
        </h2>
        <p className="text-sm">{t('validUntil', { date: format.dateTime(new Date(validUntil), { dateStyle: 'long', timeZone: 'Europe/Madrid' }) })}</p>
        <p className="font-corp text-xl font-extrabold tabular-nums text-varsity-emerald" data-testid="voucher-station-spent">
          {t('spentHere', { count: spentHere })}
        </p>
        <p className="text-sm text-ink-soft">{t('onlineOnly')}</p>
      </section>

      {problem ? (
        <p role="alert" className="rounded-2xl bg-red-700 p-3 font-bold text-white" data-testid="voucher-station-problem">
          {t(`problem.${problem}`)}
        </p>
      ) : null}

      {shown ? <VoucherStationResult key={shownKey} shown={shown} busy={busy} onRedeem={(quantity) => void redeem(quantity)} onNext={next} /> : null}

      <section aria-labelledby="voucher-station-camera" className="flex flex-col gap-3 rounded-2xl bg-varsity-ivory p-5 text-ink" hidden={shown !== null}>
        <h2 id="voucher-station-camera" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('camera.title')}
        </h2>
        <div className="aspect-4/3 w-full overflow-hidden rounded-xl bg-varsity-navy-deep" hidden={cameraStatus !== 'scanning'}>
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" aria-label={t('camera.videoLabel')} />
        </div>
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
            data-testid="voucher-station-camera"
          >
            {cameraStatus === 'starting' ? t('camera.starting') : t('camera.start')}
          </button>
        ) : (
          <button type="button" className={secondaryButton} onClick={stopCamera}>
            {t('camera.stop')}
          </button>
        )}
      </section>

      <form ref={formRef} onSubmit={submitCode} className="flex flex-col gap-3 rounded-2xl bg-varsity-ivory p-5 text-ink" hidden={shown !== null}>
        <p className="text-sm text-ink-soft">{t('manual.hint')}</p>
        <Field label={t('manual.label')} value={code} onChange={(event) => setCode(event.target.value)} inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={200} />
        <button type="submit" className={secondaryButton} aria-disabled={busy} data-testid="voucher-station-manual-submit">
          {t('manual.submit')}
        </button>
      </form>

      <section className="flex flex-col gap-2 rounded-2xl bg-varsity-ivory p-5 text-sm text-ink">
        <label className="flex min-h-11 items-center gap-3 font-semibold">
          <input type="checkbox" className="korum-check" checked={sound} onChange={(event) => setSound(event.target.checked)} />
          {t('sound')}
        </label>
        <button type="button" className={secondaryButton} onClick={() => void leave()} data-testid="voucher-station-leave">
          {t('leave')}
        </button>
      </section>
    </div>
  );
}
