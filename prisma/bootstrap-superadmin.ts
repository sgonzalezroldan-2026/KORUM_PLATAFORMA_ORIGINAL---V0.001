import { getEnv } from '@/config/env';
import { bootstrapSuperadmin, type BootstrapOutcome } from '@/core/onboarding/superadmin-bootstrap';
import { connectionFromUrl, createPrismaClient } from '@/lib/prisma';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';

/**
 * Alta del primer Super-Admin (`npm run superadmin:bootstrap`): invita a `SUPERADMIN_BOOTSTRAP_EMAIL` a crear su contraseña. Solo actúa si
 * todavía no existe ningún Super-Admin. Después la persona entra en `/login`, activa el TOTP y la consola (`/admin`) queda abierta para ella.
 */
const MESSAGES: Record<BootstrapOutcome, string> = {
  INVITED: '✅ Invitación enviada. Revisa el correo (en modo de pruebas, la carpeta .email-preview/).',
  ALREADY_EXISTS: 'ℹ️ Ya existe un Super-Admin: no se ha hecho nada. Los siguientes se dan de alta desde la consola.',
  NOT_CONFIGURED: '⚠️ Falta SUPERADMIN_BOOTSTRAP_EMAIL en el entorno.',
  INVALID_EMAIL: '⚠️ SUPERADMIN_BOOTSTRAP_EMAIL no es un email válido.',
  RATE_LIMITED: '⚠️ Se han pedido demasiadas invitaciones para este email. Espera 15 minutos y vuelve a intentarlo.'
};

async function main() {
  const env = getEnv();
  const db = createPrismaClient(connectionFromUrl(env.DATABASE_URL));
  const pending: number[] = [];
  try {
    const outcome = await bootstrapSuperadmin(db, { email: env.SUPERADMIN_BOOTSTRAP_EMAIL, appUrl: env.NEXT_PUBLIC_APP_URL, hmacSecret: env.DATA_HMAC_SECRET, dispatch: (ids) => pending.push(...ids) });
    if (pending.length > 0) await dispatchOutbox(db, buildOutboxDeps(db), { ids: pending, limit: pending.length });
    console.log(MESSAGES[outcome]);
    if (outcome !== 'INVITED' && outcome !== 'ALREADY_EXISTS') process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main();
