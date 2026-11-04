import { getEnv } from '@/config/env';
import { MemoryStorage } from './memory-storage';
import type { StorageProvider } from './storage-provider';
import { SupabaseStorage } from './supabase-storage';

let memory: MemoryStorage | undefined;

/**
 * Supabase Storage si hay credenciales. Sin ellas, y solo fuera de producción, un almacén en memoria para desarrollar: en producción
 * subir un fichero sin almacén falla de forma explícita en lugar de perderlo en silencio.
 */
export function getStorageProvider(): StorageProvider {
  const env = getEnv();
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return new SupabaseStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  if (env.NODE_ENV === 'production') throw new Error('Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY: sin almacén de ficheros no se puede subir nada.');
  memory ??= new MemoryStorage();
  return memory;
}
