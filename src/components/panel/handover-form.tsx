'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { correctCosignerAction, proposeHandoverAction, type TeamActionResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/team-actions';
import { Field, FormAlert } from '@/components/auth/auth-ui';
import type { SeatRole } from '@/core/panel/team-rules';
import { useApprovalsNotice } from './approvals-notice';
import { useFreshCode } from './use-fresh-code';

/** Motivos con texto propio junto al formulario; el resto se dice de forma genérica. */
const KNOWN = ['REAUTH_REQUIRED', 'ALREADY_OPEN', 'SEAT_EMPTY', 'SEAT_TAKEN', 'SINGLE_MODE', 'SAME_INBOX', 'DISPOSABLE_EMAIL', 'UNAVAILABLE', 'INVITEE_BUSY', 'RATE_LIMITED', 'FORBIDDEN'];
/** Motivos que son del email: se dicen junto al campo, no arriba (revisión de experiencia del 4.2e). */
const EMAIL_REASONS = ['SAME_INBOX', 'DISPOSABLE_EMAIL', 'UNAVAILABLE', 'INVITEE_BUSY'];

export interface HandoverFormProps {
  orgSlug: string;
  /** `propose`: relevo de un puesto ocupado. `correct`: invitar a la cofirma mientras su puesto está vacío (solo quien dirige). */
  mode: 'propose' | 'correct';
  /** Puestos que se pueden relevar, el propio primero. */
  seats: Array<{ role: SeatRole; mine: boolean; label: string }>;
  email: string;
}

/**
 * Proponer quién ocupa un puesto que firma (Sprint 4.2e): el propio o el de la otra persona; la invitación sale al momento y la otra persona recibe un aviso, sin visto bueno. Se confirma
 * con el código de la app de verificación. Los errores se dicen junto a cada campo y el foco va al primero; el éxito, en el aviso de la sección.
 */
export function HandoverForm({ orgSlug, mode, seats, email }: HandoverFormProps) {
  const t = useTranslations('panel.settings.team.form');
  const router = useRouter();
  const notify = useApprovalsNotice();
  const { run, dialog } = useFreshCode(email);
  const [role, setRole] = useState<SeatRole | null>(seats[0]?.role ?? null);
  const [values, setValues] = useState({ name: '', email: '', roleLabel: '' });
  const [fields, setFields] = useState<string[]>([]);
  // Motivo concreto del email que devuelve el servidor (ya firma, temporal, ocupado…), en lugar del genérico «Revisa el email».
  const [emailReason, setEmailReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (fields.length > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fields]);

  const set = (key: keyof typeof values, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const fieldError = (key: string) => (fields.includes(key) ? (key === 'email' && emailReason ? t(`errors.${emailReason}`) : t(`errors.${key}`)) : undefined);
  const mine = seats.find((seat) => seat.role === role)?.mine ?? false;

  async function submit() {
    const missing = (['name', 'email', 'roleLabel'] as const).filter((key) => values[key].trim().length < (key === 'roleLabel' ? 3 : 2));
    if (missing.length > 0) {
      setFields(missing);
      setEmailReason(null);
      setError(t('errors.form'));
      return;
    }
    setBusy(true);
    setFields([]);
    setEmailReason(null);
    setError(null);
    try {
      // Las dos acciones deciden quién firmará: se confirman con el código de la app si no se ha dado en los últimos 10 minutos.
      const result: TeamActionResult = await run(() => (mode === 'correct' ? correctCosignerAction(orgSlug, values) : proposeHandoverAction(orgSlug, { role, ...values })));
      if (result.status === 'OK') {
        notify(mode === 'correct' ? t('savedCorrected') : t(mine ? 'savedSelf' : 'savedOther'));
        setValues({ name: '', email: '', roleLabel: '' });
        router.refresh();
      } else if (result.reason === 'INVALID' || EMAIL_REASONS.includes(result.reason)) {
        const email = EMAIL_REASONS.includes(result.reason);
        setEmailReason(email ? result.reason : null);
        setFields(email ? ['email'] : result.fields?.length ? result.fields : ['form']);
        // El motivo del email ya está junto al campo: arriba, solo si son varios campos.
        setError(email ? null : t('errors.form'));
      } else setError(t(`errors.${KNOWN.includes(result.reason) ? result.reason : 'generic'}`));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  // El diálogo del código va fuera del formulario: tiene su propio formulario y no se pueden anidar.
  return (
    <>
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === 'propose' && seats.length > 1 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-bold text-varsity-navy">{t('seatLegend')}</legend>
            {seats.map((seat) => (
              <label key={seat.role} className="flex min-h-11 items-center gap-3 rounded-xl border-2 border-varsity-navy/20 bg-white px-3">
                <input type="radio" name="seat" value={seat.role} checked={role === seat.role} onChange={() => setRole(seat.role)} className="size-5 accent-varsity-navy" />
                <span className="font-semibold text-varsity-navy">{seat.label}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <p className="text-sm text-ink-soft">{mode === 'correct' ? t('correctHint') : t(mine ? 'selfHint' : 'otherHint')}</p>
        <Field label={t('name')} name="name" autoComplete="off" required value={values.name} onChange={(event) => set('name', event.target.value)} error={fieldError('name')} maxLength={80} />
        <Field label={t('email')} name="email" type="email" autoComplete="off" required value={values.email} onChange={(event) => set('email', event.target.value)} error={fieldError('email')} maxLength={254} />
        <Field label={t('roleLabel')} name="roleLabel" hint={t('roleLabelHint')} required value={values.roleLabel} onChange={(event) => set('roleLabel', event.target.value)} error={fieldError('roleLabel')} maxLength={60} />
        {error ? <FormAlert>{error}</FormAlert> : null}
        <button type="submit" disabled={busy} aria-busy={busy} className="tactile-btn self-start disabled:opacity-60">
          {busy ? t('sending') : mode === 'correct' ? t('submitCorrect') : t(mine ? 'submitSelf' : 'submitOther')}
        </button>
      </form>
      {dialog}
    </>
  );
}
