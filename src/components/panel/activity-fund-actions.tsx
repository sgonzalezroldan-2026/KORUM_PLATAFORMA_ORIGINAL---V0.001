'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import {
  cancelFundPayoutAction,
  requestFundPayoutAction,
  requestFundSignatureAction,
  retryFundPayoutAction,
  type FundActionResult
} from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/fondo/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { CurrencyText } from '@/components/ui/currency-text';
import { FUND_PURPOSE_MAX, FUND_PURPOSE_MIN } from '@/core/sponsors/activity-fund-rules';
import type { ActivityFundView } from '@/services/panel/activity-fund-data';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Lo que se hace con el Fondo de actividades desde el panel (Sprint 4.2f). Nunca se firma aquí: el enlace de un solo uso y el código llegan por email
 * y se abren con la sesión de esa persona (`/firmar`), como cualquier doble firma. Los estados se dicen con texto, no solo con color.
 */

/** Motivos que cambian lo que se ve (la tarjeta o el formulario desaparecen al recargar): se dicen en el aviso de la página, que sobrevive al refresco. */
const PAGE_LEVEL = new Set(['LINK_NOT_SENT', 'FUND_CHANGED', 'WINDOW_EXPIRED', 'WRONG_STATUS', 'PAYOUT_PENDING']);

function useFundAction() {
  const tErrors = useTranslations('panel.fund.errors');
  const announce = useApprovalsNotice();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<FundActionResult>, onOk: (result: Extract<FundActionResult, { status: 'OK' }>) => void) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.status === 'ERROR') {
          if (PAGE_LEVEL.has(result.reason)) {
            announce(tErrors(result.reason), 'warning');
            router.refresh();
          } else setError(tErrors(result.reason));
        } else {
          onOk(result);
          router.refresh();
        }
      } catch {
        setError(tErrors('failed'));
      }
    });
  };
  return { error, pending, run };
}

/** Pedir la liquidación: para qué usará la entidad el dinero (lo firman las personas que exige la entidad y sale en el justificante). */
export function ActivityFundRequestForm({ orgSlug, availableCents }: { orgSlug: string; availableCents: number }) {
  const t = useTranslations('panel.fund.request');
  const announce = useApprovalsNotice();
  const ids = { field: useId(), help: useId(), error: useId() };
  const [purpose, setPurpose] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { error, pending, run } = useFundAction();
  const format = useFormatter();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const length = purpose.trim().length;
    if (length < FUND_PURPOSE_MIN || length > FUND_PURPOSE_MAX || /(https?:\/\/|www\.)/i.test(purpose)) {
      setFieldError(t('purposeLength', { min: FUND_PURPOSE_MIN, max: FUND_PURPOSE_MAX }));
      document.getElementById(ids.field)?.focus();
      return;
    }
    setFieldError(null);
    run(
      () => requestFundPayoutAction(orgSlug, { purpose }),
      (result) =>
        announce(
          result.expiresAt
            ? t('requested', {
                date: format.dateTime(new Date(result.expiresAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: 'Europe/Madrid'
                })
              })
            : t('requestedNoLink')
        )
    );
  };

  return (
    <form onSubmit={submit} noValidate aria-busy={pending} className="korum-trust-vault flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-white p-5" data-testid="fund-request">
      <h2 className="font-corp text-xl font-extrabold text-varsity-navy">{t('title')}</h2>
      <p>
        {t.rich('lead', {
          amount: () => <CurrencyText cents={availableCents} className="font-extrabold text-varsity-navy" />
        })}
      </p>
      <label htmlFor={ids.field} className="font-bold text-varsity-navy">
        {t('purposeLabel')}
      </label>
      <p id={ids.help} className="text-sm text-ink-soft">
        {t('purposeHelp', { min: FUND_PURPOSE_MIN, max: FUND_PURPOSE_MAX })}
      </p>
      <textarea
        id={ids.field}
        value={purpose}
        onChange={(event) => setPurpose(event.target.value.slice(0, FUND_PURPOSE_MAX))}
        rows={4}
        maxLength={FUND_PURPOSE_MAX}
        aria-describedby={fieldError ? `${ids.help} ${ids.error}` : ids.help}
        aria-invalid={fieldError ? true : undefined}
        className="min-h-24 rounded-xl border-2 border-varsity-navy/30 bg-white p-3 focus-visible:border-varsity-navy aria-invalid:border-red-700"
      />
      <p className="text-right text-xs text-ink-soft tabular-nums" aria-hidden="true">{`${purpose.trim().length}/${FUND_PURPOSE_MAX}`}</p>
      {fieldError ? (
        <p id={ids.error} role="alert" className="text-sm font-semibold text-red-800">
          {fieldError}
        </p>
      ) : null}
      <p className="text-sm text-ink-soft">{t('effect')}</p>
      {error ? <FormAlert>{error}</FormAlert> : null}
      <button type="submit" disabled={pending} className="tactile-btn self-start disabled:opacity-60">
        {pending ? t('sending') : `🛡️ ${t('submit')}`}
      </button>
    </form>
  );
}

/** Liquidación que espera la doble firma: casillas de las dos personas, pedir (otra vez) el enlace propio y retirarla. */
export function ActivityFundPending({ orgSlug, payout, canAct }: { orgSlug: string; payout: NonNullable<ActivityFundView['pending']>; canAct: boolean }) {
  const t = useTranslations('panel.fund.pending');
  const tSlots = useTranslations('panel.approvals.doubleCheck');
  const format = useFormatter();
  const announce = useApprovalsNotice();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const openConfirm = (open: boolean) => {
    setConfirmCancel(open);
    // El botón pulsado desaparece: el foco va a la siguiente decisión (o vuelve a «Retirar»), no al documento.
    requestAnimationFrame(() => (open ? confirmButton.current : cancelButton.current)?.focus());
  };
  const { error, pending, run } = useFundAction();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Europe/Madrid'
    });

  return (
    <section aria-labelledby="fund-pending" className="korum-trust-vault flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-white p-5" data-testid="fund-pending">
      <h2 id="fund-pending" className="font-corp text-xl font-extrabold text-varsity-navy">
        {t(payout.slots.length > 0 && payout.signed === payout.slots.length ? 'titleSigned' : 'title', { reference: payout.reference })}
      </h2>
      <p className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy">
        <CurrencyText cents={payout.amountCents} />
      </p>
      <p className="text-sm font-semibold text-ink-soft">
        {t('purpose', {
          name: payout.requestedBy || t('someone'),
          date: date(payout.createdAt)
        })}
      </p>
      <p className="whitespace-pre-line wrap-break-word rounded-xl bg-varsity-ivory p-3">{payout.purpose}</p>
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold text-varsity-navy">{t('splits', { count: payout.splits.length })}</summary>
        <ul className="flex flex-col gap-1 ps-4">
          {payout.splits.map((split, index) => (
            <li key={index} className="flex justify-between gap-2">
              <span className="wrap-break-word">{split.sponsor}</span>
              <CurrencyText cents={split.amountCents} />
            </li>
          ))}
        </ul>
      </details>
      <p className="font-corp text-lg font-extrabold tabular-nums text-varsity-navy">{tSlots('progress', { signed: payout.signed, total: payout.slots.length })}</p>
      <ul className="mobile-stack grid gap-2 sm:grid-cols-2">
        {payout.slots.map((slot) => (
          <li key={slot.role} className={clsx('flex flex-col gap-0.5 rounded-lg border-2 p-3', slot.signedBy ? 'border-varsity-emerald bg-emerald-50' : 'border-dashed border-stone-300 bg-stone-50')}>
            <span className="text-sm font-extrabold text-varsity-navy">{slot.holderLabel ?? tSlots(`roles.${slot.role}`)}</span>
            {slot.signedBy ? (
              <span className="text-sm text-emerald-950">{`✅ ${tSlots('signedBy', { name: slot.signedBy.name || (slot.signedBy.roleLabel ?? ''), date: date(slot.signedBy.signedAt) })}`}</span>
            ) : (
              <span className="text-sm text-ink-soft">{`⏳ ${tSlots('pending')}`}</span>
            )}
          </li>
        ))}
      </ul>
      {/* Ya tiene las firmas que exige la entidad pero no se aprobó (p. ej. pasó a firma única con la firma de Dirección puesta): se puede aprobar y enviar ya. */}
      {canAct && payout.slots.length > 0 && payout.signed === payout.slots.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-soft">{t('allSigned')}</p>
          <FundRetryButton orgSlug={orgSlug} payoutId={payout.id} primary />
        </div>
      ) : canAct && payout.mySlotOpen ? (
        <div className="flex flex-col gap-2">
          {payout.myChallengeExpiresAt ? <FormAlert tone="success">{tSlots('sent', { date: date(payout.myChallengeExpiresAt) })}</FormAlert> : null}
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () => requestFundSignatureAction(orgSlug, { payoutId: payout.id }),
                (result) =>
                  announce(
                    tSlots('sent', {
                      date: result.expiresAt ? date(result.expiresAt) : ''
                    })
                  )
              )
            }
            className={
              payout.myChallengeExpiresAt ? 'min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4 disabled:opacity-60' : 'tactile-btn self-start disabled:opacity-60'
            }
          >
            {payout.myChallengeExpiresAt ? tSlots('resend') : `🛡️ ${t('requestLink')}`}
          </button>
        </div>
      ) : (
        <p className="text-sm text-ink-soft">{canAct ? t('waitingOther') : tSlots('readOnly')}</p>
      )}
      {canAct ? (
        confirmCancel ? (
          <div className="flex flex-col gap-2 rounded-xl border-2 border-amber-300 bg-amber-50 p-3" role="group" aria-label={t('cancelConfirmLabel')}>
            <p className="text-sm font-semibold text-amber-950">{t('cancelConfirm')}</p>
            <div className="flex flex-wrap gap-2">
              <button
                ref={confirmButton}
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () => cancelFundPayoutAction(orgSlug, { payoutId: payout.id }),
                    () => announce(t('cancelled'))
                  )
                }
                className="tactile-btn disabled:opacity-60"
              >
                {t('cancelYes')}
              </button>
              <button type="button" onClick={() => openConfirm(false)} className="min-h-11 font-semibold text-varsity-navy underline underline-offset-4">
                {t('cancelNo')}
              </button>
            </div>
          </div>
        ) : (
          <button ref={cancelButton} type="button" onClick={() => openConfirm(true)} className="min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4">
            {t('cancel')}
          </button>
        )
      ) : null}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </section>
  );
}

/** Reintentar ya el envío de una liquidación firmada que Paycomet no terminó. */
export function FundRetryButton({ orgSlug, payoutId, primary = false }: { orgSlug: string; payoutId: number; primary?: boolean }) {
  const t = useTranslations('panel.fund.history');
  const announce = useApprovalsNotice();
  const { error, pending, run } = useFundAction();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          run(
            () => retryFundPayoutAction(orgSlug, { payoutId }),
            (result) => announce(t(result.executed ? 'retryDone' : 'retryPending'))
          )
        }
        className={primary ? 'tactile-btn self-start disabled:opacity-60' : 'min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4 disabled:opacity-60'}
      >
        {pending ? t(primary ? 'sending' : 'retrying') : t(primary ? 'send' : 'retry')}
      </button>
      {error ? <FormAlert>{error}</FormAlert> : null}
    </div>
  );
}
