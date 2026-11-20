import { act, fireEvent, screen, within } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StudioBoardView } from '@/components/panel/studio-board-view';
import { InitiativeCard } from '@/components/portal/initiative-card';
import { useCategoryLabel } from '@/components/portal/use-category-label';
import { standardCategoryKey } from '@/core/public/category-label';
import type { InitiativeCardData } from '@/core/public/view-model';
import { consoleActor, wasKorum, type KorumPeriods } from '@/services/audit/audit-people';
import { tryResizedBudgetBoard, resizedBudgetBoard } from '@/core/studio/resized-board';
import { storedBudgetBoard, type StudioContext } from '@/core/studio/studio-board';
import { useFocusPainted } from '@/lib/use-focus-painted';
import { renderWithIntl } from '../utils/render-with-intl';

/**
 * Sprint 5.9 · Tanda de pulido previa al piloto: vocabulario de la taquilla, categorías traducidas,
 * casillas de 44 px, pizarra que avisa en vez de caerse, foco al pintarse y la etiqueta «KORUM» de la auditoría juzgada por fecha.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

const baseCard = (overrides: Partial<InitiativeCardData> = {}): InitiativeCardData => ({
  id: 1,
  format: 'TICKETING',
  subtype: 'EVENT',
  voucher: null,
  title: 'Fiesta de Navidad',
  category: 'Taquilla',
  stage: 'Todo el centro',
  pct: 100,
  daysLeft: 4,
  raisedCents: 0,
  goalCents: 0,
  ticketsSold: 500,
  ticketMax: 500,
  ticketsAvailable: 0,
  ticketPriceCents: 200,
  ticketBuyerCents: 249,
  contributions: 60,
  achieved: true,
  closed: false,
  matching: false,
  zeroCommission: false,
  coverFileId: null,
  ...overrides
});

describe('Vocabulario de la taquilla', () => {
  it('la tarjeta de un evento dice «entrada» y «aforo»', () => {
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={baseCard()} />, 'es');
    expect(document.body.textContent).toContain('Entrada 2,49');
    expect(document.body.textContent).toContain('aforo 500');
    expect(document.body.textContent).toContain('entradas agotadas');
  });

});

describe('Categorías: las estándar se enseñan traducidas; las de la entidad, tal como las escribió', () => {
  function Probe({ name, contentLang }: { name: string; contentLang?: string }) {
    const label = useCategoryLabel(contentLang)(name);
    return (
      <span data-testid="label" lang={label.lang}>
        {label.text}
      </span>
    );
  }

  it('reconoce las seis categorías estándar y nada más', () => {
    for (const name of ['Infraestructura y Confort', 'Patios y Deporte', 'Tecnología y Recursos', 'Comunidad y Viajes', 'Solidaridad y Becas', 'Taquilla']) expect(standardCategoryKey(name)).not.toBeNull();
    expect(standardCategoryKey('Huerto escolar')).toBeNull();
    expect(standardCategoryKey('')).toBeNull();
  });

  it('en catalán e inglés la estándar sale traducida, sin marcar el idioma de la entidad', () => {
    const ca = renderWithIntl(<Probe name="Patios y Deporte" contentLang="es" />, 'ca');
    expect(screen.getByTestId('label')).toHaveTextContent('Patis i esport');
    expect(screen.getByTestId('label')).not.toHaveAttribute('lang');
    ca.unmount();
    renderWithIntl(<Probe name="Solidaridad y Becas" contentLang="es" />, 'en');
    expect(screen.getByTestId('label')).toHaveTextContent('Solidarity and scholarships');
  });

  it('una categoría propia de la entidad no se toca y conserva el idioma de su contenido', () => {
    renderWithIntl(<Probe name="Huerto escolar" contentLang="es" />, 'en');
    expect(screen.getByTestId('label')).toHaveTextContent('Huerto escolar');
    expect(screen.getByTestId('label')).toHaveAttribute('lang', 'es');
  });

  it('la tarjeta de una campaña la enseña traducida', () => {
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={baseCard({ format: 'BUDGET', subtype: null, category: 'Infraestructura y Confort', achieved: false })} contentLang="es" />, 'ca');
    expect(document.body.textContent).toContain('Infraestructura i confort');
    expect(document.body.textContent).not.toContain('Infraestructura y Confort');
  });
});

describe('Casillas de verificación: zona táctil de 44 px', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === 'generated' ? [] : sourceFiles(path);
      return path.endsWith('.tsx') ? [path] : [];
    });
  }

  it('ninguna casilla del código es de 20 px: todas usan korum-check (el propio campo mide 44 px)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<input\b[^]*?\/>/g)) {
        const tag = match[0];
        if (!tag.includes('type="checkbox"')) continue;
        if (!/className="[^"]*\bkorum-check\b/.test(tag)) offenders.push(file.replace(process.cwd(), ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('el estilo existe en las hojas globales y mide 44 px (2,75 rem)', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/\.korum-check\s*\{[^}]*width:\s*2\.75rem;[^}]*height:\s*2\.75rem;/);
  });

  it('el enlace del título de una tarjeta mide al menos 44 px de alto sin cambiar el hueco que ocupa', () => {
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={baseCard({ format: 'BUDGET', subtype: null, achieved: false })} />, 'es');
    const link = screen.getByRole('link', { name: /Abrir la ficha/ });
    expect(link.className).toMatch(/\bpy-2\.5\b/);
    expect(link.className.split(' ')).toContain('-my-2.5');
    expect(link.className).toMatch(/\binline-block\b/);
  });
});

describe('Pizarra de una campaña rehecha: avisa en vez de caerse', () => {
  const input = { originalGoalCents: 579_500, goalCents: 200_000, costMatCents: 100_000, costInstCents: 50_000, contingencyBps: 1_000, bracketFeeCents: 6_278, maintFeeCents: 0, gatewayFeeCents: 2_710, absorbsGatewayCostByKorum: false };

  it('lo que cuadra, se enseña', () => {
    // 160.000 + 12.000 + 17.200 de reserva + 6.278 + 2.710 de comisiones = 198.188.
    const ok = tryResizedBudgetBoard({ ...input, costMatCents: 160_000, costInstCents: 12_000, goalCents: 198_188 });
    expect(ok.kind).toBe('OK');
  });

  it('lo que no cuadra por muchos céntimos (sobra dinero entre el proyecto y la meta) es un aviso', () => {
    // 153.000 + 15.000 + 16.800 + 6.278 + 2.710 = 193.788, y la meta es 200.000.
    expect(tryResizedBudgetBoard({ ...input, costMatCents: 153_000, costInstCents: 15_000, goalCents: 200_000 }).kind).toBe('MISMATCH');
  });

  it('un descuadre se devuelve como aviso, con el motivo, y el que lanza sigue lanzando', () => {
    const bad = { ...input, goalCents: 100 };
    const result = tryResizedBudgetBoard(bad);
    expect(result).toMatchObject({ kind: 'MISMATCH' });
    expect(result.kind === 'MISMATCH' && result.detail).toContain('no cuadra');
    expect(() => resizedBudgetBoard(bad)).toThrow(RangeError);
  });

  it('una cifra no válida también se avisa; un error que no es de cifras no se esconde', () => {
    expect(tryResizedBudgetBoard({ ...input, costMatCents: -1 }).kind).toBe('MISMATCH');
    expect(tryResizedBudgetBoard({ ...input, goalCents: 1.5 }).kind).toBe('MISMATCH');
  });
});

describe('Pizarra del Estudio: pasarela cubierta', () => {
  const CONTEXT = {
    gateway: { pctBps: 150, fixedCents: 25 },
    donationTicketCents: 2_500,
    medalRank: 0,
    categories: [],
    maintenance: { active: false },
    bracket: { mode: 'FLAT', t1MaxCents: 100_000, t2MaxCents: 500_000 }
  } as unknown as StudioContext;
  const board = storedBudgetBoard({ costMatCents: 100_000, costInstCents: 0, contingencyBps: 1_000, goalCents: 112_000, defaultExemptAppliedCents: 100_000, medalExemptAppliedCents: 0, bracketRateAppliedBps: 500, bracketFeeCents: 500, maintFeeCents: 0, gatewayFeeCents: 1_700 });

  it('si la pasarela está cubierta lo dice sin decir que KORUM la asume', () => {
    renderWithIntl(<StudioBoardView board={board} context={CONTEXT} contingencyBps={1_000} ticketFeeMode="ADD" gatewayCovered />, 'es');
    const note = screen.getByTestId('studio-gateway-covered');
    expect(note).toHaveTextContent('El coste de la pasarela de pago está cubierto: no se resta de lo que recibe la entidad.');
    expect(note.textContent).not.toMatch(/KORUM/);
  });

  it('en una campaña normal no sale ese aviso', () => {
    renderWithIntl(<StudioBoardView board={board} context={CONTEXT} contingencyBps={1_000} ticketFeeMode="ADD" />, 'es');
    expect(screen.queryByTestId('studio-gateway-covered')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('studio-tco-lines')).getByText('5. Coste de la pasarela de pago (Paycomet)')).toBeInTheDocument();
  });
});

describe('Foco al pintarse el panel (useFocusPainted)', () => {
  function Panel() {
    const [open, setOpen] = useState(false);
    const focusPainted = useFocusPainted();
    return (
      <div>
        <button type="button" onClick={() => { setOpen(true); focusPainted(() => document.getElementById('titulo-panel')); }}>
          Abrir
        </button>
        {open ? (
          <h3 id="titulo-panel" tabIndex={-1}>
            ¿Seguro?
          </h3>
        ) : null}
      </div>
    );
  }

  it('el foco llega al título en el mismo cambio en que el panel se pinta, sin esperar a un fotograma', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    renderWithIntl(<Panel />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '¿Seguro?' }));
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('si el destino no existe, no falla ni roba el foco', () => {
    function Missing() {
      const focusPainted = useFocusPainted();
      return (
        <button type="button" onClick={() => focusPainted(() => document.getElementById('no-existe'))}>
          Pulsar
        </button>
      );
    }
    renderWithIntl(<Missing />);
    const button = screen.getByRole('button', { name: 'Pulsar' });
    button.focus();
    act(() => {
      fireEvent.click(button);
    });
    expect(document.activeElement).toBe(button);
  });

  it('ningún componente vuelve a dar el foco con requestAnimationFrame, salvo los dos ayudantes con reintento (focus-later y settings-kit) y la animación del avance', () => {
    const allowed = new Set(['src/lib/focus-later.ts', 'src/components/admin/settings/settings-kit.tsx', 'src/components/checkout/checkout-celebration.tsx']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== 'generated') walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const relative = path.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '').replace(/\\/g, '/');
        if (allowed.has(relative)) continue;
        if (/requestAnimationFrame\(\(\) => [^)]*\?\.focus\(\)/.test(readFileSync(path, 'utf8'))) offenders.push(relative);
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('Auditoría de la consola: «KORUM» se juzga por la fecha de cada fila', () => {
  const row = (at: string) => ({ actorType: 'USER', actorUserId: 'u1', action: 'initiative.status_changed', occurredAt: new Date(at) });
  const accounts = new Map([['u1', { id: 'u1', name: 'Ana', email: 'ana@korum.example', isSuperadmin: true, gdprAnonymizedAt: null }]]) as unknown as Parameters<typeof consoleActor>[1];
  const periods: KorumPeriods = new Map([['u1', [{ from: new Date('2026-06-01T00:00:00Z'), to: null }]]]);

  it('una firma anterior a que entrara en el equipo sale como persona, no como «KORUM · nombre»', () => {
    expect(consoleActor(row('2026-03-01T10:00:00Z'), accounts, periods)).toMatchObject({ kind: 'person', name: 'Ana' });
  });

  it('lo que hizo ya siendo del equipo sale como de KORUM', () => {
    expect(consoleActor(row('2026-08-01T10:00:00Z'), accounts, periods)).toMatchObject({ kind: 'korum', name: 'Ana' });
    expect(wasKorum(periods, 'u1', new Date('2026-08-01T10:00:00Z'))).toBe(true);
  });

  it('lo que hizo como KORUM antes de salir del equipo sigue siendo de KORUM aunque hoy no lo sea', () => {
    const left: KorumPeriods = new Map([['u1', [{ from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-05-01T00:00:00Z') }]]]);
    const former = new Map([['u1', { id: 'u1', name: 'Ana', email: 'ana@korum.example', isSuperadmin: false, gdprAnonymizedAt: null }]]) as unknown as Parameters<typeof consoleActor>[1];
    expect(consoleActor(row('2026-03-01T10:00:00Z'), former, left)).toMatchObject({ kind: 'korum' });
    expect(consoleActor(row('2026-07-01T10:00:00Z'), former, left)).toMatchObject({ kind: 'person' });
  });
});

describe('Tarjeta social y pase anulado de una entrada (revisión de experiencia del 5.9)', () => {
  const translator = (locale: 'es' | 'ca' | 'en', namespace: string) => {
    const messages = JSON.parse(readFileSync(join(process.cwd(), `messages/${locale}.json`), 'utf8'));
    return createTranslator({ locale, messages, namespace: namespace as never }) as unknown as (key: string, values?: Record<string, unknown>) => string;
  };

  it('la tarjeta para WhatsApp de un evento dice «entradas vendidas»', () => {
    expect(translator('es', 'portal.og')('tickets', { sold: 3, max: 60 })).toBe('3 de 60 entradas vendidas');
    expect(translator('en', 'portal.og')('tickets', { sold: 3, max: 60 })).toBe('3 of 60 tickets sold');
  });

  it('la entrada anulada dice que ya no vale en la puerta, en los tres idiomas', () => {
    for (const locale of ['es', 'ca', 'en'] as const) expect(translator(locale, 'portal.pass')('revoked.description')).toMatch(/puerta|porta|door/i);
  });

});
