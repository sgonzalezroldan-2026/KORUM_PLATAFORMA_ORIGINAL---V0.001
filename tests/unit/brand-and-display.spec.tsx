import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KorumLogo } from '@/components/brand/korum-logo';
import { KorumMark } from '@/components/brand/korum-mark';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { TrustBadge } from '@/components/ui/trust-badge';
import type { InitiativeStatus } from '@/types/korum.types';
import { renderWithIntl } from '../utils/render-with-intl';

const NBSP = ' ';

describe('KorumMark y KorumLogo', () => {
  it('el isotipo suelto es una imagen con nombre accesible traducido', () => {
    renderWithIntl(<KorumMark />, 'ca');
    expect(screen.getByRole('img', { name: 'Logotip de KORUM' })).toBeInTheDocument();
  });

  it('por debajo de 32 px se simplifica (sin laureles ni cinta) y por encima es completo', () => {
    const small = renderWithIntl(<KorumMark size={24} />);
    const smallParts = small.container.querySelectorAll('svg *').length;
    expect(small.container.querySelector('textPath')).toBeNull();
    small.unmount();

    const large = renderWithIntl(<KorumMark size={96} />);
    expect(large.container.querySelector('textPath')).not.toBeNull();
    expect(large.container.querySelectorAll('svg *').length).toBeGreaterThan(smallParts);
  });

  it('no lleva año ni subtítulo escolar: la cinta solo dice KORUM', () => {
    const { container } = renderWithIntl(<KorumMark size={96} />);
    expect(container.querySelector('textPath')?.textContent).toBe('KORUM');
    expect(container.textContent).not.toMatch(/EST\.|SCHOOL|ESCOLAR|PLATFORM/i);
  });

  it('el logotipo con nombre deja el isotipo como decorativo para no leer «KORUM» dos veces', () => {
    const { container } = renderWithIntl(<KorumLogo />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container).toHaveTextContent('KORUM');
  });

  it('en modo solo isotipo conserva el nombre accesible', () => {
    renderWithIntl(<KorumLogo markOnly />, 'en');
    expect(screen.getByRole('img', { name: 'KORUM logo' })).toBeInTheDocument();
  });
});

describe('CurrencyText', () => {
  it('da formato según el idioma activo y conserva el importe exacto en data-cents', () => {
    const { container } = renderWithIntl(<CurrencyText cents={100_000} />, 'es');
    // jest-dom normaliza los espacios duros al comparar, así que se compara el texto crudo.
    expect(container.firstElementChild?.textContent).toBe(`1.000,00${NBSP}€`);
    expect(container.firstElementChild).toHaveAttribute('data-cents', '100000');

    renderWithIntl(<CurrencyText cents={2500} />, 'en');
    expect(screen.getByText('€25.00')).toBeInTheDocument();
  });

  it('usa la tipografía de dinero con cifras tabulares', () => {
    const { container } = renderWithIntl(<CurrencyText cents={0} />);
    expect(container.firstElementChild).toHaveClass('font-corp', 'tabular-nums');
    expect(container.firstElementChild?.textContent).toBe(`0,00${NBSP}€`);
    expect(container).not.toHaveTextContent('Desactivado');
  });
});

describe('StatusBadge', () => {
  const STATUSES: InitiativeStatus[] = [
    'BUDGETING',
    'FUNDRAISING',
    'GOAL_REACHED',
    'CLOSED',
    'EXPIRED',
    'RESIZE_VOTING',
    'REFUNDING',
    'REFUNDED',
    'CANCELLED'
  ];

  it('muestra el texto traducido de los 9 estados (no solo color o icono)', () => {
    const expected: Record<string, string[]> = {
      es: ['Presupuestación', 'Recaudando', '¡Conseguido!', 'Cerrada', 'Vencida', 'Votación de redimensionamiento', 'Devolviendo', 'Reembolsada', 'Cancelada'],
      en: ['Budgeting', 'Fundraising', 'Goal reached!', 'Closed', 'Expired', 'Resize vote', 'Refunding', 'Refunded', 'Cancelled']
    };
    for (const locale of ['es', 'en'] as const) {
      STATUSES.forEach((status, index) => {
        const { unmount } = renderWithIntl(<StatusBadge status={status} />, locale);
        expect(screen.getByText(expected[locale]![index]!)).toBeInTheDocument();
        unmount();
      });
    }
  });

  it('marca el icono como decorativo y expone el código para las pruebas', () => {
    const { container } = renderWithIntl(<StatusBadge status="FUNDRAISING" />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-status', 'FUNDRAISING');
  });
});

describe('EmptyState, TrustBadge y Skeleton', () => {
  it('el estado vacío explica qué falta y ofrece la siguiente acción', () => {
    renderWithIntl(
      <EmptyState
        icon="💡"
        title="Todavía no hay campañas abiertas"
        description="¿Tienes una idea para el cole?"
        action={<button type="button">Proponer idea</button>}
      />
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Todavía no hay campañas abiertas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Proponer idea' })).toBeInTheDocument();
  });

  it('el nivel de encabezado del estado vacío se puede bajar a h3', () => {
    renderWithIntl(<EmptyState title="Vacío" description="Nada por aquí" headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
  });

  it('la etiqueta de confianza oculta el icono a los lectores de pantalla', () => {
    const { container } = renderWithIntl(<TrustBadge icon="🛡️">Devolución del 100 %</TrustBadge>);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('🛡️');
    expect(container).toHaveTextContent('Devolución del 100 %');
  });

  it('el esqueleto es invisible para los lectores de pantalla y SkeletonText pinta las líneas pedidas', () => {
    const { container } = renderWithIntl(
      <>
        <Skeleton className="h-4" />
        <SkeletonText lines={4} />
      </>
    );
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
