'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useState, type FormEvent } from 'react';
import { enterGateAction, leaveGateAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/actions';
import { CodeField, FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';

/** PIN de 6 dígitos del evento. Tras 5 fallos desde la misma red se bloquea un rato (QA-SEC06). */
export function GatePinForm({ eventId }: { eventId: number }) {
  const t = useTranslations('gate');
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'INVALID' | 'LOCKED' | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await enterGateAction(eventId, pin).catch(() => 'INVALID' as const);
    setBusy(false);
    if (result === 'OPENED') router.refresh();
    else {
      setError(result);
      setPin('');
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 rounded-2xl bg-varsity-ivory p-5 text-ink">
      <p>{t('pinIntro')}</p>
      {error ? <FormAlert>{t(`errors.${error}`)}</FormAlert> : null}
      <CodeField label={t('pin')} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} />
      <button type="submit" className={primaryButton} disabled={busy || pin.length !== 6}>
        {t('enter')}
      </button>
    </form>
  );
}

export function LeaveGateButton() {
  const t = useTranslations('gate');
  const router = useRouter();
  return (
    <button type="button" className={secondaryButton} onClick={() => void leaveGateAction().then(() => router.refresh())}>
      {t('leave')}
    </button>
  );
}
