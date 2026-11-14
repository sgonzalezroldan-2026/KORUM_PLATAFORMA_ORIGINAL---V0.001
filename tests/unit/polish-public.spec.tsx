import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ComponentProps, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLIC_PRICING } from '@/core/finance/public-pricing';
import { paidNotice, resultNavigation, sponsorshipNotice } from '@/core/checkout/checkout-rules';
import { ENTITY_CARD_VERSION_PATTERN, entityCardVersion } from '@/lib/seo/entity-card';
import { ogEntityUrl, ORG_SLUG_PATTERN } from '@/lib/seo/portal-routes';
import { renderWithIntl } from '../utils/render-with-intl';

/**
 * Sprint 5.5 · pulido de lo público: la vuelta del pago con la campaña cerrada, la tarjeta de la entidad, la cabecera de marketing (página actual,
 * menú móvil que se cierra al pulsar fuera), el simulador que dice cómo ha leído el importe y el sello de tampón al firmar.
 */

const pathname = vi.fn<() => string>(() => '/');
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => pathname()
}));
vi.mock('@/components/layout/account-link', () => ({ AccountLink: () => null }));

const { MobileMenu } = await import('@/components/layout/mobile-menu');
const { NavLink } = await import('@/components/layout/nav-link');
const { ImpactCalculator } = await import('@/components/marketing/impact-calculator');
const { SignChallengeResult } = await import('@/components/panel/sign-challenge-result');

type Done = ComponentProps<typeof SignChallengeResult>['done'];
const done = (overrides: Partial<Record<string, unknown>>): Done => ({ status: 'SIGNED', complete: false, initiativeId: null, fund: null, payout: null, otherSignerNotified: true, ...overrides }) as unknown as Done;

describe('vuelta del pago según el estado actual de la campaña (heredado del 4.2f)', () => {
  it('mientras recauda: enlaza a la ficha y deja volver a intentarlo', () => {
    expect(resultNavigation('FUNDRAISING')).toEqual({ showInitiative: true, canRetry: true, ended: 'NONE' });
  });

  it('conseguida o cerrada: la ficha sigue pública, pero ya no admite aportaciones', () => {
    expect(resultNavigation('GOAL_REACHED')).toEqual({ showInitiative: true, canRetry: false, ended: 'NONE' });
    expect(resultNavigation('CLOSED')).toEqual({ showInitiative: true, canRetry: false, ended: 'NONE' });
  });

  it('vencida o en votación se decide; devolviéndose, devuelta o cancelada se devuelve; en ninguna hay ficha (sería un 404) ni reintento', () => {
    for (const status of ['EXPIRED', 'RESIZE_VOTING']) expect(resultNavigation(status), status).toEqual({ showInitiative: false, canRetry: false, ended: 'DECIDING' });
    for (const status of ['REFUNDING', 'REFUNDED', 'CANCELLED']) expect(resultNavigation(status), status).toEqual({ showInitiative: false, canRetry: false, ended: 'REFUNDING' });
    for (const status of ['BUDGETING', 'DESCONOCIDO']) expect(resultNavigation(status), status).toEqual({ showInitiative: false, canRetry: false, ended: 'NONE' });
  });
});

describe('qué se le dice a quien ya pagó (auditoría de seguridad del 5.5a, H2)', () => {
  it('en una campaña que se devuelve nunca «ya suma»: se le devuelve el 100 %, haya llegado ya su lote o no', () => {
    for (const status of ['REFUNDING', 'REFUNDED', 'CANCELLED']) {
      expect(paidNotice('CONFIRMED', status, 'COMPLETED'), status).toBe('failedCampaign');
      expect(paidNotice('RETURNED', status, 'REFUND_PENDING'), status).toBe('failedCampaign');
    }
  });

  it('pagó justo antes del vencimiento: se decide (votar o devolver); si llegó después, se le devuelve por llegar tarde', () => {
    for (const status of ['EXPIRED', 'RESIZE_VOTING']) {
      expect(paidNotice('CONFIRMED', status, 'COMPLETED'), status).toBe('deciding');
      expect(paidNotice('RETURNED', status, 'REFUND_PENDING'), status).toBe('returnedLate');
    }
  });

  it('con la campaña abierta o conseguida, lo pagado suma; una devolución con la campaña abierta no inventa el motivo', () => {
    for (const status of ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED']) expect(paidNotice('CONFIRMED', status, 'COMPLETED'), status).toBe('confirmed');
    expect(paidNotice('RETURNED', 'GOAL_REACHED', 'REFUND_PENDING')).toBe('returnedLate');
    expect(paidNotice('RETURNED', 'CLOSED', 'REFUND_PENDING')).toBe('returnedLate');
    expect(paidNotice('RETURNED', 'FUNDRAISING', 'REFUND_PENDING')).toBe('returnedGeneric');
  });
});

describe('contracargo de una familia (segunda pasada de seguridad del 5.5a)', () => {
  it('su banco anuló el pago: nunca «te devolvemos» ni «llegó tarde», sea cual sea el estado de la campaña', () => {
    for (const status of ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED']) expect(paidNotice('RETURNED', status, 'CHARGEBACK'), status).toBe('chargeback');
  });
});

describe('qué se le dice a un comercio sobre su dinero (auditoría de seguridad del 5.5a, H1)', () => {
  const sponsor = (overrides: Partial<{ status: string; renewedFromId: number | null; reassignedCents: number; isMatchingPool: boolean }> = {}) => ({ status: 'PENDING', renewedFromId: null, reassignedCents: 0, isMatchingPool: false, ...overrides });

  it('pagó con la campaña ya cerrada y espera la moderación: «siguen retenidos en PAYCOMET hasta que el centro decida»', () => {
    expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor({ reassignedCents: 25_000 }), 'EXPIRED', 'COMPLETED')).toBe('creditPool');
    // Una renovación no es un pago tardío.
    expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor({ reassignedCents: 25_000, renewedFromId: 7 }), 'EXPIRED', 'COMPLETED')).toBe('moved');
  });

  it('un comercio ya admitido cuyo dinero se movió (a otra campaña o al Fondo) no lee que «espera la decisión del centro»', () => {
    for (const status of ['APPROVED', 'CREDIT_POOL']) expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor({ status, reassignedCents: 25_000 }), 'REFUNDING', 'COMPLETED'), status).toBe('moved');
    expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor({ status: 'APPROVED', reassignedCents: 10_000 }), 'CLOSED', 'COMPLETED')).toBe('moved');
  });

  it('la campaña ya no es pública aunque aún no se haya movido nada: va a moverse, no «llega a la hucha de la iniciativa»', () => {
    expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor({ status: 'APPROVED' }), 'EXPIRED', 'COMPLETED')).toBe('moved');
    expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor({ status: 'APPROVED', isMatchingPool: true }), 'REFUNDING', 'COMPLETED')).toBe('moved');
  });

  it('con la campaña abierta: Matching 2x o íntegro a la hucha', () => {
    expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor({ isMatchingPool: true }), 'FUNDRAISING', 'COMPLETED')).toBe('pool');
    expect(sponsorshipNotice('CONFIRMED', 25_000, sponsor(), 'FUNDRAISING', 'COMPLETED')).toBe('escrow');
    expect(sponsorshipNotice('CONFIRMED', 25_000, null, 'FUNDRAISING', 'COMPLETED')).toBe('escrow');
  });

  it('se le devuelve: por no admitirlo (con rectificativa) o por otro motivo, sin inventarlo', () => {
    expect(sponsorshipNotice('RETURNED', 25_000, sponsor({ status: 'REJECTED' }), 'FUNDRAISING', 'REFUND_PENDING')).toBe('notAdmitted');
    // `REFUNDED` no es «no admitido»: lo pone un contracargo, una devolución desde Paycomet o una renovación que ya no procedía.
    expect(sponsorshipNotice('RETURNED', 25_000, sponsor({ status: 'REFUNDED' }), 'CLOSED', 'REFUNDED')).toBe('returnedGeneric');
    // Contracargo: ni «no admitido» ni otra devolución, aunque el comercio esté rechazado o la campaña cerrada.
    expect(sponsorshipNotice('RETURNED', 25_000, sponsor({ status: 'REFUNDED' }), 'CLOSED', 'CHARGEBACK')).toBe('chargeback');
    expect(sponsorshipNotice('RETURNED', 25_000, sponsor({ status: 'REJECTED' }), 'FUNDRAISING', 'CHARGEBACK')).toBe('chargeback');
    expect(sponsorshipNotice('RETURNED', 25_000, sponsor({ status: 'APPROVED' }), 'FUNDRAISING', 'REFUND_PENDING')).toBe('returnedGeneric');
  });
});

describe('tarjeta social de la entidad (heredado del 3.3)', () => {
  it('admite los identificadores de entidad y rechaza lo demás sin consultar la base de datos', () => {
    for (const slug of ['cervantes', 'basket-valles', 'ies-mediterraneo', 'a1', 'e2e-cierre-1a2b3c4d']) expect(ORG_SLUG_PATTERN.test(slug), slug).toBe(true);
    for (const slug of ['', 'CERVANTES', '-cervantes', 'cervantes-', 'cer vantes', '../admin', 'a'.repeat(65), 'café']) expect(ORG_SLUG_PATTERN.test(slug), slug).toBe(false);
  });

  it('la URL lleva el idioma y la versión, y escapa el identificador', () => {
    expect(ogEntityUrl('ca', 'cervantes', '3f9a0c12be47')).toMatch(/\/api\/og\/entity\/cervantes\?locale=ca&v=3f9a0c12be47$/);
    expect(ogEntityUrl('es', 'a/b', '3f9a0c12be47')).toContain('/api/og/entity/a%2Fb?');
  });

  it('la versión es la huella de lo que se dibuja: cambia con el nombre, el vertical, el logotipo o el color, y con nada más (H5)', () => {
    const base = { name: 'CEIP Cervantes', vertical: 'SCHOOL', logoFileId: null, brandPrimary: '#101F38' };
    const version = entityCardVersion(base);
    expect(version).toMatch(ENTITY_CARD_VERSION_PATTERN);
    expect(entityCardVersion({ ...base })).toBe(version);
    for (const change of [{ name: 'CEIP Cervantes 2' }, { vertical: 'CULTURAL' }, { logoFileId: 'f1' }, { brandPrimary: '#047857' }]) expect(entityCardVersion({ ...base, ...change })).not.toBe(version);
    // Los campos no se mezclan: «ab» + «c» no es lo mismo que «a» + «bc».
    expect(entityCardVersion({ ...base, name: 'ab', logoFileId: 'c' })).not.toBe(entityCardVersion({ ...base, name: 'a', logoFileId: 'bc' }));
    for (const bad of ['', '1730000000000', 'ABCDEF123456', '3f9a0c12be4', '3f9a0c12be47a']) expect(ENTITY_CARD_VERSION_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('cabecera de marketing (heredado del 3.1)', () => {
  beforeEach(() => pathname.mockReturnValue('/'));

  it('NavLink marca solo la página actual con aria-current', () => {
    pathname.mockReturnValue('/precios');
    renderWithIntl(
      <nav>
        <NavLink href="/precios">Precios</NavLink>
        <NavLink href="/como-funciona">Cómo funciona</NavLink>
      </nav>
    );
    expect(screen.getByRole('link', { name: 'Precios' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Cómo funciona' })).not.toHaveAttribute('aria-current');
  });

  it('el menú móvil se cierra al pulsar fuera, no al pulsar dentro, y marca la página actual', async () => {
    pathname.mockReturnValue('/como-funciona');
    renderWithIntl(
      <div>
        <p>Contenido de la página</p>
        <MobileMenu />
      </div>
    );
    const toggle = screen.getByRole('button', { name: 'Menú' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Cómo funciona' })).toHaveAttribute('aria-current', 'page');
    fireEvent.pointerDown(screen.getByRole('navigation', { name: 'Menú' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(screen.getByText('Contenido de la página'));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Menú' })).toBeNull();
  });
});

describe('simulador: cómo ha leído el importe (heredado del 3.1)', () => {
  it('con el importe de ejemplo enseña la pista; con «4.5» dice que lo lee como 4,50 €; en catalán e inglés, igual', async () => {
    const { unmount } = renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    expect(screen.getByTestId('cost-read-as')).toHaveTextContent('cámbialo por vuestro presupuesto');
    const cost = screen.getByLabelText('Presupuesto de vuestro proveedor');
    await userEvent.clear(cost);
    await userEvent.type(cost, '4.5');
    expect(screen.getByTestId('cost-read-as').textContent?.replace(/\s/g, ' ')).toBe('Lo leemos como 4,50 €.');
    await userEvent.clear(cost);
    await userEvent.type(cost, '12000');
    expect(screen.getByTestId('cost-read-as').textContent?.replace(/\s/g, ' ')).toBe('Lo leemos como 12.000,00 €.');
    unmount();

    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />, 'en');
    const english = screen.getByLabelText('Your supplier’s quote');
    await userEvent.clear(english);
    await userEvent.type(english, '4,5');
    expect(screen.getByTestId('cost-read-as').textContent?.replace(/\s/g, ' ')).toBe('We’re reading this as €4.50.');
  });

  it('un importe no válido sigue mostrando su error, no la lectura', async () => {
    renderWithIntl(<ImpactCalculator pricing={DEFAULT_PUBLIC_PRICING} />);
    const cost = screen.getByLabelText('Presupuesto de vuestro proveedor');
    await userEvent.clear(cost);
    await userEvent.type(cost, 'abc');
    expect(screen.queryByTestId('cost-read-as')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('sello de tampón al firmar (EXPERIENCIA §6)', () => {
  it('la primera firma estampa «Firmado» y la segunda «Aprobado»; es decorativo (el título ya lo dice)', () => {
    const { unmount } = renderWithIntl(<SignChallengeResult orgSlug="cervantes" done={done({})} resultRef={createRef()} />);
    const partial = screen.getByTestId('sign-stamp');
    expect(partial).toHaveTextContent('Firmado');
    expect(partial).toHaveAttribute('aria-hidden', 'true');
    expect(partial).toHaveClass('korum-stamp-badge', 'korum-stamp-in');
    unmount();

    renderWithIntl(<SignChallengeResult orgSlug="cervantes" done={done({ complete: true, initiativeId: 7 })} resultRef={createRef()} />, 'ca');
    expect(screen.getByTestId('sign-stamp')).toHaveTextContent('Aprovat');
    // La idea convertida también lleva su pegatina que salta.
    expect(document.querySelector('.die-cut-sticker')).toHaveClass('korum-sticker-pop');
  });

  it('con las dos firmas pero el dinero aún sin salir (tono informativo) el sello dice «Firmado», no «Aprobado»', () => {
    renderWithIntl(<SignChallengeResult orgSlug="cervantes" done={done({ complete: true, payout: { settlement: null } })} resultRef={createRef()} />);
    expect(screen.getByTestId('sign-stamp')).toHaveTextContent('Firmado');
  });

  it('un aviso (la liquidación no ha podido salir) no lleva sello', () => {
    renderWithIntl(<SignChallengeResult orgSlug="cervantes" done={done({ complete: true, payout: { settlement: { status: 'NOT_APPROVED', reason: 'FIGURES_CHANGED' } } })} resultRef={createRef()} />);
    expect(screen.queryByTestId('sign-stamp')).toBeNull();
  });
});
