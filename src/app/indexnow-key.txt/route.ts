import { getKeyring } from '@/config/keyring';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { readIndexNowKey } from '@/services/seo/indexnow.service';

/**
 * Fichero de verificación de IndexNow (Sprint 5.5b): el protocolo comprueba que el dominio es nuestro leyendo aquí la misma clave que enviamos en cada aviso
 * (`keyLocation`). Es pública por diseño. Sin clave configurada (o con un formato que el protocolo no admite) responde 404.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  let key: string | null = null;
  try {
    key = await readIndexNowKey(getPrisma(), getKeyring());
  } catch (error) {
    reportError(error, { area: 'indexnow-key' });
  }
  if (!key) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  return new Response(key, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' } });
}
