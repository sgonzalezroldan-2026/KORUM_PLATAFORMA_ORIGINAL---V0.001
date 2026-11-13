/**
 * Qué email de la bandeja de vista previa vale para una prueba (sin tocar el disco, para poder probarlo aparte).
 *
 * `emailTo` acepta emails escritos hasta 1 s **antes** de `since` (por si la prueba toma la hora justo después de pulsar el botón que lo envía). El margen tiene un
 * peligro: el email del código con el que la prueba acaba de entrar también cae dentro cuando todo va muy rápido (un CI en Linux con PostgreSQL real tarda menos de
 * un segundo desde que entra hasta que pide el siguiente código), y el servidor ya lo ha sustituido por el nuevo, así que el código viejo se rechaza con «El código no es
 * correcto». Por eso un email del margen **no se devuelve de inmediato**: se espera a ver si llega uno posterior a `since`, y solo si no llega en `EMAIL_GRACE_MS` se da por
 * bueno el del margen (la prueba lo pidió justo antes de tomar la hora).
 */

export const EMAIL_MARGIN_MS = 1_000;
export const EMAIL_GRACE_MS = 2_500;

export interface MailFile {
  text: string;
  /** Momento en que se escribió el fichero (ms). */
  time: number;
}

const newest = (files: readonly MailFile[]): string | null => [...files].sort((a, b) => b.time - a.time)[0]?.text ?? null;

/**
 * `files`: los emails del destinatario que cumplen lo que la prueba pide. `ambiguousForMs`: cuánto lleva la prueba viendo solo emails del margen.
 * Devuelve el texto elegido, o `null` si hay que seguir esperando.
 */
export function chooseEmail(files: readonly MailFile[], since: number, ambiguousForMs: number): string | null {
  const fresh = files.filter((file) => file.time >= since);
  if (fresh.length > 0) return newest(fresh);
  const nearby = files.filter((file) => file.time >= since - EMAIL_MARGIN_MS);
  return nearby.length > 0 && ambiguousForMs >= EMAIL_GRACE_MS ? newest(nearby) : null;
}
