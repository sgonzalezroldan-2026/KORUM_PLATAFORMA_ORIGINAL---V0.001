import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';

/**
 * Quién es la persona detrás de una donación: el email al que escribirle y su email canónico (sin alias `+` ni puntos de Gmail), que la identifica aunque
 * aportara varias veces con un invitado y con su cuenta. Lo comparten los avisos por lotes (Sprint 4.4a) y la votación de redimensionamiento (Sprint 4.4b:
 * una persona, un voto). Una cuenta anonimizada o un email que no se puede normalizar no son nadie: ni reciben aviso ni votan.
 */

export const DONOR_RECIPIENT_SELECT = { guestEmail: true, canonicalEmail: true, user: { select: { email: true, canonicalEmail: true, gdprAnonymizedAt: true } } } as const;

export interface DonorRow {
  guestEmail: string | null;
  canonicalEmail: string | null;
  user: { email: string; canonicalEmail: string; gdprAnonymizedAt: Date | null } | null;
}

function canonicalOf(address: string | null): string | null {
  if (!address) return null;
  try {
    return normalizeCanonicalEmail(address);
  } catch {
    return null;
  }
}

export function donorRecipient(row: DonorRow): { toAddress: string; canonical: string } | null {
  const account = row.user && !row.user.gdprAnonymizedAt ? row.user : null;
  const toAddress = row.guestEmail ?? account?.email ?? null;
  const canonical = row.canonicalEmail ?? account?.canonicalEmail ?? canonicalOf(toAddress);
  if (!toAddress || !canonical || canonical.startsWith('anonimizado:')) return null;
  return { toAddress, canonical };
}

/**
 * Filtro de base de datos que **incluye** todas las donaciones de una persona (y quizá alguna más, que `donorRecipient` descarta): las que guardan su
 * email canónico, las de su cuenta y las de invitado antiguas que no lo guardaron.
 */
export function donorCandidatesWhere(canonical: string) {
  return { OR: [{ canonicalEmail: canonical }, { canonicalEmail: null, user: { canonicalEmail: canonical } }, { canonicalEmail: null, userId: null, guestEmail: { not: null } }] };
}
