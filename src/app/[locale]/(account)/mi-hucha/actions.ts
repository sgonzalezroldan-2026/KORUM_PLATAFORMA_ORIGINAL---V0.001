'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { trustedClientIp } from '@/lib/trusted-ip';
import { getPaymentProvider, PaymentConfigurationError } from '@/services/payments/provider-factory';
import { cancelPledge, changePledgeCampaign, pausePledge, pledgeModeEnabled, resumePledge, startPledge, type PledgeChange, type PledgeStart } from '@/services/pledges/pledge.service';

/**
 * Acciones de Mi Hucha (Sprint 3.8). La persona sale siempre de la sesión: ninguna acción acepta un identificador de usuario, y una aportación
 * de otra persona responde igual que una que no existe. Con Mi Hucha desactivada por el Super-Admin no se puede programar nada; pausar y cancelar
 * siguen funcionando (son de la familia).
 */

type LoginRequired = { status: 'LOGIN_REQUIRED' };

/** IP según el proxy de confianza: el límite de intentos agrupa por red y una cabecera falsa no debe saltárselo. */
async function clientIp(): Promise<string | null> {
  const requestHeaders = await headers();
  return trustedClientIp((name) => requestHeaders.get(name));
}

export async function startPledgeAction(payload: unknown): Promise<PledgeStart | LoginRequired> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  const db = getPrisma();
  if (!(await pledgeModeEnabled(db))) return { status: 'DISABLED' };
  let provider;
  try {
    provider = await getPaymentProvider(db);
  } catch (error) {
    // Sin credenciales de Paycomet no se puede cobrar: se dice en lenguaje llano y la consola ya lo marca como pendiente de configurar.
    if (error instanceof PaymentConfigurationError) return { status: 'UNAVAILABLE' };
    throw error;
  }
  return startPledge({ db, provider, keyring: getKeyring(), hmacSecret: getEnv().DATA_HMAC_SECRET }, payload, { session: { userId: session.userId, email: session.email }, ip: await clientIp() });
}

const pledgeId = z.number().int().positive();
const manageInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause'), pledgeId }),
  z.object({ action: z.literal('resume'), pledgeId }),
  z.object({ action: z.literal('cancel'), pledgeId, confirm: z.literal(true) }),
  z.object({ action: z.literal('campaign'), pledgeId, initiativeId: z.number().int().positive().nullable() })
]);

export async function managePledgeAction(payload: unknown): Promise<PledgeChange | LoginRequired> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  const parsed = manageInput.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  const input = parsed.data;
  const db = getPrisma();
  switch (input.action) {
    case 'pause':
      return pausePledge(db, session.userId, input.pledgeId);
    case 'resume':
      // Reanudar vuelve a cobrar: no con Mi Hucha desactivada.
      if (!(await pledgeModeEnabled(db))) return { status: 'INVALID' };
      return resumePledge(db, session.userId, input.pledgeId);
    case 'campaign':
      return changePledgeCampaign(db, session.userId, input.pledgeId, input.initiativeId);
    case 'cancel':
      return cancelPledge({ db, keyring: getKeyring(), paymentProvider: () => getPaymentProvider(db) }, session.userId, input.pledgeId);
  }
}
