import { describe, expect, it, vi } from 'vitest';
import type { StorageProvider } from '@/services/storage/storage-provider';

/**
 * Sprint 5.6 · El almacén en memoria (demostración y pruebas) es uno solo para todo el servidor, pero la compilación de producción lleva DOS copias de su
 * clase: una para las rutas (`route.ts`) y otra para las páginas y las acciones de servidor. Lo crea la primera que lo pide. La ruta de imágenes públicas y
 * las tarjetas sociales lo reconocían con `instanceof`, que falla entre copias: las fotos del logro respondían 404 si el almacén lo había estrenado la otra
 * mitad de la aplicación. Lo destapó el recorrido de certificación (`QA-X03`) al ejecutarse solo, sin que otra prueba hubiera pedido antes una imagen.
 */
describe('almacén en memoria compartido entre las dos copias de la compilación', () => {
  it('se reconoce aunque lo haya creado la otra copia de la clase, donde `instanceof` no lo reconocía', async () => {
    const routes = await import('@/services/storage/memory-storage');
    vi.resetModules();
    const pages = await import('@/services/storage/memory-storage');
    // Dos copias del mismo módulo, como en la compilación.
    expect(pages.MemoryStorage).not.toBe(routes.MemoryStorage);

    const shared: StorageProvider = new pages.MemoryStorage();
    await shared.put({ bucket: 'korum-public', objectKey: 'logros/antes.jpg', body: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' });

    // La causa del fallo: para la copia de las rutas, ese almacén «no era» un MemoryStorage.
    expect(shared instanceof routes.MemoryStorage).toBe(false);
    // Lo que preguntan ahora la ruta de imágenes públicas y las tarjetas sociales.
    expect(routes.isMemoryStorage(shared)).toBe(true);
    expect(routes.isMemoryStorage(shared) ? shared.readPublic('korum-public', 'logros/antes.jpg')?.body : null).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('no toma por almacén en memoria a otro proveedor, ni a uno que solo lleve su nombre', async () => {
    const { isMemoryStorage } = await import('@/services/storage/memory-storage');
    const base = { put: async () => undefined, remove: async () => undefined, publicUrl: () => 'https://cubo.example/fichero', createSignedUrl: async () => 'https://cubo.example/firmada' };
    expect(isMemoryStorage({ ...base, name: 'supabase' })).toBe(false);
    expect(isMemoryStorage({ ...base, name: 'memory' })).toBe(false);
  });

  it('ninguna parte de la aplicación vuelve a reconocer el almacén con `instanceof`', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'generated' ? [] : walk(full);
        return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
      });
    const offenders = walk(path.join(process.cwd(), 'src')).filter((file) => /instanceof\s+(MemoryStorage|SupabaseStorage)\b/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(process.cwd(), file))).toEqual([]);
  });
});
