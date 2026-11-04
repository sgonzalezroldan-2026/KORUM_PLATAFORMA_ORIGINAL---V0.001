import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '@/config/env';

const b64 = (bytes = 32) => randomBytes(bytes).toString('base64');

function validSource(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://korum:korum@localhost:5432/korum',
    BETTER_AUTH_SECRET: b64(),
    ENCRYPTION_KEY: b64(),
    DATA_HMAC_SECRET: b64(),
    QR_HMAC_SECRET: b64(),
    CRON_SECRET: b64(),
    ...overrides
  };
}

function issuesOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues;
    throw error;
  }
  return [];
}

describe('QA-C01 · validación del entorno (fail-fast)', () => {
  it('rechaza cobros reales en el entorno de demostración', () => {
    expect(issuesOf(validSource({ PAYCOMET_MODE: 'live', NEXT_PUBLIC_DEMO_MODE: 'true' })).join()).toMatch(/demostración/);
    expect(issuesOf(validSource({ PAYCOMET_MODE: 'live' }))).toEqual([]);
  });

  it('acepta un entorno mínimo válido y rellena los valores por defecto', () => {
    const env = parseEnv(validSource());
    expect(env.PAYCOMET_MODE).toBe('mock');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
    expect(env.NEXT_PUBLIC_DEMO_MODE).toBe('false');
    expect(env.ENCRYPTION_KEY_VERSION).toBe(1);
  });

  it('sin variables críticas falla y nombra cada una de ellas en un único mensaje', () => {
    let message = '';
    try {
      parseEnv({ NODE_ENV: 'development' });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['DATABASE_URL', 'ENCRYPTION_KEY', 'QR_HMAC_SECRET', 'BETTER_AUTH_SECRET', 'DATA_HMAC_SECRET', 'CRON_SECRET']) {
      expect(message).toContain(name);
    }
    expect(message).toContain('npm run setup:env');
  });

  it('trata las cadenas vacías de la plantilla .env.example como variables ausentes', () => {
    const issues = issuesOf(validSource({ BETTER_AUTH_SECRET: '', QR_HMAC_SECRET: '   ' }));
    expect(issues.some((issue) => issue.includes('BETTER_AUTH_SECRET'))).toBe(true);
    expect(issues.some((issue) => issue.includes('QR_HMAC_SECRET'))).toBe(true);
    expect(parseEnv(validSource({ SUPABASE_URL: '', SENTRY_AUTH_TOKEN: '' })).SUPABASE_URL).toBeUndefined();
  });

  it('el almacén de ficheros se configura entero o no se configura: la dirección y la clave van juntas', () => {
    const url = 'https://abc.supabase.co';
    expect(issuesOf(validSource({ SUPABASE_URL: url })).some((issue) => issue.includes('SUPABASE_SERVICE_ROLE_KEY'))).toBe(true);
    expect(issuesOf(validSource({ SUPABASE_SERVICE_ROLE_KEY: 'clave' })).some((issue) => issue.includes('SUPABASE_URL'))).toBe(true);
    expect(issuesOf(validSource({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'clave' }))).toEqual([]);
    expect(issuesOf(validSource())).toEqual([]);
  });

  it('exige una clave AES de exactamente 32 bytes en base64', () => {
    expect(issuesOf(validSource({ ENCRYPTION_KEY: b64(16) })).some((issue) => issue.includes('ENCRYPTION_KEY'))).toBe(true);
    expect(issuesOf(validSource({ ENCRYPTION_KEY: 'no es base64 !!' })).some((issue) => issue.includes('ENCRYPTION_KEY'))).toBe(true);
    expect(issuesOf(validSource({ ENCRYPTION_KEY: b64(32) }))).toEqual([]);
  });

  it('exige secretos de al menos 32 caracteres', () => {
    expect(issuesOf(validSource({ CRON_SECRET: 'corto' })).some((issue) => issue.includes('CRON_SECRET'))).toBe(true);
  });

  it('exige una URL de PostgreSQL', () => {
    expect(issuesOf(validSource({ DATABASE_URL: 'mysql://localhost/korum' })).some((issue) => issue.includes('DATABASE_URL'))).toBe(true);
  });

  it('rechaza valores fuera de rango en el modo de pagos', () => {
    expect(issuesOf(validSource({ PAYCOMET_MODE: 'produccion' })).some((issue) => issue.includes('PAYCOMET_MODE'))).toBe(true);
    expect(parseEnv(validSource({ PAYCOMET_MODE: 'sandbox' })).PAYCOMET_MODE).toBe('sandbox');
  });

  it('prohíbe el simulador de pagos en producción salvo en el entorno de demostración', () => {
    const production = { NODE_ENV: 'production' };
    expect(issuesOf(validSource({ ...production, PAYCOMET_MODE: 'mock' })).some((issue) => issue.includes('PAYCOMET_MODE'))).toBe(true);
    expect(issuesOf(validSource({ ...production, PAYCOMET_MODE: 'live' }))).toEqual([]);
    expect(issuesOf(validSource({ ...production, PAYCOMET_MODE: 'mock', NEXT_PUBLIC_DEMO_MODE: 'true' }))).toEqual([]);
  });

  it('valida el formato del email del primer Super-Admin y de las URL públicas', () => {
    expect(issuesOf(validSource({ SUPERADMIN_BOOTSTRAP_EMAIL: 'no-es-un-email' })).length).toBeGreaterThan(0);
    expect(issuesOf(validSource({ NEXT_PUBLIC_APP_URL: 'localhost' })).length).toBeGreaterThan(0);
    expect(issuesOf(validSource({ SUPERADMIN_BOOTSTRAP_EMAIL: 'admin@korum.example' }))).toEqual([]);
  });
});
