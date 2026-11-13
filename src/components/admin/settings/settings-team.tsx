'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { cancelSuperadminInvitationAction, inviteSuperadminAction, revokeSuperadminAction } from '@/app/[locale]/(superadmin)/admin/ajustes/actions';
import { focusLater } from '@/components/admin/rules-action';
import type { TeamInvitation, TeamMember } from '@/services/admin/platform-settings-view';
import { FIELD, OUTLINE, PRIMARY, SettingsOutcome, useSettingsAction } from './settings-kit';

const WHEN = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' } as const;
const LANGUAGES = ['es', 'ca', 'en'] as const;
type Language = (typeof LANGUAGES)[number];

/** Una persona del equipo con su botón de retirar el acceso, que pide una confirmación aparte (Escape la cancela). No se puede retirar a uno mismo. */
function MemberRow({ member, afterRevokeFocusId }: { member: TeamMember; afterRevokeFocusId: string }) {
  const t = useTranslations('admin.settings.team');
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const action = useSettingsAction({ failureFocusId: `revoke-${member.id}` });
  const when = member.lastSeenAt ? new Intl.DateTimeFormat(locale, WHEN).format(member.lastSeenAt) : null;
  const cancel = () => {
    setConfirming(false);
    focusLater(`revoke-${member.id}`);
  };
  return (
    <li className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy/15 p-3" data-testid="team-member">
      <div className="flex flex-col gap-x-4 gap-y-1 sm:flex-row sm:flex-wrap sm:items-center">
        <span className="min-w-0 sm:flex-1">
          <span className="[overflow-wrap:anywhere] font-semibold">{member.email}</span>
          {member.isYou ? <span className="whitespace-nowrap font-semibold">{` (${t('you')})`}</span> : null}
        </span>
        <span className="text-sm text-ink-soft">{member.twoFactorEnabled ? t('twoFactorOn') : t('twoFactorOff')}</span>
        <span className="text-sm text-ink-soft">{when ? t('lastSeen', { when }) : t('neverSeen')}</span>
      </div>
      {member.isYou ? (
        <p className="text-sm text-ink-soft">{t('selfNote')}</p>
      ) : confirming ? (
        <div
          role="group"
          aria-label={t('revokeAria', { email: member.email })}
          className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel();
          }}
        >
          <p className="text-sm font-semibold text-amber-950">{t('revokeConfirm', { email: member.email })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" id={`revoke-cancel-${member.id}`} className={OUTLINE} onClick={cancel}>
              {t('cancel')}
            </button>
            <button
              type="button"
              id={`revoke-yes-${member.id}`}
              aria-disabled={action.pending}
              aria-busy={action.pending}
              className={PRIMARY}
              data-testid="team-revoke-yes"
              onClick={() =>
                action.run(
                  () => revokeSuperadminAction({ userId: member.id }),
                  () => t('revoked'),
                  // La fila desaparece al recargar: el foco pasa al campo de invitar (si no, caería al principio de la página).
                  () => focusLater(afterRevokeFocusId),
                  () => setConfirming(false)
                )
              }
            >
              {t('revokeYes')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          id={`revoke-${member.id}`}
          className={`${OUTLINE} w-fit`}
          data-testid="team-revoke"
          aria-label={t('revokeAria', { email: member.email })}
          onClick={() => {
            setConfirming(true);
            focusLater(`revoke-cancel-${member.id}`);
          }}
        >
          {t('revoke')}
        </button>
      )}
      <SettingsOutcome outcome={action.outcome} failed={action.failed} />
    </li>
  );
}

function InvitationRow({ invitation, afterCancelFocusId }: { invitation: TeamInvitation; afterCancelFocusId: string }) {
  const t = useTranslations('admin.settings.team');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const rowId = useId();
  const locale = useLocale();
  const resend = useSettingsAction();
  const cancel = useSettingsAction({ failureFocusId: afterCancelFocusId });
  const when = new Intl.DateTimeFormat(locale, WHEN).format(invitation.expiresAt);
  return (
    <li className="flex flex-col gap-2 rounded-xl border-2 border-dashed border-varsity-navy/30 p-3" data-testid="team-invitation">
      <div className="flex flex-col gap-x-4 gap-y-1 sm:flex-row sm:flex-wrap sm:items-center">
        <span className="min-w-0 [overflow-wrap:anywhere] font-semibold sm:flex-1">{invitation.email}</span>
        <span className="text-sm text-ink-soft">{invitation.expired ? t('expired', { when }) : t('expires', { when })}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-disabled={resend.pending}
          aria-busy={resend.pending}
          className={OUTLINE}
          aria-label={t('resendAria', { email: invitation.email })}
          onClick={() =>
            resend.run(
              () => inviteSuperadminAction({ email: invitation.email, locale }),
              () => t('invited')
            )
          }
        >
          {t('resend')}
        </button>
        <button
          type="button"
          id={`${rowId}-cancel`}
          className={OUTLINE}
          aria-label={t('cancelInvitationAria', { email: invitation.email })}
          onClick={() => {
            setConfirmingCancel(true);
            focusLater(`${rowId}-cancel-no`);
          }}
        >
          {t('cancelInvitation')}
        </button>
      </div>
      {confirmingCancel ? (
        <div
          role="group"
          aria-label={t('cancelInvitationAria', { email: invitation.email })}
          className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setConfirmingCancel(false);
              focusLater(`${rowId}-cancel`);
            }
          }}
        >
          <p className="text-sm font-semibold text-amber-950">{t('cancelInvitationConfirm', { email: invitation.email })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              id={`${rowId}-cancel-no`}
              className={OUTLINE}
              onClick={() => {
                setConfirmingCancel(false);
                focusLater(`${rowId}-cancel`);
              }}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              aria-disabled={cancel.pending}
              aria-busy={cancel.pending}
              className={PRIMARY}
              data-testid="team-cancel-invitation-yes"
              onClick={() =>
                cancel.run(
                  () => cancelSuperadminInvitationAction({ userId: invitation.userId }),
                  () => t('invitationCancelled'),
                  // La fila desaparece al recargar: el foco pasa al campo de invitar (si no, caería al principio de la página).
                  () => focusLater(afterCancelFocusId),
                  () => setConfirmingCancel(false)
                )
              }
            >
              {t('cancelInvitationYes')}
            </button>
          </div>
        </div>
      ) : null}
      <SettingsOutcome outcome={resend.outcome} failed={resend.failed} />
      <SettingsOutcome outcome={cancel.outcome} failed={cancel.failed} />
    </li>
  );
}

export function TeamSettings({ members, invitations }: { members: TeamMember[]; invitations: TeamInvitation[] }) {
  const t = useTranslations('admin.settings.team');
  const locale = useLocale();
  const [email, setEmail] = useState('');
  // El idioma de la persona invitada no se conoce: se elige (por defecto, el de esta pantalla) y es el de su email y su cuenta nueva.
  const [language, setLanguage] = useState<Language>((LANGUAGES as readonly string[]).includes(locale) ? (locale as Language) : 'es');
  const emailId = useId();
  const languageId = useId();
  const errorId = `${emailId}-error`;
  const invite = useSettingsAction({ failureFocusId: emailId });
  const rejected = invite.outcome?.status === 'REJECTED' || invite.outcome?.status === 'INVALID_INPUT';
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft">{t('intro')}</p>
      <ul className="flex flex-col gap-2" aria-label={t('membersTitle')}>
        {members.map((member) => (
          <MemberRow key={member.id} member={member} afterRevokeFocusId={emailId} />
        ))}
      </ul>
      {invitations.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('pendingTitle')}</h3>
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <InvitationRow key={invitation.userId} invitation={invitation} afterCancelFocusId={emailId} />
            ))}
          </ul>
        </div>
      ) : null}
      <form
        noValidate
        className="flex flex-col gap-2 rounded-xl bg-varsity-navy/5 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (email.trim() === '') return;
          invite.run(
            () => inviteSuperadminAction({ email, locale: language }),
            () => t('invited'),
            () => {
              setEmail('');
              // El botón queda sin uso (el campo vacío): el foco vuelve al campo para invitar a otra persona.
              focusLater(emailId);
            }
          );
        }}
      >
        <p className="font-corp text-lg font-extrabold text-varsity-navy">{t('inviteLabel')}</p>
        <p id={`${emailId}-help`} className="text-sm text-ink-soft">
          {t('inviteHelp')}
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor={emailId} className="font-semibold text-varsity-navy">
            {t('emailLabel')}
          </label>
          <input
            id={emailId}
            type="email"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={254}
            value={email}
            aria-invalid={rejected ? true : undefined}
            aria-describedby={rejected ? `${emailId}-help ${errorId}` : `${emailId}-help`}
            onChange={(event) => setEmail(event.target.value)}
            className={`${FIELD} scroll-mt-24 aria-invalid:border-red-700`}
            data-testid="team-invite-email"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={languageId} className="font-semibold text-varsity-navy">
            {t('languageLabel')}
          </label>
          <select id={languageId} value={language} onChange={(event) => setLanguage(event.target.value as Language)} className={`${FIELD} sm:w-64`} data-testid="team-invite-language">
            {LANGUAGES.map((value) => (
              <option key={value} value={value}>
                {t(`languages.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" aria-disabled={invite.pending || email.trim() === ''} aria-busy={invite.pending} className={`${PRIMARY} w-fit`} data-testid="team-invite-send">
          {invite.pending ? t('sending') : t('invite')}
        </button>
        <SettingsOutcome outcome={invite.outcome} failed={invite.failed} id={errorId} />
      </form>
    </div>
  );
}
