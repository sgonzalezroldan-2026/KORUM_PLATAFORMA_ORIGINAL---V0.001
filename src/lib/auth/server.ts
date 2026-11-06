import { after } from 'next/server';
import { getEnv } from '@/config/env';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { createKorumAuth, type KorumAuth } from './auth-config';

/**
 * Instancia de Better Auth de la aplicación. Se crea al primer uso (no al importar): `next build` no necesita las variables de entorno.
 * Los emails de acceso se envían con `after()`, cuando la respuesta ya ha salido; fuera de una petición (un script) se envían al momento.
 */

const globalForAuth = globalThis as unknown as { korumAuth?: KorumAuth };

function dispatchNow(ids: readonly number[]) {
  const db = getPrisma();
  const run = () =>
    dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length }).then(
      () => undefined,
      (error: unknown) => reportError(error, { area: 'auth.email' })
    );
  try {
    after(run);
  } catch {
    void run();
  }
}

export function getAuth(): KorumAuth {
  if (!globalForAuth.korumAuth) {
    const env = getEnv();
    globalForAuth.korumAuth = createKorumAuth({
      db: getPrisma(),
      secret: env.BETTER_AUTH_SECRET,
      hmacSecret: env.DATA_HMAC_SECRET,
      baseURL: env.NEXT_PUBLIC_APP_URL,
      production: env.NODE_ENV === 'production',
      dispatch: dispatchNow
    });
  }
  return globalForAuth.korumAuth;
}
