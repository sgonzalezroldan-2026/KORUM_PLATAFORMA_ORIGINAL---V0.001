import { CRYPTO_CONTEXT, dataHmac, HMAC_PURPOSE, openValue, sealValue, type Keyring } from '@/core/security/crypto';
import { validateTaxId } from './tax-id';

/**
 * Cifrado de los NIF que guarda KORUM (CUMPLIMIENTO §5.2: sin excepciones, porque un autónomo factura con su DNI). Cada NIF se cifra con
 * su propio contexto: el de un donante, el de un comercio de una entidad o el de una factura concreta. Es el único sitio que cifra un NIF,
 * y la rotación de claves (`key-rotation.ts`) usa estos mismos contextos. El del donante se valida aquí (lo exige el Modelo 182); el de un
 * comercio o una factura lo valida quien lo recibe (`issueInvoice`, el alta del comercio), y aquí solo se normaliza.
 */

export class InvalidTaxIdError extends RangeError {
  constructor(subject: string) {
    super(`El NIF ${subject} no es válido.`);
    this.name = 'InvalidTaxIdError';
  }
}

function normalizedOrThrow(rawTaxId: string, subject: string): string {
  const validation = validateTaxId(rawTaxId);
  if (!validation.valid) throw new InvalidTaxIdError(subject);
  return validation.normalized;
}

/** Lo que guarda el checkout del NIF de un donante (Modelo 182): cifrado, su HMAC para la recurrencia y la versión de clave. */
export function sealDonorTaxId(rawTaxId: string, keys: { keyring: Keyring; hmacSecret: string }) {
  const normalized = normalizedOrThrow(rawTaxId, 'del donante');
  const { sealed, keyVersion } = sealValue(keys.keyring, normalized, CRYPTO_CONTEXT.donorTaxId);
  return { donorTaxIdEnc: sealed, donorTaxIdHmac: dataHmac(keys.hmacSecret, HMAC_PURPOSE.donorTaxId, normalized), donorTaxIdKeyVersion: keyVersion };
}

export const openDonorTaxId = (keyring: Keyring, sealed: string, keyVersion: number | null) => openValue(keyring, sealed, keyVersion, CRYPTO_CONTEXT.donorTaxId);

/** Mayúsculas y sin separadores (`b-12.345.678` → `B12345678`). */
function compactTaxId(rawTaxId: string, subject: string): string {
  const compact = rawTaxId.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{5,20}$/.test(compact)) throw new InvalidTaxIdError(subject);
  return compact;
}

/** CIF o NIF de un comercio amigo, atado a su entidad. */
export function sealSponsorTaxId(keyring: Keyring, organizationId: string, rawTaxId: string) {
  const { sealed, keyVersion } = sealValue(keyring, compactTaxId(rawTaxId, 'del comercio'), CRYPTO_CONTEXT.sponsorTaxId(organizationId));
  return { cifEnc: sealed, cifKeyVersion: keyVersion };
}

export const openSponsorTaxId = (keyring: Keyring, sponsor: { organizationId: string; cifEnc: string; cifKeyVersion: number | null }) =>
  openValue(keyring, sponsor.cifEnc, sponsor.cifKeyVersion, CRYPTO_CONTEXT.sponsorTaxId(sponsor.organizationId));

/** NIF del destinatario de una factura, atado a su número: no se puede trasladar a otra factura. */
export function sealInvoiceRecipientTaxId(keyring: Keyring, invoiceNumber: string, rawTaxId: string) {
  const { sealed, keyVersion } = sealValue(keyring, compactTaxId(rawTaxId, 'del destinatario de la factura'), CRYPTO_CONTEXT.invoiceRecipientTaxId(invoiceNumber));
  return { recipientTaxIdEnc: sealed, recipientTaxIdKeyVersion: keyVersion };
}

export const openInvoiceRecipientTaxId = (keyring: Keyring, invoice: { invoiceNumber: string; recipientTaxIdEnc: string; recipientTaxIdKeyVersion: number | null }) =>
  openValue(keyring, invoice.recipientTaxIdEnc, invoice.recipientTaxIdKeyVersion, CRYPTO_CONTEXT.invoiceRecipientTaxId(invoice.invoiceNumber));
