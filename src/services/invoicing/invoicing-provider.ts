import type { VerifactuRecord } from './verifactu-record';

/**
 * Proveedor de facturación homologado para Veri*factu (DECISIONES_TECNICAS §4). Ninguna otra parte de KORUM habla con él. Aún sin elegir: de
 * momento solo existe el simulador, y sin proveedor real no se emite con cobros reales.
 */

export type InvoiceRegistrationStatus = 'ACCEPTED' | 'ACCEPTED_WITH_ERRORS' | 'REJECTED';

export interface InvoiceRegistrationResult {
  status: InvoiceRegistrationStatus;
  providerReference: string;
}

export class InvoicingProviderError extends Error {
  readonly code: string;
  /** Se cortó la conexión y no se sabe si la factura quedó registrada: no se reintenta a ciegas. */
  readonly outcomeUnknown: boolean;

  constructor(code: string, outcomeUnknown: boolean) {
    super(`Fallo del proveedor de facturación: ${code}.`);
    this.name = 'InvoicingProviderError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export interface InvoicingProvider {
  readonly name: string;
  registerInvoice(record: VerifactuRecord, hash: string): Promise<InvoiceRegistrationResult>;
}
