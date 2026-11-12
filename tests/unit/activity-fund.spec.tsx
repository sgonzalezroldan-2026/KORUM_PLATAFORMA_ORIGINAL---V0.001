import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityFundPending, ActivityFundRequestForm } from '@/components/panel/activity-fund-actions';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { activityFundTargetDigest } from '@/core/security/signature-hash';
import { buildFundReceiptLines, renderFundReceiptPdf } from '@/core/sponsors/activity-fund-receipt';
import { FUND_REMINDER_DAYS, fundNeedsReminder, planFundPayout, requestFundPayoutSchema, splitDeadline, type FundBalance } from '@/core/sponsors/activity-fund-rules';
import { ACTIVITY_FUND_DAY, creditPoolDeadline, effectiveCreditPoolMaxDays } from '@/core/sponsors/sponsor-reassignment-rules';
import type { ActivityFundView } from '@/services/panel/activity-fund-data';
import es from '../../messages/es.json';
import { renderWithIntl } from '../utils/render-with-intl';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const actions = { requestFundPayoutAction: vi.fn(), requestFundSignatureAction: vi.fn(), cancelFundPayoutAction: vi.fn(), retryFundPayoutAction: vi.fn() };
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/fondo/actions', () => ({
  requestFundPayoutAction: (...args: unknown[]) => actions.requestFundPayoutAction(...args),
  requestFundSignatureAction: (...args: unknown[]) => actions.requestFundSignatureAction(...args),
  cancelFundPayoutAction: (...args: unknown[]) => actions.cancelFundPayoutAction(...args),
  retryFundPayoutAction: (...args: unknown[]) => actions.retryFundPayoutAction(...args)
}));

afterEach(() => {
  vi.clearAllMocks();
});

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T10:00:00.000Z');
const balance = (sponsorId: number, daysAgo: number, balanceCents: number, splittable = true): FundBalance => ({ sponsorId, contributionId: sponsorId * 10, chargedAt: new Date(NOW.getTime() - daysAgo * DAY), balanceCents, splittable });

describe('Sprint 4.2f · qué se puede liquidar del Fondo de actividades', () => {
  it('suma lo que sigue dentro de la ventana de 90 días, del cobro más antiguo al más reciente; lo vencido o deshecho queda aparte', () => {
    const plan = planFundPayout([balance(3, 20, 10_000), balance(1, 80, 25_000), balance(2, 95, 50_000), balance(4, 10, 7_000, false), balance(5, 5, 0)], NOW);
    expect(plan.splits.map((split) => split.sponsorId)).toEqual([1, 3]);
    expect(plan.amountCents).toBe(35_000);
    expect(plan.stuckCents).toBe(57_000);
    expect(plan.deadline?.getTime()).toBe(NOW.getTime() - 80 * DAY + 90 * DAY);
    expect(planFundPayout([], NOW)).toEqual({ splits: [], amountCents: 0, deadline: null, stuckCents: 0 });
  });

  it('1.000 Fondos aleatorios: lo liquidable más lo atascado es exactamente el saldo, al céntimo', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 1_000; run += 1) {
      const balances = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) => balance(index + 1, Math.floor(random() * 120), Math.floor(random() * 60_000), random() > 0.1));
      const plan = planFundPayout(balances, NOW);
      const total = balances.reduce((sum, entry) => sum + entry.balanceCents, 0);
      expect(plan.amountCents + plan.stuckCents).toBe(total);
      expect(plan.splits.reduce((sum, split) => sum + split.amountCents, 0)).toBe(plan.amountCents);
      expect(plan.splits.every((split) => split.amountCents > 0)).toBe(true);
    }
  });

  it('el recordatorio salta a 10 días del final; la bolsa nunca espera más allá del día 70 aunque la consola diga más', () => {
    const deadline = splitDeadline(new Date(NOW.getTime() - 80 * DAY));
    expect(fundNeedsReminder(deadline, NOW)).toBe(true);
    expect(fundNeedsReminder(new Date(NOW.getTime() + (FUND_REMINDER_DAYS + 1) * DAY), NOW)).toBe(false);
    expect(fundNeedsReminder(null, NOW)).toBe(false);
    expect(effectiveCreditPoolMaxDays(90)).toBe(ACTIVITY_FUND_DAY);
    expect(effectiveCreditPoolMaxDays(-5)).toBe(0);
    expect(creditPoolDeadline({ paidAt: NOW, creditPoolAt: NOW }, 80).getTime()).toBe(NOW.getTime() + ACTIVITY_FUND_DAY * DAY);
  });

  it('el destino tiene entre 10 y 500 caracteres y no admite enlaces', () => {
    expect(requestFundPayoutSchema.safeParse({ purpose: 'Material para las colonias' }).success).toBe(true);
    expect(requestFundPayoutSchema.safeParse({ purpose: 'corto' }).success).toBe(false);
    expect(requestFundPayoutSchema.safeParse({ purpose: 'x'.repeat(501) }).success).toBe(false);
    expect(requestFundPayoutSchema.safeParse({ purpose: 'Mirad www.ejemplo.test para el material' }).success).toBe(false);
    expect(requestFundPayoutSchema.safeParse({ purpose: 'Mirad HTTPS://ejemplo.test para el material' }).success).toBe(false);
  });
});

describe('Sprint 4.2f · huella de lo que se firma', () => {
  const payout = { id: 4, organizationId: 'org_1', amountCents: 35_000, purpose: 'Material para las colonias', splits: [{ sponsorId: 1, amountCents: 25_000 }, { sponsorId: 3, amountCents: 10_000 }] };
  const digest = (overrides: Partial<typeof payout> = {}, account: string | null = 'split_1') => activityFundTargetDigest('secreto-de-pruebas-del-fondo-0123456789', { ...payout, ...overrides }, account);

  it('cambia si cambia el importe, el destino, la cuenta o de quién es cada parte; no depende del orden de los repartos', () => {
    const base = digest();
    expect(digest({ splits: [...payout.splits].reverse() })).toBe(base);
    expect(digest({ amountCents: 35_001 })).not.toBe(base);
    expect(digest({ purpose: 'Otra cosa distinta' })).not.toBe(base);
    expect(digest({}, 'split_2')).not.toBe(base);
    expect(digest({ splits: [{ sponsorId: 1, amountCents: 10_000 }, { sponsorId: 3, amountCents: 25_000 }] })).not.toBe(base);
    expect(digest({ id: 5 })).not.toBe(base);
  });
});

describe('Sprint 4.2f · justificante en PDF', () => {
  const t = (key: string, values: Record<string, string> = {}) => {
    const template = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], es.panel.fund.receipt) as string;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
  };
  const data = {
    reference: 'FA-4',
    entityName: 'AMPA CEIP Cervantes',
    legalName: 'Asociación de Madres y Padres del CEIP Cervantes',
    amountCents: 35_000,
    purpose: 'Material para las colonias\nY la fiesta de fin de curso',
    requestedAt: NOW,
    executedAt: NOW,
    sponsors: [{ name: 'Papelería Nube', level: 'Categoría PLATA', amountCents: 25_000, chargedAt: new Date('2026-09-01T10:00:00.000Z') }],
    signatures: [{ role: 'Primera firma', name: 'Laura Pérez', signedAt: NOW }, { role: 'Segunda firma', name: 'Marta Soler', signedAt: NOW }],
    generatedAt: NOW,
    locale: 'es' as const
  };

  it('dice cuánto, para qué, de qué comercios y quién firmó, sin emojis (el PDF no los puede pintar)', () => {
    const text = buildFundReceiptLines(data, t).map((line) => line.text).join('\n');
    expect(text).toContain('Justificante de liquidación del Fondo de actividades');
    expect(text.replaceAll('\n', ' ')).toContain('KORUM no comprueba el uso del dinero');
    expect(text).toMatch(/Importe enviado: 350,00\s€/);
    expect(text).toContain('Y la fiesta de fin de curso');
    expect(text).toMatch(/Papelería Nube \(Categoría PLATA\): 250,00\s€/);
    expect(text).toContain('Segunda firma: Marta Soler');
    expect(text).toContain('no custodia fondos');
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    const pdf = Buffer.from(renderFundReceiptPdf(data, t)).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  });
});

const pendingPayout = (overrides: Partial<NonNullable<ActivityFundView['pending']>> = {}): NonNullable<ActivityFundView['pending']> => ({
  id: 4,
  reference: 'FA-4',
  amountCents: 25_000,
  purpose: 'Material para las colonias de primavera',
  status: 'PENDING_DOUBLE_CHECK',
  cancelReason: null,
  requestedBy: 'Laura Pérez',
  createdAt: NOW.toISOString(),
  executedAt: null,
  doneCents: 0,
  splits: [{ sponsor: 'Papelería Nube', level: 'PLATA', amountCents: 25_000, done: false }],
  signed: 1,
  slots: [
    { role: 'DIRECTOR', holderLabel: 'Dirección', signedBy: { name: 'Laura Pérez', roleLabel: 'Dirección', signedAt: NOW.toISOString() } },
    { role: 'COSIGNER', holderLabel: 'Tesorería del AMPA', signedBy: null }
  ],
  mySlotOpen: true,
  myChallengeExpiresAt: null,
  ...overrides
});

const withNotice = (node: React.ReactNode) => renderWithIntl(<ApprovalsNoticeProvider>{node}</ApprovalsNoticeProvider>);

describe('Sprint 4.2f · pedir y firmar la liquidación desde el panel', () => {
  it('el destino es obligatorio: el error se asocia al campo y se anuncia; al pedirla, el aviso recibe el foco', async () => {
    actions.requestFundPayoutAction.mockResolvedValue({ status: 'OK', expiresAt: '2026-11-13T10:00:00.000Z' });
    withNotice(<ActivityFundRequestForm orgSlug="colegio-sol" availableCents={25_000} />);
    expect(screen.getByTestId('fund-request')).toHaveTextContent(/Hoy podéis liquidar 250,00\s€/);
    const field = screen.getByLabelText('Para qué se usará el dinero');
    await userEvent.type(field, 'Poco');
    await userEvent.click(screen.getByRole('button', { name: /Pedir la liquidación/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribid entre 10 y 500 caracteres');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveFocus();
    expect(actions.requestFundPayoutAction).not.toHaveBeenCalled();

    await userEvent.type(field, ' material para las colonias');
    await userEvent.click(screen.getByRole('button', { name: /Pedir la liquidación/ }));
    expect(actions.requestFundPayoutAction).toHaveBeenCalledWith('colegio-sol', { purpose: 'Poco material para las colonias' });
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('Liquidación pedida'));
    expect(screen.getByTestId('approvals-notice')).toHaveFocus();
    expect(refresh).toHaveBeenCalled();
  });

  it('un error del servidor se dice en lenguaje llano dentro del formulario', async () => {
    actions.requestFundPayoutAction.mockResolvedValue({ status: 'ERROR', reason: 'KYB_NOT_VERIFIED' });
    withNotice(<ActivityFundRequestForm orgSlug="colegio-sol" availableCents={25_000} />);
    await userEvent.type(screen.getByLabelText('Para qué se usará el dinero'), 'Material para las colonias');
    await userEvent.click(screen.getByRole('button', { name: /Pedir la liquidación/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('documentos del titular verificados');
  });

  it('la liquidación pendiente enseña las dos casillas con texto, pide el enlace propio y se retira solo tras confirmarlo', async () => {
    actions.requestFundSignatureAction.mockResolvedValue({ status: 'OK', expiresAt: '2026-11-13T10:00:00.000Z' });
    actions.cancelFundPayoutAction.mockResolvedValue({ status: 'OK' });
    withNotice(<ActivityFundPending orgSlug="colegio-sol" payout={pendingPayout()} canAct />);
    const box = screen.getByTestId('fund-pending');
    expect(box).toHaveTextContent('Doble firma: 1 de 2');
    expect(box).toHaveTextContent('Firmado por Laura Pérez');
    expect(box).toHaveTextContent('Pendiente de firma');
    await userEvent.click(screen.getByRole('button', { name: /Pedir mi enlace de firma/ }));
    expect(actions.requestFundSignatureAction).toHaveBeenCalledWith('colegio-sol', { payoutId: 4 });
    await waitFor(() => expect(screen.getByTestId('approvals-notice')).toHaveTextContent('Te hemos enviado a tu email'));

    await userEvent.click(screen.getByRole('button', { name: 'Retirar esta liquidación' }));
    expect(actions.cancelFundPayoutAction).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirmar que se retira la liquidación' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sí, retirarla' }));
    expect(actions.cancelFundPayoutAction).toHaveBeenCalledWith('colegio-sol', { payoutId: 4 });
  });

  it('con firma única, una liquidación que ya tiene la firma que exige la entidad pero no se aprobó ofrece aprobar y enviar ya; con una firma aún pendiente, no (auditoría financiera del 5.2, H3)', async () => {
    actions.retryFundPayoutAction.mockResolvedValue({ status: 'OK', executed: true });
    const complete = pendingPayout({ signed: 1, slots: [{ role: 'DIRECTOR', holderLabel: 'Dirección', signedBy: { name: 'Laura Pérez', roleLabel: 'Dirección', signedAt: NOW.toISOString() } }], mySlotOpen: false });
    const { unmount } = withNotice(<ActivityFundPending orgSlug="colegio-sol" payout={complete} canAct />);
    expect(screen.getByTestId('fund-pending')).toHaveTextContent('Ya están las firmas que exige la entidad');
    expect(screen.getByTestId('fund-pending')).not.toHaveTextContent('Falta la de la otra persona firmante');
    // El título y el botón cuentan lo que pasa de verdad: ya está firmada y falta el primer envío (no es un «reintento»).
    expect(screen.getByRole('heading', { name: /firmada, falta enviarla/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reintentar/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Enviar el dinero ahora' }));
    expect(actions.retryFundPayoutAction).toHaveBeenCalledWith('colegio-sol', { payoutId: 4 });
    unmount();
    withNotice(<ActivityFundPending orgSlug="colegio-sol" payout={pendingPayout({ mySlotOpen: false })} canAct />);
    expect(screen.queryByRole('button', { name: 'Enviar el dinero ahora' })).toBeNull();
  });

  it('en solo lectura (Super-Admin) no hay botones', () => {
    withNotice(<ActivityFundPending orgSlug="colegio-sol" payout={pendingPayout()} canAct={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('fund-pending')).toHaveTextContent('Solo las personas firmantes');
  });
});
