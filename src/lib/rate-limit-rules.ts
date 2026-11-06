import { MAX_TICKETS_PER_ORDER } from '@/core/checkout/checkout-limits';
import type { PurgeRule, RateLimitRule } from './rate-limit';

/**
 * Límites de intentos de las entradas públicas que no tienen su propio servicio (Sprint 2.4). Cada regla lleva el prefijo de su clave, para
 * que la tarea de limpieza pueda purgar sus contadores caducados sin tocar los demás.
 */

/** Notificaciones de Paycomet con firma inválida desde una misma red: las válidas no cuentan (se devuelve el intento). */
export const WEBHOOK_INVALID_RULE: RateLimitRule & PurgeRule = { prefix: 'webhook:paycomet:ip:', limit: 60, windowMs: 60_000 };

/** Peticiones de enlace y código de firma por persona y objetivo: evita una avalancha de correos a quien firma. */
export const SIGNATURE_REQUEST_RULE: RateLimitRule & PurgeRule = { prefix: 'double-check:req:', limit: 5, windowMs: 10 * 60_000 };

/** Emails de acceso (enlace, código, invitación) por destinatario: nadie puede llenar la bandeja de otra persona pidiendo enlaces. */
export const AUTH_EMAIL_RULE: RateLimitRule & PurgeRule = { prefix: 'auth:mail:', limit: 5, windowMs: 15 * 60_000 };

/**
 * Peticiones a Better Auth por red y ruta (`/api/auth/*`). Las ventanas las fija `auth-config.ts` (la más larga, 15 minutos); la clave
 * guarda el HMAC de la IP, nunca la IP en claro. La purga usa esa ventana más larga: un contador más viejo ya habría vuelto a cero.
 */
export const AUTH_REQUEST_PREFIX = 'auth:ip:';
export const AUTH_REQUEST_PURGE_RULE: PurgeRule = { prefix: AUTH_REQUEST_PREFIX, windowMs: 15 * 60_000 };

/**
 * Códigos TOTP o de respaldo probados **con una sesión ya abierta** (la de un enlace mágico, al pedir el segundo factor): por persona, para
 * que quien controle el correo no pueda probar códigos sin fin cambiando de red. Al iniciar sesión con contraseña ya los limita Better Auth.
 */
export const AUTH_SECOND_FACTOR_RULE: RateLimitRule & PurgeRule = { prefix: 'auth:2fa:', limit: 10, windowMs: 15 * 60_000 };

/** Altas de entidades por red: el formulario crea cuentas y envía invitaciones. */
export const REGISTRATION_RULE: RateLimitRule & PurgeRule = { prefix: 'register:ip:', limit: 5, windowMs: 60 * 60_000 };

/** Fallos seguidos de códigos TOTP o de respaldo con una sesión ya abierta: al octavo, 24 h de bloqueo y fuera las sesiones sin 2FA (antes de que salte el tope de 10 cada 15 min). */
export const AUTH_SECOND_FACTOR_FAILURE_RULE: RateLimitRule & PurgeRule = { prefix: 'auth:totp-fail:', limit: 8, windowMs: 24 * 3_600_000 };

/**
 * Pagos iniciados por red (checkout de familias, Sprint 3.4). Cada inicio crea una aportación pendiente y, en taquilla, retiene plazas 15
 * minutos: sin este tope, alguien podría bloquear todo el aforo sin pagar. Es generoso porque un colegio entero puede salir por la misma red.
 */
export const CHECKOUT_RULE: RateLimitRule & PurgeRule = { prefix: 'checkout:ip:', limit: 30, windowMs: 15 * 60_000 };

/**
 * Plazas de taquilla retenidas por red **y por evento** (auditoría del Sprint 3.4): el límite de pagos cuenta pedidos, y 30 pedidos de 20 entradas
 * dejarían agotado cualquier evento de colegio sin pagar nada. Cada compra consume tantas unidades como plazas retiene. El tope real es
 * `seatHoldLimit(ticketMax)`: un cuarto del aforo, nunca menos que una compra máxima (20, para que una red compartida como el wifi del colegio
 * pueda comprar) y nunca más que el propio aforo: en una rifa de 40 papeletas, una sola red no puede retenerlas todas.
 */
export const CHECKOUT_SEATS_RULE: RateLimitRule & PurgeRule = { prefix: 'checkout:seats:', limit: MAX_TICKETS_PER_ORDER, windowMs: 15 * 60_000 };
export function seatHoldLimit(ticketMax: number): number {
  const capacity = Math.max(1, Math.floor(ticketMax));
  return Math.min(capacity, Math.max(CHECKOUT_SEATS_RULE.limit, Math.ceil(capacity / 4)));
}
