'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { loadInitiativePopupAction } from '@/app/[locale]/(superadmin)/admin/actions';
import { CurrencyText } from '@/components/ui/currency-text';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatCents } from '@/core/finance/money';
import { useRouter } from '@/i18n/navigation';
import { isLocale, type Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { InitiativePopupView } from '@/services/admin/initiative-popup';
import { SelfBoostPanel, TariffFixPanel } from './popup-actions';

const DATE = { dateStyle: 'medium', timeZone: 'Europe/Madrid' } as const;

type Load = { state: 'loading' } | { state: 'error'; reason: 'NOT_FOUND' | 'FORBIDDEN' | 'FAILED' } | { state: 'ready'; view: InitiativePopupView };

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-bold tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * Ficha ejecutiva de una iniciativa (`sa-init-popup-modal`, Sprint 5.2). Diálogo nativo: atrapa el foco, se cierra con Escape y devuelve el foco a
 * la fila que lo abrió. Pide sus datos al abrirse (la misma fila del BI que la tabla: las cifras no pueden diferir) y, tras una acción, los recarga.
 */
export function InitiativePopup({ initiativeId, onClose }: { initiativeId: number | null; onClose: () => void }) {
  const t = useTranslations('admin.popup');
  const format = useFormatter();
  const current = useLocale();
  const locale: Locale = isLocale(current) ? current : 'es';
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (initiativeId !== null && !node.open) node.showModal();
    if (initiativeId === null && node.open) node.close();
  }, [initiativeId]);

  useEffect(() => {
    if (initiativeId === null) return;
    let cancelled = false;
    loadInitiativePopupAction({ initiativeId })
      .then((result) => {
        if (cancelled) return;
        setLoad(result.status === 'OK' ? { state: 'ready', view: result.view } : { state: 'error', reason: result.status === 'FORBIDDEN' ? 'FORBIDDEN' : 'NOT_FOUND' });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'error', reason: 'FAILED' });
      });
    return () => {
      cancelled = true;
    };
  }, [initiativeId, reload]);

  // Tras una acción el panel desaparece y el aviso de éxito vive **dentro** del diálogo (un aviso global quedaría tapado por el fondo modal y no se anunciaría).
  const afterAction = useCallback(
    (message: string) => {
      setNotice(message);
      setReload((value) => value + 1);
      router.refresh();
      requestAnimationFrame(() => noticeRef.current?.focus());
    },
    [router]
  );

  const view = load.state === 'ready' ? load.view : null;
  const publicUrl = view ? `${window.location.origin}${localizedPath(locale, view.publicPath)}` : '';

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      onClose={() => {
        setLoad({ state: 'loading' });
        setCopied(null);
        setNotice(null);
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-3xl bg-white p-0 text-ink shadow-2xl backdrop:bg-varsity-navy-deep/70"
      data-testid="initiative-popup"
    >
      {initiativeId !== null ? (
        <div className="flex flex-col gap-4 p-5 md:p-6">
          <div className="flex items-start justify-between gap-3 border-b-2 border-patio-rule pb-3">
            <div>
              <p className="inline-block rounded-full bg-varsity-navy px-3 py-0.5 text-xs font-extrabold uppercase text-amber-300">{t('badge')}</p>
              <h2 id={headingId} className="font-corp mt-1 text-xl font-bold text-varsity-navy">
                {view ? view.row.title : t('genericTitle')}
              </h2>
            </div>
            <button type="button" onClick={() => dialog.current?.close()} aria-label={t('close')} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xl font-bold text-ink-soft hover:bg-patio-rule">
              <span aria-hidden="true">{'✕'}</span>
            </button>
          </div>

          {load.state === 'loading' ? <p role="status">{t('loading')}</p> : null}
          {load.state === 'error' ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="font-semibold text-red-900">
                {t(`error.${load.reason}`)}
              </p>
              {load.reason !== 'FORBIDDEN' ? (
                <button
                  type="button"
                  onClick={() => {
                    setLoad({ state: 'loading' });
                    setReload((value) => value + 1);
                  }}
                  className="min-h-11 w-fit rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy hover:bg-varsity-navy/5"
                >
                  {t('retry')}
                </button>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <p ref={noticeRef} tabIndex={-1} role="status" className="rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-3 font-bold text-emerald-950" data-testid="popup-notice">
              <span aria-hidden="true">{'✅ '}</span>
              {notice}
            </p>
          ) : null}

          {view ? (
            <>
              <dl className="flex flex-col gap-1.5 rounded-2xl border-2 border-patio-rule bg-patio-soft p-4 text-sm" data-testid="popup-summary">
                <Line label={t('organization')}>{`${view.row.organizationName} (${view.row.province})`}</Line>
                <Line label={t('format')}>{t(`formats.${view.row.format}`)}</Line>
                <Line label={t('wallet')}>
                  <span className="font-mono">{view.row.walletEscrowId}</span> <StatusBadge status={view.row.status} />
                </Line>
                <Line label={t('progress')}>
                  <CurrencyText cents={view.row.raisedCents} />
                  {' / '}
                  <CurrencyText cents={view.row.goalCents} />
                  {` (${t('percent', { value: view.row.progressPct })})`}
                </Line>
                <Line label={t('contributions')}>
                  <span aria-hidden="true">{'💛 '}</span>
                  {t('contributionsCount', { count: view.row.totalContributions })}
                </Line>
                <Line label={t('closesAt')}>{format.dateTime(new Date(view.row.closesAt), DATE)}</Line>
              </dl>

              <div className="flex flex-col gap-2 rounded-2xl border-2 border-patio-rule p-3" data-testid="popup-link">
                <p className="text-sm font-semibold text-ink-soft">{t('publicLink')}</p>
                <p className="break-all font-mono text-sm text-sky-900">{publicUrl}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={copyLink} className="min-h-11 rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy hover:bg-varsity-navy/5">
                    <span aria-hidden="true">{'📋 '}</span>
                    {t('copy')}
                  </button>
                  <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-xl bg-varsity-navy px-4 font-bold text-white hover:bg-varsity-navy-deep">
                    {t('openPublic')}
                    <span className="sr-only"> {t('newTab')}</span>
                  </a>
                </div>
                <p role="status" className="text-sm font-semibold text-varsity-emerald">
                  {copied === 'ok' ? t('copied') : copied === 'failed' ? t('copyFailed') : ''}
                </p>
              </div>

              <section aria-labelledby={`${headingId}-sponsors`} className="flex flex-col gap-2 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4" data-testid="popup-sponsors">
                <h3 id={`${headingId}-sponsors`} className="font-corp text-base font-extrabold text-amber-950">
                  <span aria-hidden="true">{'🏪 '}</span>
                  {t('sponsorsTitle', { count: view.sponsors.length })}
                </h3>
                {view.sponsors.length === 0 ? (
                  <p className="text-sm text-ink-soft">{t('sponsorsNone')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {view.sponsors.map((sponsor) => (
                      <li key={sponsor.id} className="flex flex-wrap justify-between gap-x-3 rounded-xl border border-amber-200 bg-white p-2 text-sm">
                        <span>
                          <strong>{sponsor.name}</strong>
                          {` · ${t(`level.${sponsor.categoryLevel}`)} · ${t(`sponsorStatus.${sponsor.status}`)}`}
                          {sponsor.isMatchingPool ? ` · ${t('matching')}` : ''}
                        </span>
                        <span className="font-bold tabular-nums text-varsity-emerald">{t('sponsorAmount', { amount: formatCents(sponsor.amountCents, locale), fee: formatCents(sponsor.feeCents, locale) })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {view.row.isNegativeReturnAlert ? (
                <section aria-labelledby={`${headingId}-negative`} className="flex flex-col gap-2 rounded-2xl border-2 border-red-700 bg-red-50 p-4 text-red-950" data-testid="popup-negative">
                  <h3 id={`${headingId}-negative`} className="font-corp text-base font-extrabold">
                    <span aria-hidden="true">{'🚨 '}</span>
                    {t('negativeTitle', { net: formatCents(view.row.netRevenueCents, locale) })}
                  </h3>
                  <p className="text-sm" data-testid="popup-negative-text">
                    {t(view.row.sunkCostsCents > 0 ? (view.row.gatewayLossCents > 0 ? 'negativeTextBoth' : 'negativeTextSunk') : 'negativeText', { loss: formatCents(view.row.gatewayLossCents, locale), sunk: formatCents(view.row.sunkCostsCents, locale) })}
                  </p>
                  {/* Subir tarifas no arregla lo ya gastado en un Auto-Impulso o un contracargo: solo se ofrece si, sin ese gasto, el neto seguiría siendo negativo. */}
                  {view.row.netRevenueCents + view.row.sunkCostsCents < 0 ? <TariffFixPanel view={view} onDone={afterAction} /> : null}
                </section>
              ) : (
                <section aria-labelledby={`${headingId}-analysis`} className="flex flex-col gap-2 rounded-2xl border-2 border-patio-rule p-4" data-testid="popup-analysis">
                  <h3 id={`${headingId}-analysis`} className="font-corp text-base font-extrabold text-varsity-navy">
                    {view.row.isProfitableSelfBoost ? t('analysisProfitable') : t('analysisTitle')}
                  </h3>
                  <dl className="flex flex-col gap-1 text-sm">
                    <Line label={t('missing')}>
                      <CurrencyText cents={view.row.missingTo100Cents} />
                    </Line>
                    <Line label={t('netAt100')}>
                      <CurrencyText cents={view.row.netRevenueCents} />
                    </Line>
                    {view.row.status === 'FUNDRAISING' ? (
                      <Line label={t('returnAfterBoost')}>
                        <span className={view.row.netProfitAfterBoostCents < 0 ? 'text-red-800' : 'text-varsity-emerald'}>
                          <CurrencyText cents={view.row.netProfitAfterBoostCents} />
                        </span>
                      </Line>
                    ) : null}
                  </dl>
                  {view.row.status === 'FUNDRAISING' ? <p className="text-xs text-ink-soft">{t('returnHint')}</p> : null}
                  {view.row.status === 'FUNDRAISING' && view.row.recoverableSelfBoostCents > 0 ? (
                    <p className="text-sm" data-testid="popup-recoverable-boost">
                      {t('recoverableNote', { amount: formatCents(view.row.recoverableSelfBoostCents, locale) })}
                    </p>
                  ) : null}
                </section>
              )}

              {/* Con retorno negativo no se ofrece aportar (como en el prototipo): primero se corrigen las tarifas. */}
              {view.boost.availableCents > 0 && !view.row.isNegativeReturnAlert ? <SelfBoostPanel key={`${view.row.id}-${view.row.raisedCents}`} view={view} onDone={afterAction} onStale={() => setReload((value) => value + 1)} /> : null}

              {view.boost.previous.length > 0 ? (
                <section aria-labelledby={`${headingId}-previous`} className="flex flex-col gap-1 text-sm" data-testid="popup-previous-boosts">
                  <h3 id={`${headingId}-previous`} className="font-corp text-base font-extrabold text-varsity-navy">
                    {t('previousTitle')}
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {view.boost.previous.map((boost) => (
                      <li key={boost.createdAt}>
                        {t('previousItem', { amount: formatCents(boost.amountCents, locale), date: format.dateTime(new Date(boost.createdAt), DATE), visibility: t(`visibilityShort.${boost.publiclyDisclosed ? 'SHOW' : 'HIDE'}`) })}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
