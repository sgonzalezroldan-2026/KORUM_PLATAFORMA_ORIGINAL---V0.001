import { secretFieldsOf } from './templates/catalog';

/**
 * Enlaces y códigos de un solo uso dentro de la bandeja de salida. Se guardan en `payloadJson` solo el tiempo imprescindible para
 * componer el email: al enviarse, cancelarse o fallar, se borran. Tampoco se envían ya caducados.
 */

/** Los enlaces de acceso y códigos sin fecha propia valen una hora desde que se escribieron en la bandeja. */
export const SECRET_MESSAGE_DEFAULT_TTL_MS = 3_600_000;

/** Quita del payload los campos secretos de la plantilla. Si el payload no es un objeto (p. ej. ya vaciado por la supresión), lo deja igual. */
export function scrubSecrets(templateKey: string, payload: unknown): unknown {
  const secrets = secretFieldsOf(templateKey);
  if (secrets.length === 0 || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([field]) => !secrets.includes(field)));
}

/** `true` si el mensaje lleva un secreto que ya no vale (su `expiresAt`, o una hora desde que se escribió si no tiene fecha). */
export function secretsExpired(message: { templateKey: string; payloadJson: unknown; createdAt: Date }, now: Date): boolean {
  if (secretFieldsOf(message.templateKey).length === 0) return false;
  const expiresAt = typeof message.payloadJson === 'object' && message.payloadJson !== null ? (message.payloadJson as { expiresAt?: unknown }).expiresAt : undefined;
  const limit = typeof expiresAt === 'string' && !Number.isNaN(Date.parse(expiresAt)) ? Date.parse(expiresAt) : message.createdAt.getTime() + SECRET_MESSAGE_DEFAULT_TTL_MS;
  return now.getTime() > limit;
}

/** Sin destinatario real: vacío, sin `@` o en el dominio reservado `.invalid` que usa la supresión de cuentas (`*@anonimizado.invalid`). */
export function isUndeliverableAddress(address: string): boolean {
  const trimmed = address.trim().toLowerCase();
  return trimmed === '' || !trimmed.includes('@') || trimmed.endsWith('.invalid');
}
