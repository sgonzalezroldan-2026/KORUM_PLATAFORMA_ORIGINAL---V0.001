import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { routing } from '@/i18n/routing';
import { INITIATIVE_ID_PATTERN } from '@/lib/seo/portal-routes';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { loadInitiativePage } from '@/services/portal/portal-data';

/**
 * Comprueba que la iniciativa existe y es pública **antes** de que `loading.tsx` empiece a enviar la página: un `notFound()` dentro de la página
 * llegaría tarde, con el código `200` ya enviado, y los buscadores lo tomarían por una página válida (skill de interfaz §5). Una iniciativa de
 * otra entidad responde igual que una inexistente. La página reutiliza esta misma lectura (`cache()`).
 */
export default async function InitiativeLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string; orgSlug: string; id: string }> }) {
  const { locale, orgSlug, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  if (!INITIATIVE_ID_PATTERN.test(id)) notFound();
  try {
    await loadInitiativePage(orgSlug, Number(id), locale, '');
  } catch (error) {
    if (error instanceof ResourceNotFoundError) notFound();
    throw error;
  }
  return children;
}
