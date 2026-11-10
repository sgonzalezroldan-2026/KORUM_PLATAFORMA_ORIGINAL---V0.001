'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { approveIdeaAction, rejectIdeaAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { IDEA_DESCRIPTION_MAX, IDEA_TITLE_MAX } from '@/core/ideas/idea-rules';
import { Link } from '@/i18n/navigation';
import type { ModerationIdeaView } from '@/services/panel/approvals-data';
import { useApprovalsNotice } from './approvals-notice';
import { DoubleCheckBox } from './double-check-box';
import { IdeaCenterChat } from './idea-center-chat';
import { IdeaSignatureAudit } from './idea-signature-audit';

/**
 * Una idea en la bandeja de aprobaciones (`renderSchoolModeration` del prototipo): estado en texto, avance del quórum, auditoría de firmas,
 * chat con la familia y la acción que toca según la fase. En revisión inicial, la entidad puede corregir el texto antes de abrir las firmas;
 * desestimar pide siempre un motivo, que la familia leerá en su chat.
 */

const inputClass = 'w-full rounded-lg border-2 border-varsity-navy bg-white p-2 text-base';

export function IdeaModerationCard({
  orgSlug,
  idea,
  minVotes,
  categories,
  canModerate
}: {
  orgSlug: string;
  idea: ModerationIdeaView;
  minVotes: number;
  categories: string[];
  canModerate: boolean;
}) {
  const t = useTranslations('panel.approvals');
  const format = useFormatter();
  const router = useRouter();
  const ids = {
    title: useId(),
    heading: useId(),
    category: useId(),
    description: useId(),
    reason: useId()
  };
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(idea.title);
  const [category, setCategory] = useState(idea.category);
  const [description, setDescription] = useState(idea.description);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const open = idea.chatOpen;
  const announce = useApprovalsNotice();

  function act(operation: () => Promise<{ status: 'OK'; phase?: string } | { status: 'ERROR'; reason: string }>, success: (phase?: string) => string) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await operation();
        if (result.status === 'ERROR') setError(t(`errors.${result.reason}`));
        else {
          announce(success(result.phase));
          setRejecting(false);
          router.refresh();
        }
      } catch {
        setError(t('errors.failed'));
      }
    });
  }

  const approve = () =>
    act(
      () =>
        approveIdeaAction(orgSlug, {
          ideaId: idea.id,
          title,
          category,
          description
        }),
      (phase) => (phase === 'DOUBLE_CHECK' ? t('notices.approvedQuorum') : t('notices.approved'))
    );
  const reject = (event: React.FormEvent) => {
    event.preventDefault();
    act(
      () => rejectIdeaAction(orgSlug, { ideaId: idea.id, reason }),
      () => t('notices.rejected')
    );
  };
  const categoryOptions = categories.includes(idea.category) ? categories : [idea.category, ...categories];

  return (
    <article aria-labelledby={ids.heading} className="flex flex-col gap-3 rounded-2xl border-2 border-stone-200 bg-white p-4" data-testid="moderation-idea" data-phase={idea.phase}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={ids.heading} className="min-w-0 wrap-break-word font-corp text-lg font-extrabold text-varsity-navy">
          <code className="rounded border border-stone-300 bg-stone-50 px-1.5">{idea.alias}</code>
          {` · ${idea.title}`}
        </h3>
        <span className="rounded-full border-2 border-varsity-navy/30 bg-varsity-ivory px-3 py-1 text-sm font-bold text-varsity-navy">{t(`phases.${idea.phase}`)}</span>
      </header>
      <p className="text-sm text-ink-soft">
        {idea.phase === 'PUBLIC_VOTING' || idea.phase === 'DOUBLE_CHECK'
          ? t('meta', {
              category: idea.category,
              votes: idea.verifiedVotes,
              needed: minVotes,
              date: format.dateTime(new Date(idea.createdAt), {
                dateStyle: 'medium',
                timeZone: 'Europe/Madrid'
              })
            })
          : t('metaShort', {
              category: idea.category,
              date: format.dateTime(new Date(idea.createdAt), {
                dateStyle: 'medium',
                timeZone: 'Europe/Madrid'
              })
            })}
        {idea.phase === 'PUBLIC_VOTING' || idea.phase === 'DOUBLE_CHECK' ? ` ${t(idea.phase === 'DOUBLE_CHECK' ? 'signDaysLeft' : 'daysLeft', { count: idea.daysRemaining })}` : ''}
      </p>
      {idea.phase === 'PUBLIC_VOTING' ? (
        <div
          className="h-3 overflow-hidden rounded-full bg-stone-200"
          role="progressbar"
          aria-label={t('progressLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={idea.percent}
        >
          <div className="h-full bg-varsity-emerald" style={{ width: `${idea.percent}%` }} />
        </div>
      ) : null}

      {idea.phase === 'PHASE0_MOD' && canModerate ? (
        <fieldset className="flex flex-col gap-2 rounded-xl border border-sky-200 bg-sky-50/50 p-3" disabled={pending}>
          <legend className="px-1 text-sm font-extrabold text-sky-950">{t('edit.legend')}</legend>
          <label htmlFor={ids.title} className="text-sm font-bold text-varsity-navy">
            {t('edit.title')}
          </label>
          <input id={ids.title} className={inputClass} value={title} maxLength={IDEA_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor={ids.category} className="text-sm font-bold text-varsity-navy">
            {t('edit.category')}
          </label>
          <select id={ids.category} className={`${inputClass} min-h-11`} value={category} onChange={(event) => setCategory(event.target.value)}>
            {categoryOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <label htmlFor={ids.description} className="text-sm font-bold text-varsity-navy">
            {t('edit.description')}
          </label>
          <textarea
            id={ids.description}
            className={inputClass}
            rows={3}
            value={description}
            maxLength={IDEA_DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
          />
          <p className="text-sm text-ink-soft">{t('edit.hint')}</p>
        </fieldset>
      ) : (
        <p className="whitespace-pre-line wrap-break-word">{idea.description}</p>
      )}

      {idea.doubleCheck ? <DoubleCheckBox orgSlug={orgSlug} ideaId={idea.id} doubleCheck={idea.doubleCheck} isSigner={canModerate} /> : null}
      {idea.phase === 'CONVERTED' && idea.initiative ? (
        <p className="rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">
          {t('converted', { wallet: idea.initiative.walletEscrowId })}{' '}
          <Link href={`/panel/${orgSlug}/estudio?iniciativa=${idea.initiative.id}`} className="underline underline-offset-4" data-testid="converted-studio-link">
            {t('convertedLink')}
          </Link>
        </p>
      ) : null}

      {idea.phase !== 'PHASE0_MOD' ? (
        <IdeaSignatureAudit
          orgSlug={orgSlug}
          idea={idea}
          canRevalidate={canModerate && idea.daysRemaining > 0 && (idea.phase === 'PUBLIC_VOTING' || idea.phase === 'DOUBLE_CHECK')}
        />
      ) : null}
      <IdeaCenterChat orgSlug={orgSlug} idea={idea} canWrite={canModerate} />

      {open && canModerate ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {idea.phase === 'PHASE0_MOD' ? (
              <button type="button" onClick={approve} disabled={pending} className="tactile-btn disabled:opacity-60">
                {`✅ ${t('actions.approve')}`}
              </button>
            ) : null}
            <button
              type="button"
              aria-expanded={rejecting}
              onClick={() => {
                setRejecting(!rejecting);
                if (!rejecting) setTimeout(() => reasonField.current?.focus(), 0);
              }}
              className="min-h-11 rounded-xl border-2 border-red-700 bg-white px-4 font-bold text-red-800"
            >
              {`❌ ${t('actions.reject')}`}
            </button>
          </div>
          {rejecting ? (
            <form onSubmit={reject} className="flex flex-col gap-2 rounded-xl border-2 border-red-200 bg-red-50/60 p-3" aria-busy={pending}>
              <label htmlFor={ids.reason} className="text-sm font-bold text-red-950">
                {t('reject.label', { alias: idea.alias })}
              </label>
              <textarea
                id={ids.reason}
                ref={reasonField}
                className={inputClass}
                rows={3}
                maxLength={600}
                required
                minLength={10}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <p className="text-sm text-ink-soft">{t('reject.hint')}</p>
              <button
                type="submit"
                disabled={pending || reason.trim().length < 10}
                className="min-h-11 self-start rounded-xl bg-red-800 px-4 font-bold text-white disabled:opacity-60"
              >
                {t('reject.confirm')}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </article>
  );
}
