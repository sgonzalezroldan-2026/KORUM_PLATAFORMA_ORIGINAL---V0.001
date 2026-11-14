import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { clientMessagesFor, type ClientZone } from '@/i18n/client-messages';

/**
 * Proveedor de textos del navegador para una zona privada (acceso, cuenta, panel con su portería, consola o galería de desarrollo): el raíz solo
 * envía las secciones de lo público, y aquí se amplía con las de esa zona y ninguna más (`src/i18n/client-messages.ts`). Componente de servidor.
 */
export async function PrivateIntlProvider({ zone, children }: { zone: ClientZone; children: ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={clientMessagesFor(zone, messages)}>{children}</NextIntlClientProvider>;
}
