/**
 * Validación oficial de NIF, NIE y CIF (QA-REG03): módulo 23 para personas y dígito de control para entidades. Es pura para poder avisar en
 * vivo en el checkout; el servidor la vuelve a ejecutar siempre.
 */

export type TaxIdKind = 'DNI' | 'NIE' | 'NIF_SPECIAL' | 'CIF';

export type TaxIdValidation = { valid: true; normalized: string; kind: TaxIdKind } | { valid: false };

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const CIF_CONTROL_LETTERS = 'JABCDEFGHI';
/** Estas entidades llevan letra de control; estas otras, cifra; las demás admiten ambas. */
const CIF_LETTER_ONLY = 'NPQRSW';
const CIF_DIGIT_ONLY = 'ABEH';

export const normalizeTaxId = (raw: string): string => raw.toUpperCase().replace(/[\s.\-/]/g, '');

const personLetter = (digits: string) => DNI_LETTERS[Number(digits) % 23];

function cifControlDigit(digits: string): number {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const value = Number(digits[index]);
    // Las posiciones impares se doblan y se suman sus cifras.
    sum += index % 2 === 1 ? value : Math.floor((value * 2) / 10) + (value * 2) % 10;
  }
  return (10 - (sum % 10)) % 10;
}

export function validateTaxId(raw: string): TaxIdValidation {
  const id = normalizeTaxId(raw);
  if (/^\d{8}[A-Z]$/.test(id)) {
    return personLetter(id.slice(0, 8)) === id[8] ? { valid: true, normalized: id, kind: 'DNI' } : { valid: false };
  }
  if (/^[XYZ]\d{7}[A-Z]$/.test(id)) {
    const digits = `${'XYZ'.indexOf(id[0]!)}${id.slice(1, 8)}`;
    return personLetter(digits) === id[8] ? { valid: true, normalized: id, kind: 'NIE' } : { valid: false };
  }
  if (/^[KLM]\d{7}[A-Z]$/.test(id)) {
    return personLetter(id.slice(1, 8)) === id[8] ? { valid: true, normalized: id, kind: 'NIF_SPECIAL' } : { valid: false };
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(id)) {
    const type = id[0]!;
    const control = cifControlDigit(id.slice(1, 8));
    const asDigit = String(control);
    const asLetter = CIF_CONTROL_LETTERS[control];
    const given = id[8];
    const matches = CIF_LETTER_ONLY.includes(type) ? given === asLetter : CIF_DIGIT_ONLY.includes(type) ? given === asDigit : given === asDigit || given === asLetter;
    return matches ? { valid: true, normalized: id, kind: 'CIF' } : { valid: false };
  }
  return { valid: false };
}
