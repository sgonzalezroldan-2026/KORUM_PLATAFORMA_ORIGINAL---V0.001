'use client';

import clsx from 'clsx';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { sendIdeaMessageAction } from '@/app/[locale]/(account)/mi-cuenta/propuestas/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { CHAT_MESSAGE_MAX } from '@/core/support/support-rules';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { MyProposalView } from '@/services/ideas/my-ideas-data';

/**
 * Una propuesta de la persona con su chat anónimo con el centro (`hucha-anon-proposals-list` del prototipo). El centro solo ve el código `#FAM-XXXX`
 * y lo que se escribe aquí: el aviso recuerda no poner nombres. El estado se comunica con texto (no solo con color); la lista de mensajes es un
 * `log` (con scroll accesible si es larga) que se anuncia al llegar uno nuevo; tras enviar, el foco se queda en el campo o, si ya no caben más
 * mensajes, pasa al aviso de espera.
 */

const REASON_KEY: Record<string, string> = {
  INVALID_INPUT: 'errors.invalid',
  RATE_LIMITED: 'errors.rateLimited',
  NOT_FOUND: 'errors.failed',
  ACCOUNT_NOT_ALLOWED: 'errors.failed',
  CLOSED: 'blocked.CLOSED',
  WAIT_FOR_CENTER: 'blocked.WAIT_FOR_CENTER',
  LIMIT_REACHED: 'blocked.LIMIT_REACHED'
};

export function IdeaChat({ proposal }: { proposal: MyProposalView }) {
  const t = useTranslations('account.proposals');
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const ids = { field: useId(), hint: useId(), title: useId() };
  const field = useRef<HTMLTextAreaElement>(null);
  const blockedNotice = useRef<HTMLParagraphElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const justSent = useRef(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  const blocked = proposal.block !== null;

  // Una conversación larga se abre por el final: lo último que se dijo es lo que la familia necesita ver.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [proposal.messages.length]);

  // Si el mensaje que acaba de enviar es el último que cabe, el formulario desaparece: el foco pasa al aviso y no se pierde (WCAG 2.4.3).
  useEffect(() => {
    if (blocked && justSent.current) {
      justSent.current = false;
      blockedNotice.current?.focus();
    }
  }, [blocked]);

  function send(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSent(false);
    startTransition(async () => {
      try {
        const result = await sendIdeaMessageAction({ ideaId: proposal.id, body });
        if (result.status === 'SENT') {
          setBody('');
          setSent(true);
          justSent.current = true;
          router.refresh();
        } else if (result.status === 'LOGIN_REQUIRED') setError('errors.login');
        else setError(REASON_KEY[result.reason] ?? 'errors.failed');
      } catch {
        setError('errors.failed');
      }
      // El formulario sigue en pantalla: el foco vuelve al campo (o al aviso del error) y no se pierde.
      field.current?.focus();
    });
  }

  return (
    <article aria-labelledby={ids.title} className="flex flex-col gap-3 rounded-2xl border-2 border-sky-200 bg-sky-50/60 p-4" data-testid="my-proposal">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={ids.title} className="min-w-0 wrap-break-word font-corp text-lg font-extrabold text-varsity-navy">
          <span data-testid="proposal-alias">{proposal.alias}</span>
          <span className="font-semibold text-ink-soft">{` · ${proposal.title}`}</span>
        </h3>
        <span className="rounded-full border-2 border-sky-300 bg-white px-3 py-1 text-sm font-bold text-sky-950">{t(`phases.${proposal.phase}`)}</span>
      </header>
      <p className="wrap-break-word text-sm text-ink-soft">
        {t('summary', { entity: proposal.organizationName, category: proposal.category, votes: proposal.verifiedVotes, needed: proposal.needed })}
        {proposal.phase === 'PUBLIC_VOTING' ? ` ${t('daysLeft', { count: proposal.daysRemaining })}` : ''}
      </p>

      {/* Zona con scroll (conversación larga): enfocable con teclado, como exige WCAG 2.1.1. */}
      <div ref={logRef} role="log" tabIndex={0} aria-labelledby={ids.title} aria-relevant="additions" className="max-h-96 overflow-y-auto rounded-xl border border-sky-100 bg-white p-3" data-testid="chat-log">
        <ol className="flex flex-col gap-2">
          {proposal.messages.map((message) => (
            <li key={message.id} className={clsx('flex max-w-[92%] flex-col gap-0.5 rounded-xl border px-3 py-2', message.role === 'FAMILY' ? 'self-end border-varsity-navy/30 bg-varsity-ivory' : 'self-start border-stone-200 bg-stone-50')}>
              <span className="text-xs font-extrabold text-varsity-navy">
                {message.role === 'FAMILY' ? t('fromYou', { alias: message.label }) : message.role === 'SYSTEM' ? t('fromKorum') : message.label}
                <span className="font-semibold text-ink-soft">{` · ${format.dateTime(new Date(message.createdAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' })}`}</span>
              </span>
              <span className="whitespace-pre-line wrap-break-word">{message.body}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="text-sm text-ink-soft">{t('refreshHint')}</p>

      {blocked ? (
        <p ref={blockedNotice} tabIndex={-1} role="status" className="rounded-xl border-2 border-stone-300 bg-white p-3 font-semibold text-ink-soft" data-testid="chat-blocked">
          {t(`blocked.${proposal.block}`)}
        </p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-2" aria-busy={pending}>
          <label htmlFor={ids.field} className="font-bold text-varsity-navy">
            {t('writeLabel')}
            <span className="sr-only">{` ${proposal.alias}`}</span>
          </label>
          <textarea
            id={ids.field}
            ref={field}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              // El aviso de «enviado» era del mensaje anterior: al empezar otro, se quita.
              if (sent) setSent(false);
            }}
            maxLength={CHAT_MESSAGE_MAX}
            rows={3}
            aria-describedby={ids.hint}
            className="min-h-24 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 font-semibold"
          />
          <p id={ids.hint} className="text-sm text-ink-soft">
            {t('privacyHint', { max: CHAT_MESSAGE_MAX })}
          </p>
          {error ? (
            <FormAlert>
              {t(error)}
              {error === 'errors.login' ? (
                <>
                  {' '}
                  <Link href={`/login?next=${encodeURIComponent(localizedPath(locale, '/mi-cuenta/propuestas'))}`} prefetch={false} className="underline">
                    {t('loginLink')}
                  </Link>
                </>
              ) : null}
            </FormAlert>
          ) : null}
          {sent ? <FormAlert tone="success">{t('sent')}</FormAlert> : null}
          <button type="submit" disabled={pending || body.trim().length === 0} className="tactile-btn min-h-11 self-start">
            {pending ? t('sending') : t('send')}
          </button>
        </form>
      )}
    </article>
  );
}
