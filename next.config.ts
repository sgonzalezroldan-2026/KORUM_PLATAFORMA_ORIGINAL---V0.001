import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Sin `preload`: entrar en la lista de precarga de los navegadores es difícil de deshacer; se decide en la preproducción (Sprint 6.1).
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // La cámara solo se concede a la portería (se ampliará en su sprint); el resto de sensores quedan cerrados.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' }
];

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
      // Abrir un documento del titular redirige a una URL firmada del almacén: no debe viajar en el `Referer` de nada (Sprint 4.2c). Va después de la
      // regla general porque, con la misma cabecera, gana la última.
      { source: '/api/panel/documentos/:id', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] }
    ];
  }
};

export default withNextIntl(nextConfig);
