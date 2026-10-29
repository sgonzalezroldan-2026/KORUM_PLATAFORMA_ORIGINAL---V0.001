import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import type { Locale } from '@/i18n/routing';

const MESSAGES = { es, ca, en };

/** Renderiza un componente con los catálogos reales de KORUM en el idioma indicado. */
export function renderWithIntl(ui: ReactElement, locale: Locale = 'es') {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      {ui}
    </NextIntlClientProvider>
  );
}
