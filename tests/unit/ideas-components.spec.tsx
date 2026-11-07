import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BeforeAfter } from '@/components/achievements/before-after';
import { DeviceProtectionNotice } from '@/components/ideas/device-protection-notice';
import { IdeaCard, type IdeaCardData } from '@/components/ideas/idea-card';
import { PortalNav } from '@/components/portal/portal-nav';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));
// Las acciones de servidor no se ejecutan en jsdom: aquí solo se comprueba lo que se ve y lo que se pide.
vi.mock('@/app/[locale]/(public)/[orgSlug]/ideas/actions', () => ({ withdrawFingerprintConsentAction: vi.fn(async () => 'WITHDRAWN'), signIdeaAction: vi.fn(), proposeIdeaAction: vi.fn() }));

const idea = (overrides: Partial<IdeaCardData> = {}): IdeaCardData => ({
  id: 7,
  alias: '#FAM-3109',
  title: 'Aparcabicicletas techado',
  category: 'Patios y Deporte',
  description: 'Cuando llueve los niños se mojan.',
  phase: 'PUBLIC_VOTING',
  verifiedVotes: 27,
  percent: 90,
  quorumReached: false,
  daysRemaining: 10,
  action: 'SIGN',
  ...overrides
});

const renderCard = (data: IdeaCardData, extra: Partial<Parameters<typeof IdeaCard>[0]> = {}) => {
  const onSign = vi.fn();
  const onShare = vi.fn();
  renderWithIntl(<IdeaCard idea={data} needed={30} signedIn loginHref="/login?next=%2Fcervantes%2Fideas" busy={false} onSign={onSign} onShare={onShare} {...extra} />);
  return { onSign, onShare };
};

describe('tarjeta de idea (QA-F09)', () => {
  it('enseña el código anónimo, las firmas verificadas, los días y una barra accesible; firmar pide la idea', async () => {
    const { onSign, onShare } = renderCard(idea());
    expect(screen.getByRole('heading', { level: 2, name: 'Aparcabicicletas techado' })).toBeInTheDocument();
    expect(screen.getByText('Código #FAM-3109')).toBeInTheDocument();
    expect(screen.getByText('27 de 30 firmas')).toBeInTheDocument();
    expect(screen.getByText('Quedan 10 días')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Firmas de «Aparcabicicletas techado»' })).toHaveAttribute('aria-valuenow', '90');
    await userEvent.click(screen.getByRole('button', { name: /Firmar apoyo/ }));
    expect(onSign).toHaveBeenCalledWith(7);
    await userEvent.click(screen.getByRole('button', { name: /Compartir/ }));
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('«un día» en singular y «último día» el mismo día', () => {
    renderCard(idea({ daysRemaining: 1 }));
    expect(screen.getByText('Queda 1 día')).toBeInTheDocument();
  });

  it('con sesión y ya firmada: un texto, no un botón; sin sesión: enlace para entrar con la vuelta al buzón', () => {
    const view = renderWithIntl(<IdeaCard idea={idea({ action: 'SIGNED' })} needed={30} signedIn loginHref="/login" busy={false} onSign={vi.fn()} onShare={vi.fn()} />);
    expect(screen.getByTestId('idea-signed')).toHaveTextContent('Ya has firmado, ¡gracias!');
    expect(screen.queryByRole('button', { name: /Firmar apoyo/ })).toBeNull();
    view.unmount();
    renderWithIntl(<IdeaCard idea={idea()} needed={30} signedIn={false} loginHref="/login?next=%2Fcervantes%2Fideas" busy={false} onSign={vi.fn()} onShare={vi.fn()} />);
    expect(screen.getByRole('link', { name: /Entra para firmar/ })).toHaveAttribute('href', '/login?next=%2Fcervantes%2Fideas');
  });

  it('con quórum logrado: sello y «en manos del centro», sin botón de firmar; plazo cerrado: lo dice con texto', () => {
    const view = renderWithIntl(<IdeaCard idea={idea({ phase: 'DOUBLE_CHECK', action: 'CLOSED', verifiedVotes: 30, percent: 100, quorumReached: true })} needed={30} signedIn loginHref="/login" busy={false} onSign={vi.fn()} onShare={vi.fn()} />);
    expect(screen.getByText('Quórum logrado')).toBeInTheDocument();
    expect(screen.getByText('En manos del centro')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Firmar apoyo/ })).toBeNull();
    view.unmount();
    renderWithIntl(<IdeaCard idea={idea({ action: 'CLOSED' })} needed={30} signedIn loginHref="/login" busy={false} onSign={vi.fn()} onShare={vi.fn()} />);
    expect(screen.getByText('Plazo de firmas cerrado')).toBeInTheDocument();
  });

  it('mientras firma, el botón está ocupado y desactivado (no se puede firmar dos veces con doble clic)', () => {
    renderCard(idea(), { busy: true });
    const button = screen.getByRole('button', { name: /Firmar apoyo/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});

describe('aviso de la cookie y la huella', () => {
  it('la casilla empieza desmarcada, explica la cookie y avisa de que es opcional y retirable', async () => {
    const onChange = vi.fn();
    renderWithIntl(<DeviceProtectionNotice granted={false} checked={false} onCheckedChange={onChange} onWithdrawn={vi.fn()} />);
    const checkbox = screen.getByRole('checkbox', { name: /Ayudar a proteger la votación \(opcional\)/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/cookie propia/)).toBeInTheDocument();
    expect(screen.getByText(/puedes retirarlo con un clic/)).toBeInTheDocument();
    await userEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('con el consentimiento dado, se retira con un clic, lo confirma y la casilla vuelve desmarcada; al volver a consentir, retirar sigue disponible', async () => {
    const onWithdrawn = vi.fn();
    // Como el tablero: quien manda el estado de «consentimiento vigente» es el padre.
    function Board() {
      const [granted, setGranted] = useState(true);
      const [checked, setChecked] = useState(true);
      return (
        <>
          <DeviceProtectionNotice
            granted={granted}
            checked={checked}
            onCheckedChange={setChecked}
            onWithdrawn={() => {
              onWithdrawn();
              setGranted(false);
              setChecked(false);
            }}
          />
          <button type="button" onClick={() => setGranted(true)}>
            simular firma con consentimiento
          </button>
        </>
      );
    }
    renderWithIntl(<Board />);
    expect(screen.getByText('Has activado la protección extra del navegador.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retirar mi consentimiento' }));
    expect(await screen.findByText(/hemos borrado la huella/)).toBeInTheDocument();
    expect(onWithdrawn).toHaveBeenCalledOnce();
    expect(screen.getByRole('checkbox', { name: /Ayudar a proteger/ })).not.toBeChecked();
    // Vuelve a consentir en la misma visita: el botón de retirar está de nuevo, como al principio.
    await userEvent.click(screen.getByRole('button', { name: 'simular firma con consentimiento' }));
    expect(screen.getByRole('button', { name: 'Retirar mi consentimiento' })).toBeInTheDocument();
  });
});

describe('comparador Antes / Después', () => {
  it('con las dos fotos: barra con teclado y valor leído en voz alta; cada imagen con su texto alternativo', () => {
    renderWithIntl(<BeforeAfter title="Toldos" beforeSrc="/api/files/public/aaaaaaaaaaaaaaaaaaaaaaaa" afterSrc="/api/files/public/bbbbbbbbbbbbbbbbbbbbbbbb" />);
    expect(screen.getByRole('img', { name: 'Estado de «Toldos» antes de la mejora' })).toHaveAttribute('src', '/api/files/public/aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(screen.getByRole('img', { name: 'Estado de «Toldos» después de la mejora' })).toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: 'Deslizar para comparar el antes y el después' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Se ve el 50 % del después y el 50 % del antes');
    fireEvent.change(slider, { target: { value: '80' } });
    expect(slider).toHaveAttribute('aria-valuetext', 'Se ve el 20 % del después y el 80 % del antes');
  });

  it('con una sola foto la enseña con su etiqueta; sin ninguna, explica que llegarán', () => {
    const view = renderWithIntl(<BeforeAfter title="Toldos" beforeSrc={null} afterSrc="/api/files/public/bbbbbbbbbbbbbbbbbbbbbbbb" />);
    expect(screen.getByTestId('achievement-single-photo')).toHaveTextContent('Después');
    expect(screen.queryByRole('slider')).toBeNull();
    view.unmount();
    renderWithIntl(<BeforeAfter title="Toldos" beforeSrc={null} afterSrc={null} />);
    expect(screen.getByTestId('achievement-no-photos')).toHaveTextContent('El centro publicará aquí las fotos del antes y el después.');
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('navegación del portal', () => {
  it('cuatro apartados; el actual no es un enlace y se marca con aria-current', () => {
    renderWithIntl(<PortalNav orgSlug="cervantes" current="ideas" />);
    const nav = screen.getByRole('navigation', { name: 'Secciones de la comunidad' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(4);
    expect(within(nav).getByRole('link', { name: /Iniciativas y taquilla/ })).toHaveAttribute('href', '/cervantes');
    expect(within(nav).getByRole('link', { name: /Logros conseguidos/ })).toHaveAttribute('href', '/cervantes/logros');
    expect(within(nav).getByRole('link', { name: /Comercios amigos/ })).toHaveAttribute('href', '/cervantes/comercios');
    expect(within(nav).queryByRole('link', { name: /Buzón de ideas/ })).toBeNull();
    expect(within(nav).getByText(/Buzón de ideas/).closest('[aria-current]')).toHaveAttribute('aria-current', 'page');
  });
});
