'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { saveSponsorRenewalRuleAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { SPONSOR_RENEWAL_RULES, type SponsorRenewalRule } from '@/core/sponsors/sponsor-reassignment-rules';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Regla de la entidad para el dinero de los comercios (`id="sch-sponsor-renewal-rule"`, `function saveSponsorRenewalRule` del prototipo): a dónde va
 * una renovación anual y el patrocinio de una campaña que no sale. Las dos personas firmantes la cambian; el Super-Admin la ve sin poder tocarla.
 */
export function SponsorRenewalRuleForm({ orgSlug, rule, canEdit, maxDays }: { orgSlug: string; rule: SponsorRenewalRule; canEdit: boolean; maxDays: number }) {
  const t = useTranslations('panel.sponsors.rule');
  const tErrors = useTranslations('panel.approvals.errors');
  const router = useRouter();
  const announce = useApprovalsNotice();
  const ids = { select: useId(), help: useId() };
  const [value, setValue] = useState<SponsorRenewalRule>(rule);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveSponsorRenewalRuleAction(orgSlug, { rule: value });
        if (result.status === 'ERROR') setError(tErrors(result.reason));
        else {
          announce(result.placed ? t('savedPlaced', { count: result.placed }) : t('saved', { rule: t(`options.${value}`) }));
          router.refresh();
        }
      } catch {
        setError(tErrors('failed'));
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-2xl border-2 border-amber-300 bg-amber-50/60 p-4" data-testid="sponsor-renewal-rule">
      <label htmlFor={ids.select} className="font-corp font-extrabold text-varsity-navy">
        <span aria-hidden="true">{'🔄 '}</span>
        {t('label')}
      </label>
      <p id={ids.help} className="text-sm text-ink-soft">
        {t('help', { days: maxDays })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={ids.select}
          value={value}
          onChange={(event) => setValue(event.target.value as SponsorRenewalRule)}
          disabled={!canEdit || pending}
          aria-describedby={ids.help}
          className="min-h-11 max-w-full rounded-xl border-2 border-varsity-navy bg-white px-3 font-bold text-varsity-navy disabled:opacity-70"
        >
          {SPONSOR_RENEWAL_RULES.map((option) => (
            <option key={option} value={option}>
              {t(`options.${option}`)}
            </option>
          ))}
        </select>
        {canEdit ? (
          <button type="submit" disabled={pending || value === rule} className="tactile-btn disabled:opacity-60">
            {pending ? t('saving') : t('save')}
          </button>
        ) : null}
      </div>
      {canEdit ? null : <p className="text-sm text-ink-soft">{t('readOnly')}</p>}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </form>
  );
}
