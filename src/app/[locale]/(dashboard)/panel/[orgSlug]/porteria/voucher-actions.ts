'use server';

import { z } from 'zod';
import { getEnv } from '@/config/env';
import { lookupVoucherBalance, redeemVouchers, VoucherRedeemInputError } from '@/core/ticketing/voucher-redemption.service';
import { MAX_VOUCHERS_PER_ORDER } from '@/core/ticketing/voucher-rules';
import { TenantAccessError } from '@/repositories/tenant-guard';
import { resolveGateAccess } from './gate-request';
import type { GateActionError } from './scan-actions';

/**
 * Lo que pide el móvil del puesto de canje de vales (Sprint 5.14c, QA-VAL05): leer un QR para ver cuántos vales le quedan y gastar los que se teclean. Quién es y
 * de qué venta sale de la cookie de la sesión con PIN, nunca del navegador (que solo dice la venta que ve en pantalla, y debe coincidir con la de la sesión). Sin
 * red no se canjea: un vale es una cuenta que solo lleva el servidor.
 */

const lookupSchema = z.object({ payload: z.string().min(1).max(200) }).strict();
const redeemSchema = z.object({ payload: z.string().min(1).max(200), quantity: z.number().int().min(1).max(MAX_VOUCHERS_PER_ORDER), clientScanId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict();

export type VoucherLookupView =
  | { status: 'OK'; balance: number; quantity: number; serial: string; validUntil: string }
  | { status: 'INVALID_SIGNATURE' | 'OTHER_SALE' | 'EXHAUSTED' | 'REVOKED' | 'NOT_PAID' | 'SALE_CLOSED' | 'SALE_CANCELLED' | 'EXPIRED' };

export type VoucherRedeemView =
  | { status: 'REDEEMED'; spent: number; balance: number; quantity: number; serial: string }
  | { status: 'DUPLICATE'; accepted: boolean; balance: number }
  | { status: 'INSUFFICIENT'; balance: number }
  | { status: 'EXHAUSTED' | 'INVALID_SIGNATURE' | 'OTHER_SALE' | 'REVOKED' | 'NOT_PAID' | 'SALE_CLOSED' | 'SALE_CANCELLED' | 'EXPIRED' };

export type VoucherLookupResult = { status: 'DONE'; result: VoucherLookupView } | { status: 'ERROR'; reason: GateActionError };
export type VoucherRedeemResult = { status: 'DONE'; result: VoucherRedeemView } | { status: 'ERROR'; reason: GateActionError };

/** Una sesión que ya no vale (cerrada desde el panel o la venta cancelada) se comunica como tal; un error del lector, como entrada no válida. */
function failure(error: unknown): { status: 'ERROR'; reason: GateActionError } {
  if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'NO_SESSION' };
  if (error instanceof VoucherRedeemInputError) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  throw error;
}

export async function lookupVoucherAction(saleId: number, input: unknown): Promise<VoucherLookupResult> {
  const access = await resolveGateAccess(saleId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  const parsed = lookupSchema.safeParse(input);
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  try {
    const result = await lookupVoucherBalance(access.db, getEnv().QR_HMAC_SECRET, access.actor, access.event, parsed.data.payload);
    if (result.status !== 'OK') return { status: 'DONE', result: { status: result.status } };
    return { status: 'DONE', result: { status: 'OK', balance: result.balance, quantity: result.quantity, serial: result.serialCode, validUntil: result.validUntil.toISOString() } };
  } catch (error) {
    return failure(error);
  }
}

export async function redeemVoucherAction(saleId: number, input: unknown): Promise<VoucherRedeemResult> {
  const access = await resolveGateAccess(saleId);
  if (access.status !== 'OK') return { status: 'ERROR', reason: access.status };
  const parsed = redeemSchema.safeParse(input);
  if (!parsed.success) return { status: 'ERROR', reason: 'INVALID_INPUT' };
  try {
    const result = await redeemVouchers(access.db, getEnv().QR_HMAC_SECRET, access.actor, access.event, parsed.data.payload, parsed.data.quantity, parsed.data.clientScanId);
    if (result.status === 'REDEEMED') return { status: 'DONE', result: { status: 'REDEEMED', spent: result.spent, balance: result.balance, quantity: result.quantity, serial: result.serialCode } };
    return { status: 'DONE', result };
  } catch (error) {
    return failure(error);
  }
}
