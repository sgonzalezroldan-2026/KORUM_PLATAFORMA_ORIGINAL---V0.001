'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { discardStudioAction, publishStudioAction, saveStudioAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/estudio/actions';
import { FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { formatCents } from '@/core/finance/money';
import { computeStudioBoard, computeTicketingBoard, publishBlockers, saveProblems, storedBudgetBoard, type PublishBlocker, type StudioContext } from '@/core/studio/studio-board';
import type { RewardPreset, StudioDraft } from '@/core/studio/studio-draft';
import { Link, useRouter } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { StudioBoardView } from './studio-board-view';
import { StudioFields, type StudioFieldErrors, type StudioLock } from './studio-fields';

/**
 * Estudio de edición (`sch-sub-studio`, `loadInitiativeIntoStudio`, `recalcStudioTCO`, `saveInitiativeFromStudio`): el formulario a la izquierda y la
 * pizarra TCO a la derecha, recalculada en cada pulsación con las mismas funciones que usa el servidor. Una campaña en `BUDGETING` se edita entera; con la
 * campaña ya recaudando solo se tocan los campos que no mueven dinero, y una cerrada solo se mira. Publicar pide confirmación (no se deshace: reserva cupos y
 * fija presupuesto, precio y fecha) y el servidor vuelve a calcular y comprueba todo; si la meta que se aceptó ya no coincide, no publica. Un borrador se
 * puede descartar (`BUDGETING` → `CANCELLED`).
 */

export interface StoredPricing {
  status: string;
  walletEscrowId: string;
  raisedCents: number;
  goalCents: number;
  maintFeeCents: number;
  defaultExemptAppliedCents: number;
  medalExemptAppliedCents: number;
  bracketRateAppliedBps: number;
  bracketFeeCents: number;
  gatewayFeeCents: number;
}

export interface StudioWorkbenchProps {
  orgSlug: string;
  context: StudioContext;
  initialDraft: StudioDraft;
  lock: StudioLock;
  stored: StoredPricing | null;
  rewardPresets: Record<RewardPreset, string>;
  nowIso: string;
  today: string;
  maxCloseOn: string;
  justPublished: boolean;
}

type Message = { tone: 'error' | 'success' | 'info'; text: string; list?: string[] } | null;

const FIELD_FOR: Partial<Record<PublishBlocker, keyof StudioFieldErrors>> = {
  TITLE_MISSING: 'title',
  INVALID_CATEGORY: 'category',
  STAGE_MISSING: 'stage',
  DESCRIPTION_MISSING: 'description',
  GOAL_ZERO: 'costMat',
  CLOSING_INVALID: 'closesOn',
  CLOSING_PAST: 'closesOn',
  CLOSING_TOO_LATE: 'closesOn',
  TICKET_MAX_ZERO: 'ticketMax',
  TICKET_PRICE_ZERO: 'ticketPrice',
  TICKET_FEE_EXCEEDS_PRICE: 'ticketPrice',
  RAFFLE_PRIZES_EXCEED: 'rafflePrizeCount',
  RAFFLE_PRIZES: 'rafflePrizeCount',
  RAFFLE_NOTICE: 'raffleNotice'
};

const ERROR_KEYS = ['INVALID_INPUT', 'PROBLEMS', 'BLOCKED', 'NOT_EDITABLE', 'STALE_BOARD', 'QUOTA', 'NOT_PUBLISHABLE', 'TOO_MANY_DRAFTS', 'SEMANTIC_LOCK', 'FORBIDDEN'];

/**
 * Aviso de «borrador guardado» de una campaña recién creada. Si Next vuelve a montar el Estudio con la campaña ya en la dirección, el aviso no puede perderse: el
 * nuevo montaje lo recoge si es de su misma campaña. Se descarta en cuanto la persona vuelve a actuar.
 */
let carriedSavedNotice: { initiativeId: number; message: Exclude<Message, null> } | null = null;

export function StudioWorkbench({ orgSlug, context, initialDraft, lock, stored, rewardPresets, nowIso, today, maxCloseOn, justPublished }: StudioWorkbenchProps) {
  const t = useTranslations('panel.studio');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const router = useRouter();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState<'save' | 'publish' | 'discard' | null>(null);
  const [confirming, setConfirming] = useState<'publish' | 'discard' | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [message, setMessage] = useState<Message>(() => (carriedSavedNotice !== null && carriedSavedNotice.initiativeId === initialDraft.initiativeId ? carriedSavedNotice.message : null));
  const confirmRef = useRef<HTMLDivElement>(null);
  const publishedRef = useRef<HTMLDivElement>(null);
  const publishButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  const editable = lock === 'NONE';
  // Al guardar por primera vez, la dirección pasa a apuntar a la campaña y Next vuelve a pedir la página al servidor: el Estudio se monta de nuevo con otra clave
  // y lo que estuviera abierto (una confirmación) desaparece. Hasta que llegue, descartar y publicar esperan; pasados 8 segundos sin que llegue, se liberan.
  const pendingSync = initialDraft.initiativeId === null && draft.initiativeId !== null;
  const [syncGaveUp, setSyncGaveUp] = useState(false);
  const syncing = pendingSync && !syncGaveUp;

  useEffect(() => {
    if (!pendingSync) return undefined;
    const timer = setTimeout(() => setSyncGaveUp(true), 8_000);
    return () => clearTimeout(timer);
  }, [pendingSync]);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (justPublished) publishedRef.current?.focus();
  }, [justPublished]);

  const board = useMemo(() => {
    if (editable || !stored) return computeStudioBoard(context, draft);
    return draft.format === 'TICKETING' ? computeTicketingBoard(context, draft, stored.maintFeeCents) : storedBudgetBoard({ ...stored, costMatCents: draft.costMatCents, costInstCents: draft.costInstCents, contingencyBps: draft.contingencyBps });
  }, [context, draft, editable, stored]);
  const blockers = useMemo(() => (editable ? publishBlockers(context, draft, board, now) : []), [context, draft, board, now, editable]);
  // En vivo solo la fecha (su error se arregla al momento); lo demás, tras el primer intento de guardar o publicar: no se grita a quien aún está escribiendo.
  const live = useMemo(() => saveProblems(context, draft, now).filter((problem) => problem.startsWith('CLOSING')), [context, draft, now]);
  const ticketFeeUnitCents = board.kind === 'TICKETING' ? board.digitalFeeUnitCents : computeTicketingBoard(context, { ...draft, format: 'TICKETING' }).digitalFeeUnitCents;

  const errors: StudioFieldErrors = {};
  for (const problem of editable ? (attempted ? blockers : live) : []) {
    const field = FIELD_FOR[problem];
    if (field && !errors[field]) errors[field] = t(`blockers.${problem}`);
  }
  const needsKyb = blockers.includes('KYB');
  // Lo que ya tiene su aviso junto al campo no se repite en la lista del panel (que en móvil queda al final de la página).
  const blockerList = blockers.filter((blocker) => blocker !== 'KYB' && !(FIELD_FOR[blocker] && attempted));

  function change(patch: Partial<StudioDraft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    carriedSavedNotice = null;
    setMessage(null);
    setConfirming(null);
  }

  function rememberInitiative(initiativeId: number) {
    if (draft.initiativeId === null) {
      setDraft((previous) => ({ ...previous, initiativeId }));
      // La campaña ya existe: la dirección apunta a ella sin volver a cargar la página (se perdería lo que aún no se guarda, como la confirmación de la rifa).
      window.history.replaceState(null, '', `${window.location.pathname}?${new URLSearchParams({ iniciativa: String(initiativeId) }).toString()}`);
    }
  }

  function errorMessage(reason: string, detail: string[]): Message {
    const key = ERROR_KEYS.includes(reason) ? reason : 'generic';
    const list = reason === 'BLOCKED' || reason === 'PROBLEMS' ? detail.map((item) => t(`blockers.${item}`)) : undefined;
    return { tone: 'error', text: t(`errors.${key}`), ...(list ? { list } : {}) };
  }

  async function save() {
    setBusy('save');
    carriedSavedNotice = null;
    setMessage(null);
    try {
      const result = await saveStudioAction(orgSlug, draft);
      if (result.status === 'SAVED') {
        rememberInitiative(result.initiativeId);
        const saved: Exclude<Message, null> = { tone: 'success', text: t(lock === 'SOFT' ? 'saved.soft' : 'saved.draft', { goal: formatCents(result.goalCents, locale) }) };
        if (result.created) carriedSavedNotice = { initiativeId: result.initiativeId, message: saved };
        setMessage(saved);
        // Una campaña recién creada cambia la dirección con `replaceState`: refrescar la página entonces la vuelve a montar con otra clave y se perdería el aviso.
        if (!result.created) router.refresh();
      } else if (result.status === 'ERROR') {
        setAttempted(true);
        setMessage(errorMessage(result.reason, result.detail));
      }
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    setBusy('publish');
    setConfirming(null);
    carriedSavedNotice = null;
    setMessage(null);
    const wasNew = draft.initiativeId === null;
    try {
      const result = await publishStudioAction(orgSlug, { draft, expectedGoalCents: board.goalCents });
      if (result.status === 'PUBLISHED') {
        router.replace(`/panel/${orgSlug}/estudio?${new URLSearchParams({ iniciativa: String(result.initiativeId), publicada: '1' }).toString()}`);
        return;
      }
      if (result.status === 'ERROR') {
        if (result.initiativeId !== undefined) rememberInitiative(result.initiativeId);
        setAttempted(true);
        setMessage(errorMessage(result.reason, result.detail));
        // En un borrador recién creado, refrescar remontaría la página y se perdería el aviso: se abre ya la campaña guardada con su pizarra al día.
        if (result.reason === 'STALE_BOARD') {
          if (wasNew && result.initiativeId !== undefined) router.replace(`/panel/${orgSlug}/estudio?${new URLSearchParams({ iniciativa: String(result.initiativeId) }).toString()}`);
          else router.refresh();
        }
      }
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (draft.initiativeId === null) return;
    setBusy('discard');
    setConfirming(null);
    try {
      const result = await discardStudioAction(orgSlug, draft.initiativeId);
      if (result.status === 'DISCARDED') router.replace(`/panel/${orgSlug}/estudio`);
      else if (result.status === 'ERROR') setMessage(errorMessage(result.reason, result.detail));
    } finally {
      setBusy(null);
    }
  }

  /** Cerrar la confirmación devuelve el foco al botón que la abrió (si no, cae al documento). */
  function cancelConfirmation() {
    const target = confirming === 'discard' ? discardButton : publishButton;
    setConfirming(null);
    requestAnimationFrame(() => target.current?.focus());
  }

  function onConfirmKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancelConfirmation();
    }
  }

  const canPublish = editable && blockers.length === 0 && busy === null && !syncing;
  const goal = formatCents(board.goalCents, locale);
  const fundraising = stored?.status === 'FUNDRAISING' && draft.initiativeId !== null;
  const publicHref = fundraising ? `/${orgSlug}/iniciativas/${draft.initiativeId}` : null;
  const posterHref = fundraising ? `/panel/${orgSlug}/estudio/${draft.initiativeId}/cartel` : null;
  const linkClass = 'inline-flex min-h-11 items-center font-bold underline underline-offset-4';

  const footer = (
    <div className="flex flex-col gap-3">
      {/* El aviso de guardado va aquí, junto al botón que se acaba de pulsar: en móvil el formulario queda muy por encima. */}
      {message && message.tone !== 'error' ? (
        <p role="status" className="rounded-xl bg-emerald-100 p-3 text-sm font-semibold text-emerald-950" data-testid="studio-saved">
          {message.text}
        </p>
      ) : null}
      {editable ? (
        <>
          {(blockerList.length > 0 || needsKyb) && (
            <div className="rounded-xl bg-white/10 p-3 text-sm text-slate-100" data-testid="studio-blockers">
              <p className="font-bold">{t('blockers.title')}</p>
              <ul className="ms-5 mt-1 list-disc">
                {needsKyb ? (
                  <li>
                    {t('blockers.KYB')}{' '}
                    <Link href={`/panel/${orgSlug}/ajustes#documentos`} className="font-bold text-amber-300 underline underline-offset-4">
                      {t('blockers.kybLink')}
                    </Link>
                  </li>
                ) : null}
                {blockerList.map((blocker) => (
                  <li key={blocker}>{t(`blockers.${blocker}`)}</li>
                ))}
              </ul>
            </div>
          )}
          {confirming === 'publish' ? (
            <div ref={confirmRef} tabIndex={-1} role="alertdialog" aria-labelledby="studio-confirm-title" onKeyDown={onConfirmKey} className="flex flex-col gap-3 rounded-xl bg-amber-50 p-3 text-amber-950">
              <p id="studio-confirm-title" className="font-bold">
                {t('confirm.title', { goal })}
              </p>
              <p className="text-sm">{t('confirm.body', { date: formatDate(draft.closesOn, locale) })}</p>
              {draft.format === 'BUDGET' ? <p className="text-sm">{t('confirm.refund')}</p> : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={`${primaryButton} sm:w-auto`} onClick={publish} data-testid="studio-confirm-publish">
                  {t('confirm.yes')}
                </button>
                <button type="button" className={`${secondaryButton} sm:w-auto`} onClick={cancelConfirmation}>
                  {t('confirm.no')}
                </button>
              </div>
            </div>
          ) : (
            <button ref={publishButton} type="button" className={primaryButton} disabled={!canPublish} aria-describedby={syncing ? 'studio-syncing' : blockers.length > 0 ? 'studio-publish-hint' : undefined} onClick={() => setConfirming('publish')} data-testid="studio-publish">
              <span aria-hidden="true">{'🚀 '}</span>
              {busy === 'publish' ? t('actions.publishing') : t('actions.publish')}
            </button>
          )}
          {blockers.length > 0 ? (
            <p id="studio-publish-hint" className="text-xs text-slate-300">
              {t('actions.publishHint')}
            </p>
          ) : null}
          <button type="button" className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-white/70 px-4 font-semibold text-white hover:bg-white/10 disabled:opacity-60" disabled={busy !== null} onClick={save} data-testid="studio-save">
            <span aria-hidden="true">{'💾 '}</span>
            {busy === 'save' ? t('actions.saving') : t('actions.saveDraft')}
          </button>
          {draft.initiativeId !== null ? (
            confirming === 'discard' ? (
              <div ref={confirmRef} tabIndex={-1} role="alertdialog" aria-labelledby="studio-discard-title" onKeyDown={onConfirmKey} className="flex flex-col gap-3 rounded-xl bg-red-50 p-3 text-red-950">
                <p id="studio-discard-title" className="font-bold">
                  {t('discard.title')}
                </p>
                <p className="text-sm">{t('discard.body')}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={`${primaryButton} sm:w-auto`} onClick={discard} data-testid="studio-confirm-discard">
                    {t('discard.yes')}
                  </button>
                  <button type="button" className={`${secondaryButton} sm:w-auto`} onClick={cancelConfirmation}>
                    {t('discard.no')}
                  </button>
                </div>
              </div>
            ) : (
              <button ref={discardButton} type="button" className="inline-flex min-h-11 items-center justify-center font-semibold text-slate-200 underline underline-offset-4 disabled:opacity-60" disabled={busy !== null || syncing} aria-describedby={syncing ? 'studio-syncing' : undefined} onClick={() => setConfirming('discard')} data-testid="studio-discard">
                {busy === 'discard' ? t('actions.discarding') : t('actions.discard')}
              </button>
            )
          ) : null}
          {/* Siempre en la página (vacío fuera de la espera): los lectores de pantalla solo anuncian una región viva que ya existía. */}
          <p id="studio-syncing" role="status" className="text-xs text-slate-300" data-testid={syncing ? 'studio-syncing' : undefined}>
            {syncing ? t('actions.syncing') : ''}
          </p>
        </>
      ) : null}
      {lock === 'SOFT' ? (
        <button type="button" className={primaryButton} disabled={busy !== null} onClick={save} data-testid="studio-save">
          <span aria-hidden="true">{'💾 '}</span>
          {busy === 'save' ? t('actions.saving') : t('actions.saveChanges')}
        </button>
      ) : null}
      {lock !== 'NONE' ? (
        <div className="flex flex-wrap gap-3 text-sm">
          {publicHref ? (
            <Link href={publicHref} className={`${linkClass} text-amber-300`}>
              {t('links.public')}
            </Link>
          ) : null}
          {posterHref ? (
            <Link href={posterHref} className={`${linkClass} text-amber-300`} data-testid="studio-poster-link">
              {t('links.poster')}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      {justPublished && stored ? (
        <div ref={publishedRef} tabIndex={-1} role="status" className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4 text-emerald-950" data-testid="studio-published">
          <p className="font-corp text-lg font-extrabold">{t('published.title', { wallet: stored.walletEscrowId })}</p>
          <p className="text-sm">{t('published.body')}</p>
          <div className="flex flex-wrap gap-x-5">
            {posterHref ? (
              <Link href={posterHref} className={linkClass} data-testid="published-poster-link">
                <span aria-hidden="true">{'🖨️ '}</span>
                {t('links.poster')}
              </Link>
            ) : null}
            {publicHref ? (
              <Link href={publicHref} className={linkClass}>
                {t('links.public')}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
      {lock === 'SOFT' ? <FormAlert tone="info">{t('lock.soft')}</FormAlert> : null}
      {lock === 'ALL' ? <FormAlert tone="info">{t('lock.all')}</FormAlert> : null}
      {board.kind === 'BUDGET' && board.lock.blocked ? (
        <div role="status" className="rounded-2xl border-2 border-red-700 bg-red-50 p-3.5 text-sm text-red-950" data-testid="studio-lock-alert">
          <p className="font-extrabold">
            <span aria-hidden="true">{'🛡️ '}</span>
            {t('lockAlert.title')}
          </p>
          <p>{t('lockAlert.body', { term: board.lock.term ?? '' })}</p>
        </div>
      ) : null}
      {message && message.tone === 'error' ? (
        <FormAlert tone="error">
          {message.text}
          {message.list ? (
            <ul className="ms-5 mt-1 list-disc font-normal">
              {message.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </FormAlert>
      ) : null}
      <div className="mobile-stack grid gap-6 lg:grid-cols-12">
        <section aria-label={t('formLabel')} className="korum-trust-vault p-5 sm:p-6 lg:col-span-7">
          <StudioFields draft={draft} context={context} lock={lock} rewardPresets={rewardPresets} ticketFeeUnitCents={ticketFeeUnitCents} today={today} maxCloseOn={maxCloseOn} onChange={change} errors={errors} />
        </section>
        <div className="lg:col-span-5">
          <StudioBoardView board={board} context={context} contingencyBps={draft.contingencyBps} ticketFeeMode={draft.ticketFeeMode} ticketSubtype={draft.ticketSubtype} footer={footer} />
        </div>
      </div>
    </div>
  );
}

/** Fecha de cierre con el formato del idioma (`AAAA-MM-DD` en hora de España, sin que el huso la corra un día). */
function formatDate(isoDate: string, locale: 'es' | 'ca' | 'en'): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}
