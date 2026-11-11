/**
 * Campos del proveedor de una liquidación (Sprint 4.4a): nombre e IBAN. Funciones puras y sin dependencias de servidor: las usan el formulario del panel
 * (aviso junto al campo) y el servidor (que es quien decide).
 */

export const PROVIDER_NAME_MIN = 2;
export const PROVIDER_NAME_MAX = 120;

/** Mayúsculas y sin espacios ni guiones (`es91 2100-0418…` → `ES912100…`). */
export const compactIban = (raw: string): string => raw.toUpperCase().replace(/[\s-]/g, '');

/**
 * IBAN válido: país, dígitos de control y cuenta, con el módulo 97 de la norma ISO 13616. Para España, además, 24 caracteres. Solo se aceptan los países
 * de la zona SEPA en la forma (dos letras): el reparto de Paycomet es en euros.
 */
export function validateIban(raw: string): { valid: true; normalized: string; last4: string } | { valid: false } {
  const iban = compactIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return { valid: false };
  if (iban.startsWith('ES') && iban.length !== 24) return { valid: false };
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  if (remainder !== 1) return { valid: false };
  return { valid: true, normalized: iban, last4: iban.slice(-4) };
}

/** Proveedor de una liquidación, ya validado y descifrado en el servidor: lo recibe el proveedor de pagos para resolver su cuenta (pendiente de Paycomet). */
export interface ProviderPayoutBeneficiary {
  iban: string;
  taxId: string;
  name: string;
}
