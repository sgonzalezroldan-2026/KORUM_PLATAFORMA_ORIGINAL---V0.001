'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useState, type FormEvent } from 'react';
import { enterGateAction, leaveGateAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/actions';
import { CodeField, Field, FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { clearGateState } from '@/components/gate/gate-offline-store';

/** PIN de 6 dígitos del evento. Tras 5 fallos desde la misma red se bloquea un rato (QA-SEC06). El nombre del móvil es opcional: así la entidad sabe qué puerta es cada sesión. */
export function GatePinForm({ gateCode }: { gateCode: string }) {
  const t = useTranslations('gate');
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [device, setDevice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'INVALID' | 'LOCKED' | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await enterGateAction(gateCode, pin, device).catch(() => 'INVALID' as const);
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
      <Field label={t('deviceLabel')} hint={t('deviceHint')} value={device} maxLength={40} autoComplete="off" onChange={(event) => setDevice(event.target.value)} />
      <button type="submit" className={primaryButton} disabled={busy || pin.length !== 6}>
        {t('enter')}
      </button>
    </form>
  );
}

export function LeaveGateButton({ eventId }: { eventId: number }) {
  const t = useTranslations('gate');
  const router = useRouter();
  return (
    <button
      type="button"
      className={secondaryButton}
      onClick={() => {
        clearGateState(eventId);
        void leaveGateAction().then(() => router.refresh());
      }}
    >
      {t('leave')}
    </button>
  );
}
