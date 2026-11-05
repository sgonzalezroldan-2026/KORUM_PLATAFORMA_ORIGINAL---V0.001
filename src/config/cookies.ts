/**
 * Registro de cookies no esenciales de KORUM. Hoy está **vacío**: la web solo usa cookies técnicas (sesión y dispositivo del buzón de
 * ideas) y la analítica es Plausible, sin cookies (CUMPLIMIENTO §6). Añadir aquí una cookie de analítica, publicidad o terceros es lo que
 * hace aparecer el aviso de cookies en todo el sitio, con «Rechazar» tan visible como «Aceptar»: nada se carga hasta que la persona acepta.
 */
export interface NonEssentialCookie {
  name: string;
  /** Quién la pone (dominio del proveedor). */
  provider: string;
  /** Clave del texto de su finalidad en `cookies.purposes` de los catálogos de traducción. */
  purpose: 'analytics' | 'preferences' | 'marketing';
}

export const NON_ESSENTIAL_COOKIES: readonly NonEssentialCookie[] = [];

/** Dónde se recuerda la decisión (en el navegador de la persona, nunca en una cookie ni en el servidor). */
export const CONSENT_STORAGE_KEY = 'korum.cookieConsent';
export type CookieConsent = 'granted' | 'denied';
