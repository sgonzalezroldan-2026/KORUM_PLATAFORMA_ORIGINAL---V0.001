import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { SponsorMoneyDetail } from '@/components/panel/sponsor-money-detail';
import { SponsorRenewalRuleForm } from '@/components/panel/sponsor-renewal-rule-form';
import {
  ACTIVITY_FUND_DAY,
  creditPoolDeadline,
  isEligibleTarget,
  planPlacement,
  renewalExpiry,
  renewalLinkValidUntil,
  renewalWindowOpen,
  type PlacementTarget
} from '@/core/sponsors/sponsor-reassignment-rules';
import { newRenewalOrder, readRenewalToken, signRenewalToken } from '@/core/sponsors/sponsor-renewal-token';
import type { ModerationSponsorView } from '@/services/panel/sponsor-moderation-data';
import { renderWithIntl } from '../utils/render-with-intl';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const actions = { assignPooledSponsorAction: vi.fn(), sendSponsorRenewalLinkAction: vi.fn(), saveSponsorRenewalRuleAction: vi.fn() };
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions', () => ({
  assignPooledSponsorAction: (...args: unknown[]) => actions.assignPooledSponsorAction(...args),
  sendSponsorRenewalLinkAction: (...args: unknown[]) => actions.sendSponsorRenewalLinkAction(...args),
  saveSponsorRenewalRuleAction: (...args: unknown[]) => actions.saveSponsorRenewalRuleAction(...args)
}));

afterEach(() => {
  vi.clearAllMocks();
});

const DAY = 86_400_000;
const NOW = new Date('2026-11-09T10:00:00.000Z');
const target = (id: number, closesInDays: number, goalCents: number, raisedCents = 0): PlacementTarget => ({ id, closesAt: new Date(NOW.getTime() + closesInDays * DAY), goalCents, raisedCents });

describe('Sprint 4.2d · plan de colocación según la regla de la entidad', () => {
  it('SOONEST lleva todo a la que cierra antes (a igual fecha, la más antigua); MANUAL o sin campañas, nada', () => {
    const targets = [target(9, 30, 10_000), target(4, 12, 10_000), target(2, 12, 10_000)];
    expect(planPlacement('SOONEST', 25_000, targets)).toEqual([{ initiativeId: 2, amountCents: 25_000 }]);
    expect(planPlacement('MANUAL', 25_000, targets)).toEqual([]);
    expect(planPlacement('PROPORTIONAL', 25_000, [])).toEqual([]);
    expect(() => planPlacement('SOONEST', 0, targets)).toThrow(RangeError);
    expect(() => planPlacement('SOONEST', 10.5, targets)).toThrow(RangeError);
  });

  it('PROPORTIONAL reparte por lo que le falta a cada una; si a ninguna le falta, a partes iguales', () => {
    expect(planPlacement('PROPORTIONAL', 25_000, [target(1, 10, 30_000), target(2, 20, 10_000)])).toEqual([
      { initiativeId: 1, amountCents: 18_750 },
      { initiativeId: 2, amountCents: 6_250 }
    ]);
    expect(planPlacement('PROPORTIONAL', 10_000, [target(1, 10, 5_000, 5_000), target(2, 20, 5_000, 6_000), target(3, 30, 1, 1)])).toEqual([
      { initiativeId: 1, amountCents: 3_334 },
      { initiativeId: 2, amountCents: 3_333 },
      { initiativeId: 3, amountCents: 3_333 }
    ]);
    // Nunca más partes que céntimos.
    expect(planPlacement('PROPORTIONAL', 2, [target(1, 10, 100), target(2, 20, 100), target(3, 30, 100)])).toEqual([
      { initiativeId: 1, amountCents: 1 },
      { initiativeId: 2, amountCents: 1 }
    ]);
  });

  it('fuzzing (1.000 casos con semilla fija): el reparto suma exactamente el importe, ninguna parte es 0 y no se repite campaña', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 1_000; run += 1) {
      const amount = 1 + Math.floor(random() * 2_000_000);
      const count = 1 + Math.floor(random() * 7);
      const targets = Array.from({ length: count }, (_, index) => target(index + 1, 1 + Math.floor(random() * 60), Math.floor(random() * 5_000_000), Math.floor(random() * 5_000_000)));
      const plan = planPlacement('PROPORTIONAL', amount, targets);
      expect(plan.reduce((sum, part) => sum + part.amountCents, 0)).toBe(amount);
      expect(plan.every((part) => Number.isSafeInteger(part.amountCents) && part.amountCents > 0)).toBe(true);
      expect(new Set(plan.map((part) => part.initiativeId)).size).toBe(plan.length);
    }
  });

  it('una campaña puede recibir el dinero si sigue abierta y cierra antes del día 85 desde el cobro', () => {
    const chargedAt = new Date(NOW.getTime() - 20 * DAY);
    expect(isEligibleTarget({ closesAt: new Date(NOW.getTime() + 60 * DAY) }, chargedAt, NOW)).toBe(true);
    expect(isEligibleTarget({ closesAt: new Date(NOW.getTime() + 66 * DAY) }, chargedAt, NOW)).toBe(false);
    expect(isEligibleTarget({ closesAt: new Date(NOW.getTime() - DAY) }, chargedAt, NOW)).toBe(false);
  });
});

describe('Sprint 4.2d · plazo de la bolsa y renovación', () => {
  it('la bolsa dura min(máximo de la consola desde la entrada, 70 días desde el cobro: después pasa al Fondo de actividades)', () => {
    const paidAt = new Date(NOW.getTime() - 50 * DAY);
    expect(creditPoolDeadline({ paidAt, creditPoolAt: NOW }, 60).getTime()).toBe(paidAt.getTime() + ACTIVITY_FUND_DAY * DAY);
    // Un máximo de la consola mayor que el día del Fondo no alarga la bolsa (Sprint 4.2f).
    expect(creditPoolDeadline({ paidAt: NOW, creditPoolAt: NOW }, 90).getTime()).toBe(NOW.getTime() + ACTIVITY_FUND_DAY * DAY);
    expect(creditPoolDeadline({ paidAt: NOW, creditPoolAt: NOW }, 60).getTime()).toBe(NOW.getTime() + 60 * DAY);
    expect(creditPoolDeadline({ paidAt: NOW, creditPoolAt: NOW }, -3).getTime()).toBe(NOW.getTime());
  });

  it('el distintivo renovado sigue al anterior sin perder días; el enlace vale desde 30 días antes hasta 30 después', () => {
    const expiresAt = new Date('2026-12-01T00:00:00.000Z');
    expect(renewalExpiry(expiresAt, new Date('2026-11-20T00:00:00.000Z')).toISOString()).toBe('2027-12-01T00:00:00.000Z');
    expect(renewalExpiry(expiresAt, new Date('2026-12-15T00:00:00.000Z')).toISOString()).toBe('2027-12-15T00:00:00.000Z');
    expect(renewalLinkValidUntil(expiresAt).toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(renewalWindowOpen(expiresAt, new Date('2026-10-30T00:00:00.000Z'))).toBe(false);
    expect(renewalWindowOpen(expiresAt, new Date('2026-11-02T00:00:00.000Z'))).toBe(true);
    expect(renewalWindowOpen(expiresAt, new Date('2026-12-30T00:00:00.000Z'))).toBe(true);
    expect(renewalWindowOpen(expiresAt, new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('el enlace firmado solo vale con su secreto y sin tocar; el pedido de la renovación es KR', () => {
    const secret = 'secreto-de-pruebas-de-la-renovacion-0123456789';
    const expiresAt = new Date('2026-12-01T00:00:00.000Z');
    const token = signRenewalToken(secret, 31, expiresAt);
    expect(readRenewalToken(secret, token)).toEqual({ sponsorId: 31, expiresAt });
    expect(readRenewalToken(`${secret}x`, token)).toBeNull();
    expect(readRenewalToken(secret, token.replace(/^31\./, '32.'))).toBeNull();
    expect(readRenewalToken(secret, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`)).toBeNull();
    expect(readRenewalToken(secret, 'basura')).toBeNull();
    expect(newRenewalOrder()).toMatch(/^KR[0-9A-F]{16}$/);
  });
});

const view = (overrides: Partial<ModerationSponsorView> = {}): ModerationSponsorView => ({
  id: 7,
  name: 'Librería El Faro',
  sector: 'Librería',
  level: 'PLATA',
  status: 'CREDIT_POOL',
  needsDecision: false,
  amountCents: 25_000,
  feeCents: 3_750,
  vatCents: 788,
  refundCents: 29_538,
  matching: false,
  promo: '',
  code: '',
  contactPerson: 'Rosa Gil',
  phone: '600112233',
  email: 'rosa@elfaro.test',
  autoRenew: true,
  paidAt: '2026-10-01T10:00:00.000Z',
  expiresAt: '2027-10-01T10:00:00.000Z',
  logoSrc: null,
  initiative: { id: 3, title: 'Toldos para el patio', walletEscrowId: 'WLT-ESC-101', status: 'REFUNDED' },
  money: { originCents: 0, placed: [], poolCents: 25_000, poolDeadline: '2026-12-25T10:00:00.000Z', fundCents: 0 },
  lateCharge: false,
  renewalInvitable: false,
  renewalInvitedAt: null,
  isRenewal: false,
  renewed: false,
  renewalOpen: false,
  renewalOpensAt: null,
  assignable: [
    { id: 11, title: 'Biblioteca de aula', closesAt: '2026-11-29T10:00:00.000Z' },
    { id: 12, title: 'Huerto escolar', closesAt: '2026-12-19T10:00:00.000Z' }
  ],
  ...overrides
});

const renderDetail = (sponsor: ModerationSponsorView, canModerate = true) =>
  renderWithIntl(
    <ApprovalsNoticeProvider>
      <SponsorMoneyDetail orgSlug="colegio-sol" sponsor={sponsor} canModerate={canModerate} />
    </ApprovalsNoticeProvider>
  );

describe('Sprint 4.2d · ficha del comercio en el panel («Ficha / Renovar»)', () => {
  it('dice dónde está el dinero y lleva la bolsa a la campaña elegida; el aviso de éxito recibe el foco', async () => {
    actions.assignPooledSponsorAction.mockResolvedValue({ status: 'OK', title: 'Huerto escolar' });
    renderDetail(view());
    await userEvent.click(screen.getByText('Ficha / Renovar'));
    expect(screen.getByTestId('sponsor-money')).toHaveTextContent('esperando campaña, retenidos en PAYCOMET hasta el');
    const select = screen.getByLabelText('Campaña a la que llevar lo que espera');
    expect(select).toHaveAccessibleDescription(/No se puede deshacer desde aquí/);
    expect(screen.getByRole('option', { name: /Huerto escolar · cierra el/ })).toBeInTheDocument();
    await userEvent.selectOptions(select, '12');
    await userEvent.click(screen.getByRole('button', { name: /Llevar 250,00\s€ a «Huerto escolar»/ }));
    expect(actions.assignPooledSponsorAction).toHaveBeenCalledWith('colegio-sol', { sponsorId: 7, initiativeId: 12 });
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('ya suman en «Huerto escolar»'));
    expect(screen.getByTestId('approvals-notice')).toHaveFocus();
    expect(refresh).toHaveBeenCalled();
  });

  it('sin campañas elegibles lo explica; un error del servidor se anuncia dentro de la ficha', async () => {
    renderDetail(view({ assignable: [], renewalOpen: true }));
    await userEvent.click(screen.getByText('Ficha / Renovar'));
    expect(screen.getByText(/no hay ninguna campaña recaudando/)).toBeInTheDocument();
    actions.sendSponsorRenewalLinkAction.mockResolvedValue({ status: 'ERROR', reason: 'RENEWAL_NOT_OPEN' });
    await userEvent.click(screen.getByRole('button', { name: /Enviarle el enlace de renovación/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ahora no se puede enviar el enlace');
  });

  it('el dinero colocado en otras campañas aparece con su hucha; en solo lectura no hay botones', async () => {
    renderDetail(
      view({ status: 'APPROVED', renewalOpen: true, assignable: [], money: { originCents: 0, placed: [{ initiativeId: 11, title: 'Biblioteca de aula', walletEscrowId: 'WLT-ESC-111', amountCents: 25_000 }], poolCents: 0, poolDeadline: null, fundCents: 0 } }),
      false
    );
    await userEvent.click(screen.getByText('Ficha / Renovar'));
    expect(screen.getByTestId('sponsor-money')).toHaveTextContent('llevados a «Biblioteca de aula» (WLT-ESC-111)');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Le enviamos un enlace de pago 30 días antes/)).toBeInTheDocument();
  });
});

describe('Sprint 4.2d · regla de la entidad', () => {
  it('guarda la regla elegida y anuncia cuántos comercios ha colocado; en solo lectura el selector está desactivado', async () => {
    actions.saveSponsorRenewalRuleAction.mockResolvedValue({ status: 'OK', placed: 2 });
    const { unmount } = renderWithIntl(
      <ApprovalsNoticeProvider>
        <SponsorRenewalRuleForm orgSlug="colegio-sol" rule="MANUAL" canEdit maxDays={45} />
      </ApprovalsNoticeProvider>
    );
    const select = screen.getByLabelText(/A dónde va el dinero/);
    expect(screen.getByRole('button', { name: 'Guardar la regla' })).toBeDisabled();
    expect(screen.getByText(/como mucho 45 días/)).toBeInTheDocument();
    await userEvent.selectOptions(select, 'PROPORTIONAL');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar la regla' }));
    expect(actions.saveSponsorRenewalRuleAction).toHaveBeenCalledWith('colegio-sol', { rule: 'PROPORTIONAL' });
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('el dinero de 2 comercios'));
    unmount();

    renderWithIntl(<SponsorRenewalRuleForm orgSlug="colegio-sol" rule="SOONEST" canEdit={false} maxDays={60} />);
    expect(screen.getByLabelText(/A dónde va el dinero/)).toBeDisabled();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Solo las personas firmantes/)).toBeInTheDocument();
  });
});
