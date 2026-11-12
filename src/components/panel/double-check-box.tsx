'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { requestIdeaSignatureAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import type { ModerationIdeaView } from '@/services/panel/approvals-data';

/**
 * Doble firma de una idea con quórum (`1/2 → 2/2`, QA-S02): las dos casillas (dirección y cofirma) con quién firmó y cuándo, y el botón para
 * pedir el enlace de un solo uso y el código. Nunca se firma desde aquí: el enlace llega por email y se abre con la sesión de esa persona
 * (`/firmar`). El estado se dice con texto, no solo con el color.
 */
export function DoubleCheckBox({
  orgSlug,
  ideaId,
  doubleCheck,
  isSigner
}: {
  orgSlug: string;
  ideaId: number;
  doubleCheck: NonNullable<ModerationIdeaView['doubleCheck']>;
  isSigner: boolean;
}) {
  const t = useTranslations('panel.approvals.doubleCheck');
  const tErrors = useTranslations('panel.approvals.errors');
  const format = useFormatter();
  const [sentUntil, setSentUntil] = useState<string | null>(doubleCheck.myChallengeExpiresAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Europe/Madrid'
    });

  function request() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await requestIdeaSignatureAction(orgSlug, { ideaId });
        if (result.status === 'OK' && result.expiresAt) setSentUntil(result.expiresAt);
        else if (result.status === 'ERROR') setError(tErrors(result.reason));
      } catch {
        setError(tErrors('failed'));
      }
    });
  }

  return (
    <section aria-label={t('label')} className="korum-trust-vault flex flex-col gap-3 rounded-xl border-2 border-varsity-navy bg-white p-4" data-testid="double-check-box">
      <p className="font-corp text-lg font-extrabold tabular-nums text-varsity-navy">{t('progress', { signed: doubleCheck.signed, total: doubleCheck.slots.length })}</p>
      {doubleCheck.revalidatedVotes > 0 ? <p className="text-sm font-semibold text-amber-950">{`⚠️ ${t('revalidated', { count: doubleCheck.revalidatedVotes })}`}</p> : null}
      <ul className="mobile-stack grid gap-2 sm:grid-cols-2">
        {doubleCheck.slots.map((slot) => (
          <li
            key={slot.role}
            className={clsx('flex flex-col gap-0.5 rounded-lg border-2 p-3', slot.signedBy ? 'border-varsity-emerald bg-emerald-50' : 'border-dashed border-stone-300 bg-stone-50')}
          >
            <span className="text-sm font-extrabold text-varsity-navy">{slot.holderLabel ?? t(`roles.${slot.role}`)}</span>
            {slot.signedBy ? (
              <span className="text-sm text-emerald-950">
                {`✅ ${t('signedBy', { name: slot.signedBy.name || (slot.signedBy.roleLabel ?? ''), date: date(slot.signedBy.signedAt) })}`}
              </span>
            ) : (
              <span className="text-sm text-ink-soft">{`⏳ ${t('pending')}`}</span>
            )}
          </li>
        ))}
      </ul>
      {doubleCheck.mySlotOpen ? (
        sentUntil ? (
          <div className="flex flex-col gap-2">
            <FormAlert tone="success">{t('sent', { date: date(sentUntil) })}</FormAlert>
            <button
              type="button"
              onClick={request}
              disabled={pending}
              className="min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4 disabled:opacity-60"
            >
              {t('resend')}
            </button>
          </div>
        ) : (
          <button type="button" onClick={request} disabled={pending} className="tactile-btn self-start disabled:opacity-60">
            {pending ? t('requesting') : `🛡️ ${t('request')}`}
          </button>
        )
      ) : (
        <p className="text-sm text-ink-soft">{t(isSigner ? 'notYours' : 'readOnly')}</p>
      )}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </section>
  );
}
