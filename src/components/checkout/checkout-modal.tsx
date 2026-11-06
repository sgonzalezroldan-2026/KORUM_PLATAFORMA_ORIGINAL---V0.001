'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { KorumMark } from '@/components/brand/korum-mark';
import { useHydrated } from '@/components/ui/use-hydrated';
import type { CheckoutMethod } from '@/core/checkout/checkout-limits';
import { useRouter } from '@/i18n/navigation';
import { initiativePath } from '@/lib/seo/portal-routes';
import type { CheckoutStart } from '@/services/checkout/checkout.service';
import type { SponsorshipStart } from '@/services/checkout/sponsorship.service';
import { isLocale } from '@/i18n/routing';
import { draftFromHint, initialDraft, loadDraft, type CheckoutOffer, type RetryHint } from './checkout-draft';
import { CheckoutForm } from './checkout-form';
import { initialSponsorDraft, loadSponsorDraft, type SponsorDraft, type SponsorOffer } from './sponsor-draft';
import { SponsorForm } from './sponsor-form';

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
  /** Condiciones del patrocinio de esta iniciativa, o `null` si no admite comercios (taquilla, rifa o campaña cerrada). */
  sponsor: SponsorOffer | null;
  /** Pestaña con la que se abre el diálogo (`?modo=comercio`). */
  initialTab: 'family' | 'sponsor';
  startSponsorAction: (payload: unknown) => Promise<SponsorshipStart>;
}

export function CheckoutModal({ offer, restore, restoreMethod, retryHint, startAction, sponsor, initialTab, startSponsorAction }: CheckoutModalProps) {
  const t = useTranslations('portal.checkout');
  const router = useRouter();
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const tabsId = useId();
  const showTabs = sponsor !== null && offer.kind === 'DONATION' && offer.closedReason === null;
  const [tab, setTab] = useState<'family' | 'sponsor'>(showTabs ? initialTab : 'family');
  // Lo escrito en la pestaña de comercio se conserva en memoria al pasar a la de familia y volver (el formulario se desmonta al cambiar).
  const [typed, setTyped] = useState<{ draft: SponsorDraft; taxId: string } | null>(null);
  // `false` en el servidor y al hidratar, `true` después: lo que dependa del navegador no descuadra el HTML.
  const hydrated = useHydrated();
  const restored = useMemo(() => {
    if (!hydrated || !restore) return null;
    return loadDraft(offer, restoreMethod) ?? (retryHint ? draftFromHint(offer, retryHint, restoreMethod, locale) : null);
  }, [hydrated, restore, offer, restoreMethod, retryHint, locale]);
  const restoredSponsor = useMemo(() => (hydrated && restore && sponsor ? loadSponsorDraft(offer.initiativeId, sponsor) : null), [hydrated, restore, sponsor, offer.initiativeId]);

  // Flechas, Inicio y Fin cambian de pestaña, como en cualquier lista de pestañas (WAI-ARIA).
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' || event.key === 'ArrowLeft' ? 'family' : 'sponsor';
    setTab(next);
    document.getElementById(`${tabsId}-${next}`)?.focus();
  };

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
          <>
            {showTabs ? (
              <div role="tablist" aria-label={t('tabs.label')} className="grid grid-cols-2 gap-1 rounded-2xl bg-patio-cream p-1">
                {(['family', 'sponsor'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    id={`${tabsId}-${value}`}
                    aria-selected={tab === value}
                    aria-controls={`${tabsId}-panel`}
                    tabIndex={tab === value ? 0 : -1}
                    onClick={() => setTab(value)}
                    onKeyDown={moveTab}
                    className={`min-h-11 rounded-xl px-2 text-sm font-extrabold ${tab === value ? 'bg-varsity-navy text-white shadow' : 'text-ink-soft hover:bg-white'}`}
                  >
                    <span aria-hidden="true">{value === 'family' ? '💛 ' : '🏪 '}</span>
                    {t(`tabs.${value}`)}
                  </button>
                ))}
              </div>
            ) : null}
            <div role={showTabs ? 'tabpanel' : undefined} id={showTabs ? `${tabsId}-panel` : undefined} aria-labelledby={showTabs ? `${tabsId}-${tab}` : undefined} tabIndex={showTabs ? 0 : undefined}>
              {tab === 'sponsor' && sponsor ? (
                <SponsorForm key={restoredSponsor ? 'restored' : 'fresh'} orgSlug={offer.orgSlug} initiativeId={offer.initiativeId} offer={sponsor} initial={typed?.draft ?? restoredSponsor ?? initialSponsorDraft(sponsor)} initialTaxId={typed?.taxId ?? ''} onChange={(draft, taxId) => setTyped({ draft, taxId })} startAction={startSponsorAction} />
              ) : (
                <CheckoutForm key={restored ? 'restored' : 'fresh'} offer={offer} initial={restored ?? initialDraft(offer)} askTaxIdAgain={restored?.wantsCertificate ?? false} startAction={startAction} />
              )}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
