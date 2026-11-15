'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState, useTransition } from 'react';
import { findAuditPersonAction } from '@/app/[locale]/(superadmin)/admin/auditoria/actions';
import { AUDIT_QUERY_KEYS } from '@/core/audit/audit-query';
import { useRouter } from '@/i18n/navigation';

/**
 * «Buscar por persona» del visor de la auditoría (Sprint 5.8a). El email se envía a una acción de servidor, que lo traduce al identificador de la cuenta; la
 * página se abre después con ese identificador en la dirección, nunca con el email. Los errores se dicen junto al campo (`role="alert"`) y el foco vuelve a él.
 */

const FIELD = 'min-h-11 w-full rounded-lg border-2 border-varsity-navy/30 bg-white px-3 text-base text-varsity-navy';

export function AuditPersonSearch() {
  const t = useTranslations('admin.audit');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<'personNotFound' | 'personInvalid' | 'personForbidden' | 'personFailed' | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();

  const search = () => {
    startTransition(async () => {
      setError(null);
      try {
        const outcome = await findAuditPersonAction({ email });
        if (outcome.status === 'FOUND') {
          router.push(`/admin/auditoria?${AUDIT_QUERY_KEYS.person}=${encodeURIComponent(outcome.userId)}`);
          return;
        }
        setError(outcome.status === 'NOT_FOUND' ? 'personNotFound' : outcome.reason === 'INVALID' ? 'personInvalid' : 'personForbidden');
      } catch {
        // Sin conexión: se dice junto al campo, sin dejar la búsqueda a medias.
        setError('personFailed');
      }
      field.current?.focus();
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        search();
      }}
      className="korum-trust-vault flex flex-col gap-2 p-4"
      data-testid="audit-person-search"
      noValidate
    >
      <label htmlFor={`${id}-email`} className="font-corp text-lg font-extrabold text-varsity-navy">
        {t('personLabel')}
      </label>
      <p id={`${id}-hint`} className="text-sm text-ink-soft">
        {t('personHint')}
      </p>
      <div className="mobile-stack grid gap-3 md:grid-cols-[1fr_auto]">
        <input
          ref={field}
          id={`${id}-email`}
          type="email"
          name="email"
          autoComplete="off"
          inputMode="email"
          maxLength={320}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
          aria-invalid={error === 'personNotFound' || error === 'personInvalid'}
          className={FIELD}
        />
        <button type="submit" disabled={pending || email.trim() === ''} className="tactile-btn min-h-11 rounded-xl px-5 font-bold disabled:opacity-60">
          {pending ? t('personSearching') : t('personSearch')}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="font-semibold text-red-800" data-testid="audit-person-error">
          {t(error)}
        </p>
      ) : null}
    </form>
  );
}
