import { randomInt } from 'node:crypto';

/**
 * Código no adivinable de la puerta de un evento (Sprint 4.7): 10 caracteres en base 32 (50 bits), generado al crear el primer PIN. Va en el enlace de la portería
 * en lugar del identificador numérico, que se podía recorrer: sin conocer el código no se puede ni intentar un PIN. El enlace se comparte con los voluntarios,
 * como el PIN; cambiar el PIN no cambia el código.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const GATE_CODE_PATTERN = /^[a-z2-7]{10}$/;

export function generateGateCode(): string {
  return Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}
