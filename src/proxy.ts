import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Next.js 16 llama «proxy» al antiguo middleware. Aquí solo resuelve el idioma; la autenticación por rol llega en el Sprint 3.2.
export default createMiddleware(routing);

export const config = {
  // Todo menos la API, los archivos internos de Next y los archivos estáticos (con extensión).
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)'
};
