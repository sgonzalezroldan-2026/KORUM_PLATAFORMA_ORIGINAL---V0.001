import { revalidatePath } from 'next/cache';
import { routing } from '@/i18n/routing';
import { sponsorsPath } from '@/lib/seo/portal-routes';

/**
 * Vuelve a generar las páginas del portal de una entidad que enseñan sus comercios amigos, en todos sus idiomas, tras un cambio que se ve en ellas
 * (Sprint 4.2b): un comercio aprobado, no admitido o con logotipo nuevo, o una bolsa Matching 2x que se activa (la portada destaca las campañas con
 * bolsa). Sin esto, esas páginas (regeneradas cada 60 s) lo enseñarían un minuto tarde. Se pasan las direcciones concretas tal como las sirve la ruta
 * `/[locale]/...` (el castellano va sin prefijo solo en la barra de direcciones): `revalidatePath` con `'layout'` espera un patrón, no una dirección.
 */
export function revalidatePortal(orgSlug: string): void {
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/${orgSlug}`);
    revalidatePath(`/${locale}${sponsorsPath(orgSlug)}`);
  }
}
