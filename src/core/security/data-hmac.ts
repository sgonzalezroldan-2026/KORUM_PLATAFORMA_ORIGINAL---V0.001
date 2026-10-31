import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC de datos con `DATA_HMAC_SECRET`. `purpose` separa los usos: el HMAC de una IP nunca coincide con el de una cookie aunque el valor
 * sea el mismo. Es lo que permite buscar o comparar sin guardar el dato en claro (Regla 01 §5).
 */

const MIN_SECRET_LENGTH = 32;

export function dataHmac(secret: string, purpose: string, value: string): string {
  if (secret.length < MIN_SECRET_LENGTH) throw new RangeError(`DATA_HMAC_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres`);
  return createHmac('sha256', secret).update(`${purpose}\n${value}`).digest('hex');
}

/** Comparación en tiempo constante (no revela cuántos caracteres coinciden). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
