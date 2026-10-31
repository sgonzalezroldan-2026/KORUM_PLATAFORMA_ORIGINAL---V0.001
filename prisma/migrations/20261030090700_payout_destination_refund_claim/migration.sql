-- La cuenta destino se fija al aprobar la liquidación: las firmas valen para esa cuenta.
ALTER TABLE "EscrowPayout" ADD COLUMN "destinationSplitId" TEXT;

-- Reserva de una devolución antes de pedirla a Paycomet: mientras esté puesta, no se vuelve a pedir.
ALTER TABLE "Contribution" ADD COLUMN "refundSendingAt" TIMESTAMP(3);
