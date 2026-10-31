import { DISPOSABLE_EMAIL_DOMAINS } from './disposable-domains';

/**
 * Email canónico (skill korum-quorum-antifraud §1): una misma bandeja de entrada da siempre el mismo valor, sea cual sea la variante con
 * la que se escriba. Minúsculas, sin sub-alias `+` y, en Gmail, sin puntos y con un único dominio.
 */

export class InvalidEmailError extends Error {
  constructor() {
    super('El email no tiene un formato válido.');
    this.name = 'InvalidEmailError';
  }
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
// Sin espacios ni caracteres invisibles: `ana​@gmail.com` no puede ser una bandeja distinta de `ana@gmail.com`.
const LOCAL_PART = /^[^\s\p{C}]+$/u;
const DOMAIN = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u;

export function normalizeCanonicalEmail(rawEmail: string): string {
  const parts = rawEmail.normalize('NFKC').trim().toLowerCase().split('@');
  if (parts.length !== 2) throw new InvalidEmailError();
  const domainRaw = parts[1]!.replace(/\.$/, '');
  const baseLocal = parts[0]!.split('+')[0]!;
  if (!LOCAL_PART.test(baseLocal) || !DOMAIN.test(domainRaw)) throw new InvalidEmailError();
  if (!GMAIL_DOMAINS.has(domainRaw)) return `${baseLocal}@${domainRaw}`;
  const gmailLocal = baseLocal.replace(/\./g, '');
  if (gmailLocal === '') throw new InvalidEmailError();
  return `${gmailLocal}@gmail.com`;
}

/** Recibe un email canónico. También detecta los subdominios: `x.mailinator.com`. */
export function isDisposableEmail(canonicalEmail: string): boolean {
  const labels = (canonicalEmail.split('@')[1] ?? '').split('.');
  return labels.some((_, index) => DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(index).join('.')));
}
