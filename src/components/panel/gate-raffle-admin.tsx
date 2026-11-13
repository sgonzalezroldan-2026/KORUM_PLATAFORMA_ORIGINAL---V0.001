'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { downloadRaffleActAction, drawExtraRoundAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/taquilla/actions';
import { FormAlert, primaryButton, SelectField, secondaryButton } from '@/components/auth/auth-ui';
import { downloadJson } from '@/components/gate/download-json';
import type { ExtraRoundReason } from '@/core/ticketing/raffle-extra';
import { useRouter } from '@/i18n/navigation';
import type { GateEventView } from '@/repositories/gate-admin.repository';

/**
 * Sorteo y rondas extra de una rifa en «Taquilla y portería» (Sprints 4.6 y 4.7). Las rondas hechas con sus números y su acta, y la **ronda extra**: sustituir **una
 * papeleta ganadora concreta, de una en una** cuyo premio nadie reclama (pasado el plazo mínimo que fije la plataforma) o que se reembolsó. Lo que se sustituye consta en el acta y en
 * el aviso a la otra persona firmante, que así puede comprobarlo. La hace una sola persona firmante (sin doble firma; la otra recibe un aviso **si la hay**) y solo se
 * ofrece lo que el motor permite. La clave de idempotencia se genera al preparar la ronda y se conserva si falla la red: reintentar nunca sortea dos veces. La
 * confirmación es un diálogo de alerta con el foco en su título (no en el botón que sortea).
 */

const newKey = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `extra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const label = (number: number) => `#${String(number).padStart(4, '0')}`;
const BLOCK_TEXT: Record<string, string> = { PRIZES_EXHAUSTED: 'prizesExhausted', EXTRA_NOT_JUSTIFIED: 'notJustified', NOT_ENOUGH_ENTRIES: 'notEnough', KEY_REUSED: 'keyReused', REPLACED_INVALID: 'replacedInvalid', EXTRA_TOO_SOON: 'tooSoon' };

export function GateRaffleAdmin({ orgSlug, event, canAct }: { orgSlug: string; event: GateEventView; canAct: boolean }) {
  const t = useTranslations('panel.gate.raffle');
  const format = useFormatter();
  const router = useRouter();
  const raffle = event.raffle;
  // Cada papeleta tiene su plazo desde la ronda en la que ganó (el reembolso no espera): `limits` solo cuenta las que ya se pueden sustituir.
  const available = (['PRIZE_UNCLAIMED', 'WINNER_REFUNDED'] as const).filter((reason) => (raffle?.limits[reason] ?? 0) > 0);
  const [chosen, setChosen] = useState<ExtraRoundReason>('PRIZE_UNCLAIMED');
  const reason = available.includes(chosen) ? chosen : (available[0] ?? 'PRIZE_UNCLAIMED');
  const candidates = (raffle?.replaceable ?? []).filter((winner) => (reason === 'PRIZE_UNCLAIMED' ? winner.waitUntil === null : winner.refunded));
  // Una papeleta por ronda: queda claro qué sustituye a qué (y si los premios valen distinto, cuál era).
  const [selected, setSelected] = useState<number | null>(null);
  const picked = selected !== null && candidates.some((winner) => winner.number === selected) ? [selected] : [];
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ round: number; numbers: number[]; replaced: number[]; notified: number } | null>(null);
  const keyRef = useRef(newKey());
  const prepareRef = useRef<HTMLButtonElement | null>(null);
  const confirmTitleRef = useRef<HTMLParagraphElement | null>(null);
  const doneRef = useRef<HTMLParagraphElement | null>(null);

  // Al pedir confirmación el foco pasa al título del diálogo, no a «Sí, sortear»: la acción no se puede deshacer y un doble Enter no debe sortear sin leerla.
  useEffect(() => {
    if (confirming) confirmTitleRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const reasonText = (value: string) => t(`reason.${value}`);
  const waitText = raffle?.waitUntil ? t('noneWaiting', { date: format.dateTime(new Date(raffle.waitUntil), { dateStyle: 'long', timeStyle: 'short' }) }) : null;


  const draw = async () => {
    setBusy(true);
    setProblem(null);
    // Un corte de red no es «sin permiso»: la clave se conserva y reintentar devuelve la misma ronda si el servidor llegó a hacerla.
    const result = await drawExtraRoundAction(orgSlug, event.id, { reason, replacesNumbers: picked, idempotencyKey: keyRef.current }).catch(() => ({ status: 'ERROR', reason: 'NETWORK' }) as const);
    setBusy(false);
    setConfirming(false);
    if (result.status === 'OK') {
      setDone({ round: result.round, numbers: result.numbers, replaced: picked, notified: result.notified });
      setSelected(null);
      keyRef.current = newKey();
      router.refresh();
    } else {
      setProblem(result.status === 'BLOCKED' ? t(`blocked.${BLOCK_TEXT[result.reason] ?? 'other'}`) : t(`errors.${result.reason}`));
      setTimeout(() => prepareRef.current?.focus(), 0);
    }
  };

  const download = async (round: number) => {
    const result = await downloadRaffleActAction(orgSlug, event.id, round).catch(() => null);
    if (result?.status === 'OK') downloadJson(`acta-sorteo-ronda-${round}.json`, result.act);
    else setProblem(t(result ? `errors.${result.reason}` : 'errors.DOWNLOAD'));
  };

  const nothingToReplace = raffle !== null && available.length === 0 ? (raffle.entriesLeft === 0 ? 'noneNoEntries' : raffle.waitUntil !== null ? 'noneWaiting' : 'noneAllReplaced') : null;

  return (
    <section aria-labelledby={`raffle-admin-${event.id}`} className="flex flex-col gap-3 rounded-xl border-2 border-stone-200 p-4" data-testid="gate-raffle-admin">
      <h4 id={`raffle-admin-${event.id}`} className="font-corp text-base font-extrabold text-varsity-navy">
        {t('title')}
      </h4>
      {raffle === null ? (
        <p className="text-sm text-ink-soft">{t('notDrawn')}</p>
      ) : (
        <>
          <p className="text-sm font-semibold" data-testid="gate-raffle-summary">
            {t('summary', { drawn: raffle.drawnPrizes, prizes: raffle.prizeCount, extra: raffle.extraDrawn })}
          </p>
          <ul className="flex flex-col gap-2" data-testid="gate-raffle-rounds">
            {raffle.rounds.map((round) => (
              <li key={round.round} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-stone-200 p-3">
                <span className="text-sm">
                  <strong>{round.reason ? t('roundExtra', { round: round.round, reason: reasonText(round.reason) }) : t('round', { round: round.round })}</strong>
                  {`: ${round.numbers.map(label).join(', ')}${round.replaced.length > 0 ? ` · ${t('replacesText', { replaced: round.replaced.map(label).join(', ') })}` : ''} · ${format.dateTime(new Date(round.drawnAt), { dateStyle: 'short', timeStyle: 'short' })}`}
                </span>
                <button type="button" className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-3 text-sm font-bold text-varsity-navy hover:bg-varsity-navy/10" aria-label={t('downloadLabel', { round: round.round })} onClick={() => void download(round.round)}>
                  {t('download')}
                </button>
              </li>
            ))}
          </ul>

          <h5 className="font-corp text-sm font-extrabold text-varsity-navy">{t('extraTitle')}</h5>
          <p className="text-sm text-ink-soft">{t('extraIntro')}</p>
          {done ? (
            <p ref={doneRef} tabIndex={-1} role="status" className="rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-3 font-semibold text-emerald-950" data-testid="gate-raffle-done">
              {t(done.notified > 0 ? 'done' : 'doneAlone', { round: done.round, numbers: done.numbers.map(label).join(', '), replaced: done.replaced.map(label).join(', ') })}
            </p>
          ) : null}
          {problem ? <FormAlert>{problem}</FormAlert> : null}
          {!canAct ? (
            <p className="text-sm text-ink-soft">{t('readOnly')}</p>
          ) : nothingToReplace ? (
            <p className="text-sm text-ink-soft" data-testid="gate-raffle-none">
              {nothingToReplace === 'noneWaiting' ? waitText : t(nothingToReplace)}
            </p>
          ) : confirming ? (
            <div role="alertdialog" aria-labelledby={`raffle-confirm-title-${event.id}`} aria-describedby={`raffle-confirm-body-${event.id}`} className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy p-3" data-testid="gate-raffle-confirm">
              <p id={`raffle-confirm-title-${event.id}`} ref={confirmTitleRef} tabIndex={-1} className="font-bold outline-none">
                {t('confirmTitle', { replaced: picked.map(label).join(', ') })}
              </p>
              <p id={`raffle-confirm-body-${event.id}`} className="text-sm">
                {t('confirmBody', { reason: reasonText(reason), replaced: picked.map(label).join(', ') })}
              </p>
              <button type="button" className={primaryButton} disabled={busy} onClick={() => void draw()} data-testid="gate-raffle-confirm-yes">
                {busy ? t('drawing') : t('confirmYes')}
              </button>
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setTimeout(() => prepareRef.current?.focus(), 0);
                }}
              >
                {t('confirmNo')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {raffle.waitUntil !== null && waitText ? <p className="text-sm text-ink-soft">{waitText}</p> : null}
              <SelectField label={t('reasonLabel')} value={reason} onChange={(change) => setChosen(change.target.value as ExtraRoundReason)} options={available.map((value) => ({ value, label: t('reasonOption', { reason: capitalize(reasonText(value)), max: raffle.limits[value] }) }))} />
              <fieldset className="flex flex-col gap-2" data-testid="gate-raffle-replace">
                <legend className="font-bold text-varsity-navy">{t('replaceLegend')}</legend>
                <p className="text-sm text-ink-soft">{t(reason === 'WINNER_REFUNDED' ? 'replaceHintRefunded' : 'replaceHint')}</p>
                <ul className="flex flex-wrap gap-2">
                  {candidates.map((winner) => (
                    <li key={winner.number}>
                      <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-varsity-navy px-3 font-corp font-extrabold tabular-nums text-varsity-navy has-checked:bg-varsity-navy has-checked:text-varsity-ivory">
                        <input
                          type="radio"
                          name={`replace-${event.id}`}
                          className="size-5"
                          checked={picked.includes(winner.number)}
                          onChange={() => {
                            setProblem(null);
                            setSelected(winner.number);
                          }}
                        />
                        {label(winner.number)}
                        {winner.refunded ? <span className="text-xs font-semibold">{`(${t('refundedTag')})`}</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <button
                ref={prepareRef}
                type="button"
                className={primaryButton}
                onClick={() => {
                  setDone(null);
                  if (picked.length === 0) return setProblem(t('selectNone'));
                  setProblem(null);
                  setConfirming(true);
                }}
                data-testid="gate-raffle-prepare"
              >
                {t('prepare')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
