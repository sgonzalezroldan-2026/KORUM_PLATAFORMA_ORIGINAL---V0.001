'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { submitKybAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { canEditKyb } from '@/core/panel/entity-settings-rules';
import type { EntitySettingsData } from '@/services/panel/entity-settings-data';
import { useApprovalsNotice } from './approvals-notice';
import { KybDocumentRow } from './kyb-document-row';
import { KybIdentityForm } from './kyb-identity-form';

const STATUS_TONE = {
  PENDING: 'border-amber-300 bg-amber-50 text-amber-950',
  SUBMITTED: 'border-varsity-navy/30 bg-varsity-ivory text-varsity-navy',
  VERIFIED: 'border-varsity-emerald bg-emerald-50 text-emerald-950',
  REJECTED: 'border-red-700 bg-red-50 text-red-900'
} as const;
const STATUS_ICON = { PENDING: '⏳', SUBMITTED: '🔎', VERIFIED: '✅', REJECTED: '✏️' } as const;

/**
 * Documentos del titular (Sprint 4.2c, en lugar del bloque «Cuenta bancaria / IBAN» del prototipo, Regla 03 §4): estado en texto, la nota de KORUM
 * si los devolvió, los datos del titular, cada documento y el envío a revisión, que solo se ofrece con todo entregado (si falta algo, se dice qué).
 * Los avisos de éxito van al aviso común de la sección, que recibe el foco.
 */
export function KybSection({ orgSlug, kyb, canEdit, maxBytes, legalFormLabel }: { orgSlug: string; kyb: EntitySettingsData['kyb']; canEdit: boolean; maxBytes: number; legalFormLabel: string }) {
  const t = useTranslations('panel.settings.kyb');
  const format = useFormatter();
  const router = useRouter();
  const notify = useApprovalsNotice();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = canEdit && canEditKyb(kyb.status);
  const date = kyb.submittedAt ? format.dateTime(new Date(kyb.submittedAt), { dateStyle: 'long', timeZone: 'Europe/Madrid' }) : '';
  const missing = [...kyb.readiness.missing.map((kind) => t(`documents.kinds.${kind}.title`)), ...(kyb.readiness.missingTaxId ? [t('submit.missingCif')] : [])];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await submitKybAction(orgSlug);
      if (result.status === 'OK') {
        notify(t('submit.sent'));
        router.refresh();
      } else setError(t(`submit.errors.${result.reason === 'INCOMPLETE' || result.reason === 'LOCKED' || result.reason === 'FORBIDDEN' ? result.reason : 'generic'}`));
    } catch {
      setError(t('submit.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className={`flex flex-col gap-1 rounded-2xl border-2 p-4 ${STATUS_TONE[kyb.status]}`} data-testid="kyb-status">
        <p className="font-corp font-extrabold">
          <span aria-hidden="true">{`${STATUS_ICON[kyb.status]} `}</span>
          {t(`status.${kyb.status}`, { date })}
        </p>
        {kyb.status === 'SUBMITTED' || kyb.status === 'VERIFIED' ? <p className="text-sm">{t(`locked.${kyb.status}`)}</p> : null}
      </div>

      {kyb.reviewNote ? (
        <div className="korum-trust-vault flex flex-col gap-1 p-4">
          <p className="font-corp font-extrabold text-varsity-navy">{t('reviewNote')}</p>
          <p className="whitespace-pre-line text-ink">{kyb.reviewNote}</p>
        </div>
      ) : null}

      <section aria-labelledby="kyb-identity-title" className="korum-trust-vault flex min-w-0 flex-col gap-3 p-4">
        <h3 id="kyb-identity-title" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('identity.legend')}
        </h3>
        <ul className="flex flex-col gap-1 text-sm text-ink-soft">
          <li>{t('identity.legalForm', { form: legalFormLabel })}</li>
          <li>{kyb.ley49Verified ? t('identity.ley49Verified') : kyb.ley49 ? t('identity.ley49Declared') : t('identity.ley49No')}</li>
        </ul>
        {editable ? <p className="text-sm font-semibold text-varsity-navy">{t('identity.required')}</p> : null}
        {editable ? (
          <KybIdentityForm orgSlug={orgSlug} legalName={kyb.legalName} cif={kyb.cif} onSaved={notify} />
        ) : (
          <dl className="mobile-stack grid gap-3 md:grid-cols-2">
            <div>
              <dt className="text-sm font-bold text-varsity-navy">{t('identity.legalName')}</dt>
              <dd className="font-semibold">{kyb.legalName}</dd>
            </div>
            <div>
              <dt className="text-sm font-bold text-varsity-navy">{t('identity.cif')}</dt>
              <dd className="font-corp font-extrabold tabular-nums">{kyb.cif ?? t('identity.cifMissing')}</dd>
            </div>
          </dl>
        )}
      </section>

      <section aria-labelledby="kyb-documents-title" className="flex flex-col gap-3">
        <h3 id="kyb-documents-title" className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('documents.legend')}
        </h3>
        <ul className="mobile-stack grid gap-3 md:grid-cols-2">
          {kyb.required.map((kind) => (
            <KybDocumentRow key={kind} orgSlug={orgSlug} kind={kind} document={kyb.documents.find((document) => document.kind === kind) ?? null} canEdit={editable} maxBytes={maxBytes} />
          ))}
        </ul>
        {kyb.replacedCount > 0 ? <p className="text-sm text-ink-soft">{t('documents.replaced', { count: kyb.replacedCount })}</p> : null}
      </section>

      {editable ? (
        <div className="flex flex-col gap-3 border-t-2 border-varsity-navy/10 pt-4" data-testid="kyb-submit">
          {kyb.readiness.ready ? (
            <p className="font-semibold text-emerald-900">{t('submit.ready')}</p>
          ) : (
            <div className="text-sm text-ink">
              <p className="font-bold">{t('submit.missingTitle')}</p>
              <ul className="list-disc ps-6">
                {missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {error ? <FormAlert>{error}</FormAlert> : null}
          {kyb.readiness.ready ? (
            <button type="button" onClick={() => void submit()} disabled={busy} aria-busy={busy} className="tactile-btn self-start disabled:opacity-60">
              <span aria-hidden="true">{'📨 '}</span>
              {busy ? t('submit.sending') : t('submit.button')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
