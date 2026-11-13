'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, useTransition } from 'react';
import {
  answerPlatformTicketAction,
  closeRectificationAction,
  rectifyNameAction,
  type PlatformTicketResult,
  type RectificationActionResult,
  type RectifyNameActionResult
} from '@/app/[locale]/(superadmin)/admin/soporte/actions';
import { REPLY_MAX, REPLY_MIN } from '@/core/support/support-inbox-rules';
import { useToast } from '@/components/ui/toast-provider';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { ConsoleTicket } from '@/services/admin/console-support.service';
import { FIELD, OUTLINE, PRIMARY } from './entity-action';
import { focusLater } from './rules-action';

const STATUS_STYLE = { OPEN: 'bg-amber-100 text-amber-950', IN_PROGRESS: 'bg-sky-100 text-sky-950', RESOLVED: 'bg-emerald-100 text-emerald-950' } as const;

/**
 * Una consulta dirigida a KORUM (prototipo `sa-tickets-list`): quién la escribe (y su email, que solo ve KORUM), el tema, el texto y, si aún no está resuelta, el formulario
 * para contestar (**una sola respuesta por consulta**) y cambiar el estado, que solo avanza. Cerrarla sin responder, o con la respuesta, pide confirmar: ya no se puede contestar.
 * Las que escribe una entidad desde su panel llevan una marca de prioridad. Si pide corregir datos personales, aparece su solicitud RGPD con el plazo de un mes: se puede corregir
 * el nombre de la cuenta desde aquí y cerrar la solicitud una vez hecho el cambio.
 */
export function SupportTicketCard({ ticket }: { ticket: ConsoleTicket }) {
  const t = useTranslations('admin.support');
  const format = useFormatter();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<'' | 'IN_PROGRESS' | 'RESOLVED'>('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<PlatformTicketResult | null>(null);
  const [failed, setFailed] = useState(false);
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });
  const hasReply = ticket.replyMessage !== null;
  const replyWrong = result?.status === 'ERROR' && result.reason === 'INVALID_INPUT';
  const statusChoices = (['IN_PROGRESS', 'RESOLVED'] as const).filter((choice) => choice !== ticket.status);
  const writing = reply.trim().length > 0;

  const send = () => {
    setConfirming(false);
    startTransition(async () => {
      setFailed(false);
      setResult(null);
      try {
        const outcome = await answerPlatformTicketAction({ ticketCode: ticket.ticketCode, ...(writing ? { reply } : {}), ...(status ? { status } : {}) });
        setResult(outcome);
        if (outcome.status === 'OK') {
          // Si se contestó pero no hubo aviso por email (la persona ya no tiene cuenta o su dirección se borró), se dice: la respuesta queda guardada y no hay segunda.
          toast({ tone: 'success', title: t(writing && !outcome.notified ? 'doneNotNotified' : outcome.notified ? 'doneNotified' : 'done', { code: ticket.ticketCode }) });
          setReply('');
          setStatus('');
          router.refresh();
          // Si sigue esperando (contestada, no cerrada) el foco va a su propio título, que tras recargar cambia de sitio en la lista: así quien responde no pierde su lugar.
          // Si se cerró, ya no está entre las que esperan y el foco va al titular de esa lista.
          focusLater(outcome.resolved ? 'waiting-title' : `ticket-title-${ticket.ticketCode}`);
        } else {
          focusLater(outcome.reason === 'INVALID_INPUT' ? `${id}-reply` : `${id}-submit`);
        }
      } catch {
        setFailed(true);
        focusLater(`${id}-submit`);
      }
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // Cerrar la consulta es definitivo: ya no se puede contestar. Se confirma, diciendo si va con respuesta o sin ella.
    if (status === 'RESOLVED') {
      setConfirming(true);
      requestAnimationFrame(() => confirmTitle.current?.focus());
      return;
    }
    send();
  };

  return (
    <li className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4" data-ticket={ticket.ticketCode} data-priority={ticket.fromOrganization ? 'true' : 'false'} data-testid="support-ticket">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded border border-patio-rule-strong bg-patio-soft px-2 py-0.5 font-mono font-bold">{ticket.ticketCode}</span>
        <span className={`rounded-full px-2 py-0.5 font-extrabold ${STATUS_STYLE[ticket.status]}`}>{t(`status.${ticket.status}`)}</span>
        {ticket.fromOrganization ? (
          <span className="rounded-full bg-varsity-navy px-2 py-0.5 font-extrabold text-white" data-testid="ticket-priority">
            {t('priority')}
          </span>
        ) : null}
        <span className="text-ink-soft">{t(`topic.${ticket.topic}` as 'topic.OTHER')}</span>
      </div>
      <h3 id={`ticket-title-${ticket.ticketCode}`} tabIndex={-1} className="font-corp wrap-break-word text-lg font-extrabold text-varsity-navy">
        {ticket.subject}
      </h3>
      <p className="wrap-break-word text-sm text-ink-soft">
        {t('from', { origin: ticket.origin, date: date(ticket.createdAt) })}
        {ticket.senderEmail ? <span className="[overflow-wrap:anywhere]">{` · ${t('sender', { email: ticket.senderEmail })}`}</span> : null}
      </p>
      {ticket.orgSlug ? (
        <Link
          href={`/panel/${ticket.orgSlug}`}
          className="inline-flex min-h-11 w-fit items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy hover:bg-varsity-navy/5"
          data-testid="ticket-open-panel"
        >
          {t('openPanel')}
        </Link>
      ) : null}
      <p className="whitespace-pre-wrap wrap-break-word" data-testid="ticket-message">
        {ticket.message === '' ? t('purged') : ticket.message}
      </p>

      {hasReply ? (
        <blockquote className="rounded-xl border-s-4 border-emerald-600 bg-emerald-50 p-3 text-emerald-950">
          <p className="text-sm font-bold">{t('replied', { date: ticket.repliedAt ? date(ticket.repliedAt) : '' })}</p>
          <p className="whitespace-pre-wrap wrap-break-word">{ticket.replyMessage}</p>
        </blockquote>
      ) : null}

      {ticket.rectification ? <RectificationBlock ticket={ticket} /> : null}

      {ticket.status !== 'RESOLVED' && ticket.message !== '' ? (
        <form onSubmit={submit} className="flex flex-col gap-3 border-t border-patio-rule pt-3">
          {hasReply ? (
            <p className="text-sm text-ink-soft">{t('alreadyReplied')}</p>
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-reply`} className="text-sm font-semibold text-ink-soft">
                {t('replyLabel')}
              </label>
              <textarea
                id={`${id}-reply`}
                value={reply}
                rows={4}
                maxLength={REPLY_MAX}
                disabled={confirming}
                onChange={(event) => setReply(event.target.value)}
                aria-invalid={replyWrong}
                aria-describedby={replyWrong ? `${id}-reply-error ${id}-reply-hint` : `${id}-reply-hint`}
                className="w-full rounded-lg border-2 border-varsity-navy/30 bg-white p-3 text-base"
                data-testid="ticket-reply"
              />
              <p id={`${id}-reply-hint`} className="text-sm text-ink-soft">
                {t('replyHint', { min: REPLY_MIN, max: REPLY_MAX })}
              </p>
              {!ticket.canNotify ? <p className="text-sm font-semibold text-amber-950">{t('noContact')}</p> : null}
              {replyWrong ? (
                <p id={`${id}-reply-error`} role="alert" className="text-sm font-semibold text-red-900">
                  {t('outcome.INVALID_INPUT', { min: REPLY_MIN, max: REPLY_MAX })}
                </p>
              ) : null}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-status`} className="text-sm font-semibold text-ink-soft">
                {t('statusLabel')}
              </label>
              <select
                id={`${id}-status`}
                value={status}
                disabled={confirming}
                onChange={(event) => setStatus(event.target.value === 'IN_PROGRESS' ? 'IN_PROGRESS' : event.target.value === 'RESOLVED' ? 'RESOLVED' : '')}
                aria-describedby={`${id}-status-hint`}
                className={`${FIELD} sm:w-64`}
                data-testid="ticket-status"
              >
                <option value="">{hasReply ? t('statusKeep') : t('statusAuto')}</option>
                {statusChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {t(`statusTo.${choice}`)}
                  </option>
                ))}
              </select>
            </div>
            <button id={`${id}-submit`} type="submit" disabled={pending || confirming || (!writing && !status)} aria-describedby={`${id}-status-hint`} className={PRIMARY} data-testid="ticket-submit">
              {pending ? t('saving') : hasReply ? t('changeStatus') : t('send')}
            </button>
          </div>
          <p id={`${id}-status-hint`} className="text-sm text-ink-soft">
            {t('statusResolvedHint')}
          </p>
          {confirming ? (
            <div
              role="group"
              aria-label={t('resolveConfirmTitle')}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setConfirming(false);
                  focusLater(`${id}-submit`);
                }
              }}
              className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3"
              data-testid="ticket-resolve-confirm"
            >
              <p ref={confirmTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
                {t('resolveConfirmTitle')}
              </p>
              <p>{t(writing ? 'resolveConfirmWithReply' : hasReply ? 'resolveConfirmAlreadyReplied' : 'resolveConfirmNoReply')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={PRIMARY} onClick={send} data-testid="ticket-resolve-yes">
                  {t('resolveConfirmYes')}
                </button>
                <button
                  type="button"
                  className={OUTLINE}
                  onClick={() => {
                    setConfirming(false);
                    focusLater(`${id}-submit`);
                  }}
                >
                  {t('resolveConfirmBack')}
                </button>
              </div>
            </div>
          ) : null}
          {failed ? (
            <p role="alert" className="text-sm font-semibold text-red-900">
              {t('outcome.FAILED')}
            </p>
          ) : null}
          {result?.status === 'ERROR' && !replyWrong ? (
            <p role="alert" className="text-sm font-semibold text-red-900">
              {t(`outcome.${result.reason}`)}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

/**
 * La solicitud de rectificación de datos (RGPD art. 16) que abrió la consulta: plazo de un mes, corrección del **nombre** de la cuenta desde aquí y cierre una vez hecho el cambio,
 * comprobando la identidad. El cambio de email no se ofrece (hay que comprobar que la persona controla el nuevo): se hace por el canal de privacidad.
 */
function RectificationBlock({ ticket }: { ticket: ConsoleTicket }) {
  const t = useTranslations('admin.support.rectification');
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState('');
  const [name, setName] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [result, setResult] = useState<RectificationActionResult | RectifyNameActionResult | { status: 'FAILED' } | null>(null);
  const rejectTitle = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const request = ticket.rectification!;
  const open = request.status === 'RECEIVED' || request.status === 'IN_PROGRESS';

  const close = (outcome: 'COMPLETED' | 'REJECTED') => {
    setRejecting(false);
    startTransition(async () => {
      setResult(null);
      try {
        const response = await closeRectificationAction({ ticketCode: ticket.ticketCode, outcome, ...(notes.trim() ? { notes } : {}) });
        setResult(response);
        if (response.status === 'CLOSED') {
          toast({ tone: 'success', title: t('closed') });
          router.refresh();
          focusLater('waiting-title');
        } else focusLater(`${id}-done`);
      } catch {
        setResult({ status: 'FAILED' });
        focusLater(`${id}-done`);
      }
    });
  };

  const rename = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      setResult(null);
      try {
        const response = await rectifyNameAction({ ticketCode: ticket.ticketCode, name });
        setResult(response);
        if (response.status === 'DONE') {
          toast({ tone: 'success', title: t('nameDone') });
          setName('');
        }
        focusLater(`${id}-name`);
      } catch {
        setResult({ status: 'FAILED' });
        focusLater(`${id}-name`);
      }
    });
  };

  const failure = result && result.status !== 'CLOSED' && result.status !== 'DONE' ? result : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border-2 border-sky-700 bg-sky-50 p-3 text-sky-950" data-testid="rectification">
      <p className="font-bold">
        <span aria-hidden="true">{'🔒 '}</span>
        {t('title')}
      </p>
      <p className="text-sm">{open ? t(request.overdue ? 'overdue' : 'open', { date: format.dateTime(new Date(request.dueAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) }) : t('done', { status: t(`status.${request.status}` as 'status.COMPLETED') })}</p>
      {open ? (
        <>
          <p className="text-sm">{t('how')}</p>
          <form onSubmit={rename} className="flex flex-col gap-1">
            {ticket.accountName ? <p className="text-sm">{t('nameCurrent', { name: ticket.accountName })}</p> : null}
            <label htmlFor={`${id}-name`} className="text-sm font-semibold">
              {t('nameLabel')}
            </label>
            <div className="flex flex-wrap gap-2">
              <input id={`${id}-name`} type="text" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className={`${FIELD} sm:w-80`} autoComplete="off" data-testid="rectification-name" />
              <button type="submit" disabled={pending || name.trim().length < 2} className={OUTLINE} data-testid="rectification-rename">
                {t('nameButton')}
              </button>
            </div>
            <p className="text-sm">{t('nameHint')}</p>
          </form>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-notes`} className="text-sm font-semibold">
              {t('notes')}
            </label>
            <input id={`${id}-notes`} type="text" value={notes} maxLength={600} onChange={(event) => setNotes(event.target.value)} className={FIELD} autoComplete="off" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button id={`${id}-done`} type="button" disabled={pending || rejecting} className={PRIMARY} onClick={() => close('COMPLETED')} data-testid="rectification-done">
              {t('markDone')}
            </button>
            <button
              type="button"
              disabled={pending || rejecting}
              className={OUTLINE}
              onClick={() => {
                setRejecting(true);
                requestAnimationFrame(() => rejectTitle.current?.focus());
              }}
              data-testid="rectification-reject"
            >
              {t('markRejected')}
            </button>
          </div>
          {rejecting ? (
            <div
              role="group"
              aria-label={t('rejectTitle')}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setRejecting(false);
                  focusLater(`${id}-done`);
                }
              }}
              className="flex flex-col gap-2 rounded-xl border-2 border-sky-900 bg-white p-3 text-ink"
              data-testid="rectification-reject-confirm"
            >
              <p ref={rejectTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
                {t('rejectTitle')}
              </p>
              <p>{t('rejectText')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={PRIMARY} onClick={() => close('REJECTED')} data-testid="rectification-reject-yes">
                  {t('rejectYes')}
                </button>
                <button
                  type="button"
                  className={OUTLINE}
                  onClick={() => {
                    setRejecting(false);
                    focusLater(`${id}-done`);
                  }}
                >
                  {t('rejectBack')}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm font-semibold text-red-900">
          {t(`error.${failure.status}` as 'error.FAILED')}
          {failure.status === 'REAUTH_REQUIRED' ? (
            <>
              {' '}
              <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin/soporte') } }} className="inline-flex min-h-11 items-center underline">
                {t('reauthLink')}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
