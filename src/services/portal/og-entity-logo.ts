import type { KorumPrismaClient } from '@/lib/prisma';
import { getPublicImageFile } from '@/repositories/achievements.repository';
import { FILE_RULES } from '@/services/storage/file-rules';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Imágenes públicas de una entidad para su tarjeta de WhatsApp y redes (Sprint 4.2e, heredado del 3.3; la imagen de la campaña, Sprint 4.4c). La
 * tarjeta se dibuja en el servidor (`next/og`). Siempre como bytes que luego se pasan como `data:`: con Supabase se descargan del cubo público
 * (3 s como mucho); sin almacén real (demostración y pruebas), del almacén en memoria. Nunca lanzan: una tarjeta sin imagen es mejor que ninguna
 * tarjeta.
 */
const DRAWABLE = new Set(['image/png', 'image/jpeg']);
const IMAGE_TIMEOUT_MS = 3_000;

/** Bytes de un fichero público de imagen de los tipos indicados y de tamaño acotado, o `null` si no hay forma de leerlos. */
export async function readPublicImage(db: KorumPrismaClient, fileId: string | null, maxBytes: number, allowed: ReadonlySet<string>): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  if (!fileId) return null;
  try {
    const file = await getPublicImageFile(db, fileId);
    if (!file || !allowed.has(file.mimeType)) return null;
    const storage = getStorageProvider();
    const url = storage.publicUrl(file.bucket, file.objectKey);
    // Se descarga aquí, con tiempo máximo, y se pasa como `data:`: si satori tuviera que bajarlo y fallara, rompería la tarjeta entera (auditoría M6).
    if (/^https:\/\//.test(url)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
      if (!response.ok) return null;
      const body = new Uint8Array(await response.arrayBuffer());
      return body.byteLength > 0 && body.byteLength <= maxBytes ? { bytes: body, mimeType: file.mimeType } : null;
    }
    if (storage instanceof MemoryStorage) {
      const object = storage.readPublic(file.bucket, file.objectKey);
      return object && object.body.byteLength <= maxBytes ? { bytes: new Uint8Array(object.body), mimeType: file.mimeType } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Logotipo de la entidad: solo PNG y JPEG (satori no pinta WebP); un WebP o un fichero retirado se queda en `null` y la tarjeta sale con el nombre. */
export async function ogEntityLogo(db: KorumPrismaClient, fileId: string | null): Promise<string | null> {
  const image = await readPublicImage(db, fileId, FILE_RULES.ORG_LOGO.maxBytes, DRAWABLE);
  return image ? `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}` : null;
}
