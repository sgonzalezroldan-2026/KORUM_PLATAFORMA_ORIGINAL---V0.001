import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KorumMarkSvg, MARK_FULL_MIN_SIZE } from '@/components/brand/korum-mark-svg';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { renderWithIntl } from '../utils/render-with-intl';

describe('KorumMarkSvg (SVG puro, sin hooks)', () => {
  it('se puede renderizar sin ningún proveedor de traducciones (tarjetas next/og, correos)', () => {
    const { container } = render(<KorumMarkSvg size={96} label="KORUM" pathId="ribbon-test" />);
    expect(screen.getByRole('img', { name: 'KORUM' })).toBeInTheDocument();
    expect(container.querySelector('textPath')?.textContent).toBe('KORUM');
    expect(container.querySelector('path#ribbon-test')).not.toBeNull();
  });

  it('sin nombre accesible queda oculto para los lectores de pantalla', () => {
    const { container } = render(<KorumMarkSvg />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it(`la cinta con texto solo se dibuja desde ${MARK_FULL_MIN_SIZE} px (a 40 px, como en la cabecera, sería ilegible)`, () => {
    expect(render(<KorumMarkSvg size={40} />).container.querySelector('textPath')).toBeNull();
    expect(render(<KorumMarkSvg size={MARK_FULL_MIN_SIZE} />).container.querySelector('textPath')).not.toBeNull();
  });

  it('`variant="simple"` fuerza la versión sin texto a cualquier tamaño (apta para next/og)', () => {
    const { container } = render(<KorumMarkSvg size={200} variant="simple" />);
    expect(container.querySelector('text')).toBeNull();
  });
});

describe('EmptyState', () => {
  it('admite h1 para páginas completas y usa la tipografía institucional por defecto', () => {
    renderWithIntl(<EmptyState title="No encontramos esta página" description="Revisa el enlace" headingLevel={1} />);
    const heading = screen.getByRole('heading', { level: 1, name: 'No encontramos esta página' });
    expect(heading).toHaveClass('font-corp');
    expect(heading).not.toHaveClass('font-joy');
  });

  it('la voz de patio (Fredoka) es opt-in con `playful`', () => {
    renderWithIntl(<EmptyState title="Vacío" description="Nada" playful />);
    expect(screen.getByRole('heading', { name: 'Vacío' })).toHaveClass('font-joy');
  });

  it('un error se anuncia con role="alert" y el titular admite foco programático', () => {
    renderWithIntl(<EmptyState title="Algo ha fallado" description="Reintenta" headingLevel={1} role="alert" headingRef={() => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Algo ha fallado');
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('tabindex', '-1');
  });

  it('sin `headingRef` el titular no entra en el orden de tabulación', () => {
    renderWithIntl(<EmptyState title="Vacío" description="Nada" />);
    expect(screen.getByRole('heading')).not.toHaveAttribute('tabindex');
  });
});

describe('LoadingRegion', () => {
  it('anuncia «Cargando…» una vez, marca la zona como ocupada y deja los esqueletos como decorativos', () => {
    const { container } = renderWithIntl(
      <LoadingRegion>
        <Skeleton className="h-4" />
        <Skeleton className="h-4" />
      </LoadingRegion>
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Cargando…');
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it('el texto sale en el idioma activo', () => {
    renderWithIntl(<LoadingRegion>{null}</LoadingRegion>, 'en');
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});
