import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IdeaChat } from '@/components/account/idea-chat';
import { FaqList } from '@/components/support/faq-list';
import {
  CHAT_FAMILY_MESSAGES_MAX,
  CHAT_UNANSWERED_MAX,
  chatBlockReason,
  chatIsOpen,
  chatMessageSchema,
  cleanSupportText,
  generateTicketCode,
  isTicketCode,
  supportTicketSchema,
  targetOfTopic
} from '@/core/support/support-rules';
import type { MyProposalView } from '@/services/ideas/my-ideas-data';
import { renderWithIntl } from '../utils/render-with-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, prefetch: _prefetch, ...props }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));
const sendIdeaMessageAction = vi.fn();
vi.mock('@/app/[locale]/(account)/mi-cuenta/propuestas/actions', () => ({ sendIdeaMessageAction: (payload: unknown) => sendIdeaMessageAction(payload) }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const roles = (...list: Array<'FAMILY' | 'ORGANIZATION' | 'SYSTEM'>) => list.map((senderRole) => ({ senderRole }));

describe('reglas del soporte y del chat (QA-F06)', () => {
  it('una consulta sobre una iniciativa va al centro; pagos, cuenta, datos y sugerencias, a KORUM', () => {
    expect(targetOfTopic('INITIATIVE')).toBe('ORGANIZATION');
    for (const topic of ['PAYMENT', 'ACCOUNT', 'RECTIFICATION', 'OTHER'] as const) expect(targetOfTopic(topic)).toBe('SUPERADMIN');
  });

  it('el texto conserva los párrafos pero pierde lo invisible, los saltos de más y los espacios dobles', () => {
    expect(cleanSupportText('  Hola​   mundo \r\n\r\n\r\n\r\nAdiós  ')).toBe('Hola mundo\n\nAdiós');
    expect(cleanSupportText('a‮b')).toBe('a b');
  });

  it('la consulta valida asunto y mensaje tras limpiarlos, y no admite un tema inventado', () => {
    const valid = { orgSlug: 'cervantes', topic: 'PAYMENT', subject: ' Devolución ', message: 'No me ha llegado la devolución de mi aportación.' };
    expect(supportTicketSchema.parse(valid).subject).toBe('Devolución');
    expect(supportTicketSchema.safeParse({ ...valid, subject: 'Hola' }).success).toBe(false);
    expect(supportTicketSchema.safeParse({ ...valid, message: 'x'.repeat(2001) }).success).toBe(false);
    expect(supportTicketSchema.safeParse({ ...valid, message: `${'​'.repeat(30)}corto` }).success).toBe(false);
    expect(supportTicketSchema.safeParse({ ...valid, topic: 'HACKER' }).success).toBe(false);
  });

  it('el mensaje del chat va de 2 a 600 caracteres y la idea es un entero positivo', () => {
    expect(chatMessageSchema.safeParse({ ideaId: 3, body: 'Hola' }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ ideaId: 3, body: 'x' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ideaId: 3, body: 'x'.repeat(601) }).success).toBe(false);
    for (const ideaId of [0, -1, 1.5, '3', 2 ** 40]) expect(chatMessageSchema.safeParse({ ideaId, body: 'Hola' }).success).toBe(false);
  });

  it('el código del ticket tiene 6 caracteres sin confusiones y casi nunca se repite', () => {
    const codes = new Set(Array.from({ length: 5_000 }, () => generateTicketCode()));
    expect(codes.size).toBeGreaterThan(4_990);
    for (const code of codes) expect(isTicketCode(code)).toBe(true);
    expect(isTicketCode('TCK-0O1IL2')).toBe(false);
    expect(generateTicketCode(() => 0)).toBe('TCK-AAAAAA');
  });

  it('el chat está abierto en revisión, firmas y doble firma; rechazada o convertida es de solo lectura', () => {
    for (const phase of ['PHASE0_MOD', 'PUBLIC_VOTING', 'DOUBLE_CHECK']) expect(chatIsOpen(phase)).toBe(true);
    for (const phase of ['REJECTED', 'CONVERTED', 'OTRA']) expect(chatIsOpen(phase)).toBe(false);
  });

  it('tres mensajes de la familia sin respuesta frenan el siguiente; una respuesta del centro lo libera; el mensaje del sistema no cuenta', () => {
    expect(chatBlockReason('PUBLIC_VOTING', roles('SYSTEM'))).toBeNull();
    expect(chatBlockReason('PUBLIC_VOTING', roles('SYSTEM', 'FAMILY', 'FAMILY'))).toBeNull();
    expect(chatBlockReason('PUBLIC_VOTING', roles('SYSTEM', ...Array<'FAMILY'>(CHAT_UNANSWERED_MAX).fill('FAMILY')))).toBe('WAIT_FOR_CENTER');
    expect(chatBlockReason('PUBLIC_VOTING', roles('FAMILY', 'FAMILY', 'FAMILY', 'ORGANIZATION'))).toBeNull();
    expect(chatBlockReason('PUBLIC_VOTING', roles('FAMILY', 'FAMILY', 'FAMILY', 'ORGANIZATION', 'FAMILY', 'FAMILY', 'FAMILY'))).toBe('WAIT_FOR_CENTER');
    expect(chatBlockReason('REJECTED', roles('SYSTEM'))).toBe('CLOSED');
    const lifetime = [...Array<'FAMILY'>(CHAT_FAMILY_MESSAGES_MAX).fill('FAMILY'), 'ORGANIZATION' as const];
    expect(chatBlockReason('PUBLIC_VOTING', roles(...lifetime))).toBe('LIMIT_REACHED');
  });
});

const proposal = (overrides: Partial<MyProposalView> = {}): MyProposalView => ({
  id: 7,
  alias: '#FAM-4821',
  title: 'Toldo para el patio',
  category: 'Patios y Deporte',
  phase: 'PUBLIC_VOTING',
  organizationName: 'CEIP Cervantes',
  organizationSlug: 'cervantes',
  verifiedVotes: 12,
  needed: 30,
  percent: 40,
  quorumReached: false,
  daysRemaining: 9,
  messages: [
    { id: 1, role: 'SYSTEM', label: 'KORUM', body: 'Propuesta registrada con #FAM-4821.', createdAt: '2026-11-10T10:00:00.000Z' },
    { id: 2, role: 'ORGANIZATION', label: 'Dirección del centro', body: 'Gracias, lo vemos esta semana.', createdAt: '2026-11-11T10:00:00.000Z' },
    { id: 3, role: 'FAMILY', label: '#FAM-4821', body: 'Perfecto, gracias.', createdAt: '2026-11-11T11:00:00.000Z' }
  ],
  block: null,
  ...overrides
});

describe('tarjeta de propuesta con su chat anónimo', () => {
  it('enseña el código, el estado en texto, las firmas y los mensajes con quién los escribe; nunca un correo', () => {
    renderWithIntl(<IdeaChat proposal={proposal()} />);
    expect(screen.getByTestId('proposal-alias')).toHaveTextContent('#FAM-4821');
    expect(screen.getByText('Abierta a firmas')).toBeInTheDocument();
    expect(screen.getByText(/12 de 30 firmas verificadas/)).toBeInTheDocument();
    const log = screen.getByRole('log');
    expect(within(log).getByText(/Tú \(#FAM-4821\)/)).toBeInTheDocument();
    expect(within(log).getByText(/Dirección del centro/)).toBeInTheDocument();
    expect(within(log).getByText(/^KORUM/)).toBeInTheDocument();
    expect(screen.queryByText(/@/)).toBeNull();
    expect(screen.getByText(/no escribas tu nombre ni el de tus hijos/)).toBeInTheDocument();
  });

  it('enviar pide el mensaje de esa idea, vacía el campo, avisa y refresca la lista', async () => {
    sendIdeaMessageAction.mockResolvedValue({ status: 'SENT', messageId: 9 });
    renderWithIntl(<IdeaChat proposal={proposal()} />);
    const send = screen.getByRole('button', { name: 'Enviar mensaje' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: /^Escribir un mensaje al centro/ }), 'Muchas gracias');
    await userEvent.click(send);
    expect(sendIdeaMessageAction).toHaveBeenCalledWith({ ideaId: 7, body: 'Muchas gracias' });
    expect(await screen.findByText(/Mensaje enviado/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Escribir un mensaje al centro/ })).toHaveValue('');
    expect(refresh).toHaveBeenCalled();
  });

  it('un rechazo del servidor se explica con texto en un aviso accesible y conserva lo escrito', async () => {
    sendIdeaMessageAction.mockResolvedValue({ status: 'REJECTED', reason: 'RATE_LIMITED' });
    renderWithIntl(<IdeaChat proposal={proposal()} />);
    await userEvent.type(screen.getByRole('textbox', { name: /^Escribir un mensaje al centro/ }), 'Otro más');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Has enviado muchos mensajes seguidos');
    expect(screen.getByRole('textbox', { name: /^Escribir un mensaje al centro/ })).toHaveValue('Otro más');
  });

  it.each([
    ['CLOSED', /ya está cerrada/],
    ['WAIT_FOR_CENTER', /Cuando responda/],
    ['LIMIT_REACHED', /máximo de mensajes/]
  ] as const)('con el bloqueo %s no hay formulario y se explica por qué', (block, text) => {
    renderWithIntl(<IdeaChat proposal={proposal({ block })} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('chat-blocked')).toHaveTextContent(text);
  });

  it('en catalán y en inglés no quedan claves sin resolver', () => {
    for (const locale of ['ca', 'en'] as const) {
      const { unmount } = renderWithIntl(<IdeaChat proposal={proposal({ block: 'WAIT_FOR_CENTER' })} />, locale);
      expect(document.body.textContent).not.toMatch(/account\.proposals|errors\.|blocked\./);
      unmount();
    }
  });
});

describe('lista de preguntas frecuentes', () => {
  it('cada pregunta es un desplegable nativo; solo la primera va abierta', () => {
    renderWithIntl(
      <FaqList
        label="Preguntas frecuentes"
        items={[
          { id: 'a', question: '¿Primera?', answer: 'Sí.' },
          { id: 'b', question: '¿Segunda?', answer: 'También.' }
        ]}
      />
    );
    const items = screen.getAllByTestId('faq-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('open');
    expect(items[1]).not.toHaveAttribute('open');
    expect(screen.getByRole('group', { name: 'Preguntas frecuentes' })).toBeInTheDocument();
  });
});
