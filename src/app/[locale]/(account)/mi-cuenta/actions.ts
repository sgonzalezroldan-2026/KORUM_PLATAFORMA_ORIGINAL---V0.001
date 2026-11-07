'use server';

import { z } from 'zod';
import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import { recordConsent } from '@/core/privacy/consents';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { accountReauthIsFresh } from '@/core/security/verified-actor';
import { isLocale } from '@/i18n/routing';
import { getAuthSession, requireVerifiedAccount } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { eraseOwnAccount, type EraseOutcome } from '@/services/account/account-privacy.service';
import { getPaymentProvider } from '@/services/payments/provider-factory';
import { writeAudit } from '@/services/audit/audit.service';
import { getSetting } from '@/services/settings/settings.service';

/**
 * Acciones de *Mi cuenta* (Sprint 3.7). La persona sale siempre de la sesión: ninguna acción acepta un identificador de usuario. Exportar los
 * datos es una ruta (`/api/cuenta/exportar`), porque devuelve un fichero; aquí están lo que solo cambia el estado de la cuenta.
 */

export type LoginRequired = { status: 'LOGIN_REQUIRED' };

/** ¿Hace falta pedir el código por email antes de exportar, suprimir o añadir una llave? No deja rastro: preguntar no es un intento. */
export async function accountReauthStatusAction(): Promise<{ status: 'FRESH' | 'REAUTH_REQUIRED' } | LoginRequired> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  const fresh = await accountReauthIsFresh(getPrisma(), { userId: session.userId, sessionId: session.sessionId });
  return { status: fresh ? 'FRESH' : 'REAUTH_REQUIRED' };
}

/** Retirar la huella del navegador desde *Mi cuenta*, con un clic como en el buzón: la huella se borra al momento de todos sus dispositivos. */
export async function withdrawFingerprintFromAccountAction(): Promise<{ status: 'WITHDRAWN' } | LoginRequired> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  const db = getPrisma();
  const policyVersion = (await getSetting(db, 'privacy.policyVersion')) ?? '2026-11-01';
  await recordConsent(db, { userId: session.userId, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion, source: 'cuenta' });
  return { status: 'WITHDRAWN' };
}

const localeInput = z.object({ locale: z.string().refine(isLocale) });

/** Idioma de la cuenta (`User.locale`): el de los emails. La página cambia de URL en el navegador; la URL sigue mandando en lo que se ve. */
export async function changeAccountLocaleAction(payload: unknown): Promise<{ status: 'SAVED' | 'INVALID' } | LoginRequired> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  const parsed = localeInput.safeParse(payload);
  if (!parsed.success || !isLocale(parsed.data.locale)) return { status: 'INVALID' };
  await getPrisma().user.update({ where: { id: session.userId }, data: { locale: parsed.data.locale } });
  return { status: 'SAVED' };
}

const eraseInput = z.object({ confirm: z.literal(true) });

/**
 * Suprimir la cuenta (QA-REG03). Exige la reautenticación de esta sesión en los últimos 10 minutos: si no la hay, se pide el código por email y
 * se vuelve a llamar. Tras suprimir, las sesiones ya no existen: el navegador solo tiene que ir a la portada.
 */
export async function eraseAccountAction(payload: unknown): Promise<EraseOutcome | { status: 'REAUTH_REQUIRED' | 'INVALID' } | LoginRequired> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  if (!eraseInput.safeParse(payload).success) return { status: 'INVALID' };
  let actor;
  try {
    actor = await requireVerifiedAccount('privacy.erasure');
  } catch (error) {
    if (error instanceof SuperadminRequiredError) return { status: 'REAUTH_REQUIRED' };
    throw error;
  }
  const db = getPrisma();
  const env = getEnv();
  return eraseOwnAccount(db, { paymentProvider: () => getPaymentProvider(db), keyring: getKeyring(), hmacSecret: env.DATA_HMAC_SECRET }, { actor });
}

const passkeyInput = z.object({ id: z.string().min(1).max(200) });

/** Quitar una llave de acceso de la propia cuenta. Solo borra si la llave es de quien tiene la sesión: la de otra persona responde igual que una que no existe. */
export async function deletePasskeyAction(payload: unknown): Promise<{ status: 'DELETED' | 'NOT_FOUND' } | LoginRequired> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  const parsed = passkeyInput.safeParse(payload);
  if (!parsed.success) return { status: 'NOT_FOUND' };
  const db = getPrisma();
  const { count } = await db.passkey.deleteMany({ where: { id: parsed.data.id, userId: session.userId } });
  if (count === 0) return { status: 'NOT_FOUND' };
  await writeAudit(db, { actorType: 'USER', actorUserId: session.userId, action: 'account.passkey_deleted', targetType: 'Passkey', targetId: parsed.data.id });
  return { status: 'DELETED' };
}
