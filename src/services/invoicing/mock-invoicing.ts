import { InvoicingProviderError, type InvoiceRegistrationResult, type InvoicingProvider } from './invoicing-provider';
import { computeVerifactuHash, type VerifactuRecord } from './verifactu-record';

/**
 * Simulador determinista del proveedor de facturación. Hace lo que hace la AEAT: recalcula la huella, y si no coincide la marca como
 * «Aceptada con errores». `failNext` permite probar los rechazos y los cortes de conexión.
 */
export class MockInvoicingProvider implements InvoicingProvider {
  readonly name = 'mock';
  readonly registered: Array<{ record: VerifactuRecord; hash: string }> = [];
  failNext: InvoicingProviderError | null = null;

  async registerInvoice(record: VerifactuRecord, hash: string): Promise<InvoiceRegistrationResult> {
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = null;
      throw failure;
    }
    this.registered.push({ record, hash });
    return { status: computeVerifactuHash(record) === hash ? 'ACCEPTED' : 'ACCEPTED_WITH_ERRORS', providerReference: `MOCK-${record.invoiceNumber}` };
  }
}

export const unknownOutcome = () => new InvoicingProviderError('CONNECTION_LOST', true);
export const rejectedByProvider = () => new InvoicingProviderError('REJECTED', false);
