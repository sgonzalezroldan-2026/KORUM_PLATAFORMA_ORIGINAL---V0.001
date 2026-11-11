'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { requestPayoutAction, type PayoutActionResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/liquidaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { PROVIDER_NAME_MAX, PROVIDER_NAME_MIN, validateIban } from '@/core/payouts/provider-fields';
import type { ReadyInitiativeView } from '@/services/panel/campaign-payouts-data';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Pedir (o cambiar) la liquidación de una campaña conseguida (Sprint 4.4a, prototipo `closeAndPublishAchievedInitiative`): destino y factura del proveedor.
 * Nunca se firma aquí: el enlace de un solo uso y el código llegan por email (`/firmar`). Los errores van junto a su campo y se anuncian.
 */

/** Motivos que cambian lo que se ve (la tarjeta cambia al recargar): se dicen en el aviso de la página, que sobrevive al refresco. */
const PAGE_LEVEL = new Set(['LINK_NOT_SENT', 'WRONG_STATUS', 'NOT_READY', 'RAFFLE_NOT_DRAWN', 'SPONSORS_PENDING', 'WINDOW_EXPIRED', 'NOTHING_TO_PAY']);

export function usePayoutAction() {
  const tErrors = useTranslations('panel.payouts.errors');
  const announce = useApprovalsNotice();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<PayoutActionResult>, onOk: (result: Extract<PayoutActionResult, { status: 'OK' }>) => void) => {
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

type Destination = 'ORGANIZATION' | 'PROVIDER';
type FieldKey = 'providerName' | 'providerTaxId' | 'iban' | 'invoice';

export function CampaignPayoutForm({
  orgSlug,
  initiative,
  providerPayoutAvailable,
  organizationAccount,
  maxInvoiceBytes
}: {
  orgSlug: string;
  initiative: ReadyInitiativeView;
  providerPayoutAvailable: boolean;
  organizationAccount: boolean;
  maxInvoiceBytes: number;
}) {
  const t = useTranslations('panel.payouts.form');
  const tErrors = useTranslations('panel.payouts.errors');
  const announce = useApprovalsNotice();
  const format = useFormatter();
  const base = useId();
  const id = (key: string) => `${base}-${key}`;
  const current = initiative.pending;
  const [destination, setDestination] = useState<Destination>(current?.destinationType ?? (organizationAccount || !providerPayoutAvailable ? 'ORGANIZATION' : 'PROVIDER'));
  const [fields, setFields] = useState({ providerName: current?.destinationType === 'PROVIDER' ? current.beneficiaryName : '', providerTaxId: '', iban: '' });
  const [invoice, setInvoice] = useState<{ fileId: string; name: string } | null>(current?.invoice && current.invoiceValid ? { fileId: current.invoice.fileId, name: t('invoiceKept') } : null);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const { error, pending, run } = usePayoutAction();

  async function upload(file: File) {
    setErrors((previous) => ({ ...previous, invoice: undefined }));
    if (file.size > maxInvoiceBytes) {
      setErrors((previous) => ({ ...previous, invoice: tErrors('FILE_TOO_LARGE') }));
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.set('orgSlug', orgSlug);
      body.set('initiativeId', String(initiative.id));
      body.set('file', file);
      const response = await fetch('/api/panel/liquidaciones/factura', { method: 'POST', body });
      const result = (await response.json()) as { ok: boolean; fileId?: string; error?: string };
      if (result.ok && result.fileId) setInvoice({ fileId: result.fileId, name: file.name });
      else setErrors((previous) => ({ ...previous, invoice: tErrors.has(result.error ?? '') ? tErrors(result.error ?? 'failed') : tErrors('failed') }));
    } catch {
      setErrors((previous) => ({ ...previous, invoice: tErrors('failed') }));
    } finally {
      setUploading(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: Partial<Record<FieldKey, string>> = {};
    if (destination === 'PROVIDER') {
      const name = fields.providerName.trim();
      if (name.length < PROVIDER_NAME_MIN || name.length > PROVIDER_NAME_MAX) found.providerName = t('providerNameError', { min: PROVIDER_NAME_MIN, max: PROVIDER_NAME_MAX });
      if (fields.providerTaxId.trim().length < 8) found.providerTaxId = tErrors('INVALID_TAX_ID');
      if (!validateIban(fields.iban).valid) found.iban = tErrors('INVALID_IBAN');
    }
    if (!invoice && (initiative.invoiceRequired || destination === 'PROVIDER')) found.invoice = tErrors('INVOICE_REQUIRED');
    setErrors(found);
    const first = (['providerName', 'providerTaxId', 'iban', 'invoice'] as const).find((key) => found[key]);
    if (first) {
      document.getElementById(id(first))?.focus();
      return;
    }
    const payload =
      destination === 'PROVIDER'
        ? { destination, initiativeId: initiative.id, invoiceFileId: invoice?.fileId ?? '', providerName: fields.providerName, providerTaxId: fields.providerTaxId, iban: fields.iban }
        : { destination, initiativeId: initiative.id, invoiceFileId: invoice?.fileId ?? null };
    run(
      () => requestPayoutAction(orgSlug, payload),
      (result) =>
        announce(t(result.updated ? 'updated' : 'requested', { date: result.expiresAt ? format.dateTime(new Date(result.expiresAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' }) : '' }))
    );
  }

  // Sin cuenta de la entidad y sin pago al proveedor no hay adónde enviar el dinero: se dice qué pasa y no se deja enviar.
  const noDestination = !organizationAccount && !providerPayoutAvailable;
  const text = (key: Exclude<FieldKey, 'invoice'>, label: string, extra: { autoComplete?: string; iban?: boolean; help?: string } = {}) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id(key)} className="font-bold text-varsity-navy">
        {label}
      </label>
      {extra.help ? (
        <p id={id(`${key}-help`)} className="text-sm text-ink-soft">
          {extra.help}
        </p>
      ) : null}
      <input
        id={id(key)}
        value={fields[key]}
        onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
        autoComplete={extra.autoComplete ?? 'off'}
        aria-required="true"
        {...(extra.iban ? { autoCapitalize: 'characters', spellCheck: false, inputMode: 'text' as const } : {})}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={[extra.help ? id(`${key}-help`) : '', errors[key] ? id(`${key}-error`) : ''].filter(Boolean).join(' ') || undefined}
        className="min-h-11 rounded-xl border-2 border-varsity-navy/30 bg-white px-3 focus-visible:border-varsity-navy aria-invalid:border-red-700"
      />
      {errors[key] ? (
        <p id={id(`${key}-error`)} role="alert" className="text-sm font-semibold text-red-800">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );

  return (
    <form onSubmit={submit} noValidate aria-busy={pending || uploading} className="flex flex-col gap-4" data-testid={`payout-form-${initiative.id}`}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-bold text-varsity-navy">{t('destinationLegend')}</legend>
        <label className="flex min-h-11 items-start gap-2 rounded-xl border-2 border-varsity-navy/20 bg-white p-3 has-checked:border-varsity-navy has-disabled:opacity-60">
          <input type="radio" name={id('destination')} value="ORGANIZATION" checked={destination === 'ORGANIZATION'} disabled={!organizationAccount} onChange={() => setDestination('ORGANIZATION')} className="mt-1 size-5" />
          <span className="flex flex-col">
            <span className="font-semibold">{`🏫 ${t('toOrganization')}`}</span>
            <span className="text-sm text-ink-soft">{organizationAccount ? t('toOrganizationHelp') : t('toOrganizationMissing')}</span>
          </span>
        </label>
        {providerPayoutAvailable ? (
          <label className="flex min-h-11 items-start gap-2 rounded-xl border-2 border-varsity-navy/20 bg-white p-3 has-checked:border-varsity-navy">
            <input type="radio" name={id('destination')} value="PROVIDER" checked={destination === 'PROVIDER'} onChange={() => setDestination('PROVIDER')} className="mt-1 size-5" />
            <span className="flex flex-col">
              <span className="font-semibold">{`🏢 ${t('toProvider')}`}</span>
              <span className="text-sm text-ink-soft">{t('toProviderHelp')}</span>
              <span className="mt-1 self-start rounded-full bg-amber-100 px-2 text-xs font-extrabold text-amber-950">{t('providerSimulated')}</span>
            </span>
          </label>
        ) : null}
      </fieldset>

      {destination === 'PROVIDER' ? (
        <div className="mobile-stack grid gap-3 md:grid-cols-3">
          {text('providerName', t('providerName'), { autoComplete: 'organization' })}
          {text('providerTaxId', t('providerTaxId'))}
          {text('iban', t('iban'), { help: t('ibanHelp'), iban: true })}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={id('invoice')} className="font-bold text-varsity-navy">
          {initiative.invoiceRequired || destination === 'PROVIDER' ? t('invoiceLabel') : t('invoiceOptional')}
        </label>
        <p id={id('invoice-help')} className="text-sm text-ink-soft">
          {t('invoiceHelp', { size: Math.floor(maxInvoiceBytes / (1024 * 1024)) })}
        </p>
        <p role="status" className="text-sm font-semibold text-emerald-900" data-testid={invoice ? 'payout-invoice-ready' : undefined}>
          {invoice ? `📎 ${t('invoiceReady', { name: invoice.name })}` : null}
        </p>
        <input
          id={id('invoice')}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          aria-busy={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
          aria-invalid={errors.invoice ? true : undefined}
          aria-describedby={[id('invoice-help'), errors.invoice ? id('invoice-error') : ''].filter(Boolean).join(' ')}
          className="min-h-11 text-sm file:me-3 file:min-h-11 file:rounded-xl file:border-2 file:border-varsity-navy file:bg-white file:px-3 file:font-semibold"
        />
        {uploading ? (
          <p role="status" className="text-sm text-ink-soft">
            {t('uploading')}
          </p>
        ) : null}
        {errors.invoice ? (
          <p id={id('invoice-error')} role="alert" className="text-sm font-semibold text-red-800">
            {errors.invoice}
          </p>
        ) : null}
      </div>

      <p className="text-sm text-ink-soft">{current ? t('effectUpdate') : t('effect')}</p>
      {noDestination ? <FormAlert tone="info">{t('orgAccountMissing')}</FormAlert> : null}
      {error ? <FormAlert>{error}</FormAlert> : null}
      <button type="submit" disabled={pending || uploading || noDestination} className="tactile-btn self-start disabled:opacity-60">
        {pending ? t('sending') : `🛡️ ${t(current ? 'submitUpdate' : 'submit')}`}
      </button>
    </form>
  );
}
