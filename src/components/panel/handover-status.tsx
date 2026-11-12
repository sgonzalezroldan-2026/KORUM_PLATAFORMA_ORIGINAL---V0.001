'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cancelHandoverAction, resendHandoverAction, type TeamActionResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/team-actions';
import { FormAlert } from '@/components/auth/auth-ui';
import type { HandoverView } from '@/services/panel/signer-team.service';
import { useApprovalsNotice } from './approvals-notice';

type Operation = 'resend' | 'cancel';

/**
 * El relevo abierto de la entidad (Sprint 4.2e, rediseñado el 2026-11-12): la invitación ya salió y el cambio será inmediato cuando la persona nueva acepte.
 * Quien sale no tiene veto: solo quien propuso el relevo puede retirarlo; cualquiera de las personas que firman reenvía la invitación. Todo en texto,
 * no solo con color. El éxito se anuncia en el aviso de la sección.
 */
export function HandoverStatus({ orgSlug, handover, seatLabel, canEdit }: { orgSlug: string; handover: HandoverView; seatLabel: string; canEdit: boolean }) {
  const t = useTranslations('panel.settings.team.handover');
  const locale = useLocale();
  const router = useRouter();
  const notify = useApprovalsNotice();
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
      const action: () => Promise<TeamActionResult> = operation === 'resend' ? () => resendHandoverAction(orgSlug, handover.id) : () => cancelHandoverAction(orgSlug, handover.id);
      const result = await action();
      if (result.status === 'OK') {
        notify(t(`done.${operation}`));
        router.refresh();
      } else setError(t(`errors.${['NOT_FOUND', 'SAME_INBOX', 'UNAVAILABLE', 'RATE_LIMITED', 'FORBIDDEN'].includes(result.reason) ? result.reason : 'generic'}`));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  }

  // Caducada: quien la propuso puede retirarla; a las demás personas se les dice que la entidad podrá proponerla de nuevo (no hay botón que no pueden pulsar).
  const message = handover.expired ? t(handover.proposedByMe ? 'expiredInvitation' : 'expiredInvitationOther', who) : t(handover.outgoingIsMe ? (handover.selfProposed ? 'invitedMine' : 'invitedReplacingMe') : handover.selfProposed ? 'invitedSelf' : 'invitedOther', who);

  const button = (operation: Operation, style: 'primary' | 'secondary') => (
    <button
      type="button"
      disabled={busy !== null}
      aria-busy={busy === operation}
      onClick={() => void act(operation)}
      className={style === 'primary' ? 'tactile-btn disabled:opacity-60' : 'inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy bg-white px-4 font-bold text-varsity-navy disabled:opacity-60'}
    >
      {busy === operation ? t(`busy.${operation}`) : t(`actions.${operation}`)}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-gold bg-amber-50 p-4" data-testid="handover-status">
      <p className="font-corp font-extrabold text-varsity-navy">{t('titleInvited')}</p>
      <p className="wrap-anywhere text-ink">{message}</p>
      {error ? <FormAlert>{error}</FormAlert> : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-3">
          {!handover.expired ? button('resend', 'secondary') : null}
          {handover.proposedByMe ? button('cancel', 'secondary') : null}
        </div>
      ) : null}
    </div>
  );
}
