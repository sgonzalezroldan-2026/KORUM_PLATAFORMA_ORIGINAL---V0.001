import { randomBytes } from 'node:crypto';
import { dataHmac, safeEqual } from '@/core/security/data-hmac';

/** Pedido y enlace firmado de la renovación anual de un comercio (Sprint 4.2d). Solo servidor: usa las claves de la plataforma. */

/** Pedido de una renovación: `KR`, para que su vuelta de la página de pago lleve a la renovación y no a una campaña. */
export function newRenewalOrder(): string {
  return `KR${randomBytes(8).toString('hex').toUpperCase()}`;
}

/**
 * Enlace firmado de la renovación (`?r=`): el comercio y el vencimiento que renueva, con dominio propio. No abre nada del comercio salvo la propia
 * renovación (nombre, nivel e importe), y caduca solo: un distintivo renovado tiene otro vencimiento, así que el enlace antiguo deja de valer.
 */
const TOKEN_PATTERN = /^([1-9]\d{0,9})\.(\d{10,13})\.([0-9a-f]{64})$/;

export function signRenewalToken(secret: string, sponsorId: number, expiresAt: Date): string {
  const payload = `${sponsorId}.${expiresAt.getTime()}`;
  return `${payload}.${dataHmac(secret, 'sponsor-renewal:v1', payload)}`;
}

export function readRenewalToken(secret: string, token: string): { sponsorId: number; expiresAt: Date } | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const payload = `${match[1]}.${match[2]}`;
  if (!safeEqual(dataHmac(secret, 'sponsor-renewal:v1', payload), match[3])) return null;
  const sponsorId = Number(match[1]);
  return Number.isSafeInteger(sponsorId) ? { sponsorId, expiresAt: new Date(Number(match[2])) } : null;
}
