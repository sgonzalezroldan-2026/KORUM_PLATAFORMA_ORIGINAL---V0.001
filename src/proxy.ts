import { getSessionCookie } from 'better-auth/cookies';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { isProtectedPath } from './lib/auth/protected-paths';

/**
 * Next.js 16 llama «proxy» al antiguo middleware. Resuelve el idioma y hace la **primera** comprobación de acceso, solo optimista: sin cookie
 * de sesión, `/panel/*` (salvo la portería, que entra con el PIN del evento) y `/admin/*` llevan a `/login` con la ruta de vuelta. Quién es
 * la persona y qué rol tiene lo deciden los `layout.tsx` de cada entorno con la base de datos (`src/lib/auth/guards.ts`): una cookie
 * falsificada pasa de aquí y se queda en un 401/403 allí.
 */

const intl = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isProtectedPath(pathname) && !getSessionCookie(request, { cookiePrefix: 'korum' })) {
    const locale = /^\/(ca|en)(?:\/|$)/.exec(pathname)?.[1];
    const login = new URL(`${locale ? `/${locale}` : ''}/login`, request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  return intl(request);
}

export const config = {
  // Todo menos la API, los archivos internos de Next y los archivos estáticos (con extensión).
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)'
};
