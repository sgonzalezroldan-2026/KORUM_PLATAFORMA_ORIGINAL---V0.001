import { z } from 'zod';
import { dataHmac } from '@/core/security/data-hmac';
import { SPLIT_WINDOW_DAYS } from '@/core/finance/campaign-window';
import { validateTaxId } from '@/core/tax/tax-id';
import { PROVIDER_NAME_MAX, PROVIDER_NAME_MIN, validateIban } from './provider-fields';

export { compactIban, PROVIDER_NAME_MAX, PROVIDER_NAME_MIN, validateIban } from './provider-fields';

/**
 * Reglas puras de la liquidación de una campaña conseguida (Sprint 4.4a, skill de pagos §8): qué se paga, a quién y con qué factura. Sin base de datos.
 *
 * - **Cifras:** a la entidad (o a su proveedor) va lo recaudado menos la comisión de KORUM (tramo + mantenimiento) y la pasarela incluida en la meta. Es la
 *   misma cuenta que comprueba `approvePayout` en la transacción que mueve el dinero.
 * - **Factura:** una campaña de presupuesto adjunta siempre la factura (o proforma) de su proveedor, también si el dinero va a la entidad (QA-S03); un
 *   evento o una rifa no tienen proveedor y no la necesitan.
 * - **Proveedor:** el IBAN se valida (módulo 97) y el CIF/NIF con su dígito de control; nunca se guardan en claro (CUMPLIMIENTO §5.2).
 */

const DAY_MS = 86_400_000;

export type CampaignPayoutRejection =
  | 'INVALID_INPUT'
  | 'INVALID_IBAN'
  | 'INVALID_TAX_ID'
  | 'NOT_FOUND'
  | 'NOT_READY'
  | 'RAFFLE_NOT_DRAWN'
  | 'SPONSORS_PENDING'
  | 'KYB_NOT_VERIFIED'
  | 'DESTINATION_ACCOUNT_MISSING'
  | 'INVOICE_REQUIRED'
  | 'INVOICE_INVALID'
  | 'PROVIDER_PAYOUT_UNAVAILABLE'
  | 'NOTHING_TO_PAY'
  | 'WINDOW_EXPIRED'
  | 'WRONG_STATUS'
  | 'RATE_LIMITED';

export class CampaignPayoutError extends Error {
  readonly reason: CampaignPayoutRejection;

  constructor(reason: CampaignPayoutRejection) {
    super(`La liquidación no se puede pedir: ${reason}.`);
    this.name = 'CampaignPayoutError';
    this.reason = reason;
  }
}

const initiativeId = z.number().int().positive().max(2_147_483_647);
const fileId = z.string().regex(/^[a-z0-9]{20,40}$/);
/** Texto de una línea sin caracteres de control ni de dirección de texto (no se cuelan saltos ni texto invertido en el justificante). */
const singleLine = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(min).max(max));

export const requestCampaignPayoutSchema = z.discriminatedUnion('destination', [
  z.object({ destination: z.literal('ORGANIZATION'), initiativeId, invoiceFileId: fileId.nullable() }).strict(),
  z
    .object({
      destination: z.literal('PROVIDER'),
      initiativeId,
      invoiceFileId: fileId,
      providerName: singleLine(PROVIDER_NAME_MIN, PROVIDER_NAME_MAX),
      providerTaxId: z.string().max(20),
      iban: z.string().max(42)
    })
    .strict()
]);
export type CampaignPayoutRequest = z.infer<typeof requestCampaignPayoutSchema>;
export const payoutInitiativeSchema = z.object({ initiativeId }).strict();

/** Datos del proveedor ya validados y normalizados, o el motivo por el que no valen. */
export function validateProvider(input: { providerTaxId: string; iban: string }): { taxId: string; iban: string; last4: string; bank: string } {
  const iban = validateIban(input.iban);
  if (!iban.valid) throw new CampaignPayoutError('INVALID_IBAN');
  const taxId = validateTaxId(input.providerTaxId);
  if (!taxId.valid) throw new CampaignPayoutError('INVALID_TAX_ID');
  return { taxId: taxId.normalized, iban: iban.normalized, last4: iban.last4, bank: iban.normalized.slice(4, 8) };
}

/** HMAC del IBAN y el CIF del proveedor: lo que firman las dos personas sin que nadie tenga que descifrarlos. */
export const beneficiaryDigest = (secret: string, provider: { iban: string; taxId: string }): string => dataHmac(secret, 'payout-beneficiary-v1', JSON.stringify([provider.iban, provider.taxId]));

export interface PayoutFiguresInput {
  raisedCents: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  absorbsGatewayCostByKorum: boolean;
}

/** Neto para la entidad = recaudado − (tramo + mantenimiento) − pasarela incluida en la meta. El excedente sobre la meta es íntegro de la entidad (Regla 02 §1). */
export function payoutFigures(initiative: PayoutFiguresInput): { netPaidCents: number; korumFeeSettledCents: number; gatewayInGoalCents: number } {
  const gatewayInGoalCents = initiative.absorbsGatewayCostByKorum ? 0 : initiative.gatewayFeeCents;
  const korumFeeSettledCents = initiative.bracketFeeCents + initiative.maintFeeCents;
  return { netPaidCents: initiative.raisedCents - korumFeeSettledCents - gatewayInGoalCents, korumFeeSettledCents, gatewayInGoalCents };
}

/** ¿Siguen valiendo las cifras de una liquidación pedida? Un contracargo posterior las descuadra y hay que volver a pedirla (y a firmarla). */
export function payoutFiguresMatch(payout: { netPaidCents: number; korumFeeSettledCents: number }, initiative: PayoutFiguresInput): boolean {
  const current = payoutFigures(initiative);
  return payout.netPaidCents === current.netPaidCents && payout.korumFeeSettledCents === current.korumFeeSettledCents;
}

/** Una campaña de presupuesto paga una obra o un equipamiento: su factura (o proforma) va siempre adjunta. */
export const invoiceRequired = (format: 'BUDGET' | 'TICKETING'): boolean => format === 'BUDGET';

/** Último día para repartir desde el primer cobro (90 días de Paycomet) y cuántos quedan, redondeando hacia abajo. */
export function payoutWindow(firstChargeAt: Date | null, now: Date): { deadline: Date; daysLeft: number } | null {
  if (!firstChargeAt) return null;
  const deadline = new Date(firstChargeAt.getTime() + SPLIT_WINDOW_DAYS * DAY_MS);
  return { deadline, daysLeft: Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / DAY_MS)) };
}
