import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../utils/render-with-intl';

/** Sprint 5.10a · `QA-LEG02`: la primera capa del alta (primeras capas §4), junto al botón de crear la entidad, en los tres idiomas. */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, locale: _locale, ...props }: { href: string | { pathname: string; query: Record<string, string> }; locale?: string; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query).toString()}`} {...props}>
      {children}
    </a>
  )
}));

const { ActivationStep, RegistrationReady } = await import('@/components/auth/registration-steps');

const draft = {
  vertical: 'SCHOOL',
  name: 'CEIP Cervantes',
  slug: 'cervantes',
  provinceCode: '08',
  city: 'Sabadell',
  postalCode: '08201',
  legalName: 'AFA CEIP Cervantes',
  legalForm: 'PARENTS_ASSOCIATION',
  centerOwnership: 'PUBLIC',
  ley49: false,
  contentLocale: 'es',
  publicIndexing: true,
  director: { name: 'Ana', email: 'ana@colegio.example', phone: '600111222', roleLabel: 'Dirección', password: 'x', passwordRepeat: 'x' },
  cosigner: { name: 'Pau', email: 'pau@colegio.example', phone: '600333444', roleLabel: 'Presidencia', password: '' },
  representationDeclared: false
} as const;

const step = (contact: { company: string | null; privacyEmail: string | null }, locale: 'es' | 'ca' | 'en' = 'es') =>
  renderWithIntl(<ActivationStep draft={draft as never} errors={{}} update={() => undefined} exemptLimitCents={100_000} groupCount={15} legalContact={contact} />, locale);

describe('QA-LEG02 · primera capa del alta', () => {
  it('la línea dice qué se acepta al crear la entidad y enlaza las condiciones para entidades, el contrato de encargo y los derechos, en otra pestaña', () => {
    step({ company: 'KORUM Plataforma, S.L.', privacyEmail: 'privacidad@korum.example' });
    const layer = screen.getByTestId('registration-first-layer');
    // Los enlaces llevan además, solo para lectores de pantalla, que se abren en otra pestaña.
    expect(layer.textContent?.replaceAll(' (se abre en otra pestaña)', '')).toContain('Al crear la entidad aceptáis las condiciones para entidades y el contrato de encargo del tratamiento.');
    const links = within(layer).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/condiciones/entidades', '/contrato-de-encargo', '/privacidad', '/privacidad']);
    for (const link of links) expect(link.getAttribute('target')).toBe('_blank');
    expect(within(layer).getByRole('link', { name: /condiciones para entidades/ }).textContent).toContain('se abre en otra pestaña');
    // El desplegable, cerrado por defecto, nombra a KORUM con su razón social y el email de privacidad.
    const details = layer.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Quién los trata: KORUM (KORUM Plataforma, S.L.).');
    expect(details.textContent).toContain('desde Mi cuenta o en privacidad@korum.example.');
    expect(details.textContent).toContain('Si no acepta, sus datos se borran a los 30 días.');
  });

  it('sin los datos de la empresa en la consola, la frase se dice sin ellos (nunca con corchetes ni «none»)', () => {
    step({ company: null, privacyEmail: null });
    const details = screen.getByTestId('registration-first-layer').querySelector('details')!;
    expect(details.textContent).toContain('Quién los trata: KORUM.');
    expect(details.textContent).toContain('Vuestros derechos: desde Mi cuenta.');
    expect(details.textContent).not.toMatch(/none|\[\[/);
  });

  it('en catalán y en inglés', () => {
    step({ company: null, privacyEmail: null }, 'ca');
    expect(screen.getByTestId('registration-first-layer').textContent).toContain('En crear l’entitat accepteu les condicions per a entitats');
  });
});

describe('QA-LEG02 · confirmación de lo aceptado al terminar el alta (LSSI, art. 28)', () => {
  it('con una cuenta ya verificada, la pantalla final confirma las versiones aceptadas y su fecha, con su enlace, antes de seguir a la verificación en dos pasos', () => {
    const legal = {
      entityTerms: { version: '2026-11-21', locale: 'es' as const, contentSha256: 'a'.repeat(64) },
      processingContract: { version: '2026-11-18', locale: 'es' as const, contentSha256: 'b'.repeat(64) }
    };
    renderWithIntl(<RegistrationReady name="CEIP Cervantes" cosigner="pau@colegio.example" result={{ slug: 'cervantes', legal, acceptedAt: '2026-11-21T10:00:00.000Z' }} />);
    const accepted = screen.getByTestId('registration-accepted');
    expect(accepted.textContent).toContain('condiciones para entidades (versión 2026-11-21)');
    expect(accepted.textContent).toContain('contrato de encargo del tratamiento (versión 2026-11-18)');
    expect(accepted.textContent).toContain('2026');
    expect(within(accepted).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/condiciones/entidades?version=2026-11-21', '/contrato-de-encargo?version=2026-11-18']);
    expect(screen.getByTestId('registration-continue').getAttribute('href')).toBe('/acceso/doble-factor?next=%2Fpanel%2Fcervantes%3Fbienvenida%3D1');
  });
});
