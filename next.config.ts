import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Sin `preload`: entrar en la lista de precarga de los navegadores es difícil de deshacer; se decide en la preproducción (Sprint 6.1).
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // La cámara solo se concede a la portería (más abajo, solo en sus rutas); el resto de sensores quedan cerrados.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' }
];

/** Solo la portería (el lector de QR del móvil de los voluntarios) puede abrir la cámara, y solo ella misma: ni siquiera un iframe de otro origen (Sprint 4.5, QA-S04). */
const gatePermissions = [{ key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(self)' }];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // forbidden() y unauthorized(): un acceso sin permiso responde 403 de verdad (QA-M02), con su página traducida.
  experimental: { authInterrupts: true },
  images: {
    formats: ['image/avif', 'image/webp']
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Va después de la regla general porque, con la misma cabecera, gana la última.
      { source: '/panel/:orgSlug/porteria/:path*', headers: gatePermissions },
      { source: '/:locale(ca|en)/panel/:orgSlug/porteria/:path*', headers: gatePermissions },
      // Abrir un documento del titular redirige a una URL firmada del almacén: no debe viajar en el `Referer` de nada (Sprint 4.2c). Va después de la
      // regla general porque, con la misma cabecera, gana la última.
      { source: '/api/panel/documentos/:id', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      // Renovación y documentos de un comercio (Sprint 4.2d): su URL lleva un enlace firmado; tampoco viaja en el `Referer` dentro del propio dominio.
      { source: '/:orgSlug/comercios/renovar', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      { source: '/:locale(ca|en)/:orgSlug/comercios/renovar', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      { source: '/:orgSlug/comercios/documentos/:kind', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
      { source: '/:locale(ca|en)/:orgSlug/comercios/documentos/:kind', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] }
    ];
  }
};

export default withNextIntl(nextConfig);
