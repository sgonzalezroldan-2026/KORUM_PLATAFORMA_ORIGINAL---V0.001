import { GUARANTEE_MAX_CENTS, MAX_TICKETS_PER_ORDER, type CheckoutMethod } from '@/core/checkout/checkout-limits';
import { maxSelectableTickets, type TicketPricing } from '@/core/checkout/checkout-summary';
import { MoneyParseError, parseEurosToCents, type MoneyLocale } from '@/core/finance/money';
import { clearSponsorDraft } from './sponsor-draft';

/**
 * Lo que la familia va eligiendo en el checkout y cómo se convierte en la petición al servidor. Sin React, para probarlo aparte. Se guarda en
 * `sessionStorage` (solo esta pestaña) antes de ir a pagar: si el pago se rechaza, al volver no se pierde nada (QA-F10). **El NIF nunca se
 * guarda en el navegador**: si hace falta, se vuelve a pedir.
 */

export interface CheckoutOffer {
  orgSlug: string;
  initiativeId: number;
  title: string;
  legalName: string;
  vertical: string;
  contentLang?: string;
  kind: 'DONATION' | 'TICKET';
  /** Por qué ya no se puede pagar, o `null` si se puede. */
  closedReason: 'achieved' | 'soldOut' | 'ended' | null;
  donation: { presetsCents: number[]; defaultIdx: number } | null;
  ticket: { subtype: 'EVENT' | 'RAFFLE'; available: number; max: number; venue: string | null; pricing: TicketPricing } | null;
  /** Grupos del reto en el orden de la entidad; vacío si el reto está desactivado. */
  groups: Array<{ group: string; items: string[] }>;
  initialGroup: string | null;
  plaque: boolean;
  guarantee: { suggestedCents: number; choicesCents: number[] };
  /** La entidad puede emitir certificado fiscal (Ley 49/2002 verificada): solo entonces se ofrece el NIF. */
  certificate: boolean;
  provinces: Array<{ code: string; name: string }>;
  /** Email de la cuenta si hay sesión: entonces no se pide. */
  sessionEmail: string | null;
}

export interface CheckoutDraft {
  /** Botón de importe elegido, o `null` si se escribe otro importe. */
  presetIdx: number | null;
  customAmount: string;
  quantity: number;
  groupName: string;
  /** El check de la aportación voluntaria: **desmarcado** al abrir (Regla 03 §3). */
  guaranteeOn: boolean;
  guaranteeCents: number;
  customGuarantee: string;
  email: string;
  wantsCertificate: boolean;
  fullName: string;
  provinceCode: string;
  method: CheckoutMethod;
}

export function initialDraft(offer: CheckoutOffer): CheckoutDraft {
  const presets = offer.donation?.presetsCents ?? [];
  const defaultIdx = offer.donation && offer.donation.defaultIdx < presets.length ? offer.donation.defaultIdx : presets.length > 0 ? 0 : null;
  return {
    presetIdx: defaultIdx,
    customAmount: '',
    quantity: offer.ticket ? Math.min(1, maxSelectableTickets(offer.ticket.available)) : 1,
    groupName: offer.initialGroup ?? '',
    guaranteeOn: false,
    guaranteeCents: offer.guarantee.suggestedCents,
    customGuarantee: '',
    email: '',
    wantsCertificate: false,
    fullName: '',
    provinceCode: '',
    method: 'BIZUM'
  };
}

const storageKey = (initiativeId: number) => `korum:checkout:${initiativeId}`;

/** Guarda el borrador para recuperarlo tras un pago rechazado. Si el navegador no deja (modo privado), simplemente no se guarda. */
export function saveDraft(initiativeId: number, draft: CheckoutDraft): void {
  try {
    window.sessionStorage.setItem(storageKey(initiativeId), JSON.stringify(draft));
  } catch {
    // Sin almacenamiento la compra sigue funcionando: solo se pierde la recuperación.
  }
}

/** Recupera el borrador comprobando cada campo: lo guardado podría ser de otra versión o estar manipulado. */
export function loadDraft(offer: CheckoutOffer, method: CheckoutMethod | null): CheckoutDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(window.sessionStorage.getItem(storageKey(offer.initiativeId)) ?? 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const base = initialDraft(offer);
  const text = (key: string, max: number) => (typeof value[key] === 'string' ? (value[key] as string).slice(0, max) : '');
  const presets = offer.donation?.presetsCents.length ?? 0;
  const presetIdx = typeof value.presetIdx === 'number' && Number.isInteger(value.presetIdx) && value.presetIdx >= 0 && value.presetIdx < presets ? value.presetIdx : null;
  const quantity = typeof value.quantity === 'number' && Number.isInteger(value.quantity) ? value.quantity : base.quantity;
  const guaranteeCents = typeof value.guaranteeCents === 'number' && Number.isSafeInteger(value.guaranteeCents) ? value.guaranteeCents : base.guaranteeCents;
  const groupName = text('groupName', 80);
  const allGroups = offer.groups.flatMap((cluster) => cluster.items);
  const provinceCode = text('provinceCode', 2);
  return {
    presetIdx: presetIdx ?? (text('customAmount', 12) === '' ? base.presetIdx : null),
    customAmount: text('customAmount', 12),
    quantity: offer.ticket ? Math.min(Math.max(1, quantity), Math.max(1, maxSelectableTickets(offer.ticket.available))) : 1,
    groupName: allGroups.includes(groupName) ? groupName : base.groupName,
    guaranteeOn: value.guaranteeOn === true,
    guaranteeCents: Math.min(Math.max(0, guaranteeCents), GUARANTEE_MAX_CENTS),
    customGuarantee: text('customGuarantee', 8),
    email: offer.sessionEmail ? '' : text('email', 254),
    wantsCertificate: offer.certificate && value.wantsCertificate === true,
    fullName: text('fullName', 120),
    provinceCode: offer.provinces.some((province) => province.code === provinceCode) ? provinceCode : '',
    method: method ?? (value.method === 'CARD' ? 'CARD' : 'BIZUM')
  };
}

/** Lee un importe escrito a mano; `null` si no se entiende o es negativo. */
export function parseTypedCents(text: string, locale: MoneyLocale): number | null {
  if (text.trim() === '') return null;
  try {
    const cents = parseEurosToCents(text, locale);
    return cents >= 0 ? cents : null;
  } catch (error) {
    if (error instanceof MoneyParseError) return null;
    throw error;
  }
}

export function donationCents(offer: CheckoutOffer, draft: CheckoutDraft, locale: MoneyLocale): number | null {
  if (draft.presetIdx !== null) return offer.donation?.presetsCents[draft.presetIdx] ?? null;
  return parseTypedCents(draft.customAmount, locale);
}

/** La aportación voluntaria que se cobra: `0` mientras el check esté desmarcado. */
export function guaranteeCents(draft: CheckoutDraft): number {
  // Mismo tope que el resumen: lo que se envía es siempre lo que se ha enseñado.
  return draft.guaranteeOn ? Math.min(Math.max(0, draft.guaranteeCents), GUARANTEE_MAX_CENTS) : 0;
}

export const clampQuantity = (quantity: number, available: number): number => Math.min(Math.max(1, quantity), Math.max(1, Math.min(MAX_TICKETS_PER_ORDER, available)));

/** La petición que se envía al servidor. Solo lo que elige la persona: precios y gastos los vuelve a calcular el servidor. */
export function buildCheckoutPayload(offer: CheckoutOffer, draft: CheckoutDraft, taxId: string, locale: MoneyLocale, method: CheckoutMethod) {
  const common = {
    orgSlug: offer.orgSlug,
    initiativeId: offer.initiativeId,
    locale,
    method,
    groupName: offer.groups.length > 0 && draft.groupName !== '' ? draft.groupName : null,
    email: offer.sessionEmail ? null : draft.email.trim()
  };
  if (offer.kind === 'TICKET') return { kind: 'TICKET' as const, ...common, quantity: draft.quantity };
  const fiscal = offer.certificate && draft.wantsCertificate ? { taxId: taxId.trim(), fullName: draft.fullName.trim(), provinceCode: draft.provinceCode } : null;
  return { kind: 'DONATION' as const, ...common, amountCents: donationCents(offer, draft, locale) ?? 0, guaranteeCents: guaranteeCents(draft), fiscal };
}

/**
 * Lo que la vuelta de un pago rechazado lleva en la URL (`?importe=&aportacion=&cantidad=`), sacado de la aportación guardada: si al volver de
 * la app de Bizum el navegador abre otra pestaña, `sessionStorage` está vacío y aun así no se pierde lo elegido. Nunca lleva email ni NIF.
 */
export interface RetryHint {
  amountCents: number | null;
  guaranteeCents: number | null;
  quantity: number | null;
}

/** Importe en céntimos como se escribiría a mano en el campo (`1250` → `12,50` o `12.50`), sin pasar por coma flotante. */
function centsToInput(cents: number, locale: MoneyLocale): string {
  const fraction = cents % 100;
  const whole = String(Math.floor(cents / 100));
  return fraction === 0 ? whole : `${whole}${locale === 'en' ? '.' : ','}${String(fraction).padStart(2, '0')}`;
}

export function draftFromHint(offer: CheckoutOffer, hint: RetryHint, method: CheckoutMethod | null, locale: MoneyLocale): CheckoutDraft {
  const base = initialDraft(offer);
  const presets = offer.donation?.presetsCents ?? [];
  const amount = hint.amountCents !== null && Number.isSafeInteger(hint.amountCents) && hint.amountCents > 0 ? hint.amountCents : null;
  const matched = amount === null ? -1 : presets.indexOf(amount);
  const guarantee = hint.guaranteeCents !== null && Number.isSafeInteger(hint.guaranteeCents) ? Math.min(Math.max(0, hint.guaranteeCents), GUARANTEE_MAX_CENTS) : 0;
  return {
    ...base,
    presetIdx: amount === null ? base.presetIdx : matched >= 0 ? matched : null,
    customAmount: amount !== null && matched < 0 ? centsToInput(amount, locale) : '',
    quantity: offer.ticket && hint.quantity !== null ? clampQuantity(hint.quantity, offer.ticket.available) : base.quantity,
    guaranteeOn: guarantee > 0,
    guaranteeCents: guarantee > 0 ? guarantee : base.guaranteeCents,
    method: method ?? base.method
  };
}

/** Borra el borrador guardado (pago confirmado), también el del comercio. Si el navegador no deja, no hay nada que borrar. */
export function clearDraft(initiativeId: number): void {
  clearSponsorDraft(initiativeId);
  try {
    window.sessionStorage.removeItem(storageKey(initiativeId));
  } catch {
    // Sin almacenamiento no se guardó nada.
  }
}
