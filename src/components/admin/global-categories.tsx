'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { addGlobalCategoryAction, setGlobalCategoryRuleAction } from '@/app/[locale]/(superadmin)/admin/reglas/actions';
import { FIELD, OUTLINE, PRIMARY } from './entity-action';
import { focusLater, RulesOutcome, useRulesAction } from './rules-action';

export interface GlobalCategoryView {
  name: string;
  icon: string;
  rule: 'EXEMPT' | 'BRACKETS';
}

/**
 * Gestor de categorías globales (prototipo `sa-categories-list` y `addNewSuperAdminCategory`): cada categoría es exenta (0 %) o va por tramos, y se pueden añadir
 * nuevas. **Solo afecta a las campañas que se calculen desde ahora**; una categoría propia de una entidad con el mismo nombre sigue mandando sobre la global. Las
 * campañas al 0 % se revisan más abajo.
 */
export function GlobalCategories({ categories }: { categories: GlobalCategoryView[] }) {
  const t = useTranslations('admin.rules.categories');
  const id = useId();
  const rule = useRulesAction({ successFocusId: null, failureFocusId: 'global-category-confirm-yes' });
  const add = useRulesAction({ successFocusId: null });
  // Crear una categoría ya exenta cambia lo que cobra la plataforma igual que pasar una existente a exenta: también se confirma.
  const [confirmingAdd, setConfirmingAdd] = useState(false);
  const confirmAddTitle = useRef<HTMLParagraphElement>(null);
  const addHintId = useId();
  const [name, setName] = useState('');
  const [newRule, setNewRule] = useState<'EXEMPT' | 'BRACKETS'>('BRACKETS');
  // Cambiar la regla de una categoría cambia lo que cobra la plataforma en campañas nuevas: se pide confirmar antes de guardar (como en la ficha de la entidad).
  const [pendingRule, setPendingRule] = useState<{ name: string; rule: 'EXEMPT' | 'BRACKETS' } | null>(null);
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const selectors = useRef<Map<string, HTMLSelectElement>>(new Map());
  // El selector puede seguir deshabilitado mientras termina la acción: el foco se devuelve cuando ya no hay nada pendiente.
  const refocus = useRef<string | null>(null);
  const closeConfirmation = (categoryName: string) => {
    refocus.current = categoryName;
    setPendingRule(null);
  };
  useEffect(() => {
    if (refocus.current === null || rule.pending || pendingRule !== null) return;
    selectors.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [rule.pending, pendingRule]);
  const nameInvalid = add.outcome?.status === 'REJECTED' && add.outcome.fields.includes('name');

  const create = () => {
    setConfirmingAdd(false);
    add.run(
      () => addGlobalCategoryAction({ category: { name, rule: newRule } }),
      () => t('added', { name: name.trim() }),
      () => setName('')
    );
    focusLater(`${id}-name`);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (newRule === 'EXEMPT') {
      setConfirmingAdd(true);
      requestAnimationFrame(() => confirmAddTitle.current?.focus());
      return;
    }
    create();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="global-categories">
      <ul className="flex flex-col gap-2">
        {categories.map((category, index) => (
          <li key={category.name} className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy/15 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
            <span id={`${id}-${index}`} className="font-bold">
              <span aria-hidden="true">{`${category.icon} `}</span>
              {category.name}
            </span>
            <select
              aria-labelledby={`${id}-${index}`}
              value={category.rule}
              ref={(node) => {
                if (node) selectors.current.set(category.name, node);
                else selectors.current.delete(category.name);
              }}
              disabled={rule.pending || pendingRule !== null}
              onChange={(event) => {
                setPendingRule({ name: category.name, rule: event.target.value === 'EXEMPT' ? 'EXEMPT' : 'BRACKETS' });
                requestAnimationFrame(() => confirmTitle.current?.focus());
              }}
              className={`${FIELD} sm:w-72`}
              data-testid={`category-rule-${index}`}
            >
              <option value="EXEMPT">{t('ruleEXEMPT')}</option>
              <option value="BRACKETS">{t('ruleBRACKETS')}</option>
            </select>
          </li>
        ))}
      </ul>
      {pendingRule ? (
        <div
          role="group"
          aria-label={t('confirmTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !rule.pending) closeConfirmation(pendingRule.name);
          }}
          className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3"
          data-testid="global-category-confirm"
        >
          <p ref={confirmTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
            {t('confirmTitle')}
          </p>
          <p>{t(pendingRule.rule === 'EXEMPT' ? 'confirmExempt' : 'confirmBrackets', { name: pendingRule.name })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={rule.pending}
              className={PRIMARY}
              id="global-category-confirm-yes"
              data-testid="global-category-confirm-yes"
              onClick={() => {
                const change = pendingRule;
                rule.run(
                  () => setGlobalCategoryRuleAction({ category: { name: change.name, rule: change.rule } }),
                  () => t('ruleSaved', { name: change.name }),
                  () => closeConfirmation(change.name)
                );
              }}
            >
              {t('confirmYes')}
            </button>
            <button type="button" disabled={rule.pending} className={OUTLINE} onClick={() => closeConfirmation(pendingRule.name)}>
              {t('confirmNo')}
            </button>
          </div>
        </div>
      ) : null}
      <RulesOutcome outcome={rule.outcome} failed={rule.failed} />
      <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border-2 border-dashed border-varsity-navy/30 p-3">
        <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('addTitle')}</h3>
        <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-name`} className="text-sm font-semibold text-ink-soft">
              {t('newName')}
            </label>
            <input
              id={`${id}-name`}
              type="text"
              value={name}
              maxLength={60}
              disabled={confirmingAdd}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? `${id}-name-error` : undefined}
              className={FIELD}
              autoComplete="off"
              data-testid="category-new-name"
            />
            {nameInvalid ? (
              <p id={`${id}-name-error`} role="alert" className="text-sm font-semibold text-red-900">
                {t('nameError')}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-rule`} className="text-sm font-semibold text-ink-soft">
              {t('newRule')}
            </label>
            <select id={`${id}-rule`} value={newRule} disabled={confirmingAdd} onChange={(event) => setNewRule(event.target.value === 'EXEMPT' ? 'EXEMPT' : 'BRACKETS')} className={FIELD}>
              <option value="BRACKETS">{t('ruleBRACKETS')}</option>
              <option value="EXEMPT">{t('ruleEXEMPT')}</option>
            </select>
          </div>
        </div>
        <p id={addHintId} className="text-sm text-ink-soft">
          {t('addHint')}
        </p>
        {confirmingAdd ? (
          <div
            role="group"
            aria-label={t('confirmAddTitle')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setConfirmingAdd(false);
                focusLater(`${id}-name`);
              }
            }}
            className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3"
            data-testid="category-add-confirm"
          >
            <p ref={confirmAddTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
              {t('confirmAddTitle')}
            </p>
            <p>{t('confirmAddExempt', { name: name.trim() })}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY} onClick={create} data-testid="category-add-confirm-yes">
                {t('confirmAddYes')}
              </button>
              <button
                type="button"
                className={OUTLINE}
                onClick={() => {
                  setConfirmingAdd(false);
                  focusLater(`${id}-name`);
                }}
              >
                {t('confirmAddNo')}
              </button>
            </div>
          </div>
        ) : null}
        <button type="submit" disabled={add.pending || confirmingAdd || name.trim().length < 2} aria-describedby={addHintId} className={`${PRIMARY} self-start`} data-testid="category-add">
          {add.pending ? t('adding') : t('add')}
        </button>
        {add.outcome?.status === 'REJECTED' && nameInvalid ? null : <RulesOutcome outcome={add.outcome} failed={add.failed} />}
      </form>
    </div>
  );
}
