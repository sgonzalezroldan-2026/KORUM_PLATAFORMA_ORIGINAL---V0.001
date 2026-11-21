import { getSessionCookie } from 'better-auth/cookies';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { isProtectedPath } from './lib/auth/protected-paths';
import { NOINDEX_VALUE, searchIndexingAllowed } from './lib/seo/indexing';

/**
 * Next.js 16 llama «proxy» al antiguo middleware. Resuelve el idioma y hace la **primera** comprobación de acceso, solo optimista: sin cookie
 * de sesión, `/panel/*` (salvo la portería, que entra con el PIN del evento) y `/admin/*` llevan a `/login` con la ruta de vuelta. Quién es
 * la persona y qué rol tiene lo deciden los `layout.tsx` de cada entorno con la base de datos (`src/lib/auth/guards.ts`): una cookie
 * falsificada pasa de aquí y se queda en un 401/403 allí.
 *
 * Fuera de producción (sin `SEARCH_INDEXING=allow`), toda página lleva además `X-Robots-Tag: noindex, nofollow` (Sprint 5.10a, `QA-SEO04`).
 */

const intl = createMiddleware(routing);

function routeRequest(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (isProtectedPath(pathname) && !getSessionCookie(request, { cookiePrefix: 'korum' })) {
    const locale = /^\/(ca|en)(?:\/|$)/.exec(pathname)?.[1];
    const login = new URL(`${locale ? `/${locale}` : ''}/login`, request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  return intl(request);
}

/** Las tarjetas sociales (`/api/og`, la única parte de la API que llega aquí) y los archivos (con extensión: `robots.txt`, `llms.txt`, imágenes…) no pasan por el idioma ni por el acceso: solo reciben la cabecera de antiindexación. */
const passesThrough = (pathname: string) => pathname.startsWith('/api/') || /\.[^/]+$/.test(pathname);

export default function proxy(request: NextRequest) {
  const response = passesThrough(request.nextUrl.pathname) ? NextResponse.next() : routeRequest(request);
  if (!searchIndexingAllowed()) response.headers.set('X-Robots-Tag', NOINDEX_VALUE);
  return response;
}

export const config = {
  // Todo menos los archivos internos de Next y la API: los archivos estáticos y las tarjetas sociales (`/api/og`, las únicas respuestas de la API que puede indexar
  // un buscador) entran solo para la cabecera de antiindexación (`passesThrough`). El resto de la API (pagos, tareas programadas, acceso) no pasa por aquí, como
  // antes del 5.10a; `robots.txt` ya la excluye.
  matcher: ['/((?!api|_next|_vercel).*)', '/api/og/:path*']
};
