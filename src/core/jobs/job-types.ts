import type { Db } from '@/lib/db';
import type { InvoicingProvider } from '@/services/invoicing/invoicing-provider';
import type { PaymentProvider } from '@/services/payments/payment-provider';

/**
 * Lo que recibe cada tarea programada. Los proveedores externos son perezosos: una tarea que no cobra ni factura (p. ej. la purga) no
 * descifra credenciales de Paycomet ni exige proveedor de facturación.
 */
export interface JobDeps {
  paymentProvider: () => Promise<PaymentProvider>;
  invoicingProvider: () => InvoicingProvider;
  /** IP que se envía a Paycomet en las devoluciones: `Contribution` no guarda la del cobro. Suposición contra el simulador (bitácora 2.4). */
  refundOriginalIp: () => Promise<string>;
}

export interface JobContext {
  db: Db;
  now: Date;
  /** Registros que esta ejecución puede procesar. */
  batchSize: number;
  /** Instante (ms desde 1970) pasado el cual no conviene empezar trabajo nuevo: la función de Vercel tiene un límite y es el mismo para toda la llamada. */
  deadline?: number;
  deps: JobDeps;
}

export interface JobResult {
  /** Registros tratados en esta ejecución. */
  processed: number;
  /** Quedan más por tratar: la siguiente ejecución los recoge. */
  hasMore: boolean;
  /** Recuentos adicionales para el rastro (sin datos personales). */
  detail?: Record<string, number>;
}

export type JobHandler = (context: JobContext) => Promise<JobResult>;
