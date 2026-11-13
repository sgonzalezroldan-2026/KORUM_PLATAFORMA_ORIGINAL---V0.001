'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { removeSecretAction, saveSecretAction } from '@/app/[locale]/(superadmin)/admin/ajustes/actions';
import { focusLater } from '@/components/admin/rules-action';
import { fieldI18nKey } from '@/core/admin/settings-model';
import type { SecretSummary } from '@/services/settings/settings.service';
import type { SecretKey } from '@/services/settings/setting-definitions';
import { FIELD, OUTLINE, PRIMARY, SettingsOutcome, useSettingsAction } from './settings-kit';

const WHEN = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' } as const;

/**
 * Una clave o contraseña del proveedor (`PlatformSecret`): **de solo escritura**. Nunca se muestra, ni entera ni a medias: solo si está guardada, de dónde sale (consola o variable
 * de respaldo del servidor), cuándo se cambió y, si es larga, los cuatro últimos caracteres para reconocerla. Escribir una nueva la sustituye (con Intro también); quitarla pide una
 * confirmación aparte (Escape la cancela y el foco empieza en «Cancelar»).
 */
export function SecretField({ secretKey, summary }: { secretKey: SecretKey; summary: SecretSummary | undefined }) {
  const t = useTranslations('admin.settings');
  const locale = useLocale();
  const id = `secret-${fieldI18nKey(secretKey)}`;
  const i18n = fieldI18nKey(secretKey);
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const save = useSettingsAction({ failureFocusId: id });
  const remove = useSettingsAction({ failureFocusId: `${id}-remove` });
  const inConsole = Boolean(summary?.configured && !summary.usesEnvFallback);

  const status = inConsole
    ? summary?.hint
      ? t('secretStatus.set', { hint: summary.hint, when: summary.updatedAt ? new Intl.DateTimeFormat(locale, WHEN).format(summary.updatedAt) : '' })
      : t('secretStatus.setNoHint', { when: summary?.updatedAt ? new Intl.DateTimeFormat(locale, WHEN).format(summary.updatedAt) : '' })
    : summary?.usesEnvFallback
      ? t('secretStatus.env')
      : t('secretStatus.none');

  const submit = () => {
    if (value.trim() === '') return;
    save.run(
      () => saveSecretAction({ key: secretKey, value }),
      () => t('secretSaved'),
      () => {
        setValue('');
        focusLater(id);
      }
    );
  };
  const cancel = () => {
    setConfirming(false);
    focusLater(`${id}-remove`);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy/15 p-3" data-testid={`secret-${secretKey}`}>
      <label htmlFor={id} className="font-semibold text-varsity-navy">
        {t(`secrets.${i18n}.label`)}
      </label>
      <p id={`${id}-status`} className="text-sm font-semibold text-ink" data-testid={`secret-status-${secretKey}`}>
        {status}
      </p>
      <p id={`${id}-help`} className="text-sm text-ink-soft">
        {t(`secrets.${i18n}.help`)}
      </p>
      <form
        noValidate
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={4096}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={inConsole ? t('secretReplacePlaceholder') : t('secretNewPlaceholder')}
          aria-describedby={`${id}-status ${id}-help`}
          className={`${FIELD} sm:flex-1`}
        />
        <button type="submit" aria-disabled={save.pending || value.trim() === ''} aria-busy={save.pending} className={PRIMARY} data-testid={`secret-save-${secretKey}`}>
          {save.pending ? t('saving') : t('secretSave')}
        </button>
      </form>
      <SettingsOutcome outcome={save.outcome} failed={save.failed} />
      {inConsole ? (
        confirming ? (
          <div
            role="group"
            aria-label={t('secretRemoveAria', { name: t(`secrets.${i18n}.label`) })}
            className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3"
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancel();
            }}
          >
            <p className="text-sm font-semibold text-amber-950">{t('secretRemoveConfirm')}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" id={`${id}-remove-cancel`} className={OUTLINE} onClick={cancel}>
                {t('cancel')}
              </button>
              <button
                type="button"
                id={`${id}-remove-yes`}
                aria-disabled={remove.pending}
                aria-busy={remove.pending}
                className={PRIMARY}
                data-testid={`secret-remove-yes-${secretKey}`}
                onClick={() =>
                  remove.run(
                    () => removeSecretAction({ key: secretKey }),
                    () => t('secretRemoved'),
                    () => {
                      setConfirming(false);
                      focusLater(id);
                    },
                    () => setConfirming(false)
                  )
                }
              >
                {t('secretRemoveYes')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            id={`${id}-remove`}
            className={`${OUTLINE} w-fit`}
            data-testid={`secret-remove-${secretKey}`}
            onClick={() => {
              setConfirming(true);
              focusLater(`${id}-remove-cancel`);
            }}
          >
            {t('secretRemove')}
          </button>
        )
      ) : null}
      <SettingsOutcome outcome={remove.outcome} failed={remove.failed} />
    </div>
  );
}
