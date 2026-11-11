import { beneficiaryDigest } from '@/core/payouts/campaign-payout-rules';
import { openProviderBeneficiary } from '@/core/payouts/payout-beneficiary-vault';
import type { Keyring } from '@/core/security/crypto';
import type { Db } from '@/lib/db';
import type { PaymentProvider } from '@/services/payments/payment-provider';
import type { ProviderDestination } from '@/services/payments/split-transfer.service';

/**
 * Cuenta de Paycomet del proveedor de una liquidación (Sprint 4.4a), resuelta desde su IBAN y su CIF descifrados en el servidor, y la huella que dan (la
 * aprobación comprueba que es la firmada). Vive fuera de `services/payments`, que nunca toca un IBAN: una devolución vuelve siempre al cobro original
 * (Regla 02 §8). Solo la usa el pago a un proveedor elegido por la entidad con doble firma y factura. Sin `providerPayoutAccount` en el proveedor de pagos
 * (pendiente de Paycomet), no hay destino y la aprobación lo rechaza.
 */
export async function providerDestinationOf(db: Db, provider: PaymentProvider, deps: { secret: string; keyring: Keyring }, payoutId: number): Promise<ProviderDestination | undefined> {
  const payout = await db.escrowPayout.findUniqueOrThrow({
    where: { id: payoutId },
    select: { destinationType: true, initiativeId: true, beneficiaryName: true, beneficiaryIbanEnc: true, providerCifEnc: true, beneficiaryKeyVersion: true }
  });
  if (payout.destinationType !== 'PROVIDER' || !provider.providerPayoutAccount || !payout.beneficiaryIbanEnc || !payout.providerCifEnc) return undefined;
  const beneficiary = openProviderBeneficiary(deps.keyring, { ...payout, beneficiaryIbanEnc: payout.beneficiaryIbanEnc, providerCifEnc: payout.providerCifEnc });
  const splitId = await provider.providerPayoutAccount({ ...beneficiary, name: payout.beneficiaryName });
  return { splitId, beneficiaryDigest: beneficiaryDigest(deps.secret, beneficiary) };
}
