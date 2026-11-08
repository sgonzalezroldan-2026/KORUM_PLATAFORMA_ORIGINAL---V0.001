'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { revalidateSignatureAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { useApprovalsNotice } from './approvals-notice';
import type { ModerationIdeaView } from '@/services/panel/approvals-data';

/**
 * Auditoría de firmas de una idea (regla padre/madre, skill de antifraude §2): cuántas cuentan y cuántas son sospechosas, y cada firma con su
 * motivo. Sin emails ni datos de la familia: solo el orden de la cuenta en el dispositivo y la fecha. La entidad puede dar por buena una firma
 * sospechosa (p. ej. muchas familias desde el wifi del centro); queda marcada como «validada por la entidad».
 */

const REASON_KEYS = ['ipBurst', 'firstAccount', 'secondAccount', 'tooManyAccounts'] as const;

export function IdeaSignatureAudit({ orgSlug, idea, canRevalidate }: { orgSlug: string; idea: ModerationIdeaView; canRevalidate: boolean }) {
  const t = useTranslations('panel.approvals.audit');
  const tReason = useTranslations('ideas.audit');
  const tErrors = useTranslations('panel.approvals.errors');
  const format = useFormatter();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const announce = useApprovalsNotice();

  function revalidate(signatureId: number) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await revalidateSignatureAction(orgSlug, {
          ideaId: idea.id,
          signatureId
        });
        if (result.status === 'ERROR') setError(tErrors(result.reason));
        else {
          announce(result.phase === 'DOUBLE_CHECK' ? t('revalidatedQuorum') : t('revalidated'));
          router.refresh();
        }
      } catch {
        setError(tErrors('failed'));
      }
    });
  }

  const reasonText = (reason: string, order: number) => {
    const key = reason.replace('ideas.audit.', '');
    // El motivo ya trae su ⚠️ en el buzón; aquí el estado lo dice al principio de la línea y no se repite.
    return ((REASON_KEYS as readonly string[]).includes(key) ? tReason(key as (typeof REASON_KEYS)[number], { n: order }) : reason).replace(/^⚠️\s*/u, '');
  };

  return (
    <details className="rounded-xl border border-stone-200 bg-white p-3" data-testid="signature-audit">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 font-bold text-varsity-navy">
        <span>{t('summary', { total: idea.verifiedVotes + idea.suspiciousVotes })}</span>
        <span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-sm text-emerald-950">{`🟢 ${t('verified', { count: idea.verifiedVotes })}`}</span>
        <span
          className={clsx('rounded-lg px-2 py-0.5 text-sm', idea.suspiciousVotes > 0 ? 'bg-amber-100 text-amber-950' : 'bg-stone-100 text-ink-soft')}
        >{`⚠️ ${t('suspicious', { count: idea.suspiciousVotes })}`}</span>
      </summary>
      <p className="mt-2 text-sm text-ink-soft">{t('explainer')}</p>
      {idea.signatures.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">{t('empty')}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {idea.signatures.map((signature) => (
            <li
              key={signature.id}
              className={clsx(
                'flex flex-wrap items-center justify-between gap-2 rounded-lg p-2 text-sm',
                signature.status === 'SUSPICIOUS' ? 'bg-amber-50 text-amber-950' : 'bg-emerald-50/70 text-emerald-950'
              )}
            >
              <span>
                <strong>{signature.status === 'SUSPICIOUS' ? t('statusSuspicious') : signature.revalidated ? t('statusRevalidated') : t('statusVerified')}</strong>
                {` · ${reasonText(signature.reason, signature.accountOrder)} · ${format.dateTime(new Date(signature.createdAt), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' })}`}
              </span>
              {signature.status === 'SUSPICIOUS' && canRevalidate ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => revalidate(signature.id)}
                  className="min-h-11 rounded-lg border-2 border-varsity-navy bg-white px-3 font-bold text-varsity-navy disabled:opacity-60"
                >
                  {t('revalidate')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {idea.verifiedVotes + idea.suspiciousVotes > idea.signatures.length ? (
        <p className="mt-2 text-sm text-ink-soft">{t('truncated', { shown: idea.signatures.length })}</p>
      ) : null}
      {error ? (
        <div className="mt-2">
          <FormAlert>{error}</FormAlert>
        </div>
      ) : null}
    </details>
  );
}
