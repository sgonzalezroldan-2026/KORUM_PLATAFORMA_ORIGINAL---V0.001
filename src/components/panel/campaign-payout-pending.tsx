'use client';

import clsx from 'clsx';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
import { requestPayoutSignatureAction, retryPayoutAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/liquidaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { CurrencyText } from '@/components/ui/currency-text';
import type { PayoutSettlement } from '@/services/payments/campaign-payout-settlement';
import type { PendingPayoutView } from '@/services/panel/campaign-payouts-data';
import type { NoticeTone } from './approvals-notice';
import { useApprovalsNotice } from './approvals-notice';
import { usePayoutAction } from './campaign-payout-form';

/** Qué decir tras reintentar: hecha, por qué no se aprueba (con su motivo) o que sigue pendiente y se reintenta sola. */
function settlementNotice(t: ReturnType<typeof useTranslations<'panel.payouts.pending'>>, settlement: PayoutSettlement | undefined): [string, NoticeTone] {
  if (settlement?.status === 'EXECUTED') return [t('retryDone'), 'success'];
  if (settlement?.status === 'NOT_APPROVED') return [t(`notApproved.${settlement.reason}`), 'warning'];
  return [t('retryPending'), 'warning'];
}

/**
 * Liquidación de una campaña que espera la doble firma (Sprint 4.4a): a quién va, la factura, las casillas de las dos personas y pedir (otra vez) el
 * enlace propio. Si las cifras ya no cuadran o la factura dejó de valer, se dice y se ofrece cambiarla (el formulario llega como `editor`). Con las dos
 * firmas y sin aprobar (los documentos aún no estaban verificados), «Reintentar». El estado se dice con texto, no solo con color.
 */
export function CampaignPayoutPending({
  orgSlug,
  initiativeId,
  payout,
  invoiceRequired,
  canAct,
  blocked,
  editor
}: {
  orgSlug: string;
  initiativeId: number;
  payout: PendingPayoutView;
  /** Campaña de presupuesto: su liquidación lleva siempre la factura del proveedor (QA-S03). */
  invoiceRequired: boolean;
  canAct: boolean;
  /** Falta algo antes de liquidar (lo dice la tarjeta): quien firma no puede pedir su enlace ni cambiarla hasta resolverlo. */
  blocked: boolean;
  editor: ReactNode;
}) {
  const t = useTranslations('panel.payouts.pending');
  const tSlots = useTranslations('panel.approvals.doubleCheck');
  const format = useFormatter();
  const announce = useApprovalsNotice();
  // Sin la factura que hace falta (o con una que ya no vale) no se puede firmar: se abre directamente el cambio.
  const invoiceMissing = !payout.invoiceValid && (invoiceRequired || payout.destinationType === 'PROVIDER' || payout.invoice !== null);
  const [editing, setEditing] = useState(payout.stale || invoiceMissing);
  const editButton = useRef<HTMLButtonElement>(null);
  const editIntro = useRef<HTMLParagraphElement>(null);
  const { error, pending, run } = usePayoutAction();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });
  const invoiceHref = payout.invoice ? `/api/panel/liquidaciones/factura/${payout.invoice.fileId}?orgSlug=${encodeURIComponent(orgSlug)}` : null;

  return (
    <section aria-labelledby={`payout-pending-${payout.id}`} className="flex flex-col gap-3 rounded-xl border-2 border-varsity-navy/20 bg-varsity-ivory p-4" data-testid={`payout-pending-${initiativeId}`}>
      <h3 id={`payout-pending-${payout.id}`} className="font-corp text-lg font-extrabold text-varsity-navy">
        {t('title', { reference: payout.reference })}
      </h3>
      <p className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy">
        <CurrencyText cents={payout.netPaidCents} />
      </p>
      <p className="wrap-break-word text-sm">
        {payout.destinationType === 'PROVIDER' ? t('toProvider', { name: payout.beneficiaryName, bank: payout.ibanBank ?? '····', last4: payout.ibanLast4 ?? '' }) : t('toOrganization', { name: payout.beneficiaryName })}
      </p>
      {payout.requestedBy ? <p className="text-sm text-ink-soft" data-testid="payout-requested-by">{t('requestedBy', { name: payout.requestedBy, date: date(payout.updatedAt) })}</p> : null}
      {invoiceHref ? (
        <a href={invoiceHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4">
          {t('openInvoice')}
        </a>
      ) : null}
      {payout.stale ? <p className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950" data-testid="payout-stale">{t('stale')}</p> : null}
      {invoiceMissing ? (
        <p className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950" data-testid="payout-invoice-missing">
          {t(payout.invoice ? 'invoiceInvalid' : 'invoiceMissing')}
        </p>
      ) : null}
      {!payout.invoice && !invoiceMissing ? <p className="text-sm text-ink-soft">{t('noInvoice')}</p> : null}

      <p className="font-corp text-lg font-extrabold tabular-nums text-varsity-navy">{tSlots('progress', { signed: payout.signed })}</p>
      <ul className="mobile-stack grid gap-2 sm:grid-cols-2">
        {payout.slots.map((slot) => (
          <li key={slot.role} className={clsx('flex flex-col gap-0.5 rounded-lg border-2 p-3', slot.signedBy ? 'border-varsity-emerald bg-emerald-50' : 'border-dashed border-stone-300 bg-white')}>
            <span className="text-sm font-extrabold text-varsity-navy">{slot.holderLabel ?? tSlots(`roles.${slot.role}`)}</span>
            {slot.signedBy ? (
              <span className="text-sm text-emerald-950">{`✅ ${tSlots('signedBy', { name: slot.signedBy.name || (slot.signedBy.roleLabel ?? ''), date: date(slot.signedBy.signedAt) })}`}</span>
            ) : (
              <span className="text-sm text-ink-soft">{`⏳ ${tSlots('pending')}`}</span>
            )}
          </li>
        ))}
      </ul>

      {canAct && !blocked && payout.signed === 2 ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => retryPayoutAction(orgSlug, { initiativeId }), (result) => announce(...settlementNotice(t, result.settlement)))}
          className="tactile-btn self-start disabled:opacity-60"
        >
          {pending ? t('retrying') : t('retry')}
        </button>
      ) : canAct && !blocked && payout.mySlotOpen && !payout.stale && !invoiceMissing ? (
        <div className="flex flex-col gap-2">
          {payout.myChallengeExpiresAt ? <FormAlert tone="success">{tSlots('sent', { date: date(payout.myChallengeExpiresAt) })}</FormAlert> : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => requestPayoutSignatureAction(orgSlug, { initiativeId }), (result) => announce(tSlots('sent', { date: result.expiresAt ? date(result.expiresAt) : '' })))}
            className={payout.myChallengeExpiresAt ? 'min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4 disabled:opacity-60' : 'tactile-btn self-start disabled:opacity-60'}
          >
            {payout.myChallengeExpiresAt ? tSlots('resend') : `🛡️ ${t('requestLink')}`}
          </button>
        </div>
      ) : (
        <p className="text-sm text-ink-soft">{blocked && canAct ? t('blockedNote') : canAct ? t('waitingOther') : tSlots('readOnly')}</p>
      )}
      {error ? <FormAlert>{error}</FormAlert> : null}

      {canAct && !blocked ? (
        editing ? (
          <div className="flex flex-col gap-3 border-t-2 border-varsity-navy/10 pt-3">
            <p ref={editIntro} tabIndex={-1} className="text-sm font-semibold text-varsity-navy">
              {t('editIntro')}
            </p>
            {editor}
            {!payout.stale && !invoiceMissing ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  requestAnimationFrame(() => editButton.current?.focus());
                }}
                className="min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4"
              >
                {t('editCancel')}
              </button>
            ) : null}
          </div>
        ) : (
          <button
            ref={editButton}
            type="button"
            onClick={() => {
              setEditing(true);
              // El botón desaparece: el foco va a la explicación del cambio, no al documento.
              requestAnimationFrame(() => editIntro.current?.focus());
            }}
            className="min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4"
          >
            {t('edit')}
          </button>
        )
      ) : null}
    </section>
  );
}

/** Reintentar ya el envío de una liquidación aprobada que Paycomet no terminó (la tarea diaria también lo hace). */
export function PayoutRetryButton({ orgSlug, initiativeId }: { orgSlug: string; initiativeId: number }) {
  const t = useTranslations('panel.payouts.pending');
  const announce = useApprovalsNotice();
  const { error, pending, run } = usePayoutAction();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => retryPayoutAction(orgSlug, { initiativeId }), (result) => announce(...settlementNotice(t, result.settlement)))}
        className="min-h-11 self-start font-semibold text-varsity-navy underline underline-offset-4 disabled:opacity-60"
      >
        {pending ? t('retrying') : t('retry')}
      </button>
      {error ? <FormAlert>{error}</FormAlert> : null}
    </div>
  );
}
