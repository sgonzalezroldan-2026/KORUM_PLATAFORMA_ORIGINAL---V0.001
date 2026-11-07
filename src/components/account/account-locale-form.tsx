'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';
import { changeAccountLocaleAction } from '@/app/[locale]/(account)/mi-cuenta/actions';
import { FormAlert, fieldClass } from '@/components/auth/auth-ui';
import { useRouter } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';

/**
 * Idioma de la cuenta (Regla 03 §7): el de los emails (`User.locale`). Al guardarlo, la página pasa a ese idioma por URL (`/`, `/ca`, `/en`): la
 * URL sigue siendo la que decide lo que se ve, nunca una cookie.
 */
export function AccountLocaleForm({ current }: { current: Locale }) {
  const t = useTranslations('account.language');
  const names = useTranslations('languageSwitcher');
  const pageLocale = useLocale() as Locale;
  const router = useRouter();
  const selectId = useId();
  const [value, setValue] = useState<Locale>(current);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setSaved(false);
      setFailed(false);
      const result = await changeAccountLocaleAction({ locale: value });
      if (result.status !== 'SAVED') return setFailed(true);
      setSaved(true);
      if (value !== pageLocale) router.replace('/mi-cuenta#language', { locale: value });
    });

  return (
    <section id="language" aria-labelledby="language-title" className="korum-trust-vault flex scroll-mt-4 flex-col gap-4 p-5">
      <h2 id="language-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="text-ink-soft">{t('intro')}</p>
      <form
        className="mobile-stack grid gap-3 md:grid-cols-[minmax(0,20rem)_auto] md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="font-bold text-varsity-navy">
            {t('label')}
          </label>
          <select id={selectId} className={fieldClass} value={value} onChange={(event) => setValue(event.target.value as Locale)}>
            {routing.locales.map((locale) => (
              <option key={locale} value={locale} lang={locale}>
                {names(locale)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="tactile-btn justify-center" disabled={pending}>
          {t('save')}
        </button>
      </form>
      {saved ? <FormAlert tone="success">{t('saved')}</FormAlert> : null}
      {failed ? <FormAlert>{t('failed')}</FormAlert> : null}
    </section>
  );
}
