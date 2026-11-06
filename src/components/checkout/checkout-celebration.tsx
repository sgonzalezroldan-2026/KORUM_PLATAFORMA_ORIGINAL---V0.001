'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ProgressBar } from '@/components/portal/progress-bar';
import { useRouter } from '@/i18n/navigation';
import { clearDraft } from './checkout-draft';

/**
 * Momentos de la pantalla de vuelta del pago (EXPERIENCIA_DE_PRODUCTO §6): la barra **sube en directo** desde el avance de antes hasta el de
 * ahora y, al llegar al 100 %, confeti breve. Con `prefers-reduced-motion` no se mueve nada: la barra aparece ya llena y no hay confeti.
 */
export function RisingProgress({ fromPct, toPct, label }: { fromPct: number; toPct: number; label: string }) {
  const [pct, setPct] = useState(fromPct);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPct(toPct));
    return () => window.cancelAnimationFrame(frame);
  }, [toPct]);
  return <ProgressBar pct={pct} label={label} size="lg" tone={toPct >= 100 ? 'emerald' : 'brand'} />;
}

const CONFETTI = ['#F59E0B', '#047857', '#FF5A43', '#101F38', '#FFB800', '#0EA5E9'];

/** Confeti decorativo (solo con movimiento permitido); el logro ya se anuncia en texto. */
export function Confetti() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-40 hidden h-0 motion-safe:block">
      {Array.from({ length: 24 }, (_, index) => (
        <span
          key={index}
          className="korum-confetti absolute top-0 block h-3 w-2 rounded-sm"
          style={{ left: `${(index * 37) % 100}%`, backgroundColor: CONFETTI[index % CONFETTI.length], animationDelay: `${(index % 6) * 90}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * Mientras Paycomet no confirma, la página se vuelve a pedir sola cada pocos segundos (hasta un minuto) y el botón permite comprobarlo ya. Al
 * dejar de recargar se dice, para no prometer algo que ya no pasa. El estado lo decide siempre el servidor con lo que ha guardado el webhook.
 */
export function PendingRefresh() {
  const t = useTranslations('portal.result.pending');
  const router = useRouter();
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > 20) {
        window.clearInterval(timer);
        setStopped(true);
      } else router.refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [router]);
  return (
    <>
      {stopped ? (
        <p role="status" className="text-sm font-semibold text-ink">
          {t('stopped')}
        </p>
      ) : null}
      <button type="button" onClick={() => router.refresh()} className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-patio-rule-strong bg-white px-4 font-extrabold text-varsity-navy">
        {t('refresh')}
      </button>
    </>
  );
}

/** Pago confirmado: lo que se guardó para un posible reintento (email, nombre, provincia) se borra del navegador (dispositivos compartidos). */
export function ClearCheckoutDraft({ initiativeId }: { initiativeId: number }) {
  useEffect(() => clearDraft(initiativeId), [initiativeId]);
  return null;
}
