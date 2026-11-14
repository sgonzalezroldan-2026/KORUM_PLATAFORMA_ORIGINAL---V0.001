import { revalidatePath } from 'next/cache';
import { routing } from '@/i18n/routing';
import type { KorumPrismaClient } from '@/lib/prisma';
import { achievementsPath, sponsorsPath } from '@/lib/seo/portal-routes';

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

/**
 * Vuelve a generar «Logros conseguidos» y la portada de una entidad tras un cambio que se ve en ellas: una foto del Antes o del Después, el agradecimiento, o
 * una campaña que se cierra al liquidarse (Sprint 5.6). Estas páginas se regeneran cada 60 s, pero solo cuando alguien las visita, y esa primera visita
 * recibe la versión anterior: quien acababa de subir las fotos pulsaba «Ver cómo lo ven las familias» y veía la página sin ellas.
 */
export function revalidateAchievements(orgSlug: string): void {
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/${orgSlug}`);
    revalidatePath(`/${locale}${achievementsPath(orgSlug)}`);
  }
}

/** Tras enviar la liquidación de una campaña (queda cerrada y su logro pasa a ser visible para las familias): vuelve a generar el portal de su entidad. */
export async function revalidatePortalAfterPayout(db: KorumPrismaClient, payoutId: number): Promise<void> {
  const payout = await db.escrowPayout.findUnique({ where: { id: payoutId }, select: { organization: { select: { slug: true } } } });
  if (payout) revalidateAchievements(payout.organization.slug);
}
