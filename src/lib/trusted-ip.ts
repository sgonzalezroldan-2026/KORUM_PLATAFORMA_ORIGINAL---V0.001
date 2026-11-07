import { isIP } from 'node:net';

/**
 * IP de la persona según el proxy de confianza (heredado del Sprint 2.2). La regla padre/madre y la ráfaga agrupan por subred: si el proxy
 * no pasa la IP (o una cabecera la falsea), todas las familias caen en el grupo común `unknown-ip` y, desde la 7ª firma de cada idea, quedan
 * sospechosas sin que nadie lo vea. Por eso aquí se distingue «no hay IP válida» de «hay IP» y quien llama avisa a la consola.
 *
 * Orden de confianza: la cabecera que fija la plataforma (`x-vercel-forwarded-for`, que el cliente no puede enviar), después `x-real-ip` y, por
 * último, el primer valor de `x-forwarded-for`. Un valor que no es una IP válida se descarta. `x-vercel-forwarded-for` solo se acepta en Vercel
 * (`VERCEL=1`): allí la plataforma sobrescribe las otras dos; detrás de nginx u otro CDN las tres las controla el cliente y habrá que fijar la
 * cabecera de confianza de ese proxy (Sprint 6.1).
 */

const VERCEL_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for'] as const;
const OTHER_HEADERS = ['x-real-ip', 'x-forwarded-for'] as const;

export function trustedClientIp(read: (name: string) => string | null | undefined, options: { vercel?: boolean } = { vercel: process.env.VERCEL === '1' }): string | null {
  for (const name of options.vercel ? VERCEL_HEADERS : OTHER_HEADERS) {
    const first = read(name)?.split(',')[0]?.trim();
    if (first && isIP(first.split('%')[0]!) !== 0) return first;
  }
  return null;
}
