'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef } from 'react';
import { KorumMark } from '@/components/brand/korum-mark';
import { useHydrated } from '@/components/ui/use-hydrated';
import type { CheckoutMethod } from '@/core/checkout/checkout-limits';
import { useRouter } from '@/i18n/navigation';
import { initiativePath } from '@/lib/seo/portal-routes';
import type { CheckoutStart } from '@/services/checkout/checkout.service';
import { isLocale } from '@/i18n/routing';
import { draftFromHint, initialDraft, loadDraft, type CheckoutOffer, type RetryHint } from './checkout-draft';
import { CheckoutForm } from './checkout-form';

/**
 * Checkout en 10 segundos (`id="checkout-modal"`, `function openCheckoutModal` del prototipo; QA-F04 · QA-F07 · QA-F10). Diálogo nativo encima
 * de la ficha: atrapa el foco, se cierra con Escape y al cerrarse vuelve a la ficha. Tras un pago rechazado (`?reintento=1`) recupera lo elegido
 * de `sessionStorage`; eso solo existe en el navegador, así que el formulario se vuelve a montar con lo recuperado una vez hidratado.
 */

export interface CheckoutModalProps {
  offer: CheckoutOffer;
  restore: boolean;
  /** Forma de pago propuesta al volver (`?metodo=`): «Pagar con tarjeta» tras un Bizum rechazado y al revés. */
  restoreMethod: CheckoutMethod | null;
  /** Lo elegido según la aportación rechazada (por si `sessionStorage` está vacío en esta pestaña). */
  retryHint: RetryHint | null;
  startAction: (payload: unknown) => Promise<CheckoutStart>;
}

export function CheckoutModal({ offer, restore, restoreMethod, retryHint, startAction }: CheckoutModalProps) {
  const t = useTranslations('portal.checkout');
  const router = useRouter();
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  // `false` en el servidor y al hidratar, `true` después: lo que dependa del navegador no descuadra el HTML.
  const hydrated = useHydrated();
  const restored = useMemo(() => {
    if (!hydrated || !restore) return null;
    return loadDraft(offer, restoreMethod) ?? (retryHint ? draftFromHint(offer, retryHint, restoreMethod, locale) : null);
  }, [hydrated, restore, offer, restoreMethod, retryHint, locale]);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) {
      node.showModal();
      // El foco va al título (qué se paga), no al botón de cerrar: un lector de pantalla empieza por lo importante.
      document.getElementById(headingId)?.focus();
    }
  }, [headingId]);

  return (
    <dialog
      ref={dialog}
      id="checkout-modal"
      aria-labelledby={headingId}
      onClose={() => router.replace(initiativePath(offer.orgSlug, offer.initiativeId), { scroll: false })}
      className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-3xl bg-white p-0 text-ink shadow-2xl backdrop:bg-varsity-navy-deep/70 sm:w-[calc(100%-2rem)]"
    >
      <div className="korum-trust-vault space-y-4 rounded-3xl! border-0! p-5 sm:p-6">
        <div className="space-y-2 border-b border-patio-rule pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <KorumMark size={40} decorative className="shrink-0" />
              {/* En taquilla no hay meta que esperar: solo se habla de pago seguro (Regla 03 §4, revisión de experiencia del 3.4). */}
              <p className="inline-flex rounded-full border border-emerald-700 bg-emerald-50 px-2 py-0.5 text-xs font-extrabold text-emerald-900">
                <span aria-hidden="true">{'🔒 '}</span>
                {offer.kind === 'TICKET' ? t('custodyTickets') : t('custody')}
              </p>
            </div>
            <button type="button" onClick={() => dialog.current?.close()} aria-label={t('close')} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xl font-bold text-ink-soft hover:bg-patio-rule">
              <span aria-hidden="true">{'✕'}</span>
            </button>
          </div>
          <h2 id={headingId} lang={offer.contentLang} tabIndex={-1} className="font-joy text-lg font-bold text-varsity-navy wrap-anywhere focus:outline-none">
            {offer.title}
          </h2>
          <p className="text-sm text-ink-soft">{t('recipient', { legalName: offer.legalName })}</p>
        </div>

        {offer.closedReason ? (
          <div role="status" className="space-y-3 rounded-2xl bg-emerald-50 p-4 text-center">
            <p className="font-joy text-lg font-bold text-emerald-950">{t('closed.title')}</p>
            <p className="text-ink">{t(`closed.${offer.closedReason}`)}</p>
            <button type="button" onClick={() => dialog.current?.close()} className="tactile-btn w-full rounded-2xl! py-3!">
              {t('close')}
            </button>
          </div>
        ) : (
          <CheckoutForm key={restored ? 'restored' : 'fresh'} offer={offer} initial={restored ?? initialDraft(offer)} askTaxIdAgain={restored?.wantsCertificate ?? false} startAction={startAction} />
        )}
      </div>
    </dialog>
  );
}
