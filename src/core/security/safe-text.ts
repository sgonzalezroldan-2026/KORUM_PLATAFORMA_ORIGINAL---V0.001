/**
 * Texto libre de una persona que se copia a un email o a un registro (su nombre): sin caracteres de control ni de dirección del texto (U+202A–202E, U+2066–2069),
 * que sirven para disfrazar lo que se lee, con los espacios normalizados y acotado. La versión HTML de un email ya lo escapa; esto protege la versión de texto.
 */
export function safeDisplayText(value: string, max = 120): string {
  return value
    .replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
