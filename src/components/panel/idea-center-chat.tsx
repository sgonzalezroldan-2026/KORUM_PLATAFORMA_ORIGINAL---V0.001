'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { replyIdeaAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { CHAT_MESSAGE_MAX } from '@/core/support/support-rules';
import type { ModerationIdeaView } from '@/services/panel/approvals-data';

/**
 * Chat anónimo con quien propuso la idea, lado de la entidad (heredado del Sprint 3.9). La familia solo es su código `#FAM-XXXX`; la entidad
 * firma con su cargo. Al responder, la familia recibe un aviso por email **sin el texto** y lo lee en *Mi cuenta*. Rechazada o convertida, la
 * conversación solo se lee.
 */
export function IdeaCenterChat({ orgSlug, idea, canWrite }: { orgSlug: string; idea: ModerationIdeaView; canWrite: boolean }) {
  const t = useTranslations('panel.approvals.chat');
  const tErrors = useTranslations('panel.approvals.errors');
  const format = useFormatter();
  const router = useRouter();
  const ids = { title: useId(), field: useId(), hint: useId() };
  const logRef = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [idea.messages.length]);

  function send(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSent(false);
    startTransition(async () => {
      try {
        const result = await replyIdeaAction(orgSlug, {
          ideaId: idea.id,
          body
        });
        if (result.status === 'OK') {
          setBody('');
          setSent(true);
          router.refresh();
        } else setError(tErrors(result.reason));
      } catch {
        setError(tErrors('failed'));
      }
      field.current?.focus();
    });
  }

  return (
    <section aria-labelledby={ids.title} className="flex flex-col gap-2 rounded-xl border border-sky-200 bg-sky-50/60 p-3">
      <h4 id={ids.title} className="text-sm font-extrabold uppercase text-sky-950">
        {`💬 ${t('title', { alias: idea.alias })}`}
      </h4>
      {idea.messages.length === 0 ? (
        <p className="text-sm text-ink-soft">{t('empty')}</p>
      ) : (
        <div
          ref={logRef}
          role="log"
          tabIndex={0}
          aria-labelledby={ids.title}
          className="max-h-72 overflow-y-auto rounded-lg border border-sky-100 bg-white p-2"
          data-testid="center-chat-log"
        >
          <ol className="flex flex-col gap-2">
            {idea.messages.map((message) => (
              <li
                key={message.id}
                className={clsx(
                  'flex max-w-[92%] flex-col gap-0.5 rounded-lg border px-3 py-2 text-sm',
                  message.role === 'ORGANIZATION' ? 'self-end border-varsity-navy/30 bg-varsity-ivory' : 'self-start border-stone-200 bg-stone-50'
                )}
              >
                <span className="text-xs font-extrabold text-varsity-navy">
                  {message.role === 'SYSTEM' ? t('fromKorum') : message.label}
                  <span className="font-semibold text-ink-soft">{` · ${format.dateTime(new Date(message.createdAt), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' })}`}</span>
                </span>
                <span className="whitespace-pre-line break-words">{message.body}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {idea.chatOpen && !canWrite ? (
        <p className="text-sm text-ink-soft">{t('readOnly')}</p>
      ) : idea.chatOpen ? (
        <form onSubmit={send} className="flex flex-col gap-2" aria-busy={pending}>
          <label htmlFor={ids.field} className="text-sm font-bold text-varsity-navy">
            {t('label', { alias: idea.alias })}
          </label>
          <textarea
            id={ids.field}
            ref={field}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={CHAT_MESSAGE_MAX}
            rows={2}
            required
            aria-describedby={ids.hint}
            className="w-full rounded-lg border-2 border-varsity-navy bg-white p-2 text-base"
          />
          <p id={ids.hint} className="text-sm text-ink-soft">
            {t('hint')}
          </p>
          <button
            type="submit"
            disabled={pending || body.trim().length < 2}
            className="min-h-11 self-start rounded-lg bg-varsity-navy px-4 font-bold text-varsity-ivory disabled:opacity-60"
          >
            {pending ? t('sending') : t('send')}
          </button>
          {sent ? <FormAlert tone="success">{t('sent')}</FormAlert> : null}
          {error ? <FormAlert>{error}</FormAlert> : null}
        </form>
      ) : (
        <p className="text-sm text-ink-soft">{t('closed')}</p>
      )}
    </section>
  );
}
