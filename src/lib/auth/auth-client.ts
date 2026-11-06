'use client';

import { emailOTPClient, magicLinkClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Cliente de Better Auth para los formularios de acceso. Usa la misma URL que la página (`/api/auth`). El doble factor se gestiona a mano
 * (`twoFactorRedirect` en la respuesta), sin redirección automática: la página decide adónde volver.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), emailOTPClient(), twoFactorClient()]
});

/** Cabecera con el idioma de la página: Better Auth la usa al crear una cuenta nueva y para escribir el email en su idioma. */
export const localeHeaders = (locale: string) => ({ headers: { 'x-korum-locale': locale } });

/** Código de error de Better Auth o de KORUM (`KORUM_*`) de una respuesta fallida, para traducirlo. */
export function authErrorCode(error: { code?: string; status?: number } | null | undefined): string {
  if (!error) return 'UNKNOWN';
  if (error.status === 429) return 'RATE_LIMITED';
  return error.code ?? 'UNKNOWN';
}
