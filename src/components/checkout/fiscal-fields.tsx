'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { CheckoutDraft, CheckoutOffer } from './checkout-draft';
import { FieldError } from './checkout-fields';

export type FiscalError = 'taxId' | 'fields' | null;
/** Lo que guarda el navegador del certificado (nunca el NIF). También lo usa el alta de Mi Hucha. */
export type FiscalDraft = Pick<CheckoutDraft, 'wantsCertificate' | 'fullName' | 'provinceCode'>;

const inputClass = 'min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold text-ink aria-invalid:border-red-700';

/**
 * «Quiero mi certificado fiscal» (QA-F04 punto 4): **opcional** y solo si la entidad puede emitir certificado (Ley 49/2002 verificada). Pide lo
 * que necesita el Modelo 182: NIF, apellidos y nombre (en ese orden) y provincia. El NIF no se guarda en el navegador: lo cifra el servidor.
 */
export function FiscalFields({
  offer,
  draft,
  update,
  taxId,
  onTaxIdChange,
  error,
  askAgain
}: {
  offer: Pick<CheckoutOffer, 'certificate' | 'provinces'>;
  draft: FiscalDraft;
  update: (patch: Partial<FiscalDraft>) => void;
  taxId: string;
  onTaxIdChange: (value: string) => void;
  error: FiscalError;
  /** Se vuelve de un pago rechazado con el certificado pedido: el NIF hay que escribirlo otra vez. */
  askAgain: boolean;
}) {
  const t = useTranslations('portal.checkout.fiscal');
  const toggleId = useId();
  const hintId = useId();
  const taxIdId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const provinceId = useId();
  const errorId = useId();
  if (!offer.certificate) return null;

  return (
    <div className="space-y-3 rounded-2xl border border-patio-rule-strong bg-white p-3.5">
      <div className="flex items-start gap-3">
        <label htmlFor={toggleId} className="-mx-2.5 -my-2 flex size-11 shrink-0 cursor-pointer items-center justify-center">
        <input
          id={toggleId}
          type="checkbox"
          checked={draft.wantsCertificate}
          onChange={(event) => update({ wantsCertificate: event.target.checked })}
          aria-describedby={hintId}
          className="size-5 accent-varsity-navy"
        />
        </label>
        <div>
          <label htmlFor={toggleId} className="block cursor-pointer font-extrabold text-varsity-navy">
            <span aria-hidden="true">{'🧾 '}</span>
            {t('toggle')}
          </label>
          <p id={hintId} className="text-sm text-ink-soft">
            {t('hint')}
          </p>
        </div>
      </div>
      {draft.wantsCertificate ? (
        <div className="space-y-3">
          {askAgain && taxId === '' ? (
            <p role="status" className="rounded-lg bg-amber-50 p-2 text-sm font-bold text-amber-950">
              {t('retryNotice')}
            </p>
          ) : null}
          <div className="space-y-1">
            <label htmlFor={taxIdId} className="block text-sm font-bold text-varsity-navy">
              {t('taxId')}
            </label>
            <input
              id={taxIdId}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={taxId}
              onChange={(event) => onTaxIdChange(event.target.value)}
              aria-invalid={error === 'taxId' || undefined}
              aria-describedby={error === 'taxId' ? errorId : undefined}
              className={`${inputClass} font-mono uppercase`}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={nameId} className="block text-sm font-bold text-varsity-navy">
              {t('fullName')}
            </label>
            <input
              id={nameId}
              autoComplete="name"
              value={draft.fullName}
              onChange={(event) => update({ fullName: event.target.value })}
              aria-invalid={(error === 'fields' && draft.fullName.trim().length < 3) || undefined}
              aria-describedby={error === 'fields' ? `${nameHintId} ${errorId}` : nameHintId}
              className={inputClass}
            />
            <p id={nameHintId} className="text-sm text-ink-soft">
              {t('fullNameHint')}
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor={provinceId} className="block text-sm font-bold text-varsity-navy">
              {t('province')}
            </label>
            <select
              id={provinceId}
              value={draft.provinceCode}
              onChange={(event) => update({ provinceCode: event.target.value })}
              aria-invalid={(error === 'fields' && draft.provinceCode === '') || undefined}
              aria-describedby={error === 'fields' ? errorId : undefined}
              className={inputClass}
            >
              <option value="">{t('provincePlaceholder')}</option>
              {offer.provinces.map((province) => (
                <option key={province.code} value={province.code}>
                  {province.name}
                </option>
              ))}
            </select>
          </div>
          <FieldError id={errorId} message={error === 'taxId' ? t('taxIdError') : error === 'fields' ? t('fieldsError') : null} />
        </div>
      ) : null}
    </div>
  );
}
