-- Sprint 4.4a · Liquidación de una campaña conseguida con doble firma, cierre y avisos a quienes aportaron.
-- (1) El IBAN y el CIF/NIF del proveedor de una liquidación dejan de guardarse en claro (heredado del Sprint 2.5, CUMPLIMIENTO §5.2): se cifran con el
--     contexto de su iniciativa y la huella de las firmas usa su HMAC. Aún no hay datos reales (los cobros reales empiezan en el 6.1): las columnas en
--     claro se retiran sin copiar nada, y la semilla las vuelve a crear con el formato nuevo.
-- (2) Lo firmado de una liquidación no cambia fuera de la espera de firmas, el estado solo avanza y nada se borra (como el Fondo de actividades, 4.2f).
-- (3) Un reparto que ya no se puede enviar se anula (`CANCELLED`) y se replanifica desde otros cobros.
-- (4) Avisos a quienes aportaron, por lotes (`SupporterBroadcast`), y la fecha de cierre de la iniciativa.

ALTER TYPE "JobType" ADD VALUE 'SUPPORTER_BROADCAST';
ALTER TYPE "OpsAlertType" ADD VALUE 'PAYOUT_BLOCKED';
ALTER TYPE "PayoutSplitStatus" ADD VALUE 'CANCELLED';

-- Por defecto, a la cuenta de la entidad: pagar a un tercero es siempre una elección expresa.
ALTER TABLE "EscrowPayout" ALTER COLUMN "destinationType" SET DEFAULT 'ORGANIZATION';
ALTER TABLE "EscrowPayout" DROP COLUMN "beneficiaryIban";
ALTER TABLE "EscrowPayout" DROP COLUMN "providerCif";
ALTER TABLE "EscrowPayout" ADD COLUMN "beneficiaryIbanEnc" TEXT;
ALTER TABLE "EscrowPayout" ADD COLUMN "providerCifEnc" TEXT;
ALTER TABLE "EscrowPayout" ADD COLUMN "beneficiaryKeyVersion" INTEGER;
ALTER TABLE "EscrowPayout" ADD COLUMN "beneficiaryDigest" TEXT;
ALTER TABLE "EscrowPayout" ADD COLUMN "beneficiaryIbanLast4" TEXT;
-- Código del banco (dígitos 5 a 8 del IBAN): con los 4 últimos, quien firma reconoce la cuenta sin verla entera (auditoría de seguridad del 4.4a, I1).
ALTER TABLE "EscrowPayout" ADD COLUMN "beneficiaryIbanBank" TEXT;
ALTER TABLE "EscrowPayout" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "EscrowPayout" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "EscrowPayout" ADD COLUMN "updatedAt" TIMESTAMP(3);
-- Un pago a un proveedor lleva sus datos cifrados y su huella; uno a la entidad, ninguno de los dos.
ALTER TABLE "EscrowPayout" ADD CONSTRAINT "EscrowPayout_beneficiary_by_destination" CHECK (
  ("destinationType" = 'PROVIDER' AND "beneficiaryIbanEnc" IS NOT NULL AND "providerCifEnc" IS NOT NULL AND "beneficiaryDigest" IS NOT NULL AND "beneficiaryKeyVersion" IS NOT NULL)
  OR ("destinationType" = 'ORGANIZATION' AND "beneficiaryIbanEnc" IS NULL AND "providerCifEnc" IS NULL AND "beneficiaryDigest" IS NULL AND "beneficiaryKeyVersion" IS NULL AND "beneficiaryIbanLast4" IS NULL AND "beneficiaryIbanBank" IS NULL)
);
ALTER TABLE "EscrowPayout" ADD CONSTRAINT "EscrowPayout_amounts_valid" CHECK ("netPaidCents" > 0 AND "korumFeeSettledCents" >= 0);

ALTER TABLE "Initiative" ADD COLUMN "closedAt" TIMESTAMP(3);

CREATE TABLE "SupporterBroadcast" (
    "id" SERIAL NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "templateKey" TEXT NOT NULL,
    "cursorId" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SupporterBroadcast_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupporterBroadcast_initiativeId_templateKey_key" ON "SupporterBroadcast"("initiativeId", "templateKey");
CREATE INDEX "SupporterBroadcast_completedAt_id_idx" ON "SupporterBroadcast"("completedAt", "id");
ALTER TABLE "SupporterBroadcast" ADD CONSTRAINT "SupporterBroadcast_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lo que se firma de una liquidación (importes, destino, titular, huella del IBAN y del CIF, factura) solo cambia mientras espera la doble firma: después
-- las firmas valen para eso y nada más. La entidad y la iniciativa no cambian nunca; la cuenta destino, una vez fijada al aprobar, tampoco. El estado solo
-- avanza: PENDING_DOUBLE_CHECK → APPROVED → PROCESSING ↔ FAILED → EXECUTED. Los datos cifrados sí pueden reescribirse (rotación de clave): su huella no.
CREATE FUNCTION "escrow_payout_keep_history"() RETURNS trigger AS $$
DECLARE
  probe "EscrowPayout";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una liquidación no se borra (EscrowPayout %).', OLD."id";
  END IF;
  -- Una escritura que no cambia nada es el bloqueo de la fila (firmar, aprobar): siempre se permite. Tampoco se impide volver a cifrar el IBAN y el
  -- CIF con la clave nueva (rotación), también en una liquidación ya hecha: su huella, que es lo firmado, no cambia.
  probe := NEW;
  probe."beneficiaryIbanEnc" := OLD."beneficiaryIbanEnc";
  probe."providerCifEnc" := OLD."providerCifEnc";
  probe."beneficiaryKeyVersion" := OLD."beneficiaryKeyVersion";
  IF ROW(probe.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
    RETURN NEW;
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."initiativeId" IS DISTINCT FROM OLD."initiativeId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."status" = 'EXECUTED'
     OR (OLD."destinationSplitId" IS NOT NULL AND NEW."destinationSplitId" IS DISTINCT FROM OLD."destinationSplitId") THEN
    RAISE EXCEPTION 'La liquidación % ya no se puede cambiar.', OLD."id";
  END IF;
  IF OLD."status" <> 'PENDING_DOUBLE_CHECK' AND (
       NEW."netPaidCents" IS DISTINCT FROM OLD."netPaidCents" OR NEW."korumFeeSettledCents" IS DISTINCT FROM OLD."korumFeeSettledCents"
    OR NEW."destinationType" IS DISTINCT FROM OLD."destinationType" OR NEW."beneficiaryName" IS DISTINCT FROM OLD."beneficiaryName"
    OR NEW."beneficiaryDigest" IS DISTINCT FROM OLD."beneficiaryDigest" OR NEW."beneficiaryIbanLast4" IS DISTINCT FROM OLD."beneficiaryIbanLast4"
    OR NEW."beneficiaryIbanBank" IS DISTINCT FROM OLD."beneficiaryIbanBank"
    OR NEW."providerInvoiceFileId" IS DISTINCT FROM OLD."providerInvoiceFileId" OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
  ) THEN
    RAISE EXCEPTION 'Lo firmado de la liquidación % ya no se puede cambiar.', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING_DOUBLE_CHECK' AND NEW."status" = 'APPROVED')
    OR (OLD."status" = 'APPROVED' AND NEW."status" = 'PROCESSING')
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('FAILED', 'EXECUTED'))
    OR (OLD."status" = 'FAILED' AND NEW."status" IN ('PROCESSING', 'EXECUTED'))
  ) THEN
    RAISE EXCEPTION 'La liquidación % no puede pasar de % a %.', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "EscrowPayout_keep_history"
  BEFORE UPDATE OR DELETE ON "EscrowPayout"
  FOR EACH ROW
  EXECUTE FUNCTION "escrow_payout_keep_history"();

-- Un reparto es de un cobro de la misma entidad y de la misma iniciativa (o de un patrocinio asignado a ella), y solo se crea en una liquidación ya
-- aprobada; después solo cambia su envío. Hecho o anulado, ya no cambia; solo se anula uno que aún no se ha enviado.
CREATE FUNCTION "escrow_payout_split_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un reparto de una liquidación no se borra (EscrowPayoutSplit %).', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "EscrowPayout" p JOIN "Contribution" c ON c."id" = NEW."contributionId"
      WHERE p."id" = NEW."payoutId" AND p."status" IN ('APPROVED', 'PROCESSING', 'FAILED') AND c."organizationId" = p."organizationId"
        AND (c."initiativeId" = p."initiativeId" OR EXISTS (SELECT 1 FROM "SponsorAllocation" a WHERE a."contributionId" = c."id" AND a."initiativeId" = p."initiativeId"))
    ) THEN
      RAISE EXCEPTION 'El reparto no casa liquidación aprobada, entidad, iniciativa y cobro (liquidación %, cobro %).', NEW."payoutId", NEW."contributionId";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."payoutId" IS DISTINCT FROM OLD."payoutId" OR NEW."contributionId" IS DISTINCT FROM OLD."contributionId"
     OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."status" IN ('DONE', 'CANCELLED') THEN
    RAISE EXCEPTION 'El reparto % solo cambia su envío, y no después de hecho o anulado.', OLD."id";
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" NOT IN ('PENDING', 'FAILED') THEN
    RAISE EXCEPTION 'Solo se anula un reparto que aún no se ha enviado (reparto %).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "EscrowPayoutSplit_keep_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "EscrowPayoutSplit"
  FOR EACH ROW
  EXECUTE FUNCTION "escrow_payout_split_keep_history"();
