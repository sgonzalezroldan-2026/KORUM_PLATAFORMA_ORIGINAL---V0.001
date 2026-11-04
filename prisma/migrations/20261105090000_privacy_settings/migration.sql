-- Sprint 2.5 · Ajustes cifrados, auditoría y privacidad RGPD.

-- Nuevas alertas de operación.
ALTER TYPE "OpsAlertType" ADD VALUE 'CARD_DELETE_FAILED';
ALTER TYPE "OpsAlertType" ADD VALUE 'PRIVACY_REQUEST_OVERDUE';
ALTER TYPE "OpsAlertType" ADD VALUE 'ENCRYPTION_KEY_MISSING';
ALTER TYPE "OpsAlertType" ADD VALUE 'PRIVACY_ERASURE_FAILED';

-- Actividad de la cuenta, para el plazo de conservación de las cuentas sin uso (CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD §6).
ALTER TABLE "User" ADD COLUMN "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "User" ADD COLUMN "inactivityNoticeAt" TIMESTAMP(3);
CREATE INDEX "User_gdprAnonymizedAt_lastActiveAt_idx" ON "User"("gdprAnonymizedAt", "lastActiveAt");

-- El NIF de comercios y destinatarios de factura deja de guardarse en claro (CUMPLIMIENTO §5.2). La base no tiene la clave, así que
-- los valores anteriores no se pueden cifrar aquí: se descartan (antes de producción solo existen datos de demostración, que la semilla
-- vuelve a escribir cifrados).
ALTER TABLE "Sponsor" ADD COLUMN "cifEnc" TEXT;
ALTER TABLE "Sponsor" ADD COLUMN "cifKeyVersion" INTEGER;
ALTER TABLE "Sponsor" DROP COLUMN "cif";
ALTER TABLE "Invoice" ADD COLUMN "recipientTaxIdEnc" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "recipientTaxIdKeyVersion" INTEGER;
ALTER TABLE "Invoice" DROP COLUMN "recipientTaxId";

-- Borrado de la tarjeta en Paycomet al suprimir una cuenta.
ALTER TABLE "PaymentMethodToken" ADD COLUMN "providerDeletedAt" TIMESTAMP(3);

-- Reautenticación guardada en el servidor: quien llama no puede declarar que la persona acaba de verificar su identidad.
ALTER TABLE "Session" ADD COLUMN "reauthenticatedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "secondFactorVerifiedAt" TIMESTAMP(3);
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
