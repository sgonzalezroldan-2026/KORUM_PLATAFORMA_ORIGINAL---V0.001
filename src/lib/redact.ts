/**
 * Limpieza de textos que pueden llevar datos de personas, para lo que se guarda como rastro técnico (Sentry, errores de tareas). Los textos
 * libres de un error no se pueden limpiar del todo —nombres y direcciones no tienen patrón—: la regla es no poner nunca datos de personas en
 * los mensajes de error, y esto es la segunda barrera.
 *
 * Todos los patrones tienen cuantificadores acotados y el texto se recorta antes de aplicarlos: un mensaje enorme (un error de validación que
 * repite una entrada del usuario) no puede bloquear el servidor con un coste que crece con el cuadrado de su longitud.
 */

const REDACTED = '[redactado]';
export const MAX_REDACTED_LENGTH = 4_000;

const PATTERNS: readonly RegExp[] = [
  // Email.
  /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}/gi,
  // Token de sesión o de enlace (JWT y cadenas largas aleatorias).
  /eyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,512}/g,
  /\b[A-Za-z0-9_-]{32,256}\b/g,
  // IBAN.
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g,
  // NIF, NIE y CIF, también con guion o espacio antes de la letra de control.
  /\b(?:[XYZ]\d{7}|\d{8}|[A-HJNP-SUVW]\d{7})[- ]?[A-Z0-9]\b/gi,
  // Tarjeta (13 a 19 cifras, con espacios o guiones).
  /\b(?:\d[ -]?){13,19}\b/g,
  // Teléfono con prefijo o separado en grupos, y teléfono español de 9 cifras con espacios o guiones (612 345 678, 612-34-56-78).
  /\+?\d{2}[ .-]?(?:\d[ .-]?){8,11}\d/g,
  /\b[6-9]\d{2}[ .-]\d{2,3}[ .-]\d{2,3}(?:[ .-]\d{2})?\b/g,
  // IPv4.
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  // IPv6, completa y comprimida (`2001:db8::1`).
  /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi,
  /\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![0-9a-f:])/gi
];

export function redactText(text: string): string {
  const bounded = text.length > MAX_REDACTED_LENGTH ? `${text.slice(0, MAX_REDACTED_LENGTH)}…[recortado]` : text;
  return PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), bounded);
}
