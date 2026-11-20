import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { VoucherQuantityField } from '@/components/checkout/voucher-quantity-field';
import { initialDraft, type CheckoutOffer } from '@/components/checkout/checkout-draft';
import { StudioVoucherFields } from '@/components/panel/studio-voucher-fields';
import { VoucherRows } from '@/components/panel/studio-voucher-rows';
import { InitiativeCard } from '@/components/portal/initiative-card';
import { VoucherDetails } from '@/components/portal/voucher-sections';
import { toCardData, type InitiativeRow } from '@/core/public/view-model';
import type { StudioContext } from '@/core/studio/studio-board';
import { blankStudioDraft, TICKETING_CATEGORY } from '@/core/studio/studio-draft';
import { computeVoucherBoard } from '@/core/studio/voucher-board';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

/** QA-VAL03 (Sprint 5.14b) · pantallas de los vales: Estudio, tarjeta, ficha y pago, con el catálogo de textos real y sin la palabra «saldo» (Regla 03 §4). */

const plain = (text: string | null | undefined) => (text ?? '').replace(/[  ]/g, ' ');
const NOW = new Date('2026-11-20T10:00:00.000Z');

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
  voucherFee: { fixedCents: 45, pctBps: 200 },
  forProfitSchool: false,
  maxCampaignDays: 60,
  categories: [{ name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT' }],
  kybVerified: true
};

const DRAFT = { ...blankStudioDraft('TICKETING', 'SCHOOL', '2026-12-10', 'VOUCHER'), title: 'Vales de la merienda' };

describe('Estudio · venta de vales', () => {
  it('pide precio, tope, validez y gastos por compra, y ofrece «sin producto» con su explicación', async () => {
    const onChange = vi.fn();
    renderWithIntl(<StudioVoucherFields draft={DRAFT} context={CONTEXT} board={computeVoucherBoard(CONTEXT, DRAFT)} disabled={false} onChange={onChange} errors={{}} />);
    expect(screen.getByLabelText('Precio de un vale')).toBeInTheDocument();
    expect(screen.getByLabelText('Tope de vales')).toHaveValue(200);
    const validity = screen.getByLabelText('Los vales se pueden gastar hasta');
    expect(validity).toHaveValue('2027-09-01');
    expect(validity).toHaveAttribute('min', '2026-12-10');
    expect(validity).toHaveAttribute('max', '2027-12-10');
    expect(plain(screen.getByTestId('studio-voucher-fee').textContent)).toContain('0,45 € + 2 % por compra');
    expect(plain(screen.getByTestId('studio-voucher-fee').textContent)).toContain('1 vale, 0,49 €; 50 vales, 2,45 €');
    await userEvent.click(screen.getByLabelText('Al agotarse, dejar seguir aportando «sin producto»'));
    expect(onChange).toHaveBeenCalledWith({ voucherNoProductEnabled: true });
    await userEvent.selectOptions(screen.getByLabelText('Cantidad de vales'), 'OPEN');
    expect(onChange).toHaveBeenCalledWith({ voucherCapped: false });
  });

  it('sin tope pide el objetivo orientativo y no ofrece «sin producto»', () => {
    const open = { ...DRAFT, voucherCapped: false, voucherTargetCount: 120 };
    renderWithIntl(<StudioVoucherFields draft={open} context={CONTEXT} board={computeVoucherBoard(CONTEXT, open)} disabled={false} onChange={vi.fn()} errors={{ ticketMax: 'Indica el objetivo de vales.' }} />);
    const target = screen.getByLabelText('Objetivo de vales');
    expect(target).toHaveValue(120);
    expect(target).toHaveAccessibleDescription(/orientativo.*Indica el objetivo de vales\./);
    expect(screen.queryByLabelText('Al agotarse, dejar seguir aportando «sin producto»')).toBeNull();
  });

  it('a un colegio con ánimo de lucro no le ofrece «sin producto» y le dice por qué (decisión 65)', () => {
    renderWithIntl(<StudioVoucherFields draft={DRAFT} context={{ ...CONTEXT, forProfitSchool: true }} board={computeVoucherBoard(CONTEXT, DRAFT)} disabled={false} onChange={vi.fn()} errors={{}} />);
    expect(screen.queryByLabelText('Al agotarse, dejar seguir aportando «sin producto»')).toBeNull();
    expect(screen.getByTestId('studio-voucher-no-product-unavailable')).toHaveTextContent('colegio con ánimo de lucro');
  });

  it('la pizarra enseña lo de una venta de vales: gastos por compra y, con los gastos incluidos, que la meta es el mínimo y el mantenimiento baja si se vende menos', () => {
    const inc = { ...DRAFT, ticketFeeMode: 'INC' as const };
    renderWithIntl(<VoucherRows board={computeVoucherBoard(CONTEXT, inc)} mode="INC" />);
    const board = screen.getByTestId('studio-voucher-board');
    expect(plain(board.textContent)).toContain('Precio de los 200 vales del tope');
    expect(plain(board.textContent)).toContain('400,00 €');
    expect(plain(board.textContent)).toContain('0,49 € en una compra de 1 vale (incluidos en el precio)');
    expect(plain(board.textContent)).toContain('Gastos de gestión digital por compra');
    expect(board.textContent).not.toContain('por entrada');
    expect(screen.getByTestId('studio-voucher-net-note')).toHaveTextContent('Es lo mínimo que recibe la entidad');
    expect(screen.getByTestId('studio-voucher-net-note')).toHaveTextContent('mantenimiento rebajado en la misma proporción');
  });
});

const ROW: InitiativeRow = {
  id: 9,
  status: 'FUNDRAISING',
  walletEscrowId: 'WLT-ESC-302',
  format: 'TICKETING',
  title: 'Vales de la cantina',
  category: TICKETING_CATEGORY,
  stage: 'Todo el club',
  description: 'Un vale, un bocadillo.',
  closesAt: new Date('2026-12-05T22:59:00.000Z'),
  raisedCents: 12_000,
  goalCents: 60_000,
  totalContributions: 24,
  showPublicBreakdown: true,
  matchingPoolRemainingCents: 0,
  matchingSponsorName: null,
  ticketSubtype: 'VOUCHER',
  ticketPriceCents: 200,
  ticketMax: 300,
  ticketsSold: 60,
  ticketsHeld: 0,
  ticketFeeMode: 'ADD',
  ticketVenue: null,
  voucherValidUntil: new Date('2027-01-10T22:59:00.000Z'),
  voucherNoProductEnabled: true,
  voucherTargetCount: null,
  plaqueEnabled: false,
  rewardEnabled: false,
  rewardText: null,
  targetFamiliesPerCourse: 35,
  costMatCents: 0,
  costInstCents: 0,
  contingencyBps: 0,
  bracketFeeCents: 0,
  maintFeeCents: 0,
  quotaReservedAt: new Date('2026-10-04T00:00:00.000Z'),
  courses: []
};
const FEES = { ticketFeeFixedCents: 45, ticketFeeBps: 200, voucherFeeFixedCents: 45, voucherFeeBps: 200, legalForm: 'SPORTS_ENTITY' };

describe('tarjeta y ficha de una venta de vales', () => {
  it('la tarjeta dice el precio de un vale, los vendidos, los que quedan y la devolución de los vales, y enlaza a comprar', () => {
    renderWithIntl(<InitiativeCard orgSlug="basket-valles" card={toCardData(ROW, NOW, FEES)} />);
    const card = screen.getByTestId('initiative-card');
    // Con los gastos sumados, la etiqueta lo dice: ninguna compra sale a 2,00 € por vale (auditoría financiera).
    expect(plain(screen.getByTestId('voucher-price').textContent)).toContain('2,00 € / vale + gastos');
    expect(card).toHaveTextContent('60 de 300 vales vendidos');
    expect(card).toHaveTextContent('Quedan 240 vales');
    expect(card).toHaveTextContent('Devolución del 100 % en 14 días si no gastas ningún vale');
    expect(within(card).getByRole('link', { name: /Comprar vales/ })).toHaveAttribute('href', '/basket-valles/iniciativas/9/aportar');
  });

  it('con los gastos incluidos, la etiqueta de la tarjeta es el precio de un vale, sin «+ gastos»', () => {
    renderWithIntl(<InitiativeCard orgSlug="basket-valles" card={toCardData({ ...ROW, ticketFeeMode: 'INC' }, NOW, FEES)} />);
    expect(plain(screen.getByTestId('voucher-price').textContent)).toContain('2,00 € / vale');
    expect(screen.getByTestId('voucher-price').textContent).not.toContain('gastos');
  });

  it('agotada con «sin producto»: la tarjeta deja aportar sin producto en lugar de decir «agotados»', () => {
    renderWithIntl(<InitiativeCard orgSlug="basket-valles" card={toCardData({ ...ROW, ticketsSold: 300 }, NOW, FEES)} />);
    expect(screen.getByRole('link', { name: /Aportar sin producto/ })).toBeInTheDocument();
  });

  it('agotada sin «sin producto»: «Vales agotados», sin botón', () => {
    renderWithIntl(<InitiativeCard orgSlug="basket-valles" card={toCardData({ ...ROW, ticketsSold: 300, voucherNoProductEnabled: false }, NOW, FEES)} />);
    expect(screen.getByText('Vales agotados')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Comprar vales|Aportar sin producto/ })).toBeNull();
  });

  it('la ficha explica cómo se gastan, la validez, los gastos por compra y la devolución, sin lista de artículos ni «saldo»', () => {
    const { container } = renderWithIntl(<VoucherDetails voucher={toCardData(ROW, NOW, FEES).voucher!} />);
    const details = screen.getByTestId('voucher-details');
    expect(plain(details.textContent)).toContain('0,45 € + 2 % por compra');
    expect(screen.getByTestId('voucher-valid-until')).toHaveTextContent('10 de enero de 2027');
    expect(details).toHaveTextContent('un solo código QR');
    expect(details).toHaveTextContent('14 días');
    expect(container.textContent).not.toMatch(/\bsaldo\b/i);
    expect(screen.queryByTestId('no-product-notice')).toBeNull();
  });
});

const OFFER: CheckoutOffer = {
  orgSlug: 'basket-valles',
  initiativeId: 9,
  title: 'Vales de la cantina',
  legalName: 'Club Deportiu Basket Vallès',
  vertical: 'SPORTS_CLUB',
  kind: 'VOUCHER',
  closedReason: null,
  donation: null,
  ticket: null,
  voucher: { capped: true, available: 2, units: 300, validUntilIso: '2027-01-10T22:59:00.000Z', noProduct: false, pricing: { mode: 'ADD', priceCents: 200, fee: { fixedCents: 45, pctBps: 200 } } },
  groups: [],
  initialGroup: null,
  plaque: false,
  guarantee: { suggestedCents: 180, choicesCents: [0, 180] },
  certificate: false,
  provinces: [],
  sessionEmail: null
};

describe('pago de vales', () => {
  it('enseña la validez y los que quedan antes de pagar, y no deja pasar de ellos', async () => {
    const update = vi.fn();
    renderWithIntl(<VoucherQuantityField offer={OFFER} draft={{ ...initialDraft(OFFER), quantity: 2 }} update={update} max={2} error={null} />);
    expect(screen.getByTestId('checkout-voucher-info')).toHaveTextContent('Quedan 2 de 300');
    expect(screen.getByTestId('checkout-voucher-info')).toHaveTextContent('10 de enero de 2027');
    expect(screen.getByRole('button', { name: 'Un vale más' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Un vale menos' }));
    expect(update).toHaveBeenCalledWith({ quantity: 1 });
    expect(screen.queryByTestId('no-product-notice')).toBeNull();
  });

  it('«sin producto»: el aviso (sin vale, sin certificado y sin devolución) va antes de elegir, en los tres idiomas', () => {
    const noProduct: CheckoutOffer = { ...OFFER, voucher: { ...OFFER.voucher!, available: 0, noProduct: true } };
    for (const [locale, words] of [
      ['es', ['No recibes vales ni código QR.', 'No da derecho a certificado fiscal de donación.', 'No se devuelve']],
      ['ca', ['No reps vals ni codi QR.', 'No dona dret a certificat fiscal de donació.', 'No es retorna']],
      ['en', ['You do not receive vouchers or a QR code.', 'It does not entitle you to a donation tax certificate.', 'It is not refunded']]
    ] as const) {
      const { unmount } = renderWithIntl(<VoucherQuantityField offer={noProduct} draft={initialDraft(noProduct)} update={vi.fn()} max={50} error={null} />, locale);
      const notice = screen.getByTestId('no-product-notice');
      for (const text of words) expect(notice, `${locale}: ${text}`).toHaveTextContent(text);
      unmount();
    }
  });
});
