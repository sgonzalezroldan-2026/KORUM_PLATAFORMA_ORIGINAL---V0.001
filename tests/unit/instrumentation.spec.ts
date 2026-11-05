import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const b64 = () => randomBytes(32).toString('base64');

function stubValidEnv() {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DATABASE_URL', 'postgresql://korum:korum@localhost:5432/korum');
  vi.stubEnv('BETTER_AUTH_SECRET', b64());
  vi.stubEnv('ENCRYPTION_KEY', b64());
  vi.stubEnv('DATA_HMAC_SECRET', b64());
  vi.stubEnv('QR_HMAC_SECRET', b64());
  vi.stubEnv('CRON_SECRET', b64());
}

describe('QA-C01 · el servidor se detiene al arrancar con un entorno inválido', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sin variables críticas muestra el mensaje y termina el proceso con código 1', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('DATA_HMAC_SECRET', '');
    vi.stubEnv('QR_HMAC_SECRET', '');
    vi.stubEnv('CRON_SECRET', '');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('@/instrumentation-node');

    expect(exit).toHaveBeenCalledWith(1);
    const message = String(error.mock.calls[0]?.[0]);
    for (const name of ['DATABASE_URL', 'ENCRYPTION_KEY', 'QR_HMAC_SECRET', 'BETTER_AUTH_SECRET']) {
      expect(message).toContain(name);
    }
    // La importación dinámica del módulo de arranque es pesada: con la máquina cargada roza los 5 s por defecto.
  }, 30_000);

  it('con un entorno válido no termina el proceso', async () => {
    stubValidEnv();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('@/instrumentation-node');

    expect(exit).not.toHaveBeenCalled();
  });

  it('durante `next build` no valida, para que la integración continua compile sin secretos', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.stubEnv('DATABASE_URL', '');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('@/instrumentation-node');

    expect(exit).not.toHaveBeenCalled();
  });
});
