-- Sprint 4.2b · Moderación de comercios amigos. Rechazar a un comercio ya cobrado le devuelve el 100 % (nivel, fee e IVA) y rectifica la
-- factura del fee: una rectificativa por diferencias (`R1`, importes en negativo) que apunta a la factura que corrige. Una factura se rectifica
-- una sola vez (índice único). Las facturas anteriores son todas completas (`F1`).
-- Aviso a la consola: la factura del fee de un patrocinio devuelto por otra vía (panel de Paycomet, contracargo) queda pendiente de rectificar.
ALTER TYPE "OpsAlertType" ADD VALUE 'INVOICE_RECTIFY_PENDING';

ALTER TABLE "Invoice" ADD COLUMN "invoiceType" TEXT NOT NULL DEFAULT 'F1';
ALTER TABLE "Invoice" ADD COLUMN "rectifiesInvoiceId" INTEGER;
-- Razón social del emisor tal como era al emitir: una factura emitida no cambia aunque el Super-Admin cambie el ajuste.
ALTER TABLE "Invoice" ADD COLUMN "issuerName" TEXT;

-- Solo dos tipos, y una rectificativa siempre dice qué factura corrige (y una completa, ninguna).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_invoiceType_check" CHECK ("invoiceType" IN ('F1', 'R1'));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_rectification_check" CHECK (("invoiceType" = 'R1') = ("rectifiesInvoiceId" IS NOT NULL));

CREATE UNIQUE INDEX "Invoice_rectifiesInvoiceId_key" ON "Invoice"("rectifiesInvoiceId");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_rectifiesInvoiceId_fkey" FOREIGN KEY ("rectifiesInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
