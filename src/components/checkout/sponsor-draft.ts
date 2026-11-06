import type { CheckoutMethod } from '@/core/checkout/checkout-limits';
import { sponsorLevelOf } from '@/core/sponsors/sponsorship-rules';

/**
 * Lo que el comercio va escribiendo en la pestaña «Soy comercio local» y cómo se recupera tras un pago rechazado (QA-F10). Sin React, para
 * probarlo aparte. Se guarda en `sessionStorage` (solo esta pestaña) antes de ir a pagar; **el CIF o NIF nunca se guarda en el navegador**: si
 * hace falta, se vuelve a pedir.
 */

export interface SponsorOffer {
  /** Niveles de la entidad de menor a mayor: Bronce, Plata y Oro. */
  tiersCents: number[];
  /** Fee de gestión publicitaria en puntos básicos (1500 = 15 %). */
  feeBps: number;
  /** Falso si la iniciativa ya tiene bolsa Matching 2x (activa o pendiente de aprobar). */
  matchingAvailable: boolean;
}

export interface SponsorDraft {
  tierCents: number;
  matchingPool: boolean;
  businessName: string;
  contactPerson: string;
  phone: string;
  email: string;
  sector: string;
  promo: string;
  promoCode: string;
  autoRenew: boolean;
}

/** El nivel sugerido (⭐) es el del medio: Plata. */
export function suggestedTier(offer: SponsorOffer): number {
  const sorted = [...offer.tiersCents].sort((a, b) => a - b);
  return sorted.find((cents) => sponsorLevelOf(cents, sorted).level === 'PLATA') ?? sorted[0] ?? 0;
}

export function initialSponsorDraft(offer: SponsorOffer): SponsorDraft {
  return { tierCents: suggestedTier(offer), matchingPool: false, businessName: '', contactPerson: '', phone: '', email: '', sector: '', promo: '', promoCode: '', autoRenew: true };
}

const storageKey = (initiativeId: number) => `korum:sponsor:${initiativeId}`;

export function saveSponsorDraft(initiativeId: number, draft: SponsorDraft): void {
  try {
    window.sessionStorage.setItem(storageKey(initiativeId), JSON.stringify(draft));
  } catch {
    // Sin almacenamiento el pago sigue funcionando: solo se pierde la recuperación.
  }
}

/** Recupera el borrador comprobando cada campo: lo guardado podría ser de otra versión o estar manipulado. */
export function loadSponsorDraft(initiativeId: number, offer: SponsorOffer): SponsorDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(window.sessionStorage.getItem(storageKey(initiativeId)) ?? 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const base = initialSponsorDraft(offer);
  const text = (key: string, max: number) => (typeof value[key] === 'string' ? (value[key] as string).slice(0, max) : '');
  return {
    tierCents: typeof value.tierCents === 'number' && offer.tiersCents.includes(value.tierCents) ? value.tierCents : base.tierCents,
    matchingPool: offer.matchingAvailable && value.matchingPool === true,
    businessName: text('businessName', 120),
    contactPerson: text('contactPerson', 120),
    phone: text('phone', 30),
    email: text('email', 254),
    sector: text('sector', 80),
    promo: text('promo', 140),
    promoCode: text('promoCode', 30),
    autoRenew: value.autoRenew !== false
  };
}

export function clearSponsorDraft(initiativeId: number): void {
  try {
    window.sessionStorage.removeItem(storageKey(initiativeId));
  } catch {
    // Sin almacenamiento no se guardó nada.
  }
}

export function buildSponsorPayload(input: { orgSlug: string; initiativeId: number; locale: 'es' | 'ca' | 'en'; method: CheckoutMethod; draft: SponsorDraft; taxId: string }) {
  const { draft } = input;
  return {
    orgSlug: input.orgSlug,
    initiativeId: input.initiativeId,
    locale: input.locale,
    method: input.method,
    tierCents: draft.tierCents,
    matchingPool: draft.matchingPool,
    businessName: draft.businessName.trim(),
    taxId: input.taxId.trim(),
    contactPerson: draft.contactPerson.trim(),
    phone: draft.phone.trim(),
    email: draft.email.trim(),
    sector: draft.sector.trim(),
    promo: draft.promo.trim(),
    promoCode: draft.promoCode.trim(),
    autoRenew: draft.autoRenew
  };
}
