import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { emailOTP, magicLink, twoFactor } from 'better-auth/plugins';
import type { KorumPrismaClient } from '@/lib/prisma';
import { queueAuthEmail, type DispatchEmails } from './auth-emails';
import { buildDatabaseHooks, buildIdentityProofHook, buildRateLimitStorage, buildSecondFactorGuard, localeFromContext } from './auth-hooks';

/**
 * Configuración de Better Auth para KORUM (DECISIONES_TECNICAS §2 y §5, ARQUITECTURA_LANDING §2).
 *
 * - **Familias y comercios:** enlace mágico (15 min, un solo uso) o código de 6 dígitos por email (10 min, 5 intentos). Sin contraseña.
 * - **Firmantes y Super-Admin:** contraseña (mín. 12) + TOTP obligatorio, que exige la capa de sesión (`session.ts`). No hay alta pública
 *   con contraseña: las cuentas con contraseña nacen en el alta de una entidad o por invitación (`src/core/onboarding/`).
 * - Tokens y códigos guardados con hash; sesiones de 30 días sin caché en cookie (una sesión cerrada deja de valer al momento).
 * - Límites por red y ruta sobre `RateLimit` con claves propias, y por destinatario en los emails (`auth-emails.ts`).
 * - Sin telemetría de Better Auth.
 */

export const MAGIC_LINK_MINUTES = 15;
export const EMAIL_CODE_MINUTES = 10;
export const MIN_PASSWORD_LENGTH = 12;

export interface KorumAuthDeps {
  db: KorumPrismaClient;
  secret: string;
  hmacSecret: string;
  baseURL: string;
  production: boolean;
  dispatch: DispatchEmails;
  now?: () => Date;
}

export function createKorumAuth(deps: KorumAuthDeps) {
  const hookDeps = { db: deps.db, hmacSecret: deps.hmacSecret, now: deps.now };
  const emailDeps = { db: deps.db, hmacSecret: deps.hmacSecret, dispatch: deps.dispatch };

  return betterAuth({
    appName: 'KORUM',
    baseURL: deps.baseURL,
    secret: deps.secret,
    trustedOrigins: [deps.baseURL],
    database: prismaAdapter(deps.db, { provider: 'postgresql' }),
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true
    },
    emailVerification: { autoSignInAfterVerification: true },
    user: {
      additionalFields: {
        canonicalEmail: { type: 'string', required: false, input: false, returned: false },
        locale: { type: 'string', required: false, input: false, returned: false },
        isSuperadmin: { type: 'boolean', required: false, input: false, returned: false, defaultValue: false },
        emailVerifiedAt: { type: 'date', required: false, input: false, returned: false }
      }
    },
    session: { expiresIn: 30 * 24 * 3600, updateAge: 24 * 3600 },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customStorage: buildRateLimitStorage(hookDeps),
      customRules: {
        '/sign-in/magic-link': { window: 600, max: 5 },
        '/email-otp/send-verification-otp': { window: 600, max: 5 },
        '/sign-in/email-otp': { window: 600, max: 10 },
        '/email-otp/request-password-reset': { window: 600, max: 5 },
        '/email-otp/reset-password': { window: 900, max: 10 },
        '/sign-in/email': { window: 900, max: 10 },
        '/two-factor/verify-totp': { window: 900, max: 15 },
        '/two-factor/verify-backup-code': { window: 900, max: 15 }
      }
    },
    advanced: {
      cookiePrefix: 'korum',
      useSecureCookies: deps.production,
      ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'] }
    },
    databaseHooks: buildDatabaseHooks(hookDeps),
    hooks: { before: buildSecondFactorGuard(hookDeps), after: buildIdentityProofHook(hookDeps) },
    // Rutas del doble factor que, con la contraseña sola, darían el secreto o códigos nuevos o quitarían el 2FA (auditoría del 3.2, B1). La
    // interfaz no las usa: el secreto sale de `enable`, que en una cuenta con 2FA exige el TOTP reciente (`buildSecondFactorGuard`).
    disabledPaths: ['/two-factor/get-totp-uri', '/two-factor/generate-backup-codes', '/two-factor/disable', '/two-factor/send-otp', '/two-factor/verify-otp'],
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }, ctx) => {
          await queueAuthEmail(emailDeps, { template: 'auth.magicLink', to: email, locale: localeFromContext(ctx), payload: { url, minutes: MAGIC_LINK_MINUTES } });
        }
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: EMAIL_CODE_MINUTES * 60,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email, otp }, ctx) => {
          await queueAuthEmail(emailDeps, { template: 'auth.otp', to: email, locale: localeFromContext(ctx), payload: { code: otp, minutes: EMAIL_CODE_MINUTES } });
        }
      }),
      twoFactor({ issuer: 'KORUM', backupCodeOptions: { amount: 10, length: 10 }, accountLockout: { enabled: true } }),
      nextCookies()
    ]
  });
}

export type KorumAuth = ReturnType<typeof createKorumAuth>;
