import { createHmac, randomBytes } from 'node:crypto';
import { hashPassword, symmetricEncrypt } from 'better-auth/crypto';
import { getEnv } from '@/config/env';
import { connectionFromUrl, createPrismaClient } from '@/lib/prisma';
import { assertSeedAllowed, databaseTargetsOf } from '@/seed/seed-guard';

/**
 * Acceso de demostración (`npm run demo:access`): da contraseña y segundo factor conocidos a las cuentas que crea la semilla
 * (Super-Admin y firmantes de cada entidad, todas `@…example`) para poder entrar en `/login` y ver el panel y la consola.
 *
 * Solo para bases locales o de demostración: pasa por la misma guardia que la semilla (`seed-guard`), que se niega ante
 * `PAYCOMET_MODE=live`, `NODE_ENV=production` sin demostración o una base remota. Una contraseña y un secreto TOTP publicados
 * en el código no pueden existir nunca en una base real.
 *
 * Cada ejecución repone la contraseña y el secreto y escribe en pantalla el código TOTP de ese momento (válido ~30 s).
 */

const DEMO_PASSWORD = 'Korum-Demo-2026!';
/** Secreto TOTP fijo de demostración (Better Auth usa los bytes del texto como clave HMAC). */
const DEMO_TOTP_SECRET = 'KORUM-DEMO-TOTP-SECRET-2026-LOCAL';
const TOTP_PERIOD_SECONDS = 30;

/** TOTP de RFC 6238 (HMAC-SHA1, 6 dígitos, 30 s), con los mismos parámetros que `twoFactor` de Better Auth. */
function totpCode(secret: string, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

async function main() {
  const env = getEnv();
  assertSeedAllowed({ nodeEnv: env.NODE_ENV, demoMode: env.NEXT_PUBLIC_DEMO_MODE === 'true', paycometMode: env.PAYCOMET_MODE, databaseUrls: databaseTargetsOf(env) });

  const db = createPrismaClient(connectionFromUrl(env.DATABASE_URL));
  try {
    const users = await db.user.findMany({ where: { email: { endsWith: '.example' } }, select: { id: true, email: true, name: true, isSuperadmin: true }, orderBy: { email: 'asc' } });
    if (users.length === 0) {
      console.error('⚠️ No hay cuentas de demostración: ejecuta antes npm run db:seed (o npm run db:reset).');
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const encryptedSecret = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: DEMO_TOTP_SECRET });

    for (const user of users) {
      const backupCodes = Array.from({ length: 10 }, () => `${randomBytes(5).toString('hex')}-${randomBytes(5).toString('hex')}`);
      const encryptedBackupCodes = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: JSON.stringify(backupCodes) });

      const account = await db.account.findFirst({ where: { userId: user.id, providerId: 'credential' }, select: { id: true } });
      if (account) await db.account.update({ where: { id: account.id }, data: { password: passwordHash } });
      else await db.account.create({ data: { id: `demo-credential-${user.id}`, accountId: user.id, providerId: 'credential', userId: user.id, password: passwordHash } });

      const twoFactor = await db.twoFactor.findFirst({ where: { userId: user.id }, select: { id: true } });
      const twoFactorData = { secret: encryptedSecret, backupCodes: encryptedBackupCodes, verified: true, failedVerificationCount: 0, lockedUntil: null };
      if (twoFactor) await db.twoFactor.update({ where: { id: twoFactor.id }, data: twoFactorData });
      else await db.twoFactor.create({ data: { id: `demo-two-factor-${user.id}`, userId: user.id, ...twoFactorData } });

      await db.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true, emailVerified: true } });
    }

    console.log('\n✅ Acceso de demostración listo (solo base local).\n');
    console.log(`   Contraseña de todas las cuentas: ${DEMO_PASSWORD}`);
    console.log(`   Código del segundo factor ahora (cambia cada 30 s; vuelve a ejecutar «npm run demo:access» para ver otro): ${totpCode(DEMO_TOTP_SECRET, Date.now())}\n`);
    for (const user of users) console.log(`   ${user.isSuperadmin ? '🛡️ Super-Admin' : '🏫 Firmante   '}  ${user.email}  (${user.name})`);
    console.log('\n   Entrar en: ' + new URL('/login', env.NEXT_PUBLIC_APP_URL).toString());
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
