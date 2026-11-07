import { NextResponse } from 'next/server';
import { getPrisma } from '@/lib/prisma';
import { getPublicImageFile } from '@/repositories/achievements.repository';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { getStorageProvider } from '@/services/storage/provider-factory';

/**
 * Puerta única a las imágenes públicas de las entidades (fotos Antes / Después, logotipos, portadas). El HTML siempre apunta aquí, con el
 * identificador del fichero: con Supabase responde una redirección permanente al cubo público; en desarrollo, sin almacén real, sirve los bytes del
 * almacén en memoria. Solo salen ficheros `PUBLIC` de imagen y no borrados; cualquier otro identificador responde el mismo 404.
 */

const FILE_ID = /^[a-z0-9]{20,40}$/;
/**
 * El contenido de un fichero con ese identificador no cambia nunca (una foto nueva es un fichero nuevo), pero una foto que se retira (por ejemplo, porque
 * aparece un menor) debe dejar de verse pronto: un día, no un año.
 */
const IMMUTABLE = 'public, max-age=86400';

const notFound = () => new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!FILE_ID.test(id)) return notFound();
  const file = await getPublicImageFile(getPrisma(), id);
  if (!file) return notFound();

  let storage;
  try {
    storage = getStorageProvider();
  } catch {
    // Sin almacén configurado (compilación de producción sin Supabase) no hay nada que servir.
    return notFound();
  }
  const url = storage.publicUrl(file.bucket, file.objectKey);
  if (/^https:\/\//.test(url)) return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': IMMUTABLE } });
  if (storage instanceof MemoryStorage) {
    const object = storage.readPublic(file.bucket, file.objectKey);
    if (!object) return notFound();
    return new NextResponse(Buffer.from(object.body), { headers: { 'Content-Type': file.mimeType, 'Cache-Control': IMMUTABLE, 'X-Content-Type-Options': 'nosniff', ETag: `"${file.sha256}"` } });
  }
  return notFound();
}
