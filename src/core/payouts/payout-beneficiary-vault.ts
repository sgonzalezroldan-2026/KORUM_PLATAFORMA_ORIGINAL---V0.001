import { CRYPTO_CONTEXT, openValue, sealValue, type Keyring } from '@/core/security/crypto';

/**
 * Cifrado del IBAN y del CIF/NIF del proveedor de una liquidación (Sprint 4.4a, heredado del 2.5; CUMPLIMIENTO §5.2: un autónomo factura con su DNI y su
 * IBAN es personal). Cada dato con su contexto, atado a la iniciativa (una liquidación por iniciativa): no se puede trasladar a otra. Se cifran juntos y
 * comparten versión de clave. Solo se descifran en el servidor, al aprobar el pago (para resolver la cuenta del proveedor y comprobar que es la firmada).
 */

export function sealProviderBeneficiary(keyring: Keyring, initiativeId: number, provider: { iban: string; taxId: string }) {
  const iban = sealValue(keyring, provider.iban, CRYPTO_CONTEXT.payoutIban(initiativeId));
  const taxId = sealValue(keyring, provider.taxId, CRYPTO_CONTEXT.payoutTaxId(initiativeId));
  return { beneficiaryIbanEnc: iban.sealed, providerCifEnc: taxId.sealed, beneficiaryKeyVersion: iban.keyVersion };
}

export function openProviderBeneficiary(keyring: Keyring, payout: { initiativeId: number; beneficiaryIbanEnc: string; providerCifEnc: string; beneficiaryKeyVersion: number | null }): { iban: string; taxId: string } {
  return {
    iban: openValue(keyring, payout.beneficiaryIbanEnc, payout.beneficiaryKeyVersion, CRYPTO_CONTEXT.payoutIban(payout.initiativeId)),
    taxId: openValue(keyring, payout.providerCifEnc, payout.beneficiaryKeyVersion, CRYPTO_CONTEXT.payoutTaxId(payout.initiativeId))
  };
}
