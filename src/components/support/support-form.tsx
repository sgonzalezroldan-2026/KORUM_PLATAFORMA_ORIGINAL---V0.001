'use client';

import clsx from 'clsx';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { submitSupportTicketAction } from '@/app/[locale]/(public)/[orgSlug]/ayuda/actions';
import { useReauth } from '@/components/account/use-reauth';
import { FormAlert } from '@/components/auth/auth-ui';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { cleanSupportText, SUPPORT_MESSAGE_MAX, SUPPORT_MESSAGE_MIN, SUPPORT_SUBJECT_MAX, SUPPORT_SUBJECT_MIN, SUPPORT_TOPICS, targetOfTopic, type SupportTopicValue } from '@/core/support/support-rules';
import { Link } from '@/i18n/navigation';
import { authClient } from '@/lib/auth/auth-client';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { Locale } from '@/i18n/routing';

/**
 * Formulario de soporte (`help-routing-select` del prototipo). Escribir exige una sesión con el email verificado: así la consulta es de quien la
 * envía, tiene su código y se ve en *Mi cuenta*. La página del portal se genera una vez y se comparte, por lo que la sesión se consulta en el
 * navegador. «Corregir mis datos» pide antes confirmar la identidad (código por email) y abre la solicitud RGPD de rectificación. Los errores de
 * texto se detectan también aquí (con los mismos mínimos que el servidor), se asocian a su campo y mueven el foco al primero que falla.
 */

const fieldClass = (invalid: boolean) => clsx('min-h-11 w-full rounded-xl border-2 bg-white px-3 py-2 font-semibold', invalid ? 'border-red-700' : 'border-patio-rule-strong');

type Sent = { ticketCode: string; rectification: boolean };

export function SupportForm({ orgSlug, loginHref }: { orgSlug: string; loginHref: string }) {
  const t = useTranslations('portal.help.support');
  const locale = useLocale() as Locale;
  const { data, isPending: loadingSession } = authClient.useSession();
  const email = data?.user.email ?? '';
  const reauth = useReauth(email);
  const ids = { topic: useId(), subject: useId(), message: useId(), hint: useId(), counter: useId(), limits: useId(), routing: useId(), error: useId() };
  const [topic, setTopic] = useState<SupportTopicValue>('INITIATIVE');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [pending, startTransition] = useTransition();
  const sentHeading = useRef<HTMLHeadingElement>(null);
  const subjectField = useRef<HTMLInputElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);

  // Al enviarse, el formulario se sustituye por la confirmación: el foco va a su título y no se pierde al principio del documento.
  useEffect(() => {
    if (sent) sentHeading.current?.focus();
  }, [sent]);

  /** Mismos mínimos que el servidor: el aviso sale al momento, junto al campo, y el foco va al primero que falla. */
  function invalidField(): 'subject' | 'message' | null {
    if (cleanSupportText(subject).length < SUPPORT_SUBJECT_MIN) return 'subject';
    if (cleanSupportText(message).length < SUPPORT_MESSAGE_MIN) return 'message';
    return null;
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await submitSupportTicketAction({ orgSlug, topic, subject, message, locale });
        if (result.status === 'SENT') {
          setSent({ ticketCode: result.ticketCode, rectification: result.rectification });
          setSubject('');
          setMessage('');
        } else if (result.status === 'LOGIN_REQUIRED') setError('errors.login');
        else if (result.reason === 'REAUTH_REQUIRED') reauth.request('email', submit);
        else if (result.reason === 'INVALID_INPUT') setError('errors.invalid');
        else if (result.reason === 'RATE_LIMITED') setError('errors.rateLimited');
        else if (result.reason === 'ACCOUNT_NOT_ALLOWED') setError('errors.account');
        else setError('errors.failed');
      } catch {
        setError('errors.failed');
      }
    });
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const invalid = invalidField();
    if (invalid) {
      setError('errors.invalid');
      (invalid === 'subject' ? subjectField : messageField).current?.focus();
      return;
    }
    if (topic === 'RECTIFICATION') void reauth.ensureFresh(submit);
    else submit();
  }

  if (loadingSession) {
    return (
      <LoadingRegion>
        <Skeleton className="h-40 w-full rounded-2xl" />
      </LoadingRegion>
    );
  }

  if (!data?.session) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-varsity-ivory p-4" data-testid="support-login">
        <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('loginTitle')}</h3>
        <p className="text-ink-soft">{t('loginText')}</p>
        <Link href={loginHref} prefetch={false} className="tactile-btn self-start">
          {t('loginAction')}
        </Link>
      </div>
    );
  }

  if (sent) {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-4" data-testid="support-sent">
        <h3 ref={sentHeading} tabIndex={-1} className="font-corp text-lg font-extrabold text-emerald-950">
          {t('sentTitle')}
        </h3>
        <p className="text-emerald-950">{t('sentText', { code: sent.ticketCode })}</p>
        {sent.rectification ? <p className="text-emerald-950">{t('sentRectification')}</p> : null}
        <div className="flex flex-wrap gap-2">
          <a href={localizedPath(locale, '/mi-cuenta#support')} className="tactile-btn">
            {t('sentAction')}
          </a>
          <button type="button" onClick={() => setSent(null)} className="min-h-11 rounded-xl border-2 border-varsity-navy px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/10">
            {t('another')}
          </button>
        </div>
      </div>
    );
  }

  const invalid = error === 'errors.invalid';
  const topicDescription = [ids.routing, topic === 'RECTIFICATION' ? ids.hint : null].filter(Boolean).join(' ');

  // El diálogo de confirmación lleva sus propios formularios: va **fuera** de este (un `<form>` dentro de otro rompe la hidratación).
  return (
    <>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-busy={pending} noValidate>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.topic} className="font-bold text-varsity-navy">
            {t('topicLabel')}
          </label>
          <select id={ids.topic} value={topic} onChange={(event) => setTopic(event.target.value as SupportTopicValue)} aria-describedby={topicDescription} className={fieldClass(false)}>
            {SUPPORT_TOPICS.map((option) => (
              <option key={option} value={option}>
                {t(`topics.${option}`)}
              </option>
            ))}
          </select>
          <p id={ids.routing} className="text-sm font-semibold text-varsity-navy" data-testid="support-routing">
            {t(`routing.${targetOfTopic(topic)}`)}
          </p>
          {topic === 'RECTIFICATION' ? (
            <p id={ids.hint} className="text-sm text-ink-soft">
              {t('rectificationHint')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.subject} className="font-bold text-varsity-navy">
            {t('subjectLabel')}
          </label>
          <input
            id={ids.subject}
            ref={subjectField}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={SUPPORT_SUBJECT_MAX}
            aria-invalid={invalid && cleanSupportText(subject).length < SUPPORT_SUBJECT_MIN}
            aria-describedby={invalid ? `${ids.limits} ${ids.error}` : ids.limits}
            className={fieldClass(invalid && cleanSupportText(subject).length < SUPPORT_SUBJECT_MIN)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.message} className="font-bold text-varsity-navy">
            {t('messageLabel')}
          </label>
          <textarea
            id={ids.message}
            ref={messageField}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={SUPPORT_MESSAGE_MAX}
            rows={5}
            aria-invalid={invalid && cleanSupportText(message).length < SUPPORT_MESSAGE_MIN}
            aria-describedby={invalid ? `${ids.counter} ${ids.limits} ${ids.error}` : `${ids.counter} ${ids.limits}`}
            className={clsx(fieldClass(invalid && cleanSupportText(message).length < SUPPORT_MESSAGE_MIN), 'min-h-32')}
          />
          <p id={ids.counter} className="text-sm text-ink-soft">
            {t('counter', { count: message.length, max: SUPPORT_MESSAGE_MAX })}
          </p>
          <p id={ids.limits} className="text-sm text-ink-soft">
            {t('limits', { subjectMin: SUPPORT_SUBJECT_MIN, messageMin: SUPPORT_MESSAGE_MIN })}
          </p>
        </div>
        {error ? (
          <div id={ids.error}>
            <FormAlert>
              {t(error, { subjectMin: SUPPORT_SUBJECT_MIN, messageMin: SUPPORT_MESSAGE_MIN, messageMax: SUPPORT_MESSAGE_MAX })}
              {error === 'errors.login' ? (
                <>
                  {' '}
                  <Link href={loginHref} prefetch={false} className="underline">
                    {t('loginAction')}
                  </Link>
                </>
              ) : null}
            </FormAlert>
          </div>
        ) : null}
        <button type="submit" disabled={pending} className="tactile-btn min-h-11 self-start">
          {pending ? t('sending') : t('send')}
        </button>
      </form>
      {reauth.dialog}
    </>
  );
}
