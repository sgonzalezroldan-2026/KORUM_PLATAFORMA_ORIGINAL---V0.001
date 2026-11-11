'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { answerTicketAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/soporte/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { REPLY_MAX, REPLY_MIN } from '@/core/support/support-inbox-rules';
import { cleanSupportText } from '@/core/support/support-rules';
import type { InboxTicket } from '@/repositories/support-inbox.repository';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Una consulta de una familia al centro (Sprint 4.4c). Se ve el código, el tema, la fecha y el texto, **nunca quién escribe**: el centro contesta desde
 * la plataforma y la familia lo ve en *Mi cuenta* (y recibe un aviso sin el texto). La respuesta es una por consulta; después solo se cambia el estado,
 * que no retrocede. El éxito se anuncia en el aviso de la página (la tarjeta cambia de lista al resolverse y se vuelve a montar); los errores van junto al
 * formulario y se anuncian aunque se repitan.
 */
export function SupportTicketCard({ orgSlug, ticket, canAct }: { orgSlug: string; ticket: InboxTicket; canAct: boolean }) {
  const t = useTranslations('panel.support');
  const format = useFormatter();
  const router = useRouter();
  const notify = useApprovalsNotice();
  const ids = { reply: useId(), help: useId(), resolve: useId(), fieldError: useId(), title: useId(), confirm: useId() };
  const replyField = useRef<HTMLTextAreaElement>(null);
  const [reply, setReply] = useState('');
  const [resolveToo, setResolveToo] = useState(false);
  /** Un texto demasiado corto se avisa junto al campo y el foco va al campo; lo que responde el servidor, en el aviso del formulario (que recibe el foco). */
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** «Resolver sin responder» no se deshace (la familia no recibe respuesta ni aviso y la consulta no se reabre): pide confirmación en línea, con el foco en ella. */
  const [confirmingResolve, setConfirmingResolve] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [error, setErrorText] = useState<{ text: string; at: number } | null>(null);
  const setError = (text: string | null) => setErrorText(text === null ? null : { text, at: Date.now() });
  useEffect(() => {
    if (confirmingResolve) confirmRef.current?.focus();
  }, [confirmingResolve]);
  const open = ticket.status !== 'RESOLVED';
  const hasReply = ticket.replyMessage !== null;

  async function send(payload: { reply?: string; status?: 'IN_PROGRESS' | 'RESOLVED' }, success: string | ((notified: boolean) => string)) {
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const result = await answerTicketAction(orgSlug, { ticketCode: ticket.ticketCode, ...payload });
      if (result.status === 'OK') {
        notify(typeof success === 'string' ? success : success(result.notified === true));
        setConfirmingResolve(false);
        setReply('');
        setResolveToo(false);
        router.refresh();
      } else setError(t(`errors.${result.reason}`));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  function submitReply(event: React.FormEvent) {
    event.preventDefault();
    if (cleanSupportText(reply).length < REPLY_MIN) {
      setError(null);
      setFieldError(t('errors.REPLY_TOO_SHORT', { min: REPLY_MIN }));
      replyField.current?.focus();
      return;
    }
    void send({ reply, ...(resolveToo ? { status: 'RESOLVED' as const } : {}) }, (notified) => t(resolveToo ? 'sentAndResolved' : notified ? 'sent' : 'sentNoNotice', { code: ticket.ticketCode }));
  }

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Madrid' });

  return (
    <li aria-labelledby={ids.title} className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-navy/20 bg-white p-4" data-testid="support-ticket" data-ticket-code={ticket.ticketCode} data-status={ticket.status}>
      <p className="flex flex-wrap items-center justify-between gap-2 font-extrabold text-varsity-navy">
        <span id={ids.title} className="min-w-0 wrap-break-word">{`${ticket.ticketCode} · ${ticket.subject}`}</span>
        <span className={clsx('rounded-full border-2 px-3 py-0.5 text-sm font-bold', open ? 'border-amber-500 bg-amber-50 text-amber-950' : 'border-stone-300 text-ink-soft')}>{t(`status.${ticket.status}`)}</span>
      </p>
      <p className="text-sm text-ink-soft">{t('line', { topic: t(`topics.${ticket.topic}`), date: date(ticket.createdAt) })}</p>
      <p className="whitespace-pre-line wrap-break-word rounded-xl border border-stone-200 bg-stone-50 p-3" data-testid="support-ticket-message">
        {ticket.message === '' ? t('purged') : ticket.message}
      </p>
      {hasReply ? (
        <p className="whitespace-pre-line wrap-break-word rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-950" data-testid="support-ticket-reply">
          <span className="font-extrabold">{`${t('yourReply', { date: ticket.repliedAt ? date(ticket.repliedAt) : '' })} `}</span>
          {ticket.replyMessage}
        </p>
      ) : null}

      {canAct && open && ticket.message !== '' ? (
        <div className="flex flex-col gap-3 border-t border-stone-200 pt-3">
          {!hasReply ? (
            <form noValidate onSubmit={submitReply} className="flex flex-col gap-2">
              <label htmlFor={ids.reply} className="font-bold text-varsity-navy">
                {t('replyLabel')}
              </label>
              <textarea
                id={ids.reply}
                ref={replyField}
                value={reply}
                onChange={(event) => {
                  setReply(event.target.value);
                  setFieldError(null);
                }}
                maxLength={REPLY_MAX}
                rows={4}
                aria-describedby={fieldError ? `${ids.help} ${ids.fieldError}` : ids.help}
                aria-invalid={fieldError ? true : undefined}
                className="min-h-28 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 text-base aria-invalid:border-red-700"
              />
              <p id={ids.help} className="text-sm text-ink-soft">
                {t('replyHelp', { min: REPLY_MIN, max: REPLY_MAX })}
              </p>
              {fieldError ? (
                <p id={ids.fieldError} role="alert" className="text-sm font-semibold text-red-800">
                  {fieldError}
                </p>
              ) : null}
              <label htmlFor={ids.resolve} className="flex min-h-11 items-center gap-3 font-semibold text-varsity-navy">
                <input id={ids.resolve} type="checkbox" checked={resolveToo} onChange={(event) => setResolveToo(event.target.checked)} className="size-5" />
                {t('alsoResolve')}
              </label>
              {error ? <FormAlert key={error.at}>{error.text}</FormAlert> : null}
              <button type="submit" disabled={busy} aria-busy={busy} className="tactile-btn self-start disabled:opacity-60">
                {busy ? t('sending') : t('send')}
              </button>
            </form>
          ) : error ? (
            <FormAlert key={error.at}>{error.text}</FormAlert>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {ticket.status === 'OPEN' && !hasReply ? (
              <button type="button" disabled={busy} aria-describedby={ids.title} onClick={() => void send({ status: 'IN_PROGRESS' }, t('markedInProgress', { code: ticket.ticketCode }))} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60">
                {t('markInProgress')}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              aria-describedby={ids.title}
              onClick={() => (hasReply ? void send({ status: 'RESOLVED' }, t('markedResolved', { code: ticket.ticketCode })) : setConfirmingResolve(true))}
              className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60"
            >
              {t(hasReply ? 'markResolved' : 'markResolvedNoReply')}
            </button>
          </div>
          {confirmingResolve ? (
            <div ref={confirmRef} tabIndex={-1} role="group" aria-labelledby={ids.confirm} className="flex flex-col gap-3 rounded-xl border-2 border-amber-500 bg-amber-50 p-3" data-testid="support-resolve-confirm">
              <p id={ids.confirm} className="font-semibold text-amber-950">
                {t(reply.trim() === '' ? 'confirmResolve.text' : 'confirmResolve.textWithDraft')}
              </p>
              <div className="flex flex-wrap gap-3">
                <button type="button" disabled={busy} onClick={() => void send({ status: 'RESOLVED' }, t('markedResolved', { code: ticket.ticketCode }))} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy bg-varsity-navy px-4 font-bold text-varsity-ivory disabled:opacity-60">
                  {t('confirmResolve.yes')}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmingResolve(false)} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60">
                  {t('confirmResolve.no')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
