'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, useTransition } from 'react';
import { sendDirectEmailAction, type DirectEmailActionResult } from '@/app/[locale]/(superadmin)/admin/soporte/actions';
import { hasLinkOrAddress } from '@/core/admin/console-support-rules';
import { SUPPORT_MESSAGE_MAX, SUPPORT_MESSAGE_MIN, SUPPORT_SUBJECT_MAX, SUPPORT_SUBJECT_MIN } from '@/core/support/support-rules';
import { useToast } from '@/components/ui/toast-provider';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { FIELD, OUTLINE, PRIMARY } from './entity-action';
import { focusLater } from './rules-action';

/**
 * «✉️ Enviar email directo al centro» (prototipo; aplazado del 5.2): un texto libre de KORUM a quienes firman por la entidad. El texto sale tal como se escribe (solo el botón y el
 * pie del email se traducen al idioma de cada persona), con el nombre de KORUM, sin enlaces ni direcciones, y no se puede retirar: antes de enviar hay una confirmación con la
 * entidad. Lleva un tope de envíos por entidad y por persona y día; queda en la auditoría con la longitud del texto y a cuántas personas salió, nunca con el contenido.
 */
export function OrgDirectEmail({ organizationId, organizationName, disabled }: { organizationId: string; organizationName: string; disabled: boolean }) {
  const t = useTranslations('admin.org360.directEmail');
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<DirectEmailActionResult | null>(null);
  const [failed, setFailed] = useState(false);
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const linkFound = hasLinkOrAddress(subject) || hasLinkOrAddress(message);
  const invalid = (result?.status === 'ERROR' && result.reason === 'INVALID_INPUT') || linkFound;
  const ready = subject.trim().length >= SUPPORT_SUBJECT_MIN && message.trim().length >= SUPPORT_MESSAGE_MIN && !linkFound;

  const send = () => {
    setConfirming(false);
    startTransition(async () => {
      setFailed(false);
      setResult(null);
      try {
        const outcome = await sendDirectEmailAction({ organizationId, email: { subject, message } });
        setResult(outcome);
        if (outcome.status === 'SENT') {
          toast({ tone: 'success', title: t('sent', { count: outcome.recipients }) });
          setSubject('');
          setMessage('');
        }
        focusLater(`${id}-subject`);
      } catch {
        setFailed(true);
        focusLater(`${id}-send`);
      }
    });
  };

  if (disabled) return <p className="text-ink-soft">{t('archived')}</p>;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setConfirming(true);
        requestAnimationFrame(() => confirmTitle.current?.focus());
      }}
      className="flex flex-col gap-3"
      data-testid="direct-email"
    >
      <p className="text-sm text-ink-soft">{t('explain')}</p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-subject`} className="text-sm font-semibold text-ink-soft">
          {t('subject')}
        </label>
        <input
          id={`${id}-subject`}
          type="text"
          value={subject}
          maxLength={SUPPORT_SUBJECT_MAX}
          disabled={confirming}
          onChange={(event) => setSubject(event.target.value)}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error ${id}-hint` : `${id}-hint`}
          className={FIELD}
          autoComplete="off"
          data-testid="direct-subject"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-message`} className="text-sm font-semibold text-ink-soft">
          {t('message')}
        </label>
        <textarea
          id={`${id}-message`}
          value={message}
          rows={6}
          maxLength={SUPPORT_MESSAGE_MAX}
          disabled={confirming}
          onChange={(event) => setMessage(event.target.value)}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error ${id}-hint` : `${id}-hint`}
          className="w-full rounded-lg border-2 border-varsity-navy/30 bg-white p-3 text-base"
          data-testid="direct-message"
        />
        <p id={`${id}-hint`} className="text-sm text-ink-soft">
          {t('lengthHint', { min: SUPPORT_MESSAGE_MIN, max: SUPPORT_MESSAGE_MAX })}
        </p>
      </div>
      <button id={`${id}-send`} type="submit" disabled={!ready || pending || confirming} aria-describedby={`${id}-hint`} className={`${PRIMARY} self-start`} data-testid="direct-send">
        {pending ? t('sending') : t('continue')}
      </button>
      {confirming ? (
        <div
          role="group"
          aria-label={t('confirmTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setConfirming(false);
              focusLater(`${id}-send`);
            }
          }}
          className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3"
          data-testid="direct-confirm"
        >
          <p ref={confirmTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
            {t('confirmTitle')}
          </p>
          <p>{t('confirmText', { organization: organizationName })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY} onClick={send} data-testid="direct-confirm-yes">
              {t('confirmYes')}
            </button>
            <button
              type="button"
              className={OUTLINE}
              onClick={() => {
                setConfirming(false);
                focusLater(`${id}-send`);
              }}
            >
              {t('confirmBack')}
            </button>
          </div>
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm font-semibold text-red-900">
          {t('error.FAILED')}
        </p>
      ) : null}
      {linkFound || (result?.status === 'ERROR' && result.reason !== 'REAUTH_REQUIRED') ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-red-900">
          {linkFound ? t('error.INVALID_INPUT') : result?.status === 'ERROR' ? t(`error.${result.reason}`) : null}
        </p>
      ) : null}
      {result?.status === 'ERROR' && result.reason === 'REAUTH_REQUIRED' ? (
        <p role="alert" className="text-sm font-semibold text-red-900">
          {t('error.REAUTH_REQUIRED')}{' '}
          <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin') } }} className="inline-flex min-h-11 items-center underline">
            {t('reauthLink')}
          </Link>
        </p>
      ) : null}
    </form>
  );
}
