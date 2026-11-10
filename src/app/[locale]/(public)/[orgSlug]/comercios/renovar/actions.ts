'use server';

import { headers } from 'next/headers';
import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import { getPrisma } from '@/lib/prisma';
import { startSponsorRenewal, type RenewalStart } from '@/services/checkout/sponsor-renewal.service';
import { getPaymentProvider, PaymentConfigurationError } from '@/services/payments/provider-factory';

/**
 * Pago de la renovación de un comercio (Sprint 4.2d). Quién renueva y qué importe salen del enlace firmado y de la base, nunca de lo que envía el navegador
 * (que solo elige tarjeta o Bizum). Mismo límite de intentos que el checkout.
 */
export async function startSponsorRenewalAction(payload: unknown): Promise<RenewalStart> {
  const db = getPrisma();
  let provider;
  try {
    provider = await getPaymentProvider(db);
  } catch (error) {
    if (error instanceof PaymentConfigurationError) return { status: 'UNAVAILABLE' };
    throw error;
  }
  const requestHeaders = await headers();
  const ip = requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || requestHeaders.get('x-real-ip')?.trim() || null;
  return startSponsorRenewal({ db, provider, keyring: getKeyring(), hmacSecret: getEnv().DATA_HMAC_SECRET }, payload, { session: null, ip });
}
