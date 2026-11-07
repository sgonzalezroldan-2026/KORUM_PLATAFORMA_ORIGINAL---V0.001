'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { CheckoutOutcome } from '@/core/checkout/checkout-rules';

/**
 * Vuelta del primer pago de la aportación mensual. Lo que cuenta es la notificación de Paycomet, ya guardada: aquí solo se enseña. El foco va al
 * resultado al cargar (éxito o no), para que un lector de pantalla lo lea primero.
 */

type Variant = 'activated' | 'notActive' | 'cardNotSaved' | 'pending' | 'failed';

/**
 * `null`: no hay nada que contar sobre aquel pago, porque la aportación cambió después por otro motivo (la familia la canceló, contracargo, pausa
 * caducada…). Volver a la URL con `?pedido=` no debe decir «no quedó activa» de algo que sí lo estuvo.
 */
function variantOf(outcome: CheckoutOutcome, pledgeStatus: string | null, pledgeReason: string | null): Variant | null {
  if (outcome === 'PENDING') return 'pending';
  if (outcome === 'CONFIRMED' || outcome === 'RETURNED') {
    if (pledgeStatus === 'ACTIVE' || pledgeStatus === 'PAUSED' || pledgeStatus === 'FINISHED') return 'activated';
    // El mes llegó como donación, pero la aportación no quedó activa: sin tarjeta guardada, sustituida o con otra viva.
    if (pledgeReason === 'CARD_NOT_SAVED') return 'cardNotSaved';
    return pledgeReason === 'REPLACED' ? 'notActive' : null;
  }
  return 'failed';
}

const TONE: Record<Variant, string> = {
  activated: 'border-varsity-emerald bg-emerald-50 text-emerald-950',
  notActive: 'border-amber-500 bg-amber-50 text-amber-950',
  cardNotSaved: 'border-amber-500 bg-amber-50 text-amber-950',
  pending: 'border-sky-600 bg-sky-50 text-sky-950',
  failed: 'border-red-800 bg-red-50 text-red-950'
};
const ICON: Record<Variant, string> = { activated: '🎉 ', notActive: 'ℹ️ ', cardNotSaved: '⚠️ ', pending: '⏳ ', failed: '❌ ' };

export function PledgeResult({ outcome, organization, pledgeStatus, pledgeReason }: { outcome: CheckoutOutcome; organization: string; pledgeStatus: string | null; pledgeReason: string | null }) {
  const t = useTranslations('hucha.result');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const variant = variantOf(outcome, pledgeStatus, pledgeReason);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  if (variant === null) return null;

  return (
    <section role={variant === 'failed' ? 'alert' : 'status'} className={`rounded-3xl border-2 p-5 ${TONE[variant]}`} data-testid="pledge-result" data-variant={variant}>
      <h2 ref={headingRef} tabIndex={-1} className={variant === 'activated' ? 'font-joy text-2xl font-bold' : 'font-corp text-xl font-extrabold'}>
        <span aria-hidden="true">{ICON[variant]}</span>
        {t(`${variant}.title`)}
      </h2>
      <p className="mt-1 font-semibold">{t(`${variant}.text`, { organization })}</p>
      {variant === 'pending' ? (
        <button type="button" onClick={() => window.location.reload()} className="mt-3 inline-flex min-h-11 items-center rounded-xl border-2 border-current px-4 font-bold">
          {t('pending.reload')}
        </button>
      ) : null}
    </section>
  );
}
