'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { changeSignatureModeAction, type TeamActionResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/team-actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { useApprovalsNotice } from './approvals-notice';
import { useFreshCode } from './use-fresh-code';

/**
 * Cuántas firmas exige la entidad (decisión del promotor, 2026-11-12). La entidad la elige y la cambia ella misma, sin esperas ni intervención de KORUM:
 * solo Dirección, con el código reciente y marcando que entiende lo que cambia. Va en texto claro, no solo con color.
 */
export function SignatureModeForm({ orgSlug, mode, canChange, email }: { orgSlug: string; mode: 'DOUBLE' | 'SINGLE'; canChange: boolean; email: string }) {
  const t = useTranslations('panel.settings.team.mode');
  const router = useRouter();
  const notify = useApprovalsNotice();
  const { run, dialog } = useFreshCode(email);
  const confirmId = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = mode === 'DOUBLE' ? 'SINGLE' : 'DOUBLE';
  // Foco (WCAG 2.4.3): al abrir va a la explicación; al cancelar vuelve al botón que se pulsó. Tras un éxito lo toma el aviso de la sección.
  const introRef = useRef<HTMLParagraphElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const refocusOpen = useRef(false);
  useEffect(() => {
    if (open) introRef.current?.focus();
    else if (refocusOpen.current) {
      refocusOpen.current = false;
      openRef.current?.focus();
    }
  }, [open]);

  function close(returnFocus: boolean) {
    refocusOpen.current = returnFocus;
    setOpen(false);
    setConfirmed(false);
    setError(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result: TeamActionResult = await run(() => changeSignatureModeAction(orgSlug, { mode: target, confirm: true }));
      if (result.status === 'OK') {
        notify(t(`done.${target}`));
        close(false);
        router.refresh();
      } else if (result.reason === 'ALREADY_IN_MODE') {
        // Otra persona (o otra pestaña) ya lo cambió: se actualiza la pantalla sola y se dice qué ha pasado.
        notify(t('errors.ALREADY_IN_MODE'));
        close(false);
        router.refresh();
      } else setError(t(`errors.${['REAUTH_REQUIRED', 'FORBIDDEN'].includes(result.reason) ? result.reason : 'generic'}`));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${confirmId}-title`} className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy/20 bg-white p-4" data-testid="signature-mode" data-mode={mode}>
      <h3 id={`${confirmId}-title`} className="font-corp text-lg font-extrabold text-varsity-navy">
        {t('title')}
      </h3>
      <p className="font-semibold text-ink" data-testid="signature-mode-current">
        {t(`current.${mode}`)}
      </p>
      <p className="text-sm text-ink-soft">{t(`help.${mode}`)}</p>
      {canChange ? (
        open ? (
          <div className="flex flex-col gap-3 border-t-2 border-varsity-navy/10 pt-3">
            <p ref={introRef} tabIndex={-1} className="text-sm font-semibold text-varsity-navy outline-none focus-visible:ring-2 focus-visible:ring-varsity-gold">
              {t(`change.${target}.intro`)}
            </p>
            {target === 'SINGLE' ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink" data-testid="signature-mode-effects">
                {(['noReview', 'gate', 'pending'] as const).map((effect) => (
                  <li key={effect}>{t(`change.SINGLE.effects.${effect}`)}</li>
                ))}
              </ul>
            ) : null}
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 size-5" data-testid="signature-mode-confirm" />
              <span>{t(`change.${target}.confirm`)}</span>
            </label>
            {error ? <FormAlert>{error}</FormAlert> : null}
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={!confirmed || busy} aria-busy={busy} onClick={() => void submit()} className="tactile-btn disabled:opacity-60" data-testid="signature-mode-submit">
                {busy ? t('saving') : t(`change.${target}.submit`)}
              </button>
              <button type="button" disabled={busy} onClick={() => close(true)} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy bg-white px-4 font-bold text-varsity-navy disabled:opacity-60">
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button ref={openRef} type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 w-fit items-center rounded-xl border-2 border-varsity-navy bg-white px-4 font-bold text-varsity-navy" data-testid="signature-mode-open">
            {t(`change.${target}.open`)}
          </button>
        )
      ) : (
        <p className="text-sm text-ink-soft">{t('onlyDirector')}</p>
      )}
      {dialog}
    </section>
  );
}
