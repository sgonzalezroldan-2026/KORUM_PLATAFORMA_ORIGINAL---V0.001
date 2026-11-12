'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { addCategoryAction, setCategoryRuleAction } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import type { Org360View } from '@/services/admin/org-360-data';
import { ActionOutcome, FIELD, OUTLINE, PRIMARY, useEntityAction } from './entity-action';

/**
 * Categorías de la entidad (exentas al 0 % o por tramos): las globales de la plataforma con la regla que esta entidad les da y las propias que ha creado.
 * Una global «sobrescrita» por la entidad lleva su propia fila (el Estudio da prioridad a la de la entidad). Cambia lo que se cobra en campañas **nuevas**.
 */
export function OrgCategories({ organizationId, categories }: { organizationId: string; categories: Org360View['categories'] }) {
  const t = useTranslations('admin.org360.categories');
  const action = useEntityAction();
  const nameId = useId();
  const ruleId = useId();
  const [name, setName] = useState('');
  const [rule, setRule] = useState<'EXEMPT' | 'BRACKETS'>('EXEMPT');
  // Cambiar la regla de una categoría cambia lo que se cobra en las campañas nuevas: se pide confirmar antes de guardar.
  const [pendingRule, setPendingRule] = useState<{ name: string; rule: 'EXEMPT' | 'BRACKETS' } | null>(null);
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const selectors = useRef<Map<string, HTMLSelectElement>>(new Map());
  const closeConfirmation = (name: string) => {
    setPendingRule(null);
    requestAnimationFrame(() => selectors.current.get(name)?.focus());
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pe-1" data-testid="categories-list">
        {categories.map((category, index) => {
          // Un identificador sin espacios: `aria-labelledby` separa por espacios y el nombre de una categoría los lleva.
          const id = `${nameId}-category-${index}`;
          return (
            <li key={category.name} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-patio-rule bg-patio-soft p-2" data-category={category.name}>
              <span id={id} className="font-bold">
                <span aria-hidden="true">{`${category.icon} `}</span>
                {category.name}
                {category.source !== 'GLOBAL' ? <span className="ms-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-bold text-sky-900">{t(`source.${category.source}`)}</span> : null}
              </span>
              <select
                ref={(node) => {
                  if (node) selectors.current.set(category.name, node);
                  else selectors.current.delete(category.name);
                }}
                aria-labelledby={id}
                value={category.rule}
                disabled={action.pending || pendingRule !== null}
                onChange={(event) => {
                  setPendingRule({ name: category.name, rule: event.target.value === 'EXEMPT' ? 'EXEMPT' : 'BRACKETS' });
                  requestAnimationFrame(() => confirmTitle.current?.focus());
                }}
                className={`min-h-11 rounded-lg border-2 px-2 text-sm font-bold ${category.rule === 'EXEMPT' ? 'border-emerald-400 bg-emerald-100 text-emerald-950' : 'border-amber-400 bg-amber-100 text-amber-950'}`}
              >
                <option value="EXEMPT">{t('rule.EXEMPT')}</option>
                <option value="BRACKETS">{t('rule.BRACKETS')}</option>
              </select>
            </li>
          );
        })}
      </ul>
      {pendingRule ? (
        <div
          role="group"
          aria-label={t('confirmTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !action.pending) closeConfirmation(pendingRule.name);
          }}
          className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3"
          data-testid="category-rule-confirm"
        >
          <p ref={confirmTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
            {t('confirmTitle')}
          </p>
          <p>{t('confirmText', { name: pendingRule.name, rule: t(`rule.${pendingRule.rule}`) })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={action.pending}
              className={PRIMARY}
              data-testid="category-rule-confirm-yes"
              onClick={() => {
                const change = pendingRule;
                action.run(() => setCategoryRuleAction({ organizationId, category: { name: change.name, rule: change.rule } }), t('doneRule'), () => closeConfirmation(change.name));
              }}
            >
              {t('confirmYes')}
            </button>
            <button type="button" disabled={action.pending} className={OUTLINE} onClick={() => closeConfirmation(pendingRule.name)}>
              {t('confirmNo')}
            </button>
          </div>
        </div>
      ) : null}
      <form
        className="grid gap-2 md:grid-cols-[1fr_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(() => addCategoryAction({ organizationId, category: { name, rule } }), t('doneAdd'), () => setName(''));
        }}
      >
        <label htmlFor={`${nameId}-new`} className="sr-only">
          {t('newName')}
        </label>
        <input id={`${nameId}-new`} type="text" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder={t('newName')} className={FIELD} autoComplete="off" data-testid="category-name" />
        <label htmlFor={ruleId} className="sr-only">
          {t('newRule')}
        </label>
        <select id={ruleId} value={rule} onChange={(event) => setRule(event.target.value as 'EXEMPT' | 'BRACKETS')} className={FIELD}>
          <option value="EXEMPT">{t('rule.EXEMPT')}</option>
          <option value="BRACKETS">{t('rule.BRACKETS')}</option>
        </select>
        <button type="submit" disabled={action.pending || name.trim().length < 2} className={PRIMARY} data-testid="category-add">
          {t('add')}
        </button>
      </form>
      <ActionOutcome outcome={action.outcome} failed={action.failed} />
    </div>
  );
}
