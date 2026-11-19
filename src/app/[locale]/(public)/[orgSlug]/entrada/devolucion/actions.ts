'use server';

import { headers } from 'next/headers';
import { getEnv } from '@/config/env';
import { getPrisma } from '@/lib/prisma';
import { trustedClientIp } from '@/lib/trusted-ip';
import { claimEventRefund, EventRefundError, type EventRefundRejection } from '@/services/ticketing/event-refund-link.service';

/**
 * Devolución de las entradas desde el enlace del aviso de cambio de fecha (Sprint 5.13). Quién pide y de qué evento salen del enlace firmado y de la base,
 * nunca de lo que envía el navegador. Con límite de intentos por red. El dinero lo envía después la tarea `MASS_REFUND` al medio de pago original.
 */

export type EventRefundResult = { status: 'OK'; refundedCents: number; purchases: number } | { status: 'ERROR'; reason: EventRefundRejection | 'FAILED' };

export async function claimEventRefundAction(payload: unknown): Promise<EventRefundResult> {
  const requestHeaders = await headers();
  const ip = trustedClientIp((name) => requestHeaders.get(name));
  try {
    const receipt = await claimEventRefund(getPrisma(), getEnv().DATA_HMAC_SECRET, payload, { ip });
    return { status: 'OK', refundedCents: receipt.refundedCents, purchases: receipt.purchases };
  } catch (error) {
    if (error instanceof EventRefundError) return { status: 'ERROR', reason: error.reason };
    throw error;
  }
}
