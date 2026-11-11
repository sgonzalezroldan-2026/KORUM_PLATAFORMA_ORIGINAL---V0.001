import type { DoubleCheckTargetType, MemberRole, PayoutDestination } from '@/generated/prisma/enums';
import { dataHmac, safeEqual } from './data-hmac';

/**
 * Huella de la doble firma. `targetDigest` resume lo que se firma (importe y cuenta destino de una liquidación, texto de una idea) y entra
 * en `signatureHash`: si después cambia cualquiera de esos datos, o alguien edita la fila de la firma, la firma deja de valer. También entra
 * la fila del cargo (`membershipId`): quien pierde el rol no recupera su firma aunque se lo vuelvan a dar.
 */

const toText = (parts: ReadonlyArray<string | number | null>) => JSON.stringify(parts);

/** Lo que se firma de una liquidación de campaña (Sprint 4.4a): sin el IBAN ni el CIF en claro, que van cifrados; su HMAC y el contenido de la factura. */
export interface PayoutDigestInput {
  organizationId: string;
  netPaidCents: number;
  korumFeeSettledCents: number;
  destinationType: PayoutDestination;
  beneficiaryName: string;
  /** HMAC del IBAN y el CIF del proveedor (`beneficiaryDigest`); nulo si el destino es la entidad. */
  beneficiaryDigest: string | null;
  providerInvoiceFileId: string | null;
  /** Huella SHA-256 del contenido de la factura adjunta: cambiar el fichero (aunque conserve su id) invalida las firmas (heredado del Sprint 2.2). */
  providerInvoiceSha256: string | null;
}

export function payoutTargetDigest(secret: string, payout: PayoutDigestInput, destinationAccount: string | null): string {
  return dataHmac(
    secret,
    'double-check-target-payout-v2',
    toText([
      payout.organizationId,
      payout.netPaidCents,
      payout.korumFeeSettledCents,
      payout.destinationType,
      destinationAccount,
      payout.beneficiaryName,
      payout.beneficiaryDigest,
      payout.providerInvoiceFileId,
      payout.providerInvoiceSha256
    ])
  );
}

/**
 * Huella de una liquidación tal como está guardada. La cuenta destino que se firma es la de la entidad en Paycomet si el dinero va a ella; si va a un
 * proveedor, su cuenta la fija el IBAN (ya dentro de `beneficiaryDigest`) y un cambio de la cuenta de la entidad no invalida esas firmas.
 */
export function payoutDigestFor(
  secret: string,
  payout: Omit<PayoutDigestInput, 'providerInvoiceSha256'> & { providerInvoiceFile: { sha256: string } | null },
  organizationSplitId: string | null
): string {
  const { providerInvoiceFile, ...rest } = payout;
  return payoutTargetDigest(secret, { ...rest, providerInvoiceSha256: providerInvoiceFile?.sha256 ?? null }, payout.destinationType === 'PROVIDER' ? null : organizationSplitId);
}

/**
 * Liquidación del Fondo de actividades (Sprint 4.2f): importe, destino escrito por la entidad (el justificante de uso), cuenta destino y de qué comercio
 * es cada parte. Si cambia cualquiera de esos datos, las firmas dejan de valer.
 */
export function activityFundTargetDigest(
  secret: string,
  payout: { id: number; organizationId: string; amountCents: number; purpose: string; splits: ReadonlyArray<{ sponsorId: number; amountCents: number }> },
  destinationAccount: string | null
): string {
  const parts = [...payout.splits].sort((a, b) => a.sponsorId - b.sponsorId).flatMap((split) => [split.sponsorId, split.amountCents]);
  return dataHmac(secret, 'double-check-target-activity-fund-v1', toText([payout.organizationId, payout.id, payout.amountCents, payout.purpose, destinationAccount, ...parts]));
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
