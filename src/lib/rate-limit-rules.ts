import type { PurgeRule, RateLimitRule } from './rate-limit';

/**
 * Límites de intentos de las entradas públicas que no tienen su propio servicio (Sprint 2.4). Cada regla lleva el prefijo de su clave, para
 * que la tarea de limpieza pueda purgar sus contadores caducados sin tocar los demás.
 */

/** Notificaciones de Paycomet con firma inválida desde una misma red: las válidas no cuentan (se devuelve el intento). */
export const WEBHOOK_INVALID_RULE: RateLimitRule & PurgeRule = { prefix: 'webhook:paycomet:ip:', limit: 60, windowMs: 60_000 };

/** Peticiones de enlace y código de firma por persona y objetivo: evita una avalancha de correos a quien firma. */
export const SIGNATURE_REQUEST_RULE: RateLimitRule & PurgeRule = { prefix: 'double-check:req:', limit: 5, windowMs: 10 * 60_000 };
