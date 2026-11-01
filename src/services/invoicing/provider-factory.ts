import type { InvoicingProvider } from './invoicing-provider';
import { MockInvoicingProvider } from './mock-invoicing';

/** Con cobros reales no vale el simulador: una factura simulada no cumpliría Veri*factu. Falla al pedirlo, no al emitir la primera factura. */
export function getInvoicingProvider(paycometMode: 'mock' | 'sandbox' | 'live'): InvoicingProvider {
  if (paycometMode === 'live') throw new Error('Veri*factu: falta elegir el proveedor homologado antes de operar con cobros reales (ficha 6.1).');
  return new MockInvoicingProvider();
}
