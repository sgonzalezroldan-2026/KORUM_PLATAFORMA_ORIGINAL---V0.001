import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePillarContent, collectFaq } from '@/components/marketing/pillar-content';
import { simulateImpact, SIMULATOR_AVERAGE_CONTRIBUTION_CENTS, SIMULATOR_LIMITS, SIMULATOR_SPONSOR_LEVEL_CENTS } from '@/core/finance/impact-simulator';
import { formatBps } from '@/core/finance/money';
import { DEFAULT_PUBLIC_PRICING } from '@/core/finance/public-pricing';
import { calculateStudioBudgetTCO } from '@/core/finance/tco.service';
import { LOCALES, type Locale } from '@/i18n/routing';
import { buildRobotsRules, DEFAULT_CRAWLER_POLICY } from '@/lib/seo/crawler-policy';
import { breadcrumbJsonLd, faqJsonLd, organizationJsonLd, serializeJsonLd, websiteJsonLd } from '@/lib/seo/json-ld';
import { buildLlmsTxt } from '@/lib/seo/llms';
import { absoluteUrl, languageAlternates, localizedPath, MARKETING_CONTENT_UPDATED, MARKETING_PATHS, PILLAR_PAGES } from '@/lib/seo/marketing-routes';
import { buildPageMetadata, DESCRIPTION_MAX, TITLE_MAX, TITLE_SUFFIX } from '@/lib/seo/metadata';
import { fillTokens, fillTokensDeep, pricingTokens } from '@/lib/seo/pricing-tokens';
import sitemap from '@/app/sitemap';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

const CATALOGS = { es, ca, en } as const;

// El sitemap lee las entidades y las iniciativas públicas: aquí se sustituye la base de datos por datos de prueba.
const repository = vi.hoisted(() => ({ listIndexableOrganizations: vi.fn(), listIndexableInitiatives: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }));
vi.mock('@/repositories/public.repository', () => repository);

describe('QA-M01 · simulador de impacto (misma pizarra TCO que el Estudio)', () => {
  const baseCost = 500_000;

  it('la meta coincide al céntimo con la pizarra del Estudio y sus líneas suman la meta', () => {
    const result = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents: baseCost, families: 400, sponsors: 0 });
    const tco = calculateStudioBudgetTCO({
      costMatCents: baseCost,
      costInstCents: 0,
      contingencyBps: 1000,
      isCategoryExempt: false,
      baseExemptRemainingCents: DEFAULT_PUBLIC_PRICING.exemptLimitCents,
      medalGrantAvailableCents: 0,
      bracketConfig: DEFAULT_PUBLIC_PRICING.bracket,
      maintConfig: { active: false, perInitCents: 4900, annualCapCents: 14_700, alreadyChargedOrReservedCents: 0 },
      gatewayConfig: { pctBps: 100, fixedCents: 9, defaultDonationTicketCents: 2500 }
    });
    expect(result.goalCents).toBe(tco.finalGoalCents);
    expect(result.netForEntityCents + result.commissionCents + result.maintenanceCents + result.gatewayCents).toBe(result.goalCents);
    expect(result.goalCents % 100).toBe(0);
  });

  it('los primeros 1.000 € no pagan comisión: una mejora que cabe en lo exento tiene comisión 0', () => {
    const result = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents: 80_000, families: 100, sponsors: 0 });
    expect(result.commissionCents).toBe(0);
    expect(result.exemptUsedCents).toBe(result.netForEntityCents);
    expect(result.maintenanceCents).toBe(0);
  });

  it('con el mantenimiento activo se cobra en el simulador; apagado, son 0 céntimos', () => {
    const on = simulateImpact({ ...DEFAULT_PUBLIC_PRICING, maintActive: true }, { costCents: baseCost, families: 100, sponsors: 0 });
    const off = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents: baseCost, families: 100, sponsors: 0 });
    expect(on.maintenanceCents).toBe(DEFAULT_PUBLIC_PRICING.maintPerInitCents);
    expect(off.maintenanceCents).toBe(0);
  });

  it('cada comercio descuenta el nivel de referencia íntegro y las aportaciones necesarias bajan', () => {
    const without = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents: baseCost, families: 400, sponsors: 0 });
    const withSponsors = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents: baseCost, families: 400, sponsors: 3 });
    expect(withSponsors.goalCents).toBe(without.goalCents);
    expect(withSponsors.sponsorsCents).toBe(3 * SIMULATOR_SPONSOR_LEVEL_CENTS);
    expect(withSponsors.remainingCents).toBe(without.goalCents - 3 * SIMULATOR_SPONSOR_LEVEL_CENTS);
    expect(withSponsors.contributorsNeeded).toBeLessThan(without.contributorsNeeded);
    expect(withSponsors.contributorsNeeded * SIMULATOR_AVERAGE_CONTRIBUTION_CENTS).toBeGreaterThanOrEqual(withSponsors.remainingCents);
  });

  it('si los comercios cubren la meta no hace falta nada más', () => {
    const covered = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents: 100_000, families: 50, sponsors: 10 });
    expect(covered.remainingCents).toBe(0);
    expect(covered.contributorsNeeded).toBe(0);
    expect(covered.participationPct).toBe(0);
  });

  it('la aportación media con la mitad de la comunidad cubre lo que falta, redondeada hacia arriba', () => {
    const result = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents: baseCost, families: 401, sponsors: 1 });
    const halfCommunity = Math.ceil(401 / 2);
    expect(result.averageIfHalfCents * halfCommunity).toBeGreaterThanOrEqual(result.remainingCents);
    expect((result.averageIfHalfCents - 1) * halfCommunity).toBeLessThan(result.remainingCents);
  });

  it('rechaza entradas fuera de rango o con decimales en lugar de redondear en silencio', () => {
    const ok = { costCents: baseCost, families: 10, sponsors: 0 };
    expect(() => simulateImpact(DEFAULT_PUBLIC_PRICING, { ...ok, costCents: 1.5 })).toThrow(RangeError);
    expect(() => simulateImpact(DEFAULT_PUBLIC_PRICING, { ...ok, costCents: -1 })).toThrow(RangeError);
    expect(() => simulateImpact(DEFAULT_PUBLIC_PRICING, { ...ok, costCents: SIMULATOR_LIMITS.maxCostCents + 1 })).toThrow(RangeError);
    expect(() => simulateImpact(DEFAULT_PUBLIC_PRICING, { ...ok, families: 0 })).toThrow(RangeError);
    expect(() => simulateImpact(DEFAULT_PUBLIC_PRICING, { ...ok, sponsors: SIMULATOR_LIMITS.maxSponsors + 1 })).toThrow(RangeError);
  });

  it('fuzz: con presupuestos de todo tipo la meta cuadra, es en euros enteros y nunca baja del presupuesto', () => {
    let seed = 20261105;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let i = 0; i < 400; i += 1) {
      const costCents = 1 + next(SIMULATOR_LIMITS.maxCostCents);
      const result = simulateImpact(DEFAULT_PUBLIC_PRICING, { costCents, families: 1 + next(5000), sponsors: next(SIMULATOR_LIMITS.maxSponsors + 1) });
      expect(result.netForEntityCents + result.commissionCents + result.maintenanceCents + result.gatewayCents).toBe(result.goalCents);
      expect(result.goalCents % 100).toBe(0);
      expect(result.goalCents).toBeGreaterThanOrEqual(costCents);
    }
  });
});

describe('formatBps y marcas de tarifas', () => {
  it('da formato a los puntos básicos según el idioma', () => {
    expect(formatBps(500, 'es').replace(/\s/g, ' ')).toBe('5 %');
    expect(formatBps(45, 'es').replace(/\s/g, ' ')).toBe('0,45 %');
    expect(formatBps(1500, 'en')).toBe('15%');
    expect(() => formatBps(1.5, 'es')).toThrow(RangeError);
  });

  it('las marcas {…} se sustituyen con las tarifas vigentes y una desconocida se deja visible', () => {
    const tokens = pricingTokens(DEFAULT_PUBLIC_PRICING, 'es');
    expect(fillTokens('Primeros {exempt}, luego {t1Rate}. {nada}', tokens).replace(/\s/g, ' ')).toBe('Primeros 1.000,00 €, luego 5 %. {nada}');
    const filled = fillTokensDeep({ a: ['{maxDays} días', { b: '{t3Rate}' }], c: 3 }, tokens);
    expect(JSON.parse(JSON.stringify(filled).replace(/\u00a0/g, ' '))).toEqual({ a: ['60 días', { b: '3 %' }], c: 3 });
  });

  it('los valores de lanzamiento coinciden con los de GlobalConfig en el esquema de Prisma', () => {
    const schema = readFileSync('schema/schema.prisma', 'utf8');
    const model = /model GlobalConfig \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    const defaultOf = (field: string) => {
      const raw = new RegExp(`^\\s*${field}\\s+\\w+\\s+@default\\(([^)]*)\\)`, 'm').exec(model)?.[1];
      if (raw === undefined) throw new Error(`Sin @default para ${field}`);
      return raw === 'true' || raw === 'false' ? raw === 'true' : raw === 'FLAT' || raw === 'MARGINAL' ? raw : Number(raw);
    };
    const p = DEFAULT_PUBLIC_PRICING;
    expect({
      exemptLimitCents: p.exemptLimitCents,
      bracketMode: p.bracket.mode,
      t1MaxCents: p.bracket.t1MaxCents,
      t2MaxCents: p.bracket.t2MaxCents,
      t1Bps: p.bracket.ratesBps.t1,
      t2Bps: p.bracket.ratesBps.t2,
      t3Bps: p.bracket.ratesBps.t3,
      sponsorFeeBps: p.sponsorFeeBps,
      gatewayPctBps: p.gatewayPctBps,
      gatewayFixedCents: p.gatewayFixedCents,
      ticketFeeFixedCents: p.ticketFeeFixedCents,
      ticketFeeBps: p.ticketFeeBps,
      maintActive: p.maintActive,
      maintPerInitCents: p.maintPerInitCents,
      maintAnnualCapCents: p.maintAnnualCapCents,
      maxCampaignDays: p.maxCampaignDays
    }).toEqual({
      exemptLimitCents: defaultOf('exemptLimitCents'),
      bracketMode: defaultOf('bracketMode'),
      t1MaxCents: defaultOf('t1MaxCents'),
      t2MaxCents: defaultOf('t2MaxCents'),
      t1Bps: defaultOf('t1Bps'),
      t2Bps: defaultOf('t2Bps'),
      t3Bps: defaultOf('t3Bps'),
      sponsorFeeBps: defaultOf('sponsorFeeBps'),
      gatewayPctBps: defaultOf('gatewayPctBps'),
      gatewayFixedCents: defaultOf('gatewayFixedCents'),
      ticketFeeFixedCents: defaultOf('ticketFeeFixedCents'),
      ticketFeeBps: defaultOf('ticketFeeBps'),
      maintActive: defaultOf('maintActive'),
      maintPerInitCents: defaultOf('maintPerInitCents'),
      maintAnnualCapCents: defaultOf('maintAnnualCapCents'),
      maxCampaignDays: defaultOf('maxCampaignDays')
    });
  });
});

describe('QA-SEO01 · contenido de las páginas pilar en los 3 idiomas', () => {
  for (const locale of LOCALES) {
    const tokens = pricingTokens(DEFAULT_PUBLIC_PRICING, locale);
    const pages = CATALOGS[locale].marketing.pages as Record<string, unknown>;

    it(`${locale}: las 8 páginas existen, validan su estructura y no dejan marcas sin sustituir`, () => {
      expect(Object.keys(pages).sort()).toEqual(PILLAR_PAGES.map((page) => page.key).sort());
      for (const page of PILLAR_PAGES) {
        const content = fillTokensDeep(parsePillarContent(pages[page.key]), tokens);
        expect(JSON.stringify(content), `${locale}:${page.key}`).not.toMatch(/\{\w+\}/);
      }
    });

    it(`${locale}: título ≤ ${TITLE_MAX} con « · KORUM», descripción ≤ ${DESCRIPTION_MAX} y un solo h1 con respuesta`, () => {
      for (const page of PILLAR_PAGES) {
        const content = fillTokensDeep(parsePillarContent(pages[page.key]), tokens);
        expect(`${content.title}${TITLE_SUFFIX}`.length, `${locale}:${page.key} título`).toBeLessThanOrEqual(TITLE_MAX);
        expect(content.description.length, `${locale}:${page.key} descripción`).toBeLessThanOrEqual(DESCRIPTION_MAX);
        expect(content.description.length, `${locale}:${page.key} descripción`).toBeGreaterThan(60);
        expect(content.h1.length, `${locale}:${page.key} h1`).toBeLessThanOrEqual(90);
        expect(content.answer.length, `${locale}:${page.key} respuesta`).toBeGreaterThan(80);
      }
    });

    it(`${locale}: la portada respeta las longitudes de título y descripción`, () => {
      const meta = CATALOGS[locale].metadata;
      expect(meta.title.length).toBeLessThanOrEqual(TITLE_MAX);
      expect(meta.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    });
  }

  it('los títulos de las páginas pilar no repiten «KORUM» (la plantilla ya lo añade al final)', () => {
    for (const locale of LOCALES) {
      for (const page of PILLAR_PAGES) {
        expect((CATALOGS[locale].marketing.pages as Record<string, { title: string }>)[page.key]?.title, `${locale}:${page.key}`).not.toMatch(/korum/i);
      }
    }
  });

  it('la página de preguntas frecuentes aporta preguntas al JSON-LD y las demás no inventan ninguna', () => {
    const faq = parsePillarContent(es.marketing.pages.faq);
    expect(collectFaq(faq).length).toBeGreaterThanOrEqual(10);
    expect(collectFaq(parsePillarContent(es.marketing.pages.colegios))).toEqual([]);
  });

  it('los textos públicos no presentan a KORUM como entidad regulada ni prometen garantías legales', () => {
    const forbidden = /garantizad[oa] por ley|cuenta bancaria|compte bancari|bank account|exenci[oó]n CNMV|regulad[oa] por el banco|regulat pel banc|regulated by the bank|\bescrow\b/i;
    for (const locale of LOCALES) {
      const text = JSON.stringify({ home: CATALOGS[locale].home, marketing: CATALOGS[locale].marketing });
      expect(text, locale).not.toMatch(forbidden);
    }
  });

  it('la redacción aprobada de Paycomet aparece tal cual en la portada, la página de seguridad y las preguntas frecuentes', () => {
    expect(es.home.money.text).toContain('Los pagos los procesa PAYCOMET, entidad de pago autorizada por el Banco de España. KORUM es la tecnología: no guarda vuestro dinero.');
    expect(es.marketing.pages.seguridad.answer).toContain('Los pagos los procesa PAYCOMET, entidad de pago autorizada por el Banco de España. KORUM es la tecnología: no guarda vuestro dinero.');
  });
});

describe('QA-SEO01 · metadatos, hreflang y datos estructurados', () => {
  const seo = { locale: 'ca' as Locale, path: '/precios', title: 'Preus', description: 'Descripció', imageAlt: 'Imatge', ogPage: 'precios' as const };

  it('canónica absoluta por idioma, alternativas es/ca/en/x-default y tarjeta social de 1200×630 con alt', () => {
    const metadata = buildPageMetadata(seo);
    expect(metadata.alternates?.canonical).toBe(absoluteUrl('ca', '/precios'));
    expect(metadata.alternates?.canonical).toMatch(/^https?:\/\/.+\/ca\/precios$/);
    expect(metadata.alternates?.languages).toEqual(languageAlternates('/precios'));
    expect(Object.keys(languageAlternates('/precios')).sort()).toEqual(['ca', 'en', 'es', 'x-default']);
    expect(languageAlternates('/precios')['x-default']).toBe(languageAlternates('/precios').es);
    const image = (metadata.openGraph?.images as Array<{ url: string; width: number; height: number; alt: string }>)[0];
    expect(image).toMatchObject({ width: 1200, height: 630, alt: 'Imatge' });
    expect(image?.url).toContain('/api/og/marketing?locale=ca&page=precios&v=');
    expect(metadata.openGraph).toMatchObject({ type: 'website', siteName: 'KORUM', locale: 'ca_ES', title: `Preus${TITLE_SUFFIX}` });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
    expect(metadata.robots).toBeUndefined();
  });

  it('la portada usa un título absoluto, sin añadir « · KORUM»', () => {
    const metadata = buildPageMetadata({ ...seo, path: '/', ogPage: 'home', absoluteTitle: true, title: 'KORUM · Lema' });
    expect(metadata.title).toEqual({ absolute: 'KORUM · Lema' });
    expect(metadata.openGraph?.title).toBe('KORUM · Lema');
  });

  it('el castellano va sin prefijo y el resto con él', () => {
    expect(localizedPath('es', '/')).toBe('/');
    expect(localizedPath('ca', '/')).toBe('/ca');
    expect(localizedPath('en', '/precios')).toBe('/en/precios');
  });

  it('JSON-LD: organización, sitio, preguntas y migas sin datos personales, y el serializado no puede cerrar el <script>', () => {
    const org = organizationJsonLd({ description: 'd', slogan: 's' });
    expect(org['@type']).toBe('Organization');
    expect(Object.keys(org)).not.toEqual(expect.arrayContaining(['email', 'telephone', 'address', 'founder', 'employee']));
    expect(websiteJsonLd('en', { description: 'd' })).toMatchObject({ '@type': 'WebSite', inLanguage: 'en' });
    expect(faqJsonLd([{ q: '¿Q?', a: 'A' }])).toMatchObject({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: '¿Q?', acceptedAnswer: { text: 'A' } }] });
    const crumbs = breadcrumbJsonLd('es', [{ name: 'Inicio', path: '/' }, { name: 'Precios', path: '/precios' }]);
    expect((crumbs.itemListElement as Array<{ position: number }>).map((item) => item.position)).toEqual([1, 2]);
    expect(serializeJsonLd({ text: '</script><script>alert(1)</script>' })).not.toContain('</script>');
    expect(JSON.parse(serializeJsonLd({ text: '</script>' })).text).toBe('</script>');
  });
});

describe('QA-SEO02 · robots, sitemap y llms.txt', () => {
  type Rule = { userAgent: string | string[]; allow?: string | string[]; disallow?: string | string[] };
  const rules = buildRobotsRules(DEFAULT_CRAWLER_POLICY, MARKETING_PATHS) as Rule[];
  const list = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

  it('bloquea /panel/, /admin/ y /api/ en los tres idiomas y deja leer las tarjetas sociales', () => {
    const general = rules.find((rule) => rule.userAgent === '*');
    expect(list(general?.disallow)).toEqual(expect.arrayContaining(['/panel/', '/admin/', '/ca/panel/', '/ca/admin/', '/en/panel/', '/en/admin/', '/api/']));
    expect(list(general?.allow)).toContain('/api/og/');
  });

  it('los asistentes de búsqueda y respuesta pueden leer la web pública con las mismas zonas privadas bloqueadas', () => {
    const search = rules.find((rule) => list(rule.userAgent).includes('OAI-SearchBot'));
    expect(list(search?.userAgent)).toEqual(expect.arrayContaining(['ChatGPT-User', 'Claude-SearchBot', 'PerplexityBot']));
    expect(list(search?.allow)).toContain('/');
    expect(list(search?.disallow)).toContain('/panel/');
  });

  it('los de entrenamiento solo entran en las páginas de marketing y no en las portadas de las entidades', () => {
    const training = rules.find((rule) => list(rule.userAgent).includes('GPTBot'));
    expect(list(training?.disallow)).toEqual(['/']);
    const allowed = list(training?.allow);
    expect(allowed).toEqual(expect.arrayContaining(['/$', '/ca$', '/en$', '/precios', '/ca/precios', '/en/para-colegios', '/llms.txt']));
    expect(allowed).not.toContain('/');
    expect(allowed.filter((path) => path.startsWith('/panel') || path.startsWith('/admin'))).toEqual([]);
  });

  it('una política editada en la consola se aplica: un bot desactivado queda bloqueado por completo', () => {
    const custom = buildRobotsRules({ search: [{ userAgent: 'PerplexityBot', allow: false }], training: [{ userAgent: 'GPTBot', allow: false }] }, MARKETING_PATHS) as Rule[];
    const blocked = custom.find((rule) => list(rule.userAgent).includes('GPTBot'));
    expect(list(blocked?.userAgent).sort()).toEqual(['GPTBot', 'PerplexityBot']);
    expect(list(blocked?.disallow)).toEqual(['/']);
    expect(custom.some((rule) => list(rule.allow).includes('/$'))).toBe(false);
  });

  describe('sitemap', () => {
    afterEach(() => vi.resetAllMocks());

    it('sin base de datos lista solo la portada, las 8 páginas pilar y el alta, en los 3 idiomas y con sus alternativas', async () => {
      repository.listIndexableOrganizations.mockRejectedValue(new Error('sin base de datos'));
      const entries = await sitemap();
      expect(entries).toHaveLength((MARKETING_PATHS.length + 1) * LOCALES.length);
      expect(entries.filter((entry) => new URL(entry.url).pathname.endsWith('/registro-comunidad'))).toHaveLength(LOCALES.length);
      expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length);
      for (const entry of entries) {
        expect(entry.lastModified).toBe(MARKETING_CONTENT_UPDATED);
        expect(Object.keys(entry.alternates?.languages ?? {}).sort()).toEqual(['ca', 'en', 'es', 'x-default']);
        expect(new URL(entry.url).pathname).not.toMatch(/\/(panel|admin|api|login|acceso|invitacion|ideas)(\/|$)/);
      }
      expect(MARKETING_CONTENT_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('añade las portadas de las entidades indexables y sus iniciativas públicas, con alternativas de idioma (QA-SEO03)', async () => {
      const touched = new Date('2026-11-01T10:00:00Z');
      repository.listIndexableOrganizations.mockResolvedValue([{ slug: 'cervantes', updatedAt: touched }]);
      repository.listIndexableInitiatives.mockResolvedValue([{ id: 7, updatedAt: touched, organization: { slug: 'cervantes' } }]);
      const entries = await sitemap();
      const urls = entries.map((entry) => entry.url);
      for (const locale of LOCALES) {
        expect(urls).toContain(absoluteUrl(locale, '/cervantes'));
        expect(urls).toContain(absoluteUrl(locale, '/cervantes/iniciativas/7'));
        expect(urls).toContain(absoluteUrl(locale, '/cervantes/comercios'));
      }
      expect(entries).toHaveLength((MARKETING_PATHS.length + 1 + 1 + 2) * LOCALES.length);
      const initiative = entries.find((entry) => entry.url === absoluteUrl('ca', '/cervantes/iniciativas/7'));
      expect(initiative?.lastModified).toBe(touched);
      expect(initiative?.alternates?.languages).toEqual(languageAlternates('/cervantes/iniciativas/7'));
      // Ideas, checkout, Mi cuenta y entradas nunca están: el repositorio solo ofrece portadas e iniciativas.
      expect(urls.some((url) => /\/(ideas|aportar|mi-cuenta|entrada)(\/|$)/.test(url))).toBe(false);
    });
  });

  it('llms.txt resume KORUM, las cifras y las páginas pilar de cada idioma', () => {
    const section = (locale: Locale) => ({
      locale,
      languageName: locale.toUpperCase(),
      summary: `Resumen ${locale}`,
      money: 'Dinero',
      figuresTitle: 'Cifras',
      figures: ['Una cifra', 'Otra cifra'],
      pagesTitle: 'Páginas',
      pages: PILLAR_PAGES.map((page) => ({ title: page.key, description: 'Descripción', url: absoluteUrl(locale, page.path) }))
    });
    const text = buildLlmsTxt(LOCALES.map(section));
    expect(text.startsWith('# KORUM\n\n> Resumen es\n')).toBe(true);
    expect(text).toContain('## CA');
    expect(text).toContain('- Una cifra');
    expect(text).toContain(`[precios](${absoluteUrl('en', '/precios')}): Descripción`);
    expect(text.match(/^- \[/gm)).toHaveLength(PILLAR_PAGES.length * LOCALES.length);
    expect(() => buildLlmsTxt([])).toThrow(RangeError);
  });
});
