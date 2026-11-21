import { render, screen } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

/**
 * Sprint 5.10a · `QA-SEO04`: fuera de producción nada se indexa (cada respuesta lleva `noindex` y `robots.txt` lo bloquea todo); en producción no cambia nada.
 * Y `QA-LEG01`: el texto legal se pinta sin HTML y sus enlaces llevan a las páginas públicas.
 */

// El middleware de idiomas de next-intl no se carga fuera de Next (importa «next/server» sin extensión): aquí basta con que deje pasar la petición.
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});
// El enlace de next-intl tampoco: se sustituye por uno que añade el prefijo del idioma como hace la aplicación (el castellano va sin prefijo).
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, locale, children, ...props }: { href: string; locale?: string; children: ReactNode }) => (
    // Sin `locale`, el enlace va en el idioma de la página (aquí, el catalán), como hace next-intl; el castellano no lleva prefijo.
    <a href={`${(locale ?? 'ca') !== 'es' ? `/${locale ?? 'ca'}` : ''}${href}`} {...props}>
      {children}
    </a>
  )
}));

vi.mock('@/services/marketing/public-config', () => ({
  getPublicPlatformConfig: async () => ({ crawlers: { search: [{ userAgent: 'Claude-SearchBot', allow: true }], training: [] } })
}));

const request = (path: string) => new NextRequest(new URL(path, 'https://preview.korum.example'));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('QA-SEO04 · la preproducción no se indexa', () => {
  it('sin SEARCH_INDEXING=allow, cada página, cada archivo y la API llevan X-Robots-Tag: noindex, y robots.txt lo bloquea todo sin sitemap', async () => {
    vi.stubEnv('SEARCH_INDEXING', '');
    const { default: proxy } = await import('@/proxy');
    for (const path of ['/', '/ca/privacidad', '/cervantes', '/api/og/marketing?locale=es&page=home', '/llms.txt', '/robots.txt']) {
      expect(proxy(request(path)).headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
    }
    const { default: robots } = await import('@/app/robots');
    expect(await robots()).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
  });

  it('una redirección al acceso también lleva noindex fuera de producción', async () => {
    vi.stubEnv('SEARCH_INDEXING', 'block');
    const { default: proxy } = await import('@/proxy');
    const response = proxy(request('/panel/cervantes'));
    expect(response.status).toBe(307);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('en producción (SEARCH_INDEXING=allow) no cambia nada: sin cabecera y con las reglas de siempre y el sitemap', async () => {
    vi.stubEnv('SEARCH_INDEXING', 'allow');
    const { default: proxy } = await import('@/proxy');
    for (const path of ['/', '/privacidad', '/api/og/marketing', '/llms.txt']) expect(proxy(request(path)).headers.get('x-robots-tag'), path).toBeNull();
    const { default: robots } = await import('@/app/robots');
    const result = await robots();
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
    expect(JSON.stringify(result.rules)).toContain('/panel/');
    expect(JSON.stringify(result.rules)).toContain('Claude-SearchBot');
  });

  it('la API y los archivos no pasan por el idioma: una ruta de la API no se redirige a /es', async () => {
    vi.stubEnv('SEARCH_INDEXING', 'allow');
    const { default: proxy } = await import('@/proxy');
    // Del resto de la API (pagos, tareas programadas, acceso) el proxy ni se entera: su `matcher` solo deja entrar las tarjetas sociales.
    const { config } = await import('@/proxy');
    expect(config.matcher).toEqual(['/((?!api|_next|_vercel).*)', '/api/og/:path*']);
    for (const path of ['/api/og/marketing', '/robots.txt', '/indexnow-key.txt']) {
      const response = proxy(request(path));
      expect(response.headers.get('location'), path).toBeNull();
      expect(response.headers.get('x-middleware-next'), path).toBe('1');
    }
  });
});

describe('QA-LEG01 · el texto legal se pinta sin HTML', () => {
  it('los enlaces entre documentos van a la página pública en el idioma de la página, los internos se quedan en texto y el HTML no se interpreta', async () => {
    const { Blocks } = await import('@/components/legal/legal-markdown');
    const { parseLegalMarkdown } = await import('@/core/legal/legal-markdown');
    const blocks = parseLegalMarkdown('Lee la [política](politica-de-privacidad.md) y las [condiciones](condiciones-entidades.md#15-baja), no la [tabla](tabla-de-plazos.md).\n\n<b>negrita falsa</b>\n\n| Plazo | Quién |\n| :--- | :--- |\n| 48 horas | KORUM |');
    const { container } = render(<Blocks blocks={blocks} locale="ca" tableLabel="Taula" />);
    expect(screen.getByRole('link', { name: 'política' }).getAttribute('href')).toBe('/ca/privacidad');
    expect(screen.getByRole('link', { name: 'condiciones' }).getAttribute('href')).toBe('/ca/condiciones/entidades#15-baja');
    expect(screen.queryByRole('link', { name: 'tabla' })).toBeNull();
    expect(screen.getByText('tabla')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>negrita falsa</b>');
    // La tabla se desplaza en su propia región, que se alcanza con el teclado y dice qué es.
    const region = screen.getByRole('region', { name: 'Taula: Plazo · Quién' });
    expect(region.getAttribute('tabindex')).toBe('0');
  });
});
