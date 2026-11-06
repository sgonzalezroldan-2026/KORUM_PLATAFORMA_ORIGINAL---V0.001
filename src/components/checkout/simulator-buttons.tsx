'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/components/ui/use-hydrated';

/** Botones del simulador de pagos: confirman o rechazan el pago y llevan a la pantalla de resultado, como la vuelta de Paycomet. */
export function SimulatorButtons({
  orgSlug,
  initiativeId,
  order,
  signature,
  settle
}: {
  orgSlug: string;
  initiativeId: number;
  order: string;
  signature: string;
  settle: (input: unknown) => Promise<{ url: string } | null>;
}) {
  const t = useTranslations('portal.simulator');
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  const ready = useHydrated();

  function run(approve: boolean) {
    startTransition(async () => {
      try {
        const result = await settle({ orgSlug, initiativeId, locale, order, signature, approve });
        if (result) window.location.assign(result.url);
        else setFailed(true);
      } catch {
        setFailed(true);
      }
    });
  }

  return (
    <div className="space-y-2">
      <button type="button" disabled={pending || !ready} onClick={() => run(true)} className="tactile-btn w-full rounded-2xl! py-4! font-joy text-base">
        {pending ? t('working') : t('confirm')}
      </button>
      <button type="button" disabled={pending || !ready} onClick={() => run(false)} className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl border-2 border-red-700 bg-white px-4 font-extrabold text-red-800 disabled:opacity-60">
        {t('reject')}
      </button>
      {failed ? (
        <p role="alert" className="text-sm font-bold text-red-800">
          {t('failed')}
        </p>
      ) : null}
    </div>
  );
}
