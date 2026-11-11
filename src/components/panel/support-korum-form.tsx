'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { sendToKorumAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/soporte/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { ENTITY_TOPICS } from '@/core/support/support-inbox-rules';
import { cleanSupportText, SUPPORT_MESSAGE_MAX, SUPPORT_MESSAGE_MIN, SUPPORT_SUBJECT_MAX, SUPPORT_SUBJECT_MIN } from '@/core/support/support-rules';
import { cleanIdeaText } from '@/core/ideas/idea-rules';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Buzón prioritario de la entidad hacia KORUM (Sprint 4.4c, prototipo `function submitSchoolTicketToSuperAdmin`). Quien firma escribe con la sesión
 * y el segundo factor; el servidor añade la entidad y el acuse sale a su correo. Los mismos mínimos que el servidor se comprueban aquí, junto al campo y
 * moviendo el foco al primero que falla; el éxito se anuncia en el aviso de la página y el formulario se vacía.
 */
export function SupportKorumForm({ orgSlug, canAct }: { orgSlug: string; canAct: boolean }) {
  const t = useTranslations('panel.support.korum');
  const te = useTranslations('panel.support.errors');
  const locale = useLocale();
  const router = useRouter();
  const notify = useApprovalsNotice();
  const ids = { topic: useId(), subject: useId(), message: useId(), counter: useId(), limits: useId(), subjectError: useId(), messageError: useId() };
  const subjectField = useRef<HTMLInputElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const [topic, setTopic] = useState<(typeof ENTITY_TOPICS)[number]>('OTHER');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setErrorText] = useState<{ text: string; field: 'subject' | 'message' | null; at: number } | null>(null);
  const setError = (text: string | null, field: 'subject' | 'message' | null = null) => setErrorText(text === null ? null : { text, field, at: Date.now() });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (cleanIdeaText(subject).length < SUPPORT_SUBJECT_MIN) {
      setError(t('errors.subject', { min: SUPPORT_SUBJECT_MIN }), 'subject');
      subjectField.current?.focus();
      return;
    }
    if (cleanSupportText(message).length < SUPPORT_MESSAGE_MIN) {
      setError(t('errors.message', { min: SUPPORT_MESSAGE_MIN }), 'message');
      messageField.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await sendToKorumAction(orgSlug, locale, { topic, subject, message });
      if (result.status === 'OK') {
        notify(t('sent', { code: result.ticketCode }));
        setSubject('');
        setMessage('');
        setTopic('OTHER');
        router.refresh();
      } else setError(te(result.reason));
    } catch {
      setError(te('generic'));
    } finally {
      setBusy(false);
    }
  }

  if (!canAct) return <p className="rounded-xl border-2 border-stone-300 bg-stone-50 p-3 font-semibold text-ink-soft">{t('readOnly')}</p>;

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="korum-trust-vault flex flex-col gap-3 p-5" aria-busy={busy} data-testid="support-korum-form">
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.topic} className="font-bold text-varsity-navy">
          {t('topicLabel')}
        </label>
        <select id={ids.topic} value={topic} onChange={(event) => setTopic(event.target.value as (typeof ENTITY_TOPICS)[number])} className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 font-semibold">
          {ENTITY_TOPICS.map((option) => (
            <option key={option} value={option}>
              {t(`topics.${option}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.subject} className="font-bold text-varsity-navy">
          {t('subjectLabel')}
        </label>
        <input id={ids.subject} ref={subjectField} value={subject} onChange={(event) => {
            setSubject(event.target.value);
            if (error?.field === 'subject') setError(null);
          }} maxLength={SUPPORT_SUBJECT_MAX} aria-invalid={error?.field === 'subject' ? true : undefined} aria-describedby={error?.field === 'subject' ? `${ids.limits} ${ids.subjectError}` : ids.limits} className="min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 text-base aria-invalid:border-red-700" />
        {error?.field === 'subject' ? (
          <p id={ids.subjectError} role="alert" className="text-sm font-semibold text-red-800">
            {error.text}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.message} className="font-bold text-varsity-navy">
          {t('messageLabel')}
        </label>
        <textarea id={ids.message} ref={messageField} value={message} onChange={(event) => {
            setMessage(event.target.value);
            if (error?.field === 'message') setError(null);
          }} maxLength={SUPPORT_MESSAGE_MAX} rows={5} aria-invalid={error?.field === 'message' ? true : undefined} aria-describedby={error?.field === 'message' ? `${ids.counter} ${ids.limits} ${ids.messageError}` : `${ids.counter} ${ids.limits}`} className="min-h-32 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 py-2 text-base aria-invalid:border-red-700" />
        <p id={ids.counter} className="text-sm text-ink-soft">
          {t('counter', { count: message.length, max: SUPPORT_MESSAGE_MAX })}
        </p>
        <p id={ids.limits} className="text-sm text-ink-soft">
          {t('limits', { subjectMin: SUPPORT_SUBJECT_MIN, messageMin: SUPPORT_MESSAGE_MIN })}
        </p>
        {error?.field === 'message' ? (
          <p id={ids.messageError} role="alert" className="text-sm font-semibold text-red-800">
            {error.text}
          </p>
        ) : null}
      </div>
      {error && error.field === null ? <FormAlert key={error.at}>{error.text}</FormAlert> : null}
      <button type="submit" disabled={busy} aria-busy={busy} className="tactile-btn self-start disabled:opacity-60">
        {busy ? t('sending') : t('send')}
      </button>
    </form>
  );
}
