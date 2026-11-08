/** Teléfono de contacto del Modelo 182: sin espacios, guiones ni paréntesis y sin el prefijo +34 / 0034 (el modelo pide 9 cifras). */
export function normalizeContactPhone(raw: string): string {
  return raw.replace(/[\s.\-()]/g, '').replace(/^(\+34|0034)/, '');
}

/** `true` si, ya normalizado, es un teléfono de 9 cifras. */
export function isValidContactPhone(raw: string): boolean {
  return /^\d{9}$/.test(normalizeContactPhone(raw));
}
