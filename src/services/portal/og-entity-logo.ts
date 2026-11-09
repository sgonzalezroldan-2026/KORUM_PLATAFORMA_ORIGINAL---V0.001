import type { KorumPrismaClient } from '@/lib/prisma';
import { getPublicImageFile } from '@/repositories/achievements.repository';
import { FILE_RULES } from '@/services/storage/file-rules';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Logotipo de la entidad para su tarjeta de WhatsApp y redes (Sprint 4.2e, heredado del 3.3). La tarjeta se dibuja en el servidor (`next/og`), que solo
 * sabe pintar PNG y JPEG: un WebP o un fichero retirado se queda en `null` y la tarjeta sale como antes, con el nombre de la entidad. Siempre como `data:`:
 * con Supabase se descarga del cubo público (3 s como mucho); sin almacén real (demostración y pruebas), del almacén en memoria. Nunca lanza: una
 * tarjeta sin logo es mejor que ninguna tarjeta.
 */
const DRAWABLE = new Set(['image/png', 'image/jpeg']);
const LOGO_TIMEOUT_MS = 3_000;
const MAX_LOGO_BYTES = FILE_RULES.ORG_LOGO.maxBytes;

export async function ogEntityLogo(db: KorumPrismaClient, fileId: string | null): Promise<string | null> {
  if (!fileId) return null;
  try {
    const file = await getPublicImageFile(db, fileId);
    if (!file || !DRAWABLE.has(file.mimeType)) return null;
    const storage = getStorageProvider();
    const url = storage.publicUrl(file.bucket, file.objectKey);
    // Se descarga aquí, con tiempo máximo, y se pasa como `data:`: si satori tuviera que bajarlo y fallara, rompería la tarjeta entera (auditoría M6).
    if (/^https:\/\//.test(url)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
      if (!response.ok) return null;
      const body = new Uint8Array(await response.arrayBuffer());
      return body.byteLength > 0 && body.byteLength <= MAX_LOGO_BYTES ? `data:${file.mimeType};base64,${Buffer.from(body).toString('base64')}` : null;
    }
    if (storage instanceof MemoryStorage) {
      const object = storage.readPublic(file.bucket, file.objectKey);
      return object ? `data:${file.mimeType};base64,${Buffer.from(object.body).toString('base64')}` : null;
    }
    return null;
  } catch {
    return null;
  }
}
