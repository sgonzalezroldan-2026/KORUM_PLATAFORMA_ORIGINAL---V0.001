'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { releaseCifAction, reviewKybAction } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { KYB_NOTE_MAX, noteHasPersonalData } from '@/core/admin/org-360-rules';
import { requiredKybKinds } from '@/core/panel/entity-settings-rules';
import type { Org360View } from '@/services/admin/org-360-data';
import { ActionOutcome, FIELD, OUTLINE, PRIMARY, useEntityAction } from './entity-action';

const DATE = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' } as const;
const TONE = { PENDING: 'bg-slate-100 text-slate-900', SUBMITTED: 'bg-amber-100 text-amber-950', VERIFIED: 'bg-emerald-100 text-emerald-950', REJECTED: 'bg-red-100 text-red-950' } as const;

/**
 * Revisión de los documentos del titular (KYB, heredado del 4.2c): abrir cada documento (con registro de cada apertura), verificar (y acreditar la Ley 49/2002
 * si la entidad la declaró) o devolver con una nota sin datos personales, y liberar un CIF ocupado. Las decisiones piden el segundo factor reciente.
 */
export function OrgKybReview({ organization, documents }: { organization: Org360View['organization']; documents: Org360View['documents'] }) {
  const t = useTranslations('admin.org360.kyb');
  const format = useFormatter();
  const groupId = useId();
  const action = useEntityAction();
  const [decision, setDecision] = useState<'VERIFIED' | 'REJECTED'>('VERIFIED');
  // Acreditar la Ley 49/2002 es una decisión explícita tras mirar su documento: nunca va marcado de antemano.
  const [ley49Accredited, setLey49Accredited] = useState(false);
  const [splitId, setSplitId] = useState('');
  const [note, setNote] = useState('');
  const [releaseCif, setReleaseCif] = useState(false);
  const [noteTouched, setNoteTouched] = useState(false);
  const [confirmingCif, setConfirmingCif] = useState(false);

  const kinds = requiredKybKinds(organization.ley49);
  const byKind = new Map(documents.map((document) => [document.kind, document]));
  const complete = kinds.every((kind) => byKind.has(kind)) && organization.cif !== null;
  const noteError = note.trim().length < 10 ? 'short' : noteHasPersonalData(note) ? 'personal' : null;
  const submitted = organization.kybStatus === 'SUBMITTED';

  const submit = () => {
    if (decision === 'REJECTED' && noteError) {
      setNoteTouched(true);
      return;
    }
    const review = decision === 'VERIFIED' ? { decision, ley49Accredited, ...(splitId.trim() ? { paycometSplitId: splitId.trim() } : {}) } : { decision, note, releaseCif };
    action.run(() => reviewKybAction({ organizationId: organization.id, review }), t(decision === 'VERIFIED' ? 'doneVerified' : 'doneRejected'));
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-sm font-extrabold ${TONE[organization.kybStatus]}`} data-testid="kyb-status" data-status={organization.kybStatus}>
          {t(`status.${organization.kybStatus}`)}
        </span>
        {organization.kybSubmittedAt ? <span className="text-sm text-ink-soft">{t('submittedAt', { date: format.dateTime(new Date(organization.kybSubmittedAt), DATE) })}</span> : null}
        {organization.kybReviewedAt ? <span className="text-sm text-ink-soft">{t('reviewedAt', { date: format.dateTime(new Date(organization.kybReviewedAt), DATE) })}</span> : null}
      </p>
      {organization.kybStatus === 'REJECTED' && organization.kybReviewNote ? (
        <p className="rounded-xl bg-red-50 p-3 text-red-950">
          <strong>{t('lastNote')}</strong> {organization.kybReviewNote}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <h3 className="font-corp text-base font-extrabold text-varsity-navy">{t('documents')}</h3>
        <ul className="flex flex-col gap-1" data-testid="kyb-documents">
          {kinds.map((kind) => {
            const document = byKind.get(kind);
            return (
              <li key={kind} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-patio-rule p-2">
                <span>{t(`kind.${kind}`)}</span>
                {document ? (
                  <a href={`/api/panel/documentos/${document.id}?orgSlug=${encodeURIComponent(organization.slug)}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline">
                    {t('open')}
                    <span className="sr-only"> {`${t(`kind.${kind}`)} ${t('newTab')}`}</span>
                  </a>
                ) : (
                  <span className="font-semibold text-red-900">{t('missing')}</span>
                )}
              </li>
            );
          })}
          <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-patio-rule p-2">
            <span>{t('cif')}</span>
            <span className={organization.cif ? 'font-mono font-bold' : 'font-semibold text-red-900'}>{organization.cif ?? t('missing')}</span>
          </li>
        </ul>
        <p className="text-xs text-ink-soft">{t('openHint')}</p>
      </div>

      {submitted ? (
        <fieldset className="flex flex-col gap-3 rounded-xl border-2 border-varsity-navy/20 p-3" disabled={action.pending} data-testid="kyb-review-form">
          <legend className="px-1 font-corp text-base font-extrabold text-varsity-navy">{t('reviewTitle')}</legend>
          {!complete ? <p className="text-sm font-semibold text-amber-950">{t('incomplete')}</p> : null}
          {(['VERIFIED', 'REJECTED'] as const).map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2">
              <input type="radio" name={`${groupId}-decision`} value={value} checked={decision === value} onChange={() => setDecision(value)} className="size-5" />
              <span>{t(`decision.${value}`)}</span>
            </label>
          ))}
          {decision === 'VERIFIED' ? (
            <>
              {organization.ley49 ? (
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" checked={ley49Accredited} onChange={(event) => setLey49Accredited(event.target.checked)} className="size-5" />
                  <span>{t('ley49Accredited')}</span>
                </label>
              ) : null}
              {organization.ley49 ? <p className="text-xs text-ink-soft">{t('ley49Hint')}</p> : null}
              <label className="flex flex-col gap-1 text-sm font-semibold text-ink-soft">
                {t('splitId')}
                <input type="text" value={splitId} maxLength={80} onChange={(event) => setSplitId(event.target.value)} className={FIELD} autoComplete="off" aria-describedby={`${groupId}-split`} />
                <span id={`${groupId}-split`} className="text-xs font-normal">
                  {organization.splitConfigured ? t('splitIdSet') : t('splitIdHint')}
                </span>
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm font-semibold text-ink-soft">
                {t('note')}
                <textarea
                  value={note}
                  maxLength={KYB_NOTE_MAX}
                  rows={4}
                  onChange={(event) => setNote(event.target.value)}
                  onBlur={() => setNoteTouched(true)}
                  aria-invalid={noteTouched && noteError !== null}
                  aria-describedby={`${groupId}-note`}
                  className={`${FIELD} py-2`}
                  data-testid="kyb-note"
                />
                <span id={`${groupId}-note`} role={noteTouched && noteError ? 'alert' : undefined} className={`text-xs font-normal ${noteTouched && noteError ? 'font-semibold text-red-900' : ''}`}>
                  {noteTouched && noteError ? t(`noteError.${noteError}`) : t('noteHint', { max: KYB_NOTE_MAX })}
                </span>
              </label>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" checked={releaseCif} onChange={(event) => setReleaseCif(event.target.checked)} className="size-5" disabled={organization.cif === null} />
                <span>{t('releaseCifWithReject')}</span>
              </label>
            </>
          )}
          <button type="button" onClick={submit} disabled={action.pending || (decision === 'VERIFIED' && !complete)} className={`${PRIMARY} self-start`} data-testid="kyb-submit">
            {action.pending ? t('saving') : t(`submit.${decision}`)}
          </button>
        </fieldset>
      ) : null}

      {organization.kybStatus !== 'VERIFIED' && organization.cif !== null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-patio-rule p-3">
          <p className="text-sm">{t('releaseCifText')}</p>
          {confirmingCif ? (
            <div role="group" aria-label={t('releaseCifConfirmTitle')} className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3">
              <p className="font-bold text-varsity-navy">{t('releaseCifConfirmText', { cif: organization.cif })}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={PRIMARY}
                  disabled={action.pending}
                  onClick={() => action.run(() => releaseCifAction({ organizationId: organization.id }), t('doneCifReleased'), () => setConfirmingCif(false))}
                  data-testid="release-cif-confirm"
                >
                  {action.pending ? t('saving') : t('releaseCifConfirm')}
                </button>
                <button type="button" className={OUTLINE} disabled={action.pending} onClick={() => setConfirmingCif(false)}>
                  {t('releaseCifCancel')}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className={`${OUTLINE} self-start`} disabled={action.pending} onClick={() => setConfirmingCif(true)} data-testid="release-cif">
              {t('releaseCif')}
            </button>
          )}
        </div>
      ) : null}
      <ActionOutcome outcome={action.outcome} failed={action.failed} />
    </div>
  );
}
