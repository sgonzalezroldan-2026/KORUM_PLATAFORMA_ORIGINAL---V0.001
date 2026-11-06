'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { resendInvitationAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/actions';

export function ResendInvitationButton({ orgSlug }: { orgSlug: string }) {
  const t = useTranslations('panel.signers');
  const [state, setState] = useState<'idle' | 'busy' | 'SENT' | 'NOT_NEEDED' | 'FORBIDDEN' | 'ERROR'>('idle');
  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="tactile-btn self-start" disabled={state === 'busy'} onClick={() => {
        setState('busy');
        resendInvitationAction(orgSlug).then(setState, () => setState('ERROR'));
      }}>
        {t('resend')}
      </button>
      <p role="status" className="text-sm font-semibold text-varsity-navy">
        {state === 'idle' || state === 'busy' ? '' : t(`resendResult.${state}`)}
      </p>
    </div>
  );
}
