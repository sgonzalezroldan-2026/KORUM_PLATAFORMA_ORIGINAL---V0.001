'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { saveKybIdentityAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/actions';
import { Field, FormAlert } from '@/components/auth/auth-ui';
import { kybIdentitySchema } from '@/core/panel/entity-settings-rules';

/**
 * Razón social y CIF del titular (Sprint 4.2c; en el prototipo, «Titular legal» y «CIF de la entidad» del bloque KYB). El CIF se comprueba en el
 * navegador al guardar (con su dígito de control) y el servidor lo vuelve a comprobar; un error se dice junto a su campo y recibe el foco.
 */
export function KybIdentityForm({ orgSlug, legalName, cif, onSaved }: { orgSlug: string; legalName: string; cif: string | null; onSaved: (message: string) => void }) {
  const t = useTranslations('panel.settings.kyb.identity');
  const router = useRouter();
  const [values, setValues] = useState({ legalName, cif: cif ?? '' });
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Con errores de campo, el foco va al primero marcado: su mensaje está asociado al campo y se lee al llegar.
  useEffect(() => {
    if (fieldErrors.length > 0) formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [fieldErrors]);

  async function submit() {
    const parsed = kybIdentitySchema.safeParse(values);
    if (!parsed.success) {
      setFieldErrors([...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]);
      setFormError(null);
      return;
    }
    setBusy(true);
    setFieldErrors([]);
    setFormError(null);
    try {
      const result = await saveKybIdentityAction(orgSlug, values);
      if (result.status === 'OK') {
        onSaved(t('saved'));
        router.refresh();
      } else if (result.reason === 'INVALID') setFieldErrors(result.fields ?? []);
      else if (result.reason === 'CIF_IN_USE') setFieldErrors(['cif-in-use']);
      else setFormError(t(`errors.${result.reason === 'LOCKED' || result.reason === 'FORBIDDEN' ? result.reason : 'generic'}`));
    } catch {
      setFormError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  const cifError = fieldErrors.includes('cif-in-use') ? t('errors.CIF_IN_USE') : fieldErrors.includes('cif') ? t('errors.cif') : null;
  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mobile-stack grid gap-4 md:grid-cols-2"
      noValidate
    >
      <Field
        label={t('legalName')}
        hint={t('legalNameHint')}
        error={fieldErrors.includes('legalName') ? t('errors.legalName') : null}
        name="legalName"
        autoComplete="organization"
        maxLength={120}
        required
        value={values.legalName}
        onChange={(event) => setValues((current) => ({ ...current, legalName: event.target.value }))}
      />
      <Field
        label={t('cif')}
        hint={t('cifHint')}
        error={cifError}
        name="cif"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={20}
        required
        className="min-h-12 w-full rounded-xl border-2 border-varsity-navy bg-white px-4 font-corp text-base uppercase tabular-nums text-ink aria-[invalid=true]:border-red-700"
        value={values.cif}
        onChange={(event) => setValues((current) => ({ ...current, cif: event.target.value }))}
      />
      {formError ? (
        <div className="md:col-span-2">
          <FormAlert>{formError}</FormAlert>
        </div>
      ) : null}
      <button type="submit" disabled={busy} aria-busy={busy} className="inline-flex min-h-11 items-center justify-self-start rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy disabled:opacity-60 md:col-span-2">
        {busy ? t('saving') : t('save')}
      </button>
    </form>
  );
}
