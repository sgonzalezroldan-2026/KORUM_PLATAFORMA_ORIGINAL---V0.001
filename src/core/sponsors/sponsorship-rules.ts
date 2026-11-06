import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CHECKOUT_METHODS } from '@/core/checkout/checkout-limits';
import { bpsOf } from '@/core/finance/money';

/**
 * Reglas del patrocinio de comercios (Sprint 3.5, QA-F05). Funciones puras: el servidor valida lo que envía el navegador y recalcula el
 * fee, el IVA y el total; el comercio solo elige el nivel entre los que ofrece la entidad. Regla 02 §5: el 100 % del nivel elegido suma
 * íntegro a la iniciativa y el fee (15 % por defecto + IVA) se cobra **encima**.
 */

/**
 * IVA del fee de gestión publicitaria (21 %). Suposición hasta que la asesoría fiscal lo confirme (skill de pagos §2: «el tipo y la base
 * del IVA los confirma la asesoría fiscal»); es el mismo tipo que usa la semilla y el predeterminado de `Invoice.taxRateBps`.
 */
export const SPONSOR_FEE_VAT_BPS = 2100;

/** Meses que dura el distintivo de «Comercio amigo» desde el pago. */
export const SPONSORSHIP_MONTHS = 12;

export type SponsorLevel = 'ORO' | 'PLATA' | 'BRONCE';

/** Orden estricto del directorio público: ORO > PLATA > BRONCE (QA-F05). */
export const SPONSOR_LEVEL_RANK: Record<SponsorLevel, number> = { ORO: 3, PLATA: 2, BRONCE: 1 };

/**
 * Categoría según el importe elegido y los tres niveles de la entidad: el más alto es ORO, el más bajo BRONCE y el del medio PLATA (como en
 * el prototipo, `confirmSponsorship`). Si la entidad ofrece menos de tres niveles, el mayor sigue siendo ORO.
 */
export function sponsorLevelOf(tierCents: number, tiersCents: readonly number[]): { level: SponsorLevel; rank: number } {
  const sorted = [...tiersCents].sort((a, b) => a - b);
  const level: SponsorLevel = tierCents >= (sorted.at(-1) ?? tierCents) ? 'ORO' : tierCents <= (sorted[0] ?? tierCents) ? 'BRONCE' : 'PLATA';
  return { level, rank: SPONSOR_LEVEL_RANK[level] };
}

export interface SponsorCharge {
  /** Lo que llega íntegro a la iniciativa (o a su bolsa Matching 2x). */
  amountCents: number;
  /** Fee de gestión publicitaria, encima del importe. */
  feeCents: number;
  /** IVA del fee. */
  vatCents: number;
  /** Lo que cobra Paycomet al comercio. */
  totalChargedCents: number;
}

export function calculateSponsorCharge(amountCents: number, feeBps: number): SponsorCharge {
  const feeCents = bpsOf(amountCents, feeBps);
  const vatCents = bpsOf(feeCents, SPONSOR_FEE_VAT_BPS);
  return { amountCents, feeCents, vatCents, totalChargedCents: amountCents + feeCents + vatCents };
}

/** Ordena el directorio: primero el nivel más alto; a igual nivel, el más antiguo (no se premia por pagar a última hora). */
export function sortSponsorsByLevel<T extends { tierRank: number; id: number }>(sponsors: readonly T[]): T[] {
  return [...sponsors].sort((a, b) => b.tierRank - a.tierRank || a.id - b.id);
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const sponsorshipInputSchema = z.object({
  orgSlug: z.string().min(1).max(80),
  initiativeId: z.number().int().positive(),
  locale: z.enum(['es', 'ca', 'en']),
  method: z.enum(CHECKOUT_METHODS),
  /** Uno de los niveles de la entidad: el servidor lo comprueba contra `Organization.sponsorTiersCents`. */
  tierCents: z.number().int().positive(),
  /** Destinar el patrocinio a la bolsa *Matching 2x* en lugar de sumarlo a la hucha. */
  matchingPool: z.boolean(),
  businessName: text(2, 120),
  taxId: text(5, 20),
  contactPerson: text(2, 120),
  phone: text(6, 30).regex(/^[+\d][\d\s().-]{5,}$/),
  email: z.email().max(254),
  /** Tipo de negocio (panadería, librería…): opcional. */
  sector: z.string().trim().max(80),
  /** Ventaja para las familias: opcional. */
  promo: z.string().trim().max(140),
  promoCode: z.string().trim().max(30).regex(/^[A-Za-z0-9_-]*$/),
  autoRenew: z.boolean()
});

export type SponsorshipInput = z.infer<typeof sponsorshipInputSchema>;

export type SponsorshipInvalidField = 'form' | 'email' | 'taxId' | 'phone' | 'tier' | 'matching';

/** Primer campo que falla, para que el formulario lleve el foco a él. */
export function sponsorshipInvalidField(raw: unknown): SponsorshipInvalidField {
  const result = sponsorshipInputSchema.safeParse(raw);
  if (result.success) return 'form';
  const path = result.error.issues[0]?.path[0];
  if (path === 'email') return 'email';
  if (path === 'taxId') return 'taxId';
  if (path === 'phone') return 'phone';
  if (path === 'tierCents') return 'tier';
  return 'form';
}

/** Pedido de un patrocinio: aleatorio, sin datos del comercio. Las donaciones usan `KD` y las entradas `KT`. */
export function newSponsorshipOrder(): string {
  return `KS${randomBytes(8).toString('hex').toUpperCase()}`;
}

/** Fin de la vigencia: doce meses naturales desde el pago. */
export function sponsorshipExpiry(paidAt: Date): Date {
  const expiry = new Date(paidAt);
  expiry.setUTCMonth(expiry.getUTCMonth() + SPONSORSHIP_MONTHS);
  return expiry;
}
