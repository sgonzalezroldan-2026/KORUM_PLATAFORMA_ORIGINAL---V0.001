import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Sprint 4.2c · Qué almacén de ficheros se usa. Con credenciales de Supabase, siempre Supabase. Sin ellas, la memoria vale para desarrollar y, en
 * producción, solo en el entorno de demostración con cobros simulados (donde corre la E2E sobre la compilación de producción); en cualquier otra
 * producción, subir un fichero falla de forma explícita.
 */

const env = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock('@/config/env', () => ({ getEnv: () => env.current }));

const { getStorageProvider } = await import('@/services/storage/provider-factory');

afterEach(() => {
  env.current = {};
});

describe('Almacén de ficheros según el entorno', () => {
  it('Supabase si hay credenciales, en cualquier entorno', () => {
    env.current = { NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'clave', NEXT_PUBLIC_DEMO_MODE: 'false', PAYCOMET_MODE: 'live' };
    expect(getStorageProvider().name).toBe('supabase');
  });

  it('memoria en desarrollo y en la demostración con cobros simulados', () => {
    env.current = { NODE_ENV: 'development', NEXT_PUBLIC_DEMO_MODE: 'false', PAYCOMET_MODE: 'sandbox' };
    expect(getStorageProvider().name).toBe('memory');
    env.current = { NODE_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'true', PAYCOMET_MODE: 'mock' };
    expect(getStorageProvider().name).toBe('memory');
  });

  it('en producción real (o demostración con cobros reales de prueba) sin credenciales, falla', () => {
    env.current = { NODE_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'false', PAYCOMET_MODE: 'live' };
    expect(() => getStorageProvider()).toThrow(/SUPABASE_URL/);
    env.current = { NODE_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'true', PAYCOMET_MODE: 'sandbox' };
    expect(() => getStorageProvider()).toThrow(/SUPABASE_URL/);
  });
});
