'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, useTransition } from 'react';
import { executeSelfBoostAction, fixTariffAction, type BoostActionResult, type FixActionResult } from '@/app/[locale]/(superadmin)/admin/actions';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { isLocale, type Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { InitiativePopupView } from '@/services/admin/initiative-popup';

const BUTTON = 'min-h-11 rounded-xl px-4 font-bold disabled:opacity-60';
const PRIMARY = `${BUTTON} bg-varsity-navy text-white hover:bg-varsity-navy-deep`;
const OUTLINE = `${BUTTON} border-2 border-varsity-navy text-varsity-navy hover:bg-varsity-navy/5`;

/** Resultado que no es «hecho»: lo dice con texto; si caducó el segundo factor, enlaza a pasarlo otra vez. */
function ActionProblem({ status, scope }: { status: string | null; scope: 'boost' | 'fix' }) {
  const t = useTranslations('admin.popup');
  const locale = useLocale() as Locale;
  if (status === null) return null;
  return (
    <p role="alert" className="text-sm font-semibold text-red-900" data-testid="popup-problem">
      {t(`${scope}.problem.${status}`)}
      {status === 'REAUTH_REQUIRED' ? (
        <>
          {' '}
          <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin') } }} className="inline-flex min-h-11 items-center underline">
            {t('reauthLink')}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/**
 * Auto-Impulso con la decisión de visibilidad (`executeSuperAdminSelfBoost`): KORUM aporta lo que falta y completa la meta. Dos pasos (elegir y
 * confirmar) porque gasta dinero de KORUM; la cifra confirmada es la que se vio, y si cambió el servidor no ejecuta nada. Si a KORUM no le compensa (casilla de
 * aceptar la pérdida), salta además un segundo mensaje de confirmación que dice lo que se pierde (decisión del promotor, 2026-11-12).
 */
export function SelfBoostPanel({ view, onDone, onStale }: { view: InitiativePopupView; onDone: (message: string) => void; onStale: () => void }) {
  const t = useTranslations('admin.popup.boost');
  const tp = useTranslations('admin.popup');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const groupId = useId();
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const [disclosure, setDisclosure] = useState<'SHOW' | 'HIDE'>(view.boost.defaultDisclosure);
  const [confirming, setConfirming] = useState(false);
  const [acceptLoss, setAcceptLoss] = useState(false);
  const [lossAsked, setLossAsked] = useState(false);
  const losing = !view.row.isProfitableSelfBoost;
  const lossCents = Math.max(0, -view.row.netProfitAfterBoostCents);
  const lossTitle = useRef<HTMLParagraphElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const amount = formatCents(view.boost.availableCents, locale);

  const backFromLoss = () => {
    setConfirming(false);
    setLossAsked(false);
    requestAnimationFrame(() => startButton.current?.focus());
  };

  const run = () =>
    startTransition(async () => {
      setProblem(null);
      let outcome: BoostActionResult;
      try {
        outcome = await executeSelfBoostAction({ initiativeId: view.row.id, expectedAmountCents: view.boost.availableCents, publiclyDisclosed: disclosure === 'SHOW', ...(losing ? { acceptLoss } : {}) });
      } catch {
        setProblem('FAILED');
        return;
      }
      if (outcome.status === 'DONE') {
        // La confirmación se cierra al instante: hasta que llega la recarga no puede pulsarse otra vez.
        setConfirming(false);
        setLossAsked(false);
        onDone(t('done', { amount: formatCents(outcome.amountCents, locale) }));
        return;
      }
      setConfirming(false);
      setLossAsked(false);
      setProblem(outcome.status);
      // La cifra que se vio ya no vale (llegó otra aportación o la campaña cambió): se recarga la ficha para enseñar la nueva.
      if (outcome.status === 'AMOUNT_CHANGED' || outcome.status === 'NOT_ALLOWED') onStale();
      // El panel de confirmación desaparece: el foco vuelve al botón que lo abrió.
      requestAnimationFrame(() => startButton.current?.focus());
    });

  return (
    <section aria-labelledby={`${groupId}-title`} className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4 text-emerald-950" data-testid="boost-panel">
      <h3 id={`${groupId}-title`} className="font-corp text-lg font-extrabold">
        <span aria-hidden="true">{'💎 '}</span>
        {losing ? t('title') : t('titleProfitable')}
      </h3>
      <fieldset className="flex flex-col gap-1" disabled={pending || confirming}>
        <legend className="text-sm font-semibold">{t('visibilityLegend')}</legend>
        {(['SHOW', 'HIDE'] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2">
            <input type="radio" name={`${groupId}-visibility`} value={value} checked={disclosure === value} onChange={() => setDisclosure(value)} className="size-5" />
            <span>{t(`visibility.${value}`)}</span>
          </label>
        ))}
        <p className="text-sm">{t('visibilityHint')}</p>
      </fieldset>
      {losing ? (
        <label className="flex min-h-11 items-start gap-2 rounded-xl border-2 border-amber-400 bg-amber-50 p-2 text-amber-950">
          <input type="checkbox" checked={acceptLoss} disabled={pending || confirming} onChange={(event) => setAcceptLoss(event.target.checked)} className="mt-1 size-5" data-testid="boost-accept-loss" />
          <span>{t('acceptLoss', { profit: formatCents(view.row.netProfitAfterBoostCents, locale) })}</span>
        </label>
      ) : null}
      {confirming && lossAsked ? (
        <div
          role="group"
          aria-label={t('lossTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !pending) {
              event.stopPropagation();
              event.preventDefault();
              backFromLoss();
            }
          }}
          className="flex flex-col gap-2 rounded-xl border-2 border-red-700 bg-red-50 p-3 text-red-950"
          data-testid="boost-loss-panel"
        >
          <p ref={lossTitle} tabIndex={-1} className="font-bold outline-offset-2">
            {t('lossTitle')}
          </p>
          <p>{lossCents > 0 ? t('lossText', { amount, loss: formatCents(lossCents, locale) }) : t('lossTextZero', { amount })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={run} disabled={pending} className={`${BUTTON} bg-red-800 text-white hover:bg-red-900`} data-testid="boost-loss-confirm">
              {pending ? t('running') : t('lossConfirm', { amount })}
            </button>
            <button type="button" onClick={backFromLoss} disabled={pending} className={OUTLINE} data-testid="boost-loss-back">
              {t('lossBack')}
            </button>
          </div>
        </div>
      ) : confirming ? (
        <div role="group" aria-label={t('confirmTitle')} className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3 text-ink">
          <p ref={confirmTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
            {t('confirmTitle')}
          </p>
          <p>{t('confirmText', { amount, visibility: tp(`visibilityShort.${disclosure}`) })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (!losing) {
                  run();
                  return;
                }
                setLossAsked(true);
                // El panel se sustituye por el aviso de pérdida: el foco pasa a su título.
                requestAnimationFrame(() => lossTitle.current?.focus());
              }}
              disabled={pending}
              className={PRIMARY}
              data-testid="boost-confirm"
            >
              {pending ? t('running') : t('confirm', { amount })}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => startButton.current?.focus());
              }}
              disabled={pending}
              className={OUTLINE}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={startButton}
          type="button"
          onClick={() => {
            setConfirming(true);
            // El botón se sustituye por la confirmación: el foco pasa a su título para que no caiga al documento.
            requestAnimationFrame(() => confirmTitle.current?.focus());
          }}
          disabled={losing && !acceptLoss}
          className={`${PRIMARY} self-start`}
          data-testid="boost-start"
        >
          {t('start', { amount })}
        </button>
      )}
      <ActionProblem status={problem} scope="boost" />
    </section>
  );
}

/** «Corregir tarifas en 1 clic»: solo lo que no se prometió (decisión del promotor, 2026-11-11). */
export function TariffFixPanel({ view, onDone }: { view: InitiativePopupView; onDone: (message: string) => void }) {
  const t = useTranslations('admin.popup.fix');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fix = view.fix;
  if (!fix) return null;

  const run = () =>
    startTransition(async () => {
      setProblem(null);
      let outcome: FixActionResult;
      try {
        outcome = await fixTariffAction({ initiativeId: view.row.id });
      } catch {
        setProblem('FAILED');
        return;
      }
      if (outcome.status === 'FIXED') {
        onDone(t('done'));
        return;
      }
      setProblem(outcome.status);
    });

  return (
    <div className="flex flex-col gap-2" data-testid="fix-panel">
      {fix.available ? (
        <button type="button" onClick={run} disabled={pending} className={`${PRIMARY} self-start`} data-testid="fix-tariff">
          {pending ? t('running') : t('button')}
        </button>
      ) : null}
      <p className="text-sm">{fix.available ? t('explainAvailable') : fix.publishedLeftUntouched ? t('explainPublished') : t('explainNothing')}</p>
      {fix.available && fix.publishedLeftUntouched ? <p className="text-sm">{t('explainPublished')}</p> : null}
      <ActionProblem status={problem} scope="fix" />
    </div>
  );
}
