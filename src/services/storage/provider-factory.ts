import { getEnv } from '@/config/env';
import { MemoryStorage } from './memory-storage';
import type { StorageProvider } from './storage-provider';
import { SupabaseStorage } from './supabase-storage';

// En `globalThis`: el servidor de desarrollo compila cada ruta por separado y, con una variable de módulo, cada una tendría su propio almacén vacío.
const shared = globalThis as typeof globalThis & { __korumMemoryStorage?: MemoryStorage };

/**
 * Supabase Storage si hay credenciales. Sin ellas, un almacén en memoria para desarrollar, y en producción solo en el entorno de demostración con
 * cobros simulados (`NEXT_PUBLIC_DEMO_MODE=true` y `PAYCOMET_MODE=mock`, el mismo que admite el simulador de pagos; Sprint 4.2c): ahí no hay
 * datos reales que perder y las pruebas de extremo a extremo sobre la compilación de producción pueden subir ficheros. En cualquier otra
 * producción, subir un fichero sin almacén falla de forma explícita en lugar de perderlo en silencio.
 */
export function getStorageProvider(): StorageProvider {
  const env = getEnv();
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return new SupabaseStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const demo = env.NEXT_PUBLIC_DEMO_MODE === 'true' && env.PAYCOMET_MODE === 'mock';
  if (env.NODE_ENV === 'production' && !demo) throw new Error('Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY: sin almacén de ficheros no se puede subir nada.');
  shared.__korumMemoryStorage ??= new MemoryStorage();
  return shared.__korumMemoryStorage;
}
