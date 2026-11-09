import { getKeyring } from '@/config/keyring';
import type { Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import type { InvoicingContext } from '@/services/payments/sponsorship-events';
import { getSetting } from '@/services/settings/settings.service';

/**
 * Lo que necesita un cobro para facturar dentro del webhook: el NIF emisor y la razón social de `/admin/ajustes` (con respaldo en
 * `VERIFACTU_ISSUER_NIF` y `VERIFACTU_ISSUER_NAME`) y el llavero con el que se cifra el NIF del destinatario. `undefined` si falta cualquiera de
 * los dos: un patrocinio con fee falla entonces y Paycomet reintenta la notificación cuando el Super-Admin lo configure, en lugar de asentar un fee
 * que no se puede facturar o de emitir una factura sin emisor (heredado del Sprint 3.5, punto 11).
 *
 * Se lee **antes** de abrir la transacción del webhook: dentro de ella necesitaría una segunda conexión (con una sola, como la base local, se
 * bloquearía). Si el ajuste no se puede leer o no es válido, se avisa y se trata como «sin datos del emisor»: los cobros de donaciones y entradas
 * no dependen de él.
 */
export async function loadInvoicingContext(db: Db): Promise<InvoicingContext | undefined> {
  try {
    const [issuerTaxId, issuerName] = await Promise.all([getSetting(db, 'invoicing.issuerNif'), getSetting(db, 'invoicing.issuerName')]);
    return issuerTaxId && issuerName ? { issuerTaxId, issuerName, keyring: getKeyring() } : undefined;
  } catch (error) {
    reportError(error, { stage: 'invoicing-context' });
    return undefined;
  }
}
