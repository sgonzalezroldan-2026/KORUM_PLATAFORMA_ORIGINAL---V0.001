'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { updateRoleLabelAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/team-actions';
import { Field, FormAlert } from '@/components/auth/auth-ui';
import { useApprovalsNotice } from './approvals-notice';

/** Cambiar el propio cargo visible (Sprint 4.2e): «Presidencia del AMPA», «Tesorería del club»… El rol que firma no cambia. */
export function RoleLabelForm({ orgSlug, current }: { orgSlug: string; current: string | null }) {
  const t = useTranslations('panel.settings.team.roleLabel');
  const router = useRouter();
  const notify = useApprovalsNotice();
  const [value, setValue] = useState(current ?? '');
  const [error, setError] = useState<'invalid' | 'generic' | null>(null);
  const [busy, setBusy] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);

  async function submit() {
    if (value.trim().length < 3) return setError('invalid');
    setBusy(true);
    setError(null);
    try {
      const result = await updateRoleLabelAction(orgSlug, { roleLabel: value });
      if (result.status === 'OK') {
        notify(t('saved'));
        details.current?.removeAttribute('open');
        router.refresh();
      } else setError(result.reason === 'INVALID' ? 'invalid' : 'generic');
    } catch {
      setError('generic');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details ref={details} className="rounded-xl border-2 border-varsity-navy/15 bg-white px-3 py-2">
      <summary className="min-h-11 cursor-pointer content-center font-bold text-varsity-navy underline underline-offset-4">{t('open')}</summary>
      <form
        noValidate
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t('label')} hint={t('hint')} value={value} maxLength={60} required onChange={(event) => setValue(event.target.value)} error={error === 'invalid' ? t('errors.invalid') : undefined} />
        {error === 'generic' ? <FormAlert>{t('errors.generic')}</FormAlert> : null}
        <button type="submit" disabled={busy} aria-busy={busy} className="tactile-btn self-start disabled:opacity-60">
          {t('save')}
        </button>
      </form>
    </details>
  );
}
