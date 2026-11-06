'use server';

import { headers } from 'next/headers';
import { RegistrationError, registerCommunity, type RegistrationFailure } from '@/core/onboarding/community-registration';
import { getEnv } from '@/config/env';
import { dataHmac } from '@/core/security/data-hmac';
import { isLocale } from '@/i18n/routing';
import { currentRequestMeta, getAuthSession, requireVerifiedAccount } from '@/lib/auth/session';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { getAuth } from '@/lib/auth/server';
import { getPrisma } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { REGISTRATION_RULE } from '@/lib/rate-limit-rules';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { after } from 'next/server';

/**
 * Envío del alta (`/registro-comunidad`). Quién ha iniciado sesión sale de la cookie, nunca del formulario; las reglas se vuelven a aplicar
 * aquí aunque el navegador ya las haya comprobado. Tras el alta, si la cuenta de quien dirige es nueva, se le envía el código para verificar
 * su email: hasta entonces no puede entrar.
 */

export type RegisterActionResult =
  | { ok: true; slug: string; email: string; needsVerification: boolean }
  | { ok: false; failure: RegistrationFailure | { code: 'RATE_LIMITED' } | { code: 'UNKNOWN' } };

export async function registerCommunityAction(locale: string, payload: unknown): Promise<RegisterActionResult> {
  if (!isLocale(locale)) return { ok: false, failure: { code: 'UNKNOWN' } };
  const db = getPrisma();
  const env = getEnv();
  const meta = await currentRequestMeta();
  const networkKey = `${REGISTRATION_RULE.prefix}${meta.ipHash ?? dataHmac(env.DATA_HMAC_SECRET, 'registration-ip', 'unknown-ip')}`;
  if (!(await reserveAttempt(db, networkKey, REGISTRATION_RULE))) return { ok: false, failure: { code: 'RATE_LIMITED' } };

  // Con sesión, la cuenta solo se usa como «quien dirige» si se verificó hace poco (enlace o código): una cookie robada no basta para
  // fijarle una contraseña (auditoría del 3.2, M3). Si no, se trata como una cuenta ajena.
  const session = (await getAuthSession()) ? await requireVerifiedAccount('registration.attach_account').catch((error: unknown) => {
    if (error instanceof SuperadminRequiredError) return null;
    throw error;
  }) : null;
  const dispatch = (ids: readonly number[]) => {
    if (ids.length > 0) after(() => dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length }).then(() => undefined));
  };
  try {
    const result = await registerCommunity(db, payload, { sessionUserId: session?.userId ?? null, locale, appUrl: env.NEXT_PUBLIC_APP_URL, hmacSecret: env.DATA_HMAC_SECRET, dispatch });
    const director = await db.user.findUniqueOrThrow({ where: { id: result.directorUserId }, select: { email: true } });
    if (result.directorNeedsVerification) {
      const requestHeaders = new Headers(await headers());
      requestHeaders.set('x-korum-locale', locale);
      await getAuth().api.sendVerificationOTP({ body: { email: director.email, type: 'email-verification' }, headers: requestHeaders });
    }
    return { ok: true, slug: result.slug, email: director.email, needsVerification: result.directorNeedsVerification };
  } catch (error) {
    if (error instanceof RegistrationError) return { ok: false, failure: error.failure };
    throw error;
  }
}
