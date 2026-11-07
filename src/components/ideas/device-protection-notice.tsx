'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';
import { withdrawFingerprintConsentAction } from '@/app/[locale]/(public)/[orgSlug]/ideas/actions';

export interface DeviceProtectionNoticeProps {
  /** La persona ya dio el consentimiento antes. */
  granted: boolean;
  /** Casilla de «ayudar a proteger la votación» de esta firma (solo si aún no hay consentimiento). */
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onWithdrawn: () => void;
}

/**
 * Aviso de la cookie de dispositivo y consentimiento de la huella (skill de antifraude §2; LSSI art. 22.2 y RGPD art. 7). La cookie propia es
 * necesaria para firmar y se explica; la huella del navegador es **opcional**, empieza desmarcada y se puede retirar aquí mismo con un clic.
 * Sin consentimiento, la votación funciona igual con las otras dos señales.
 */
export function DeviceProtectionNotice({ granted, checked, onCheckedChange, onWithdrawn }: DeviceProtectionNoticeProps) {
  const t = useTranslations('portal.ideas.protection');
  const checkboxId = useId();
  const [withdrawn, setWithdrawn] = useState(false);
  const [pending, startTransition] = useTransition();

  function withdraw() {
    startTransition(async () => {
      const result = await withdrawFingerprintConsentAction();
      if (result === 'WITHDRAWN') {
        setWithdrawn(true);
        onWithdrawn();
        // El botón de retirar desaparece: el foco pasa a la casilla, que vuelve desmarcada (WCAG 2.4.3).
        requestAnimationFrame(() => document.getElementById(checkboxId)?.focus());
      }
    });
  }

  return (
    <section aria-labelledby={`${checkboxId}-title`} className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-ink">
      <h2 id={`${checkboxId}-title`} className="font-bold text-varsity-navy">
        <span aria-hidden="true">{'🛡️ '}</span>
        {t('title')}
      </h2>
      <p className="mt-1">{t('cookie')}</p>
      {/* Región viva permanente (fuera de las dos ramas): «retirado» solo vale mientras no vuelva a marcar la casilla. */}
      <p role="status" aria-live="polite" className={withdrawn && !checked && !granted ? 'mt-2 font-bold text-emerald-900' : 'sr-only'}>
        {withdrawn && !checked && !granted ? t('withdrawn') : ''}
      </p>
      {granted ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="font-bold text-emerald-900">
            <span aria-hidden="true">{'✅ '}</span>
            {t('granted')}
          </p>
          <button type="button" onClick={withdraw} disabled={pending} aria-busy={pending} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60">
            {t('withdraw')}
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
            <input id={checkboxId} type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} className="mt-0.5 size-6 shrink-0 accent-varsity-emerald" />
            <span>
              <span className="font-bold">{t('checkboxLabel')}</span>
              <span className="block text-ink-soft">{t('checkboxHelp')}</span>
            </span>
          </label>
        </div>
      )}
    </section>
  );
}
