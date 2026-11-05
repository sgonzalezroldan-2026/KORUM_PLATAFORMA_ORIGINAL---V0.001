import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassroomIllustration, GymIllustration, PatioIllustration, PILLAR_ILLUSTRATIONS, ShopIllustration, StageIllustration } from '@/components/marketing/illustrations';
import { DEFAULT_PUBLIC_PRICING } from '@/core/finance/public-pricing';
import { cleanSearchQuery, filterEntities, normalizeForSearch, type PublicEntityHit } from '@/lib/entity-search';
import { renderWithIntl } from '../utils/render-with-intl';

const reportError = vi.fn();
const getPrisma = vi.fn<() => unknown>();
const getSetting = vi.fn<(db: unknown, key: string) => Promise<unknown>>();

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));
vi.mock('@/lib/error-reporting', () => ({ reportError }));
vi.mock('@/lib/prisma', () => ({ getPrisma }));
vi.mock('@/services/settings/settings.service', () => ({ getSetting }));

const { CookieNotice } = await import('@/components/layout/cookie-notice');
const { EntityFinder } = await import('@/components/marketing/entity-finder');
const { ImpactCalculator } = await import('@/components/marketing/impact-calculator');
const { CONSENT_STORAGE_KEY } = await import('@/config/cookies');
const publicConfig = await import('@/services/marketing/public-config');

const ENTITIES: PublicEntityHit[] = [
  { slug: 'cervantes', name: 'CEIP Cervantes', vertical: 'SCHOOL', province: 'Madrid' },
  { slug: 'cervera', name: 'Club Cervera', vertical: 'SPORTS_CLUB', province: 'Lleida' },
  { slug: 'banda', name: 'Banda Municipal', vertical: 'CULTURAL', province: 'Cervera de la Cañada' },
  { slug: 'san-jose', name: 'Colegio San José', vertical: 'SCHOOL', province: 'Málaga' }
];

describe('QA-M01 · buscador de entidades (filtrado)', () => {
  it('normaliza acentos, mayúsculas y espacios', () => {
    expect(normalizeForSearch('  Cataluña   SAN José ')).toBe('cataluna san jose');
  });

  it('no busca con menos de 2 letras ni con espacios en blanco', () => {
    expect(cleanSearchQuery('a')).toBeNull();
    expect(cleanSearchQuery('   ')).toBeNull();
    expect(cleanSearchQuery(' ce ')).toBe('ce');
    expect(filterEntities(ENTITIES, 'c ')).toEqual([]);
  });

  it('encuentra por nombre o provincia sin importar los acentos y exige todas las palabras', () => {
    expect(filterEntities(ENTITIES, 'malaga').map((entity) => entity.slug)).toEqual(['san-jose']);
    expect(filterEntities(ENTITIES, 'colegio jose').map((entity) => entity.slug)).toEqual(['san-jose']);
    expect(filterEntities(ENTITIES, 'colegio zzz')).toEqual([]);
  });

  it('pone primero las que empiezan por lo escrito y respeta el límite', () => {
    expect(filterEntities(ENTITIES, 'cerv').map((entity) => entity.slug)).toEqual(['cervantes', 'cervera', 'banda'].sort((a, b) => (a === 'banda' ? 1 : b === 'banda' ? -1 : 0)));
    expect(filterEntities(ENTITIES, 'cerv', 1)).toHaveLength(1);
  });
});

describe('QA-SEO03 · configuración pública con respaldo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicConfig.resetPublicConfigMemo();
  });
  afterEach(() => vi.useRealTimers());

  it('lee las tarifas y los ajustes de SEO de la consola', async () => {
    getPrisma.mockReturnValue({
      globalConfig: {
        findUnique: async () => ({
          ...{ exemptLimitCents: 200_000, bracketMode: 'MARGINAL', t1MaxCents: 400_000, t2MaxCents: 900_000, t1Bps: 600, t2Bps: 500, t3Bps: 200, sponsorFeeBps: 1000 },
          ...{ gatewayPctBps: 150, gatewayFixedCents: 10, ticketFeeFixedCents: 50, ticketFeeBps: 250, maintActive: true, maintPerInitCents: 3000, maintAnnualCapCents: 9000, maxCampaignDays: 45 }
        })
      }
    });
    getSetting.mockImplementation(async (_db, key) => (key === 'seo.verification.google' ? 'abc123' : undefined));
    const config = await publicConfig.getPublicPlatformConfig();
    expect(config.source).toBe('console');
    expect(config.pricing.exemptLimitCents).toBe(200_000);
    expect(config.pricing.bracket).toMatchObject({ mode: 'MARGINAL', ratesBps: { t1: 600, t2: 500, t3: 200 } });
    expect(config.pricing.maintActive).toBe(true);
    expect(config.verification).toEqual({ google: 'abc123' });
    expect(config.crawlers.search.map((rule) => rule.userAgent)).toContain('OAI-SearchBot');
  });

  it('si la base de datos falla sirve los valores de lanzamiento, lo registra y no reintenta de inmediato', async () => {
    getPrisma.mockImplementation(() => {
      throw new Error('sin base de datos');
    });
    const first = await publicConfig.getPublicPlatformConfig();
    const second = await publicConfig.getPublicPlatformConfig();
    expect(first.source).toBe('defaults');
    expect(first.pricing).toEqual(DEFAULT_PUBLIC_PRICING);
    expect(second).toBe(first);
    expect(getPrisma).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('si la base de datos no responde a tiempo cae a los valores de lanzamiento', async () => {
    vi.useFakeTimers();
    getPrisma.mockReturnValue({ globalConfig: { findUnique: () => new Promise(() => undefined) } });
    getSetting.mockResolvedValue(undefined);
    const pending = publicConfig.getPublicPlatformConfig();
    await vi.advanceTimersByTimeAsync(publicConfig.PUBLIC_CONFIG_TIMEOUT_MS + 10);
    expect((await pending).source).toBe('defaults');
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('tras el tiempo de espera de un fallo vuelve a intentarlo', async () => {
    vi.useFakeTimers();
    getPrisma.mockImplementation(() => {
      throw new Error('caída');
    });
    await publicConfig.getPublicPlatformConfig();
    await vi.advanceTimersByTimeAsync(16_000);
    await publicConfig.getPublicPlatformConfig();
    expect(getPrisma).toHaveBeenCalledTimes(2);
  });
});

describe('Aviso de cookies no esenciales', () => {
  const cookie = { name: 'analitica_demo', provider: 'ejemplo.test', purpose: 'analytics' as const };
  beforeEach(() => window.localStorage.clear());

  it('sin cookies registradas no pinta nada', () => {
    const { container } = renderWithIntl(<CookieNotice cookies={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('con cookies pide elegir y «Rechazar» y «Aceptar» son botones idénticos en tamaño y énfasis', async () => {
    renderWithIntl(<CookieNotice cookies={[cookie]} />);
    const reject = await screen.findByRole('button', { name: 'Rechazar' });
    const accept = screen.getByRole('button', { name: 'Aceptar' });
    expect(reject.className).toBe(accept.className);
    expect(screen.getByText('analitica_demo')).toBeInTheDocument();
  });

  it('recuerda la decisión en este navegador y deja de mostrarse', async () => {
    const user = userEvent.setup();
    renderWithIntl(<CookieNotice cookies={[cookie]} />);
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('denied');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Aceptar' })).not.toBeInTheDocument());
  });

  it('quien ya eligió no vuelve a ver el aviso', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    const { container } = renderWithIntl(<CookieNotice cookies={[cookie]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('si el navegador no deja guardar, no falla y no da por aceptado nada', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('lleno', 'QuotaExceededError');
    });
    const user = userEvent.setup();
    renderWithIntl(<CookieNotice cookies={[cookie]} />);
    await user.click(await screen.findByRole('button', { name: 'Aceptar' }));
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
  });
});

describe('QA-M01 · buscador de la portada (componente)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const query = new URL(url, 'http://localhost').searchParams.get('q') ?? '';
        return Response.json({ entities: filterEntities(ENTITIES, query) });
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('filtra mientras se escribe y anuncia cuántas entidades hay', async () => {
    renderWithIntl(<EntityFinder />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Nombre de tu colegio, club o entidad' }), { target: { value: 'cerv' } });
    expect(await screen.findByRole('link', { name: /CEIP Cervantes/ })).toHaveAttribute('href', '/cervantes');
    expect(screen.getByRole('status')).toHaveTextContent('3 entidades encontradas');
  });

  it('no consulta con una sola letra', async () => {
    renderWithIntl(<EntityFinder />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'c' } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('si no hay resultados ofrece dar de alta la entidad y lo anuncia a los lectores de pantalla', async () => {
    renderWithIntl(<EntityFinder />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });
    expect(await screen.findByText('No encontramos «zzzz»')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No hay resultados');
    expect(screen.getByRole('link', { name: 'Dar de alta mi entidad gratis' })).toHaveAttribute('href', '/registro-comunidad');
  });

  it('si la búsqueda falla lo dice y permite reintentar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    renderWithIntl(<EntityFinder />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cerv' } });
    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No hemos podido buscar');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ entities: [ENTITIES[0]] })));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('link', { name: /CEIP Cervantes/ })).toBeInTheDocument();
  });
});

describe('Ilustraciones vectoriales de ambiente', () => {
  const ALL = { patio: PatioIllustration, aula: ClassroomIllustration, pabellón: GymIllustration, escenario: StageIllustration, comercio: ShopIllustration };

  it('son decorativas: ocultas a lectores de pantalla, sin texto dibujado, sin enlaces y con proporción fija', () => {
    for (const [name, Illustration] of Object.entries(ALL)) {
      const { container, unmount } = renderWithIntl(<Illustration className="w-full" />);
      const svg = container.querySelector('svg');
      expect(svg, name).toHaveAttribute('aria-hidden', 'true');
      expect(svg, name).toHaveAttribute('viewBox', '0 0 480 300');
      expect(svg, name).toHaveAttribute('focusable', 'false');
      expect(container.querySelector('text, a, image, foreignObject, script'), name).toBeNull();
      expect(container.textContent, name).toBe('');
      unmount();
    }
  });

  it('cada una lleva un único identificador de recorte propio, distinto del de las demás', () => {
    const ids = Object.values(ALL).map((Illustration) => {
      const { container, unmount } = renderWithIntl(<Illustration />);
      const found = [...container.querySelectorAll('[id]')].map((node) => node.id);
      unmount();
      return found;
    });
    expect(ids.every((list) => list.length === 1)).toBe(true);
    expect(new Set(ids.flat()).size).toBe(Object.keys(ALL).length);
  });

  it('las 4 páginas por público tienen ilustración y las informativas no', () => {
    expect(Object.keys(PILLAR_ILLUSTRATIONS).sort()).toEqual(['clubes', 'colegios', 'comercios', 'culturales']);
  });
});

describe('QA-M01 · simulador de la portada (componente)', () => {
  const NBSP = /\s/g;
  const text = () => document.body.textContent?.replace(NBSP, ' ') ?? '';

  it('muestra la meta, el desglose y cuántas aportaciones hacen falta', () => {
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    expect(text()).toMatch(/Meta a publicar: [\d.]+,00 €/);
    expect(screen.getByText('Mantenimiento de la plataforma')).toBeInTheDocument();
    expect(text()).toContain('Entre las familias hay que reunir');
    expect(text()).toContain('Cifras orientativas');
  });

  it('un presupuesto no válido avisa en el campo y no calcula nada', async () => {
    const user = userEvent.setup();
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    const cost = screen.getByLabelText('Presupuesto de vuestro proveedor');
    await user.clear(cost);
    await user.type(cost, 'abc');
    expect(cost).toHaveAttribute('aria-invalid', 'true');
    expect(cost).toHaveAccessibleDescription(/Escribe un importe mayor que cero/);
    expect(screen.getByText('Completa el presupuesto y el número de personas para ver el cálculo.')).toBeInTheDocument();
  });

  it('los errores de campo se anuncian como alerta', async () => {
    const user = userEvent.setup();
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    await user.clear(screen.getByLabelText('Presupuesto de vuestro proveedor'));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe un importe mayor que cero');
    await user.clear(screen.getByLabelText('Número de familias del centro'));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('el resultado no se anuncia al cargar y, tras tocar un campo, se anuncia una sola vez con una pausa', async () => {
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    const live = () => document.querySelector('p[role="status"].sr-only');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 800)));
    expect(live()?.textContent).toBe('');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    expect(live()?.textContent).toBe('');
    await waitFor(() => expect(live()?.textContent).toMatch(/^Meta a publicar: .+ Por reunir entre las familias: /));
  });

  it('cada tipo de entidad ofrece sus propios objetivos de ejemplo y cambia el presupuesto al cambiar de tipo', async () => {
    const user = userEvent.setup();
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    const options = () => screen.getAllByRole('option').map((option) => option.textContent);
    expect(options()).toEqual(expect.arrayContaining(['Climatización de las aulas', 'Pizarras digitales']));
    await user.selectOptions(screen.getByLabelText('Tipo de entidad'), 'CULTURAL');
    expect(options()).toEqual(expect.arrayContaining(['Instrumentos y vestuario', 'Viaje de fin de curso']));
    expect(options()).not.toContain('Climatización de las aulas');
    expect(screen.getByLabelText('¿Qué queréis conseguir?')).toHaveValue('instruments');
    expect((screen.getByLabelText('Presupuesto de vuestro proveedor') as HTMLInputElement).value.replace(/\s/g, ' ')).toBe('5.000,00 €');
  });

  it('el tipo de entidad cambia cómo se llama a la comunidad', async () => {
    const user = userEvent.setup();
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    expect(screen.getByLabelText('Número de familias del centro')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Tipo de entidad'), 'SPORTS_CLUB');
    expect(screen.getByLabelText('Número de socios y familias')).toBeInTheDocument();
  });

  it('con comercios de sobra la meta queda cubierta, y con pocas familias avisa de que no basta', async () => {
    const user = userEvent.setup();
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    const cost = screen.getByLabelText('Presupuesto de vuestro proveedor');
    await user.clear(cost);
    await user.type(cost, '500');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '10' } });
    expect(screen.getByText('¡Con esos comercios la meta queda cubierta!')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
    const families = screen.getByLabelText('Número de familias del centro');
    await user.clear(families);
    await user.type(families, '5');
    expect(text()).toContain('no bastaría ni con toda la comunidad');
  });

  it('con el mantenimiento activo en la consola el simulador lo muestra', () => {
    renderWithIntl(<ImpactCalculator pricing={{ ...DEFAULT_PUBLIC_PRICING, maintActive: true }} />);
    const row = screen.getByText('Mantenimiento de la plataforma').nextElementSibling;
    expect(row?.textContent?.replace(NBSP, ' ')).toBe('49,00 €');
  });

  it('funciona en inglés con el formato de importes del idioma', () => {
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />, 'en');
    expect(text()).toMatch(/Goal to publish: €[\d,]+\.00/);
  });
});
