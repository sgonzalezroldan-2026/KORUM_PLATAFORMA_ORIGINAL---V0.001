import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CourseChallenge, PublicBreakdown } from '@/components/portal/detail-sections';
import { InitiativeCard } from '@/components/portal/initiative-card';
import { InitiativeCatalog } from '@/components/portal/initiative-catalog';
import { buildShareUrl } from '@/components/portal/share-modal';
import { ToastProvider } from '@/components/ui/toast-provider';
import { buildCourseChallenge, orderedGroupNames } from '@/core/public/course-challenge';
import type { InitiativeCardData } from '@/core/public/view-model';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

beforeAll(() => {
  // jsdom no implementa el diálogo modal: basta con marcarlo abierto para comprobar el contenido.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const card = (overrides: Partial<InitiativeCardData> = {}): InitiativeCardData => ({
  id: 1,
  format: 'BUDGET',
  subtype: null,
  title: 'Ventiladores para las aulas',
  category: 'Infraestructura',
  stage: 'Primaria',
  pct: 37,
  daysLeft: 10,
  raisedCents: 150_000,
  goalCents: 400_000,
  ticketsSold: 0,
  ticketMax: 0,
  ticketsAvailable: 0,
  ticketPriceCents: 0,
  ticketBuyerCents: 0,
  contributions: 12,
  achieved: false,
  closed: false,
  matching: false,
  zeroCommission: false,
  ...overrides
});

const TICKETS = card({ id: 2, format: 'TICKETING', subtype: 'EVENT', title: 'Fiesta de primavera', category: 'Taquilla', stage: 'Todo el centro', pct: 25, ticketsSold: 50, ticketMax: 200, ticketsAvailable: 150, ticketPriceCents: 500, ticketBuyerCents: 555, daysLeft: 3 });

function renderCatalog(cards: InitiativeCardData[]) {
  return renderWithIntl(
    <ToastProvider>
      <InitiativeCatalog orgSlug="cervantes" entityName="CEIP Cervantes" cards={cards} urls={Object.fromEntries(cards.map((item) => [item.id, `https://korum.example/cervantes/iniciativas/${item.id}`]))} groups={[{ slug: '3-primaria', name: '3º de Primaria' }]} />
    </ToastProvider>
  );
}

describe('QA-F01 · listado con filtros ocultos', () => {
  it('los filtros están ocultos al cargar y se despliegan con Filtrar', async () => {
    renderCatalog([card(), TICKETS]);
    const toggle = screen.getByRole('button', { name: /Filtrar/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('family-filters-bar')).not.toBeVisible();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('family-filters-bar')).toBeVisible();
  });

  it('muestra un contador con los filtros activos y filtra al instante', async () => {
    renderCatalog([card(), TICKETS]);
    await userEvent.click(screen.getByRole('button', { name: /Filtrar/ }));
    expect(screen.getAllByTestId('initiative-card')).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText('Fecha y avance'), 'TICKETING');
    expect(screen.getAllByTestId('initiative-card')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Filtrar/ })).toHaveTextContent('1');
    expect(screen.getByRole('status')).toHaveTextContent('1 iniciativa');
    await userEvent.selectOptions(screen.getByLabelText('Categoría'), 'Infraestructura');
    expect(screen.queryAllByTestId('initiative-card')).toHaveLength(0);
    expect(screen.getByText('No hay iniciativas con estos filtros')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ver todas las iniciativas abiertas' }));
    expect(screen.getAllByTestId('initiative-card')).toHaveLength(2);
  });

  it('las opciones de los desplegables salen de las campañas abiertas', async () => {
    renderCatalog([card(), TICKETS]);
    await userEvent.click(screen.getByRole('button', { name: /Filtrar/ }));
    const options = within(screen.getByLabelText('Etapa')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Todas las etapas', 'Primaria', 'Todo el centro']);
  });

  it('sin campañas abiertas explica qué falta, sin botón de filtros', () => {
    renderCatalog([]);
    expect(screen.getByText('Todavía no hay campañas abiertas')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Filtrar/ })).toBeNull();
  });

  it('cada tarjeta tiene su botón de compartir con el título', async () => {
    renderCatalog([card(), TICKETS]);
    await userEvent.click(screen.getByRole('button', { name: 'Compartir Fiesta de primavera' }));
    const dialog = screen.getByRole('dialog', { name: /Compartir en KORUM/ });
    expect(within(dialog).getByRole('link', { name: /WhatsApp/ })).toHaveAttribute('href', expect.stringContaining('https://wa.me/?text='));
    expect(within(dialog).getByRole('link', { name: /WhatsApp/ }).getAttribute('href')).toContain(encodeURIComponent('/cervantes/iniciativas/2'));
    await userEvent.selectOptions(within(dialog).getByLabelText('Compartir con tu grupo'), '3-primaria');
    expect(decodeURIComponent(within(dialog).getByRole('link', { name: /WhatsApp/ }).getAttribute('href') ?? '')).toContain('iniciativas/2?grupo=3-primaria');
  });
});

describe('QA-F02 · tarjeta de iniciativa', () => {
  it('lleva el contador 💛 de aportaciones, la barra accesible y los días que quedan', () => {
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={card({ contributions: 1, daysLeft: 1 })} />);
    expect(screen.getByText('1 aportación')).toBeInTheDocument();
    expect(screen.getByText('Queda 1 día')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37');
    expect(screen.getByRole('progressbar')).toHaveAccessibleName(/Ventiladores para las aulas/);
  });

  it('destaca el Matching 2x y el cero por ciento de comisión solo cuando corresponde', () => {
    const { unmount } = renderWithIntl(<InitiativeCard orgSlug="cervantes" card={card({ matching: true, zeroCommission: true })} />);
    expect(screen.getByText(/Matching 2x/)).toBeInTheDocument();
    expect(screen.getByText(/0 % de comisión de la plataforma/)).toBeInTheDocument();
    unmount();
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={card()} />);
    expect(screen.queryByText(/Matching 2x/)).toBeNull();
    expect(screen.queryByText(/comisión/)).toBeNull();
  });

  it('la ficha se abre con el título y el botón de aportar es otro enlace distinto', () => {
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={card()} />);
    expect(screen.getByRole('link', { name: /Abrir la ficha de Ventiladores/ })).toHaveAttribute('href', '/cervantes/iniciativas/1');
    expect(screen.getByRole('link', { name: /Aportar ahora/ })).toHaveAttribute('href', '/cervantes/iniciativas/1/aportar');
  });

  it('taquilla: precio, vendidas y disponibles; rifa: papeletas', () => {
    const { unmount } = renderWithIntl(<InitiativeCard orgSlug="cervantes" card={TICKETS} />);
    // Lo que paga quien compra (precio + gastos de gestión digital), no solo el precio base.
    expect(screen.getByText(/Entrada 5,55 €/)).toBeInTheDocument();
    expect(screen.getByText('50 vendidas · aforo 200')).toBeInTheDocument();
    expect(screen.getByText('150 disponibles')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Comprar entradas/ })).toBeInTheDocument();
    unmount();
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={{ ...TICKETS, subtype: 'RAFFLE' }} />);
    expect(screen.getByRole('link', { name: /Comprar papeletas/ })).toBeInTheDocument();
  });

  it('una iniciativa completa o cerrada no ofrece aportar', () => {
    const { unmount } = renderWithIntl(<InitiativeCard orgSlug="cervantes" card={card({ achieved: true, pct: 100 })} />);
    expect(screen.queryByRole('link', { name: /Aportar/ })).toBeNull();
    expect(screen.getByText('¡100 % conseguido! Cerrado')).toBeInTheDocument();
    unmount();
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={{ ...TICKETS, achieved: true }} />);
    expect(screen.getByText('Aforo completo · entradas agotadas')).toBeInTheDocument();
  });

  it('en catalán y en inglés los importes y los plurales siguen la lengua', () => {
    const { unmount } = renderWithIntl(<InitiativeCard orgSlug="cervantes" card={card({ contributions: 2, daysLeft: 4 })} />, 'ca');
    expect(screen.getByText('2 aportacions')).toBeInTheDocument();
    expect(screen.getByText('Queden 4 dies')).toBeInTheDocument();
    expect(screen.getByText('1.500,00 € de 4.000,00 €')).toBeInTheDocument();
    unmount();
    renderWithIntl(<InitiativeCard orgSlug="cervantes" card={card({ contributions: 2, daysLeft: 4 })} />, 'en');
    expect(screen.getByText('2 contributions')).toBeInTheDocument();
    expect(screen.getByText('4 days left')).toBeInTheDocument();
    expect(screen.getByText('€1,500.00 of €4,000.00')).toBeInTheDocument();
  });
});

describe('Regla 03 §6 · el reto se cuenta solo en positivo', () => {
  const lines = buildCourseChallenge([{ groupName: '3º de Primaria', familiesCount: 28 }, { groupName: '1º de ESO', familiesCount: 40 }], 35, orderedGroupNames('SCHOOL', null));

  it('«3º de Primaria ya suma 28 familias · reto: 35» y «Solo faltan 7 familias»', () => {
    renderWithIntl(<CourseChallenge lines={lines} rewardText="Tarde de cine" target={35} vertical="SCHOOL" />);
    expect(screen.getByText('3º de Primaria ya suma 28 familias · reto: 35')).toBeInTheDocument();
    expect(screen.getByText('Solo faltan 7 familias')).toBeInTheDocument();
    expect(screen.getByText('🎉 ¡Reto conseguido!')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Tarde de cine/ })).toBeInTheDocument();
  });

  it('nunca nombra importes, clasificaciones ni a quien no ha aportado', () => {
    const { container } = renderWithIntl(<CourseChallenge lines={lines} rewardText="Tarde de cine" target={35} vertical="SCHOOL" />);
    expect(container.textContent).not.toMatch(/€|ranking|último|peor|no han aportado|no ha aportado/i);
  });

  it('sin grupos que hayan empezado invita a ser el primero, sin culpar a nadie', () => {
    renderWithIntl(<CourseChallenge lines={[]} rewardText={null} target={35} vertical="SPORTS_CLUB" />);
    expect(screen.getByText(/Tu aportación puede ser la primera de tu grupo/)).toBeInTheDocument();
    expect(screen.getByText(/Cuando un equipo llega a 35 familias/)).toBeInTheDocument();
  });

  it('el desglose público lista las 4 líneas y el total, con el pie oficial', () => {
    renderWithIntl(<PublicBreakdown breakdown={{ providerCents: 300_000, installCents: 50_000, contingencyCents: 35_000, escrowAndGuaranteeCents: 15_000, realExecutionCents: 385_000, totalGoalCents: 400_000, contingencyBps: 1000 }} />);
    const cents = [...document.querySelectorAll('dd [data-cents]')].map((node) => Number(node.getAttribute('data-cents')));
    expect(cents).toEqual([300_000, 50_000, 35_000, 15_000, 400_000]);
    expect(cents[0]! + cents[1]! + cents[2]! + cents[3]!).toBe(cents[4]);
    expect(screen.getByText(/Reserva de mantenimiento, riesgos y contingencia \(10\s?%\)/)).toBeInTheDocument();
    expect(screen.getByText(/💡 Transparencia total: el importe total ya incluye el coste de la pasarela de pago/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/escrow|banco|propina/i);
  });
});

describe('Compartir', () => {
  it('añade el grupo como parámetro y mantiene la dirección de la ficha', () => {
    expect(buildShareUrl('https://korum.example/cervantes/iniciativas/1', '')).toBe('https://korum.example/cervantes/iniciativas/1');
    expect(buildShareUrl('https://korum.example/cervantes/iniciativas/1', '3-primaria')).toBe('https://korum.example/cervantes/iniciativas/1?grupo=3-primaria');
  });
});
