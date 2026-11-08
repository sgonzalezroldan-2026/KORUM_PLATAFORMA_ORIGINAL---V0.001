/**
 * Rutas que exigen sesión (con o sin prefijo de idioma): la consola (`/admin`), el panel de una entidad (`/panel/{slug}`, **salvo** su
 * portería, que entra con el PIN del evento, y `/firmar`, que guarda primero el enlace de doble firma del fragmento `#t=` y después manda a
 * iniciar sesión: una redirección del proxy lo perdería al volver), la configuración del doble factor, *Mi cuenta* (Sprint 3.7) y Mi Hucha (Sprint 3.8). Las usa el proxy para mandar a `/login` sin consultar la
 * base de datos; la comprobación real la hacen los layouts.
 */
const PROTECTED = /^(?:\/(?:ca|en))?\/(?:admin(?:\/|$)|panel\/[^/]+(?!\/(?:porteria|firmar)(?:\/|$))(?:\/|$)|acceso\/doble-factor(?:\/|$)|mi-cuenta(?:\/|$)|mi-hucha(?:\/|$))/;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED.test(pathname);
}

/**
 * Ruta de vuelta tras iniciar sesión: solo rutas internas de la aplicación (empiezan por una sola `/`, sin `//`, `\` ni esquema). Cualquier
 * otra cosa se ignora: un `?next=https://otro-sitio` no puede llevar a la persona fuera de KORUM (redirección abierta).
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || value.length > 512) return null;
  const hasControlCharacter = [...value].some((character) => character.charCodeAt(0) < 0x20);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControlCharacter) return null;
  if (value.startsWith('/api/')) return null;
  return value;
}
