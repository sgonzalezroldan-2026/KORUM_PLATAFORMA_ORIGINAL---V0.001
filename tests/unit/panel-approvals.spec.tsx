import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { DoubleCheckBox } from '@/components/panel/double-check-box';
import { IdeaModerationCard } from '@/components/panel/idea-moderation-card';
import { SignChallengeForm } from '@/components/panel/sign-challenge-form';
import { quarterOf } from '@/core/ideas/idea-conversion';
import { approveIdeaSchema, rejectIdeaSchema } from '@/core/ideas/idea-moderation-rules';
import { meetsQuorum } from '@/core/ideas/idea-quorum';
import { newWalletId } from '@/core/finance/wallet-id';
import { isProtectedPath } from '@/lib/auth/protected-paths';
import type { ModerationIdeaView } from '@/services/panel/approvals-data';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string | { pathname: string; query?: Record<string, string> }; children: ReactNode; prefetch?: boolean }) => (
    <a href={typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query ?? {}).toString()}`} {...props}>
      {children}
    </a>
  )
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const approvals = { approveIdeaAction: vi.fn(), rejectIdeaAction: vi.fn(), replyIdeaAction: vi.fn(), revalidateSignatureAction: vi.fn(), requestIdeaSignatureAction: vi.fn() };
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions', () => ({
  approveIdeaAction: (...args: unknown[]) => approvals.approveIdeaAction(...args),
  rejectIdeaAction: (...args: unknown[]) => approvals.rejectIdeaAction(...args),
  replyIdeaAction: (...args: unknown[]) => approvals.replyIdeaAction(...args),
  revalidateSignatureAction: (...args: unknown[]) => approvals.revalidateSignatureAction(...args),
  requestIdeaSignatureAction: (...args: unknown[]) => approvals.requestIdeaSignatureAction(...args)
}));
const signing = { previewSignatureAction: vi.fn(), completeSignatureAction: vi.fn() };
vi.mock('@/app/[locale]/(dashboard)/panel/[orgSlug]/firmar/actions', () => ({
  previewSignatureAction: (...args: unknown[]) => signing.previewSignatureAction(...args),
  completeSignatureAction: (...args: unknown[]) => signing.completeSignatureAction(...args)
}));

const idea = (overrides: Partial<ModerationIdeaView> = {}): ModerationIdeaView => ({
  id: 41,
  alias: '#FAM-4821',
  title: 'Taller de lectura en voz alta',
  category: 'Cultura',
  description: 'Un taller semanal de lectura para todo el curso.',
  phase: 'PHASE0_MOD',
  verifiedVotes: 1,
  suspiciousVotes: 0,
  percent: 3,
  daysRemaining: 45,
  expiresAt: '2026-12-25T10:00:00.000Z',
  createdAt: '2026-11-08T10:00:00.000Z',
  chatOpen: true,
  signatures: [],
  messages: [{ id: 1, role: 'SYSTEM', label: 'KORUM', body: 'Propuesta registrada con #FAM-4821.', createdAt: '2026-11-08T10:00:00.000Z' }],
  doubleCheck: null,
  initiative: null,
  ...overrides
});

beforeEach(() => {
  for (const mock of [...Object.values(approvals), ...Object.values(signing), refresh]) mock.mockReset();
});

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('reglas puras del 4.2a', () => {
  it('el quórum solo cuenta firmas verificadas y nunca pide menos de 1', () => {
    expect(meetsQuorum(3, 3)).toBe(true);
    expect(meetsQuorum(2, 3)).toBe(false);
    expect(meetsQuorum(1, 0)).toBe(true);
    expect(meetsQuorum(0, 0)).toBe(false);
  });

  it('trimestre natural y hucha WLT-ESC-XXXXXX sin caracteres ambiguos', () => {
    expect(quarterOf(new Date('2027-01-09T00:00:00Z'))).toBe('2027-Q1');
    expect(quarterOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026-Q4');
    for (let i = 0; i < 50; i += 1) expect(newWalletId()).toMatch(/^WLT-ESC-[A-HJ-NP-Z2-9]{6}$/);
  });

  it('aprobar limpia el texto como al proponer y desestimar exige un motivo de al menos 10 caracteres', () => {
    expect(approveIdeaSchema.parse({ ideaId: 1, title: ' Toldos​ para   el patio ', category: 'Patios', description: 'Sombra para el recreo de todo el centro.' }).title).toBe('Toldos para el patio');
    expect(approveIdeaSchema.safeParse({ ideaId: 1, title: 'Corto', category: 'Patios', description: 'Sombra para el recreo de todo el centro.' }).success).toBe(false);
    expect(rejectIdeaSchema.safeParse({ ideaId: 1, reason: 'No cabe' }).success).toBe(false);
    expect(rejectIdeaSchema.safeParse({ ideaId: 1, reason: 'No cabe este curso, lo sentimos.' }).success).toBe(true);
  });

  it('/firmar no pasa por la redirección del proxy (guarda antes el enlace); el resto del panel sí', () => {
    for (const path of ['/panel/cervantes/firmar', '/ca/panel/cervantes/firmar', '/en/panel/cervantes/firmar']) expect(isProtectedPath(path), path).toBe(false);
    for (const path of ['/panel/cervantes', '/panel/cervantes/aprobaciones', '/panel/cervantes/firmarx']) expect(isProtectedPath(path), path).toBe(true);
  });
});

describe('IdeaModerationCard', () => {
  it('en revisión inicial deja corregir el texto y aprueba con lo corregido', async () => {
    approvals.approveIdeaAction.mockResolvedValue({ status: 'OK', phase: 'PUBLIC_VOTING' });
    renderWithIntl(
      <ApprovalsNoticeProvider>
        <IdeaModerationCard orgSlug="cervantes" idea={idea()} minVotes={30} categories={['Cultura', 'Patios']} canModerate />
      </ApprovalsNoticeProvider>
    );
    expect(screen.queryByText(/firmas verificadas/)).toBeNull();
    expect(screen.getByText('🛡️ Revisión inicial')).toBeInTheDocument();
    const title = screen.getByLabelText('Título');
    await userEvent.clear(title);
    await userEvent.type(title, 'Taller de lectura para Primaria');
    await userEvent.selectOptions(screen.getByLabelText('Categoría'), 'Patios');
    await userEvent.click(screen.getByRole('button', { name: '✅ Aprobar y abrir a firmas' }));
    await waitFor(() => expect(approvals.approveIdeaAction).toHaveBeenCalledWith('cervantes', expect.objectContaining({ ideaId: 41, title: 'Taller de lectura para Primaria', category: 'Patios' })));
    // El aviso vive por encima de las listas: la tarjeta cambia de lista al refrescar y no se pierde (revisión de experiencia del 4.2a).
    const notice = await screen.findByTestId('approvals-notice');
    expect(notice).toHaveTextContent('Idea publicada: ya se pueden recoger firmas en el buzón.');
    await waitFor(() => expect(notice).toHaveFocus());
    expect(refresh).toHaveBeenCalled();
  });

  it('desestimar pide un motivo y lo envía; un error se anuncia dentro de la tarjeta', async () => {
    approvals.rejectIdeaAction.mockResolvedValueOnce({ status: 'ERROR', reason: 'WRONG_PHASE' });
    renderWithIntl(<IdeaModerationCard orgSlug="cervantes" idea={idea({ phase: 'PUBLIC_VOTING' })} minVotes={30} categories={['Cultura']} canModerate />);
    const toggle = screen.getByRole('button', { name: '❌ Desestimar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    const confirm = screen.getByRole('button', { name: 'Desestimar la idea' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Motivo para #FAM-4821 (lo leerá en su chat)'), 'Este curso no podemos asumirlo.');
    await userEvent.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent('La idea ya ha cambiado de fase.');
  });

  it('sin cargo de firma (Super-Admin) no ofrece moderar, y en firmas enseña el avance y la auditoría', () => {
    renderWithIntl(<IdeaModerationCard orgSlug="cervantes" idea={idea({ phase: 'PUBLIC_VOTING', verifiedVotes: 12, percent: 40, daysRemaining: 9, signatures: [{ id: 7, status: 'SUSPICIOUS', reason: 'ideas.audit.tooManyAccounts', accountOrder: 3, revalidated: false, createdAt: '2026-11-08T10:00:00.000Z' }], suspiciousVotes: 1 })} minVotes={30} categories={['Cultura']} canModerate={false} />);
    expect(screen.queryByRole('button', { name: /Desestimar/ })).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Avance hacia el quórum' })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText(/Quedan 9 días de firmas/)).toBeInTheDocument();
    const audit = screen.getByTestId('signature-audit');
    expect(within(audit).getByText(/3ª cuenta firmando desde el mismo dispositivo/)).toBeInTheDocument();
    expect(within(audit).queryByRole('button', { name: 'Dar por buena' })).toBeNull();
    const line = within(audit).getByText(/3ª cuenta firmando/).closest('li');
    expect(line?.textContent?.match(/⚠️/gu)).toHaveLength(1);
    expect(screen.queryByLabelText('Escribir a #FAM-4821')).toBeNull();
    expect(screen.getByText('Solo las personas firmantes de la entidad pueden escribir en esta conversación.')).toBeInTheDocument();
  });

  it('una idea convertida enlaza con su hucha y ya no deja escribir', () => {
    renderWithIntl(<IdeaModerationCard orgSlug="cervantes" idea={idea({ phase: 'CONVERTED', chatOpen: false, initiative: { id: 9, walletEscrowId: 'WLT-ESC-ABC234' } })} minVotes={30} categories={['Cultura']} canModerate />);
    expect(screen.getByText(/hucha WLT-ESC-ABC234/)).toBeInTheDocument();
    expect(screen.getByText('La conversación está cerrada.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Desestimar/ })).toBeNull();
  });
});

describe('DoubleCheckBox', () => {
  const box = { signed: 1, mySlotOpen: true, myChallengeExpiresAt: null, revalidatedVotes: 2, slots: [{ role: 'DIRECTOR' as const, holderLabel: 'Dirección del centro', signedBy: { name: 'Carla Puig', roleLabel: 'Dirección del centro', signedAt: '2026-11-08T10:00:00.000Z' } }, { role: 'COSIGNER' as const, holderLabel: null, signedBy: null }] };

  it('dice 1 de 2 con texto, quién firmó, y pide el enlace sin mostrar código ni enlace', async () => {
    approvals.requestIdeaSignatureAction.mockResolvedValue({ status: 'OK', expiresAt: '2026-11-11T10:00:00.000Z' });
    renderWithIntl(<DoubleCheckBox orgSlug="cervantes" ideaId={41} doubleCheck={box} isSigner />);
    expect(screen.getByText('Doble firma: 1 de 2')).toBeInTheDocument();
    expect(screen.getByText(/Incluye 2 firmas que la entidad validó a mano/)).toBeInTheDocument();
    expect(screen.getByText(/Firmado por Carla Puig/)).toBeInTheDocument();
    expect(screen.getByText(/Pendiente de firma/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '🛡️ Pedir mi enlace de firma' }));
    expect(await screen.findByText(/Te hemos enviado a tu email un enlace de un solo uso/)).toBeInTheDocument();
    expect(approvals.requestIdeaSignatureAction).toHaveBeenCalledWith('cervantes', { ideaId: 41 });
  });

  it('si ya firmó su cargo, no ofrece firmar; un límite de peticiones se explica', async () => {
    approvals.requestIdeaSignatureAction.mockResolvedValue({ status: 'ERROR', reason: 'RATE_LIMITED' });
    const { unmount } = renderWithIntl(<DoubleCheckBox orgSlug="cervantes" ideaId={41} doubleCheck={{ ...box, mySlotOpen: false }} isSigner />);
    expect(screen.getByText(/le toca a la otra persona firmante/)).toBeInTheDocument();
    unmount();
    renderWithIntl(<DoubleCheckBox orgSlug="cervantes" ideaId={41} doubleCheck={box} isSigner />);
    await userEvent.click(screen.getByRole('button', { name: '🛡️ Pedir mi enlace de firma' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Has pedido varios enlaces seguidos.');
  });
});

describe('SignChallengeForm (/firmar)', () => {
  const preview = { status: 'READY', targetType: 'IDEA_APPROVAL', expiresAt: '2026-11-11T10:00:00.000Z', idea: { alias: '#FAM-4821', title: 'Toldos para el patio', category: 'Patios', description: 'Sombra para el recreo.', verifiedVotes: 31 } };
  const token = 'T'.repeat(43);

  it('lee el token del fragmento, lo borra de la barra, enseña qué se firma y firma con el código', async () => {
    window.history.replaceState(null, '', `/panel/cervantes/firmar#t=${token}`);
    signing.previewSignatureAction.mockResolvedValue(preview);
    signing.completeSignatureAction.mockResolvedValue({ status: 'SIGNED', complete: true, initiativeId: 12, otherSignerNotified: false });
    renderWithIntl(<SignChallengeForm orgSlug="cervantes" session="READY" nextPath="/panel/cervantes/firmar" />);
    expect(await screen.findByText('Toldos para el patio')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(signing.previewSignatureAction).toHaveBeenCalledWith('cervantes', token);
    await userEvent.type(screen.getByLabelText('Código de 6 dígitos del email'), '12a3456');
    await userEvent.click(screen.getByRole('button', { name: 'Firmar' }));
    expect(signing.completeSignatureAction).toHaveBeenCalledWith({ token, otp: '123456' });
    const done = await screen.findByRole('heading', { name: '¡Doble firma completa! 2 de 2' });
    await waitFor(() => expect(done).toHaveFocus());
    expect(window.sessionStorage.getItem('korum:double-check:cervantes')).toBeNull();
  });

  it('sin sesión guarda el enlace en la pestaña y manda a entrar con la ruta de vuelta', async () => {
    window.history.replaceState(null, '', `/panel/cervantes/firmar#t=${token}`);
    renderWithIntl(<SignChallengeForm orgSlug="cervantes" session="LOGIN" nextPath="/panel/cervantes/firmar" />);
    const link = await screen.findByRole('link', { name: 'Entrar para firmar' });
    expect(link.getAttribute('href')).toBe('/login?next=%2Fpanel%2Fcervantes%2Ffirmar');
    expect(window.sessionStorage.getItem('korum:double-check:cervantes')).toBe(token);
    expect(signing.previewSignatureAction).not.toHaveBeenCalled();
  });

  it('un código erróneo dice los intentos que quedan; un enlace que ya no sirve lleva a Aprobaciones', async () => {
    window.sessionStorage.setItem('korum:double-check:cervantes', token);
    signing.previewSignatureAction.mockResolvedValue(preview);
    signing.completeSignatureAction.mockResolvedValue({ status: 'INVALID_OTP', attemptsLeft: 3 });
    const { unmount } = renderWithIntl(<SignChallengeForm orgSlug="cervantes" session="READY" nextPath="/panel/cervantes/firmar" />);
    await userEvent.type(await screen.findByLabelText('Código de 6 dígitos del email'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Firmar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Te quedan 3 intentos.');
    unmount();

    signing.previewSignatureAction.mockResolvedValue({ status: 'INVALID_LINK' });
    renderWithIntl(<SignChallengeForm orgSlug="cervantes" session="READY" nextPath="/panel/cervantes/firmar" />);
    expect(await screen.findByRole('heading', { name: 'Este enlace ya no sirve' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a Aprobaciones' })).toHaveAttribute('href', '/panel/cervantes/aprobaciones');
  });

  it('sin enlace en la barra ni en la pestaña, explica qué hacer (en catalán)', async () => {
    renderWithIntl(<SignChallengeForm orgSlug="cervantes" session="READY" nextPath="/ca/panel/cervantes/firmar" />, 'ca');
    expect(await screen.findByRole('heading', { name: 'Aquest enllaç ja no serveix' })).toBeInTheDocument();
  });
});
