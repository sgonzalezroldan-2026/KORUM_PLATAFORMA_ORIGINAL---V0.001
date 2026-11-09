'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cancelHandoverAction, consentHandoverAction, declineHandoverAction, resendHandoverAction, type TeamActionResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/team-actions';
import { FormAlert } from '@/components/auth/auth-ui';
import type { HandoverView } from '@/services/panel/signer-team.service';
import { useApprovalsNotice } from './approvals-notice';
import { useFreshCode } from './use-fresh-code';

type Operation = 'consent' | 'decline' | 'resend' | 'cancel';

/**
 * El relevo abierto de la entidad (Sprint 4.2e), con lo que puede hacer cada persona: quien sale da su visto bueno (con su código) o lo rechaza;
 * cualquiera de las dos lo retira o reenvía la invitación. Todo en texto, no solo con color. El éxito se anuncia en el aviso de la sección.
 */
export function HandoverStatus({ orgSlug, handover, seatLabel, canEdit, email }: { orgSlug: string; handover: HandoverView; seatLabel: string; canEdit: boolean; email: string }) {
  const t = useTranslations('panel.settings.team.handover');
  const locale = useLocale();
  const router = useRouter();
  const notify = useApprovalsNotice();
  const { run, dialog } = useFreshCode(email);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const date = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid'
  }).format(new Date(handover.expiresAt));
  const who = {
    name: handover.displayName,
    email: handover.email,
    role: handover.roleLabel,
    seat: seatLabel,
    date
  };

  async function act(operation: Operation) {
    setBusy(operation);
    setError(null);
    try {
      const action: () => Promise<TeamActionResult> =
        operation === 'consent'
          ? () => consentHandoverAction(orgSlug, handover.id)
          : operation === 'decline'
            ? () => declineHandoverAction(orgSlug, handover.id)
            : operation === 'resend'
              ? () => resendHandoverAction(orgSlug, handover.id)
              : () => cancelHandoverAction(orgSlug, handover.id);
      const result = operation === 'consent' ? await run(action) : await action();
      if (result.status === 'OK') {
        notify(t(`done.${operation}`));
        router.refresh();
      } else setError(t(`errors.${['REAUTH_REQUIRED', 'NOT_FOUND', 'SAME_INBOX', 'UNAVAILABLE', 'RATE_LIMITED', 'FORBIDDEN'].includes(result.reason) ? result.reason : 'generic'}`));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  }

  const awaiting = handover.status === 'AWAITING_CONSENT';
  const message = handover.expired ? t(awaiting ? 'expiredConsent' : 'expiredInvitation', who) : awaiting ? t(handover.outgoingIsMe ? 'askMe' : 'waitingOther', who) : t(handover.outgoingIsMe ? 'invitedMine' : handover.selfProposed ? 'invitedSelf' : 'invitedOther', who);

  const button = (operation: Operation, style: 'primary' | 'secondary') => (
    <button
      type="button"
      disabled={busy !== null}
      aria-busy={busy === operation}
      onClick={() => void act(operation)}
      className={style === 'primary' ? 'tactile-btn disabled:opacity-60' : 'inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy bg-white px-4 font-bold text-varsity-navy disabled:opacity-60'}
    >
      {t(`actions.${operation}`)}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-gold bg-amber-50 p-4" data-testid="handover-status">
      <p className="font-corp font-extrabold text-varsity-navy">{t(awaiting ? 'titleAwaiting' : 'titleInvited')}</p>
      <p className="text-ink">{message}</p>
      {awaiting && handover.outgoingIsMe && !handover.expired ? <p className="text-sm text-ink-soft">{t('consentHint')}</p> : null}
      {error ? <FormAlert>{error}</FormAlert> : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-3">
          {awaiting && handover.outgoingIsMe && !handover.expired ? (
            <>
              {button('consent', 'primary')}
              {button('decline', 'secondary')}
            </>
          ) : null}
          {!awaiting && !handover.expired ? button('resend', 'secondary') : null}
          {!(awaiting && handover.outgoingIsMe && !handover.expired) ? button('cancel', 'secondary') : null}
        </div>
      ) : null}
      {dialog}
    </div>
  );
}
