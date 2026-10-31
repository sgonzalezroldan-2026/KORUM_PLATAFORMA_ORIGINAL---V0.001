import type { DoubleCheckTargetType, MemberRole, PayoutDestination } from '@/generated/prisma/enums';
import { dataHmac, safeEqual } from './data-hmac';

/**
 * Huella de la doble firma. `targetDigest` resume lo que se firma (importe y cuenta destino de una liquidación, texto de una idea) y entra
 * en `signatureHash`: si después cambia cualquiera de esos datos, o alguien edita la fila de la firma, la firma deja de valer. También entra
 * la fila del cargo (`membershipId`): quien pierde el rol no recupera su firma aunque se lo vuelvan a dar.
 */

const toText = (parts: ReadonlyArray<string | number | null>) => JSON.stringify(parts);

export function payoutTargetDigest(
  secret: string,
  payout: { organizationId: string; netPaidCents: number; korumFeeSettledCents: number; destinationType: PayoutDestination; beneficiaryName: string; beneficiaryIban: string; providerCif: string | null; providerInvoiceFileId: string | null },
  destinationAccount: string | null
): string {
  return dataHmac(
    secret,
    'double-check-target-payout-v1',
    toText([payout.organizationId, payout.netPaidCents, payout.korumFeeSettledCents, payout.destinationType, destinationAccount, payout.beneficiaryName, payout.beneficiaryIban, payout.providerCif, payout.providerInvoiceFileId])
  );
}

export function ideaTargetDigest(secret: string, idea: { organizationId: string; title: string; category: string; description: string }): string {
  return dataHmac(secret, 'double-check-target-idea-v1', toText([idea.organizationId, idea.title, idea.category, idea.description]));
}

export interface SignatureHashInput {
  organizationId: string;
  targetType: DoubleCheckTargetType;
  targetId: number;
  targetDigest: string;
  signerUserId: string;
  signerRole: MemberRole;
  membershipId: number;
  signedAt: Date;
  otpVerifiedAt: Date | null;
}

export function computeSignatureHash(secret: string, input: SignatureHashInput): string {
  return dataHmac(
    secret,
    'double-check-signature-v1',
    toText([input.organizationId, input.targetType, input.targetId, input.targetDigest, input.signerUserId, input.signerRole, input.membershipId, input.signedAt.toISOString(), input.otpVerifiedAt?.toISOString() ?? null])
  );
}

export function verifySignatureHash(secret: string, input: SignatureHashInput, signatureHash: string): boolean {
  return safeEqual(computeSignatureHash(secret, input), signatureHash);
}
