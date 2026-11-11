import { z } from 'zod';
import { madridIsoDate, startOfDayInMadrid } from '@/core/studio/studio-draft';

/**
 * Reglas puras de la portería (Sprint 4.5). La **fecha del evento** es la fecha límite de la iniciativa (`closesAt`, la misma que ya enseñan el email
 * del pase y el calendario): de ella salen cuándo caduca el PIN y desde cuándo se puede sortear. Ninguna de las dos la decide quien llama
 * (`QA-SEC09`): antes se pasaba el fin del evento a `setGatePin` y la rifa se podía sortear en cuanto cerraba la venta.
 */

/** El PIN y las sesiones valen hasta 6 horas después de acabar el día del evento (la fecha límite es el final de ese día). */
export const GATE_PIN_GRACE_MS = 6 * 3_600_000;

export function gatePinExpiry(eventDate: Date): Date {
  return new Date(eventDate.getTime() + GATE_PIN_GRACE_MS);
}

/** El sorteo se abre a las 00:00 (hora de España) del día del evento: nunca antes del acto, y sí durante la fiesta. */
export function raffleOpensAt(eventDate: Date): Date {
  const start = startOfDayInMadrid(madridIsoDate(eventDate));
  if (!start) throw new RangeError('La fecha del evento no es válida.');
  return start;
}

/** Lecturas que un móvil puede enviar de una vez al recuperar la red, y tamaño de la cola que se acepta guardar sin cobertura. */
export const SYNC_BATCH_MAX = 100;
export const OFFLINE_QUEUE_MAX = 2_000;
export const MAX_PEOPLE_PER_SCAN = 50;
/** Una sesión de portería no vive más que esto desde que se abre (aunque el PIN dure semanas), y una lectura sin red no puede ser más antigua cuando llega. */
export const GATE_SESSION_MAX_MS = 48 * 3_600_000;
export const MAX_SCAN_AGE_MS = GATE_SESSION_MAX_MS;

export const clientScanIdSchema = z.string().regex(/^[\w-]{8,64}$/);

export const scanInputSchema = z.object({
  payload: z.string().min(1).max(200),
  /** `ASK`: el servidor decide si hace falta preguntar cuántas personas entran (pase de varias plazas). */
  quantity: z.union([z.literal('ASK'), z.number().int().min(1).max(MAX_PEOPLE_PER_SCAN)])
});

export const syncScanSchema = z.object({
  clientScanId: clientScanIdSchema,
  payload: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(MAX_PEOPLE_PER_SCAN),
  /** Milisegundos desde 1970 en el reloj del móvil. */
  scannedAt: z.number().int().positive()
});

export const syncBatchSchema = z.object({
  scans: z.array(syncScanSchema).min(1).max(SYNC_BATCH_MAX),
  /** Cuándo se descargó la lista con la que se leyó (solo para la auditoría). */
  listGeneratedAt: z.number().int().nonnegative().optional()
});

export type SyncScan = z.infer<typeof syncScanSchema>;

/**
 * Cuándo se leyó de verdad una lectura sin red: la hora del móvil, pero nunca en el futuro, ni antes de que se abriera la sesión de portería, ni de hace
 * más de `MAX_SCAN_AGE_MS`. El reloj de un móvil puede estar mal; así no puede falsear la hora del primer acceso que se enseña en la alerta roja.
 */
export function clampScanTime(scannedAtMs: number, now: Date, sessionStartedAt: Date): Date {
  const lowest = Math.max(sessionStartedAt.getTime(), now.getTime() - MAX_SCAN_AGE_MS);
  return new Date(Math.min(now.getTime(), Math.max(lowest, scannedAtMs)));
}
