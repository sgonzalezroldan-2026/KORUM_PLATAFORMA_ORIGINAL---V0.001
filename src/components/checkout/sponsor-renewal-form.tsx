'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, useTransition } from 'react';
import { startSponsorRenewalAction } from '@/app/[locale]/(public)/[orgSlug]/comercios/renovar/actions';
import { useHydrated } from '@/components/ui/use-hydrated';

/**
 * Pago de la renovación (Sprint 4.2d): el comercio solo elige tarjeta o Bizum. El importe, el fee y a quién renovar los decide el servidor con el enlace
 * firmado. Va a la página de pago de Paycomet; si algo falla, el error se anuncia aquí y el foco va a él.
 */
export function SponsorRenewalForm({ orgSlug, token, totalLabel }: { orgSlug: string; token: string; totalLabel: string }) {
  const t = useTranslations('portal.sponsorRenewal');
  const locale = useLocale();
  const ready = useHydrated();
  const legend = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [method, setMethod] = useState<'CARD' | 'BIZUM'>('CARD');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await startSponsorRenewalAction({ orgSlug, token, method, locale });
        if (result.status === 'REDIRECT') {
          window.location.assign(result.url);
          return;
        }
        setError(t(`errors.${result.status}`));
      } catch {
        setError(t('errors.UNAVAILABLE'));
      }
      requestAnimationFrame(() => errorRef.current?.focus());
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="sponsor-renewal-form">
      <fieldset className="flex flex-col gap-2" aria-labelledby={legend}>
        <legend id={legend} className="font-bold text-varsity-navy">
          {t('method')}
        </legend>
        {(['CARD', 'BIZUM'] as const).map((option) => (
          <label key={option} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-stone-200 bg-white px-3 has-checked:border-varsity-navy">
            <input type="radio" name="method" value={option} checked={method === option} onChange={() => setMethod(option)} className="size-5 accent-varsity-navy" />
            <span className="font-semibold">{t(`methods.${option}`)}</span>
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={pending || !ready} className="tactile-btn w-full rounded-2xl! py-4! font-joy text-base disabled:opacity-60">
        {pending ? t('paying') : t('pay', { total: totalLabel })}
      </button>
      {error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg border-2 border-red-700 bg-red-50 p-2 text-sm font-semibold text-red-900">
          {error}
        </p>
      ) : null}
    </form>
  );
}
