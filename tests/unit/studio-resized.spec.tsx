import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PassActions } from '@/components/checkout/pass-actions';
import { StudioWorkbench, type StoredPricing, type StudioWorkbenchProps } from '@/components/panel/studio-workbench';
import { calculatePublicBreakdown4Lines } from '@/core/finance/tco.service';
import { payoutFigures } from '@/core/payouts/campaign-payout-rules';
import { resizedFigures } from '@/core/resize/resize-figures';
import { MAX_RESIZED_ROUNDING_CENTS, resizedBudgetBoard } from '@/core/studio/resized-board';
import type { StudioContext } from '@/core/studio/studio-board';
import { blankStudioDraft, TICKETING_CATEGORY, type StudioDraft } from '@/core/studio/studio-draft';
import { renderWithIntl } from '../utils/render-with-intl';

/**
 * Sprint 5.6 · Repaso del Estudio: la pizarra de una campaña rehecha por votación (Sprint 4.4b) se enseña en solo lectura, con sus cifras guardadas y
 * cuadradas al céntimo, y con su aviso. Lo que dice que recibe el proyecto es, al céntimo, lo que paga la liquidación.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/panel/cervantes/estudio',
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() })
}));
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/estudio/actions', () => ({ publishStudioAction: vi.fn(), saveStudioAction: vi.fn(), discardStudioAction: vi.fn() }));

/** `Intl` separa el importe del símbolo con un espacio duro; las pruebas comparan con espacios normales. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s/g, ' ');

/** Generador determinista (mulberry32): mismas campañas en cada ejecución. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('resizedBudgetBoard · cifras guardadas de una campaña rehecha', () => {
  it('1.000 campañas rehechas (y vueltas a recortar por un contracargo): la pizarra cuadra, coincide con el desglose público y con lo que paga la liquidación', () => {
    const random = seeded(20261114);
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    for (let index = 0; index < 1_000; index += 1) {
      const absorbsGatewayCostByKorum = index % 4 === 0;
      const costMatCents = between(0, 2_000_000);
      const costInstCents = between(costMatCents === 0 ? 100 : 0, 800_000);
      const contingencyBps = between(0, 2_000);
      const bracketFeeCents = between(0, 90_000);
      const maintFeeCents = random() < 0.5 ? 0 : 4_900;
      const gatewayFeeCents = between(100, 40_000);
      const execution = costMatCents + costInstCents;
      // La meta pública incluye la pasarela salvo que la asuma KORUM (Regla 02 §1).
      const originalGoalCents = Math.ceil((execution + Math.round((execution * contingencyBps) / 10_000) + bracketFeeCents + maintFeeCents + (absorbsGatewayCostByKorum ? 0 : gatewayFeeCents)) / 100) * 100;
      // Lo que quedó en la hucha tras la votación: entre el 5 % y el 100 % de la meta original, sin redondear al euro (excepción del 4.4b).
      const votedGoalCents = Math.max(1, Math.floor(originalGoalCents * (0.05 + random() * 0.95)));
      let figures = resizedFigures({ originalGoalCents, newGoalCents: votedGoalCents, bracketFeeCents, maintFeeCents, gatewayFeeCents, costMatCents, costInstCents, contingencyBps, absorbsGatewayCostByKorum });

      // Primero tal como la dejó la votación; después, tras un contracargo que vuelve a bajar la meta (`rescaleResizedAfterLoss`).
      for (const afterLoss of [false, true]) {
        if (afterLoss) {
          const leftCents = Math.max(1, Math.floor(figures.goalCents * (0.2 + random() * 0.75)));
          figures = resizedFigures({ ...figures, originalGoalCents: figures.goalCents, newGoalCents: leftCents, contingencyBps, absorbsGatewayCostByKorum });
        }
        const goal = figures.goalCents;
        const board = resizedBudgetBoard({ ...figures, originalGoalCents, contingencyBps, absorbsGatewayCostByKorum });
        const label = `campaña ${index}${afterLoss ? ' tras contracargo' : ''}`;

        expect(board.projectCents + board.feesCents + board.roundingCents, label).toBe(goal);
        expect(board.roundingCents, label).toBeGreaterThanOrEqual(0);
        if (board.costMatCents + board.costInstCents > 0) expect(board.roundingCents, label).toBeLessThanOrEqual(MAX_RESIZED_ROUNDING_CENTS);
        // Lo que la pizarra dice que recibe el proyecto es lo que paga la liquidación con la meta completa.
        expect(board.entityCents, label).toBe(payoutFigures({ raisedCents: goal, bracketFeeCents: figures.bracketFeeCents, maintFeeCents: figures.maintFeeCents, gatewayFeeCents: figures.gatewayFeeCents, absorbsGatewayCostByKorum }).netPaidCents);
        // La reserva y el resto son las líneas 3 y 4 del desglose público de la ficha.
        const lines = calculatePublicBreakdown4Lines({ costMatCents: figures.costMatCents, costInstCents: figures.costInstCents, contingencyBps, goalCents: goal });
        expect(board.contingencyCents, label).toBe(lines.line3ContingencyCents);
        expect(board.feesCents + board.roundingCents, label).toBe(lines.line4EscrowAndGuaranteeCents);
        // Si KORUM asume la pasarela, no ocupa sitio en la meta: todo lo que no es tramo ni mantenimiento es del proyecto.
        if (absorbsGatewayCostByKorum) expect(board.feesCents, label).toBe(figures.bracketFeeCents + figures.maintFeeCents);
        // Las comisiones solo bajan.
        expect(board.bracketFeeCents, label).toBeLessThanOrEqual(bracketFeeCents);
        expect(board.gatewayFeeCents, label).toBeLessThanOrEqual(gatewayFeeCents);
      }
    }
  });

  it('la campaña exenta cuya pasarela asume KORUM (iniciativa 8 de la semilla): la pizarra promete lo mismo que paga la liquidación', () => {
    // Meta 4.500 € sin pasarela dentro; KORUM asume 62,50 €. Vence con 2.100 € y se rehace.
    const figures = resizedFigures({ originalGoalCents: 450_000, newGoalCents: 210_000, bracketFeeCents: 0, maintFeeCents: 0, gatewayFeeCents: 6_250, costMatCents: 400_000, costInstCents: 50_000, contingencyBps: 0, absorbsGatewayCostByKorum: true });
    const board = resizedBudgetBoard({ ...figures, originalGoalCents: 450_000, contingencyBps: 0, absorbsGatewayCostByKorum: true });
    expect(board).toMatchObject({ projectCents: 210_000, feesCents: 0, roundingCents: 0, entityCents: 210_000, gatewayAbsorbed: true, gatewayFeeCents: 2_916 });
    expect(payoutFigures({ raisedCents: 210_000, ...figures, absorbsGatewayCostByKorum: true }).netPaidCents).toBe(210_000);
    // La misma campaña con la pasarela dentro de la meta: el proyecto pierde esos 29,16 €.
    const inside = resizedFigures({ originalGoalCents: 456_300, newGoalCents: 210_000, bracketFeeCents: 0, maintFeeCents: 0, gatewayFeeCents: 6_250, costMatCents: 400_000, costInstCents: 50_000, contingencyBps: 0, absorbsGatewayCostByKorum: false });
    expect(resizedBudgetBoard({ ...inside, originalGoalCents: 456_300, contingencyBps: 0, absorbsGatewayCostByKorum: false })).toMatchObject({ feesCents: inside.gatewayFeeCents, entityCents: 210_000 - inside.gatewayFeeCents, gatewayAbsorbed: false });
  });

  it('unas cifras guardadas que no cuadran no se enseñan: lanza en lugar de pintar una pizarra descuadrada', () => {
    const figures = resizedFigures({ originalGoalCents: 100_000, newGoalCents: 50_000, bracketFeeCents: 4_000, maintFeeCents: 0, gatewayFeeCents: 2_000, costMatCents: 60_000, costInstCents: 20_000, contingencyBps: 1_000, absorbsGatewayCostByKorum: false });
    const coherent = { ...figures, originalGoalCents: 100_000, contingencyBps: 1_000, absorbsGatewayCostByKorum: false };
    expect(resizedBudgetBoard(coherent)).toMatchObject({ goalCents: 50_000, feesCents: 3_000, entityCents: 47_000 });
    // El proyecto y las comisiones pasan de la meta.
    expect(() => resizedBudgetBoard({ ...coherent, goalCents: 46_999 })).toThrow(RangeError);
    // Sobra más de un céntimo entre el proyecto y la meta: eso no es un redondeo.
    expect(() => resizedBudgetBoard({ ...coherent, goalCents: 50_002 })).toThrow(RangeError);
    expect(() => resizedBudgetBoard({ ...coherent, bracketFeeCents: -1 })).toThrow(RangeError);
    expect(() => resizedBudgetBoard({ ...coherent, costMatCents: 30_000.5 })).toThrow(RangeError);
  });
});

const CONTEXT: StudioContext = {
  vertical: 'SCHOOL',
  bracket: { mode: 'FLAT', t1MaxCents: 500_000, t2MaxCents: 1_500_000, ratesBps: { t1: 500, t2: 400, t3: 300 } },
  gateway: { pctBps: 100, fixedCents: 9 },
  donationTicketCents: 2500,
  exemptRemainingCents: 100_000,
  medalGrantAvailableCents: 0,
  medalRank: 0,
  maint: { active: false, perInitCents: 4900, annualCapCents: 14_700, paidCents: 0 },
  ticketFee: { fixedCents: 45, pctBps: 200 },
  maxCampaignDays: 60,
  categories: [
    { name: 'Infraestructura y Confort', icon: '🌡️', rule: 'BRACKETS' },
    { name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT' }
  ],
  kybVerified: true
};

/** Una campaña de 5.874 € (5.610 € de proyecto, 184,40 € de tramo y 79,60 € de pasarela) que venció con 2.000 € y se rehízo por votación. */
const ORIGINAL = { originalGoalCents: 587_400, bracketFeeCents: 18_440, maintFeeCents: 0, gatewayFeeCents: 7_960, costMatCents: 380_000, costInstCents: 130_000, contingencyBps: 1_000, absorbsGatewayCostByKorum: false };
const RESIZED = resizedFigures({ ...ORIGINAL, newGoalCents: 200_000 });

type Variant = { status?: string; figures?: typeof RESIZED; votedGoalCents?: number; absorbs?: boolean };

function resizedProps({ status = 'GOAL_REACHED', figures = RESIZED, votedGoalCents = figures.goalCents, absorbs = false }: Variant = {}): StudioWorkbenchProps {
  const draft: StudioDraft = { ...blankStudioDraft('BUDGET', 'SCHOOL', '2026-12-10'), initiativeId: 7, title: 'Aulas frescas', description: 'Ventilación', category: 'Infraestructura y Confort', stage: 'Primaria', costMatCents: figures.costMatCents, costInstCents: figures.costInstCents, contingencyBps: 1_000 };
  const stored: StoredPricing = { status, walletEscrowId: 'WLT-ESC-ABC123', raisedCents: figures.goalCents, goalCents: figures.goalCents, maintFeeCents: figures.maintFeeCents, defaultExemptAppliedCents: 100_000, medalExemptAppliedCents: 0, bracketRateAppliedBps: 400, bracketFeeCents: figures.bracketFeeCents, gatewayFeeCents: figures.gatewayFeeCents, absorbsGatewayCostByKorum: absorbs };
  return { orgSlug: 'cervantes', context: CONTEXT, initialDraft: draft, lock: 'ALL', stored, resized: { originalGoalCents: ORIGINAL.originalGoalCents, votedGoalCents }, rewardPresets: { cinema: 'Cine', games: 'Juegos', noHomework: 'Sin deberes' }, nowIso: '2026-11-14T10:00:00Z', today: '2026-11-14', maxCloseOn: '2027-01-12', justPublished: false };
}

describe('Estudio · campaña rehecha por votación (solo lectura)', () => {
  it('enseña el aviso, la meta fija y las cifras guardadas cuadradas, sin el exento ni el «resto sujeto a tramo» de la pizarra normal', () => {
    renderWithIntl(<StudioWorkbench {...resizedProps()} />);
    const notice = screen.getByTestId('studio-resized-notice');
    expect(notice).toHaveTextContent('Esta campaña se rehízo por votación: su meta es fija.');
    expect(plain(notice.textContent)).toContain('la meta pasó de 5.874,00 € a 2.000,00 €');
    expect(notice.textContent).not.toContain('contracargo');
    expect(screen.getByTestId('studio-badge')).toHaveTextContent('Meta fija por votación');
    expect(plain(screen.getByTestId('studio-goal').textContent)).toBe('2.000,00 €');

    const board = plain(screen.getByTestId('studio-board').textContent);
    expect(board).toContain('Meta con la que se publicó');
    expect(board).toContain('5.874,00 €');
    expect(board).not.toContain('Importe exento por defecto');
    expect(board).not.toContain('Resto sujeto a tramo');
    // Tramo y pasarela bajan en la proporción 2.000 / 5.874, hacia abajo: 62,78 € y 27,10 €.
    const lines = within(screen.getByTestId('studio-tco-lines'));
    expect(plain(lines.getByText('Comisión de la plataforma por tramos').closest('div')?.textContent)).toContain('62,78 €');
    expect(plain(lines.getByText('Coste de la pasarela de pago (Paycomet)').closest('div')?.textContent)).toContain('27,10 €');
    // El mantenimiento a cero se enseña solo como «0,00 €» (Regla 02 §2).
    expect(plain(lines.getByText('Cargo de mantenimiento de la plataforma').closest('div')?.textContent)).toContain('0,00 €');
    expect(document.body.textContent).not.toMatch(/desactivad/i);

    const figures = resizedBudgetBoard({ ...RESIZED, originalGoalCents: ORIGINAL.originalGoalCents, contingencyBps: 1_000, absorbsGatewayCostByKorum: false });
    expect(plain(screen.getByTestId('studio-resized-sum').textContent)).toBe('Suma cuadrada: 1.910,12 € + 62,78 € + 0,00 € + 27,10 € = 2.000,00 €.');
    // «Para el proyecto al liquidar» es lo que paga la liquidación: 2.000,00 − 62,78 − 27,10.
    expect(figures.entityCents).toBe(191_012);
    expect(plain(screen.getByTestId('studio-resized-entity').textContent)).toContain('1.910,12 €');
    // Sin céntimo de redondeo, se dice que es el mismo importe que el coste del proyecto (no parecen dos cifras distintas).
    expect(screen.getByTestId('studio-resized-entity')).toHaveTextContent('el mismo importe que el coste del proyecto');
    // El aviso es contenido de la página, no un cambio que anunciar; y solo promete lo que es cierto (la imagen de la campaña sí se puede cambiar).
    expect(notice).not.toHaveAttribute('role');
    expect(notice).toHaveTextContent('Las cifras se muestran sin poder cambiarse.');
    expect(screen.getByText('Presupuesto de proveedor y equipamiento (ajustado a la meta nueva)')).toBeInTheDocument();
  });

  it('tras un contracargo que vuelve a bajar la meta, el aviso no atribuye esa bajada a la votación', () => {
    const afterLoss = resizedFigures({ ...RESIZED, originalGoalCents: RESIZED.goalCents, newGoalCents: 150_000, contingencyBps: 1_000, absorbsGatewayCostByKorum: false });
    renderWithIntl(<StudioWorkbench {...resizedProps({ figures: afterLoss, votedGoalCents: 200_000 })} />);
    const notice = plain(screen.getByTestId('studio-resized-notice').textContent);
    expect(notice).toContain('la meta pasó de 5.874,00 € a 2.000,00 €');
    expect(notice).toContain('Después, un contracargo (un cobro que se devolvió a su titular) la dejó en 1.500,00 €');
    expect(plain(screen.getByTestId('studio-goal').textContent)).toBe('1.500,00 €');
    expect(plain(screen.getByTestId('studio-resized-sum').textContent)).toMatch(/ = 1\.500,00 €\.$/);
  });

  it('si la campaña rehecha se está devolviendo, no se promete nada «para el proyecto»', () => {
    for (const status of ['REFUNDING', 'REFUNDED', 'CANCELLED']) {
      const { unmount } = renderWithIntl(<StudioWorkbench {...resizedProps({ status })} />);
      expect(screen.getByTestId('studio-resized-notice')).toBeInTheDocument();
      expect(screen.queryByTestId('studio-resized-entity')).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain('Para el proyecto al liquidar');
      unmount();
    }
    renderWithIntl(<StudioWorkbench {...resizedProps({ status: 'CLOSED' })} />);
    expect(screen.getByTestId('studio-resized-entity')).toBeInTheDocument();
  });

  it('si KORUM asume la pasarela, se dice y no entra en la suma ni se descuenta al proyecto', () => {
    const figures = resizedFigures({ ...ORIGINAL, originalGoalCents: 579_500, newGoalCents: 200_000, absorbsGatewayCostByKorum: true });
    renderWithIntl(<StudioWorkbench {...resizedProps({ figures, absorbs: true })} />);
    const lines = within(screen.getByTestId('studio-tco-lines'));
    expect(lines.getByText('Coste de la pasarela de pago (cubierto: no se resta de la meta)')).toBeInTheDocument();
    const board = resizedBudgetBoard({ ...figures, originalGoalCents: 579_500, contingencyBps: 1_000, absorbsGatewayCostByKorum: true });
    expect(board.feesCents).toBe(figures.bracketFeeCents);
    // Tres sumandos (proyecto, tramo y mantenimiento) más, si lo hay, el céntimo del redondeo: la pasarela no está.
    const sum = plain(screen.getByTestId('studio-resized-sum').textContent);
    expect(sum.split(' + ')).toHaveLength(3 + (board.roundingCents > 0 ? 1 : 0));
    expect(sum).toMatch(/ = 2\.000,00 €\.$/);
    expect(board.entityCents).toBe(200_000 - figures.bracketFeeCents);
  });

  it('nada se puede editar ni guardar, sea cual sea el estado de la campaña', () => {
    for (const status of ['GOAL_REACHED', 'CLOSED', 'FUNDRAISING', 'REFUNDING']) {
      const { unmount } = renderWithIntl(<StudioWorkbench {...resizedProps({ status })} />);
      const controls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')];
      expect(controls.length).toBeGreaterThan(5);
      // Un campo dentro de un «fieldset» deshabilitado lo está aunque no lleve el atributo: se pregunta como lo haría el navegador.
      for (const control of controls) expect(control).toBeDisabled();
      expect(screen.queryByTestId('studio-save')).not.toBeInTheDocument();
      expect(screen.queryByTestId('studio-publish')).not.toBeInTheDocument();
      expect(screen.queryByTestId('studio-discard')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('se lee igual en catalán y en inglés, sin claves sin traducir', () => {
    for (const [locale, text] of [['ca', 'Aquesta campanya es va refer per votació: la seva meta és fixa.'], ['en', 'This campaign was resized by a vote, so its goal is fixed.']] as const) {
      const { unmount } = renderWithIntl(<StudioWorkbench {...resizedProps()} />, locale);
      expect(screen.getByTestId('studio-resized-notice')).toHaveTextContent(text);
      expect(document.body.textContent).not.toContain('panel.studio');
      unmount();
    }
  });

  it('una campaña cerrada sin votación sigue con su pizarra normal y su aviso de cerrada', () => {
    renderWithIntl(<StudioWorkbench {...resizedProps()} resized={null} />);
    expect(screen.queryByTestId('studio-resized-notice')).not.toBeInTheDocument();
    expect(screen.getByText('Esta campaña ya está cerrada: se muestra sin poder cambiar nada.')).toBeInTheDocument();
    expect(plain(screen.getByTestId('studio-board').textContent)).toContain('Importe exento por defecto');
  });
});

describe('Pase de una entrada', () => {
  it('el pase de un evento conserva sus textos', () => {
    renderWithIntl(<PassActions title="Fiesta" url="https://korum.es/cervantes/entrada/abc?sig=x" />);
    expect(screen.getByRole('group', { name: 'Acciones de la entrada' })).toBeInTheDocument();
    expect(screen.getByText(/puede usar la entrada/)).toBeInTheDocument();
  });
});
