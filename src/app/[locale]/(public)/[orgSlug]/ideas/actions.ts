'use server';

import { cookies, headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { recordConsent } from '@/core/privacy/consents';
import { DEVICE_COOKIE } from '@/core/security/device-signals';
import { isLocale, routing, type Locale } from '@/i18n/routing';
import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { trustedClientIp } from '@/lib/trusted-ip';
import { getSetting } from '@/services/settings/settings.service';
import { proposeIdeaForRequest, signIdeaForRequest, type ProposeOutcome, type SignActionResult } from '@/services/ideas/idea-requests.service';

/**
 * Acciones del buzón de ideas (Sprint 3.6). Quien firma o propone sale de la sesión, la IP, de la cabecera del proxy de confianza y la cookie del
 * dispositivo, de la propia cookie firmada: nada de eso se acepta del cuerpo de la petición. La lógica vive en `idea-requests.service.ts`.
 */

async function requestContext() {
  const [session, requestHeaders, cookieStore] = await Promise.all([getAuthSession(), headers(), cookies()]);
  return {
    context: { userId: session?.userId ?? null, ip: trustedClientIp((name) => requestHeaders.get(name)), deviceCookie: cookieStore.get(DEVICE_COOKIE.name)?.value },
    cookieStore
  };
}

/** Firma en 1 clic: las familias entran con enlace o código por email y eso basta (el segundo factor es solo para quien firma por la entidad). */
export async function signIdeaAction(payload: unknown): Promise<SignActionResult> {
  const { context, cookieStore } = await requestContext();
  const env = getEnv();
  const outcome = await signIdeaForRequest({ db: getPrisma(), hmacSecret: env.DATA_HMAC_SECRET }, payload, context);
  if (outcome.status !== 'SIGNED') return outcome;
  // La cookie del dispositivo solo se crea cuando la persona firma (necesaria para el servicio que ha pedido, LSSI art. 22.2).
  const { newDeviceCookie, ...rest } = outcome;
  if (newDeviceCookie) cookieStore.set(DEVICE_COOKIE.name, newDeviceCookie, DEVICE_COOKIE.options);
  return rest;
}

const localeOf = z.object({ locale: z.string() });

export async function proposeIdeaAction(payload: unknown): Promise<ProposeOutcome> {
  const { context } = await requestContext();
  const requested = localeOf.safeParse(payload);
  const locale: Locale = requested.success && isLocale(requested.data.locale) ? requested.data.locale : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: 'portal.ideas' });
  const env = getEnv();
  return proposeIdeaForRequest({ db: getPrisma(), hmacSecret: env.DATA_HMAC_SECRET }, payload, { ...context, systemMessage: t('systemMessage', { alias: '{alias}' }) });
}

/**
 * Retira el consentimiento de la huella del navegador, con el mismo esfuerzo con el que se dio (RGPD art. 7.3): al instante se borra la huella de
 * todos los dispositivos de la persona. Hasta que exista *Mi cuenta* (Sprint 3.7), el botón vive junto al aviso del buzón.
 */
export async function withdrawFingerprintConsentAction(): Promise<'WITHDRAWN' | 'LOGIN_REQUIRED'> {
  const session = await getAuthSession();
  if (!session) return 'LOGIN_REQUIRED';
  const db = getPrisma();
  const policyVersion = (await getSetting(db, 'privacy.policyVersion')) ?? '2026-11-01';
  await recordConsent(db, { userId: session.userId, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion, source: 'buzon' });
  return 'WITHDRAWN';
}
