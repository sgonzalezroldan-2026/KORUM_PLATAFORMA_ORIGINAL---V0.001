'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { saveParticipationGroupsAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/brand-actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { GROUP_LIMITS, groupIssues, type GroupIssue } from '@/core/panel/participation-groups-rules';
import type { ParticipationGroupCluster } from '@/types/korum.types';
import { useApprovalsNotice } from './approvals-notice';

interface DraftBlock {
  key: number;
  group: string;
  items: string;
}

const toDraft = (blocks: readonly ParticipationGroupCluster[]): DraftBlock[] =>
  blocks.map((block, index) => ({
    key: index,
    group: block.group,
    items: block.items.join('\n')
  }));
const toBlocks = (draft: readonly DraftBlock[]): ParticipationGroupCluster[] =>
  draft.map((block) => ({
    group: block.group.trim(),
    items: block.items
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }));

/**
 * Grupos de participación (Sprint 4.2e): los bloques (Infantil, Primaria, Categorías base…) con un grupo por línea. Lo que se guarda es lo que ven las
 * familias en el desplegable al aportar y en el reto por curso. Se puede volver a la plantilla oficial del vertical. Los errores se dicen en el bloque
 * que hay que corregir y el foco va a él.
 */
export function ParticipationGroupsForm({ orgSlug, blocks, template, canEdit }: { orgSlug: string; blocks: ParticipationGroupCluster[]; template: ParticipationGroupCluster[]; canEdit: boolean }) {
  const t = useTranslations('panel.settings.groups');
  const router = useRouter();
  const notify = useApprovalsNotice();
  const baseId = useId();
  const [draft, setDraft] = useState<DraftBlock[]>(() => toDraft(blocks));
  const [nextKey, setNextKey] = useState(blocks.length);
  // `2.group` o `2.items`: el nombre o la lista de grupos del bloque 3 que hay que corregir.
  const [invalid, setInvalid] = useState<string[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bloque cuyo nombre recibe el foco tras añadir o quitar uno (el botón pulsado puede desaparecer).
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (invalid.length > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalid]);

  useEffect(() => {
    if (focusKey !== null) document.getElementById(`${baseId}-name-${focusKey}`)?.focus();
  }, [focusKey, baseId]);

  const update = (key: number, change: Partial<DraftBlock>) => setDraft((current) => current.map((block) => (block.key === key ? { ...block, ...change } : block)));
  const describeIssue = (issue: GroupIssue) =>
    issue.code === 'DUPLICATE'
      ? t('errors.duplicate', { first: issue.names[0], second: issue.names[1] })
      : issue.code === 'EMPTY_SLUG'
        ? t('errors.emptySlug', { name: issue.name })
        : t('errors.tooMany', { max: GROUP_LIMITS.items, total: issue.total });

  function localCheck(next: ParticipationGroupCluster[]): { fields: string[]; messages: string[] } {
    const shape = next.flatMap((block, index) => [...(block.group === '' ? [`${index}.group`] : []), ...(block.items.length === 0 || block.items.length > GROUP_LIMITS.itemsPerBlock ? [`${index}.items`] : [])]);
    const issues = groupIssues(next);
    // Un nombre repetido o sin letras se señala en la lista del bloque donde está (el segundo, si se repite).
    const named = issues.flatMap((issue) => {
      const name = issue.code === 'DUPLICATE' ? issue.names[1] : issue.code === 'EMPTY_SLUG' ? issue.name : null;
      const index = name === null ? -1 : next.findIndex((block) => block.items.includes(name));
      return index >= 0 ? [`${index}.items`] : [];
    });
    return {
      fields: [...new Set([...shape, ...named])].sort(),
      messages: [...(shape.length > 0 ? [t('errors.blocks', { max: GROUP_LIMITS.itemsPerBlock })] : []), ...issues.map(describeIssue)]
    };
  }

  async function submit() {
    const next = toBlocks(draft);
    const local = localCheck(next);
    if (local.messages.length > 0) {
      setInvalid(local.fields);
      setMessages(local.messages);
      return;
    }
    setBusy(true);
    setInvalid([]);
    setMessages([]);
    setInfo(null);
    try {
      const result = await saveParticipationGroupsAction(orgSlug, {
        blocks: next
      });
      if (result.status === 'OK') {
        notify(t('saved'));
        router.refresh();
      } else if (result.reason === 'INVALID') {
        // `blocks.2.items` → `2.items`.
        setInvalid([...new Set((result.fields ?? []).map((field) => field.split('.').slice(1, 3).join('.')).filter((field) => /^\d+\.(group|items)$/.test(field)))]);
        setMessages([t('errors.form'), ...(result.issues ?? []).map(describeIssue)]);
      } else setMessages([t(result.reason === 'FORBIDDEN' ? 'errors.FORBIDDEN' : 'errors.generic')]);
    } catch {
      setMessages([t('errors.generic')]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {draft.map((block, index) => {
          const nameId = `${baseId}-name-${block.key}`;
          const itemsId = `${baseId}-items-${block.key}`;
          const hintId = `${baseId}-hint-${block.key}`;
          const nameErrorId = `${baseId}-name-error-${block.key}`;
          const itemsErrorId = `${baseId}-items-error-${block.key}`;
          const badName = invalid.includes(`${index}.group`);
          const badItems = invalid.includes(`${index}.items`);
          return (
            <li key={block.key} className="korum-notebook-sheet flex flex-col gap-2 rounded-2xl border-2 border-patio-rule-strong p-4" data-testid="group-block">
              <label htmlFor={nameId} className="text-sm font-bold text-varsity-navy">
                {t('blockName', { n: index + 1 })}
              </label>
              <input
                id={nameId}
                value={block.group}
                maxLength={GROUP_LIMITS.blockName}
                readOnly={!canEdit}
                aria-invalid={badName ? true : undefined}
                aria-describedby={badName ? nameErrorId : undefined}
                onChange={(event) => update(block.key, { group: event.target.value })}
                className="min-h-11 w-full rounded-xl border-2 border-varsity-navy bg-white px-3 font-semibold aria-invalid:border-red-700"
              />
              {badName ? (
                <p id={nameErrorId} className="text-sm font-semibold text-red-800">
                  {t('errors.blockName', { n: index + 1 })}
                </p>
              ) : null}
              <label htmlFor={itemsId} className="text-sm font-bold text-varsity-navy">
                {t('items')}
              </label>
              <textarea
                id={itemsId}
                value={block.items}
                rows={Math.min(8, Math.max(3, block.items.split('\n').length + 1))}
                readOnly={!canEdit}
                aria-describedby={badItems ? `${hintId} ${itemsErrorId}` : hintId}
                aria-invalid={badItems ? true : undefined}
                onChange={(event) => update(block.key, { items: event.target.value })}
                className="w-full rounded-xl border-2 border-varsity-navy bg-white px-3 py-2 aria-invalid:border-red-700"
              />
              <p id={hintId} className="text-sm text-ink-soft">
                {t('itemsHint', { max: GROUP_LIMITS.itemsPerBlock })}
              </p>
              {badItems ? (
                <p id={itemsErrorId} className="text-sm font-semibold text-red-800">
                  {t('errors.blockItems', { n: index + 1, max: GROUP_LIMITS.itemsPerBlock })}
                </p>
              ) : null}
              {canEdit && draft.length > 1 ? (
                <button
                  type="button"
                  onClick={() => {
                    setDraft((current) => current.filter((other) => other.key !== block.key));
                    setInvalid([]);
                    setFocusKey((draft[index - 1] ?? draft[index + 1])?.key ?? null);
                  }}
                  className="min-h-11 self-start font-semibold text-red-800 underline underline-offset-4"
                >
                  {t('removeBlock', { n: index + 1 })}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-ink-soft">{t('renameNote')}</p>
      {info ? <FormAlert tone="info">{info}</FormAlert> : null}
      {messages.length > 0 ? (
        <FormAlert>
          {messages.map((message) => (
            <span key={message} className="block">
              {message}
            </span>
          ))}
        </FormAlert>
      ) : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} aria-busy={busy} className="tactile-btn disabled:opacity-60">
            {t('save')}
          </button>
          {draft.length < GROUP_LIMITS.blocks ? (
            <button
              type="button"
              onClick={() => {
                setDraft((current) => [...current, { key: nextKey, group: '', items: '' }]);
                setFocusKey(nextKey);
                setNextKey((key) => key + 1);
              }}
              className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy bg-white px-4 font-bold text-varsity-navy"
            >
              {t('addBlock')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setDraft(
                toDraft(template).map((block) => ({
                  ...block,
                  key: nextKey + block.key
                }))
              );
              setNextKey((key) => key + template.length);
              setInvalid([]);
              setMessages([]);
              setInfo(t('templateLoaded'));
            }}
            className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy/40 bg-white px-4 font-bold text-varsity-navy"
          >
            {t('useTemplate')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
