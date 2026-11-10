-- Sprint 4.2f · Fondo de actividades de la entidad (decisión del promotor del 2026-11-10).
-- El dinero de un comercio admitido no se le devuelve nunca: si su bolsa (`SPONSOR_CREDIT_POOL`) vence sin campaña a la que llevarlo, pasa al Fondo de
-- actividades de la entidad (`ORG_ACTIVITY_FUND`, por comercio), que lo liquida a su cuenta con doble firma, cobro a cobro desde el pedido original del
-- comercio y dentro de los 90 días de Paycomet. La bolsa pasa al Fondo el día 70 desde el cobro como mucho, para dejar días de firma.

ALTER TYPE "LedgerAccount" ADD VALUE 'ORG_ACTIVITY_FUND';
ALTER TYPE "LedgerJournalKind" ADD VALUE 'ACTIVITY_FUND_DEPOSIT';
ALTER TYPE "LedgerJournalKind" ADD VALUE 'ACTIVITY_FUND_PAYOUT_APPROVAL';
ALTER TYPE "DoubleCheckTargetType" ADD VALUE 'ACTIVITY_FUND_PAYOUT';
ALTER TYPE "OpsAlertType" ADD VALUE 'ACTIVITY_FUND_WINDOW';
ALTER TYPE "OpsAlertType" ADD VALUE 'SPONSOR_MONEY_BLOCKED';

CREATE TYPE "ActivityFundPayoutStatus" AS ENUM ('PENDING_DOUBLE_CHECK', 'APPROVED', 'PROCESSING', 'EXECUTED', 'FAILED', 'CANCELLED');

-- Invitación a renovar a un comercio que no marcó «renovar cada año»: una vez por año de distintivo.
ALTER TABLE "Sponsor" ADD COLUMN "renewalInvitedAt" TIMESTAMP(3);

-- La bolsa no puede esperar más de 70 días: pasado ese día del cobro el dinero va al Fondo y aún quedan 20 para firmar su liquidación. Un valor anterior
-- mayor se acota antes de añadir la restricción, para que la migración no falle.
UPDATE "GlobalConfig" SET "creditPoolMaxDays" = LEAST(GREATEST("creditPoolMaxDays", 1), 70) WHERE "creditPoolMaxDays" NOT BETWEEN 1 AND 70;
ALTER TABLE "GlobalConfig" ADD CONSTRAINT "GlobalConfig_credit_pool_days_check" CHECK ("creditPoolMaxDays" BETWEEN 1 AND 70);

ALTER TABLE "DoubleCheckSignature" ADD COLUMN "fundPayoutId" INTEGER;
ALTER TABLE "DoubleCheckChallenge" ADD COLUMN "fundPayoutId" INTEGER;

CREATE TABLE "ActivityFundDeposit" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sponsorId" INTEGER NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityFundDeposit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ActivityFundDeposit_amount_check" CHECK ("amountCents" > 0)
);

CREATE TABLE "ActivityFundPayout" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "ActivityFundPayoutStatus" NOT NULL DEFAULT 'PENDING_DOUBLE_CHECK',
    "requestedById" TEXT NOT NULL,
    "destinationSplitId" TEXT,
    "cancelReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityFundPayout_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ActivityFundPayout_amount_check" CHECK ("amountCents" > 0),
    CONSTRAINT "ActivityFundPayout_purpose_check" CHECK (char_length("purpose") BETWEEN 10 AND 500),
    CONSTRAINT "ActivityFundPayout_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
);

CREATE TABLE "ActivityFundSplit" (
    "id" SERIAL NOT NULL,
    "payoutId" INTEGER NOT NULL,
    "sponsorId" INTEGER NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PayoutSplitStatus" NOT NULL DEFAULT 'PENDING',
    "splitAuthCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityFundSplit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ActivityFundSplit_amount_check" CHECK ("amountCents" > 0)
);

CREATE INDEX "ActivityFundDeposit_organizationId_createdAt_idx" ON "ActivityFundDeposit"("organizationId", "createdAt");
CREATE INDEX "ActivityFundDeposit_sponsorId_idx" ON "ActivityFundDeposit"("sponsorId");
CREATE INDEX "ActivityFundPayout_organizationId_status_idx" ON "ActivityFundPayout"("organizationId", "status");
CREATE INDEX "ActivityFundSplit_payoutId_status_idx" ON "ActivityFundSplit"("payoutId", "status");
CREATE INDEX "ActivityFundSplit_contributionId_idx" ON "ActivityFundSplit"("contributionId");
CREATE UNIQUE INDEX "ActivityFundSplit_payoutId_sponsorId_key" ON "ActivityFundSplit"("payoutId", "sponsorId");
-- Una sola liquidación esperando la doble firma por entidad: lo que reserva para sí no lo puede pedir otra a la vez.
CREATE UNIQUE INDEX "ActivityFundPayout_one_pending_key" ON "ActivityFundPayout"("organizationId") WHERE "status" = 'PENDING_DOUBLE_CHECK';
CREATE UNIQUE INDEX "DoubleCheckSignature_targetType_fundPayoutId_signerRole_key" ON "DoubleCheckSignature"("targetType", "fundPayoutId", "signerRole");
CREATE INDEX "DoubleCheckChallenge_targetType_fundPayoutId_signerUserId_idx" ON "DoubleCheckChallenge"("targetType", "fundPayoutId", "signerUserId");

ALTER TABLE "ActivityFundDeposit" ADD CONSTRAINT "ActivityFundDeposit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityFundDeposit" ADD CONSTRAINT "ActivityFundDeposit_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityFundDeposit" ADD CONSTRAINT "ActivityFundDeposit_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityFundPayout" ADD CONSTRAINT "ActivityFundPayout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityFundPayout" ADD CONSTRAINT "ActivityFundPayout_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityFundSplit" ADD CONSTRAINT "ActivityFundSplit_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "ActivityFundPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityFundSplit" ADD CONSTRAINT "ActivityFundSplit_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityFundSplit" ADD CONSTRAINT "ActivityFundSplit_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DoubleCheckSignature" ADD CONSTRAINT "DoubleCheckSignature_fundPayoutId_fkey" FOREIGN KEY ("fundPayoutId") REFERENCES "ActivityFundPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DoubleCheckChallenge" ADD CONSTRAINT "DoubleCheckChallenge_fundPayoutId_fkey" FOREIGN KEY ("fundPayoutId") REFERENCES "ActivityFundPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Una firma o un enlace de firma de una liquidación del Fondo apuntan a ella y solo a ella (y al revés).
ALTER TABLE "DoubleCheckSignature" ADD CONSTRAINT "DoubleCheckSignature_fund_target_check" CHECK ((("targetType")::text = 'ACTIVITY_FUND_PAYOUT') = ("fundPayoutId" IS NOT NULL));
ALTER TABLE "DoubleCheckChallenge" ADD CONSTRAINT "DoubleCheckChallenge_fund_target_check" CHECK ((("targetType")::text = 'ACTIVITY_FUND_PAYOUT') = ("fundPayoutId" IS NOT NULL));

-- Una entrada en el Fondo es el rastro de dónde acabó el dinero de un comercio: no se edita ni se borra, y casa comercio, cobro y entidad.
CREATE FUNCTION "activity_fund_deposit_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Una entrada del Fondo de actividades no se edita ni se borra (ActivityFundDeposit %).', OLD."id";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Sponsor" s JOIN "Contribution" c ON c."sponsorId" = s."id"
    WHERE s."id" = NEW."sponsorId" AND c."id" = NEW."contributionId" AND s."organizationId" = NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'La entrada del Fondo % no casa comercio, cobro y entidad.', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "ActivityFundDeposit_keep_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ActivityFundDeposit"
  FOR EACH ROW
  EXECUTE FUNCTION "activity_fund_deposit_keep_history"();

-- Lo que se firma de una liquidación (entidad, importe, destino, quién la pidió) no cambia una vez creada; tampoco se borra. La cuenta destino, una vez
-- fijada al aprobar, tampoco; y el estado solo avanza: PENDING_DOUBLE_CHECK → APPROVED | CANCELLED, APPROVED → PROCESSING, PROCESSING ↔ FAILED,
-- PROCESSING | FAILED → EXECUTED (auditorías del 4.2f).
CREATE FUNCTION "activity_fund_payout_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una liquidación del Fondo de actividades no se borra (ActivityFundPayout %).', OLD."id";
  END IF;
  -- Una escritura que no cambia nada es el bloqueo de la fila (firmar, aprobar): siempre se permite.
  IF ROW(NEW.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
    RETURN NEW;
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents" OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."status" IN ('EXECUTED', 'CANCELLED')
     OR (OLD."destinationSplitId" IS NOT NULL AND NEW."destinationSplitId" IS DISTINCT FROM OLD."destinationSplitId") THEN
    RAISE EXCEPTION 'La liquidación del Fondo % ya no se puede cambiar.', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING_DOUBLE_CHECK' AND NEW."status" IN ('APPROVED', 'CANCELLED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" = 'PROCESSING')
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('FAILED', 'EXECUTED'))
    OR (OLD."status" = 'FAILED' AND NEW."status" IN ('PROCESSING', 'EXECUTED'))
  ) THEN
    RAISE EXCEPTION 'La liquidación del Fondo % no puede pasar de % a %.', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "ActivityFundPayout_keep_history"
  BEFORE UPDATE OR DELETE ON "ActivityFundPayout"
  FOR EACH ROW
  EXECUTE FUNCTION "activity_fund_payout_keep_history"();

-- Un reparto es de un comercio de la misma entidad que la liquidación y de su propio cobro; después solo cambia su estado de envío.
CREATE FUNCTION "activity_fund_split_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un reparto del Fondo de actividades no se borra (ActivityFundSplit %).', OLD."id";
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."payoutId" IS DISTINCT FROM OLD."payoutId" OR NEW."sponsorId" IS DISTINCT FROM OLD."sponsorId" OR NEW."contributionId" IS DISTINCT FROM OLD."contributionId"
       OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR OLD."status" = 'DONE' THEN
      RAISE EXCEPTION 'El reparto del Fondo % solo cambia su envío, y no después de hecho.', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ActivityFundPayout" p JOIN "Sponsor" s ON s."organizationId" = p."organizationId" JOIN "Contribution" c ON c."sponsorId" = s."id"
    WHERE p."id" = NEW."payoutId" AND s."id" = NEW."sponsorId" AND c."id" = NEW."contributionId"
  ) THEN
    RAISE EXCEPTION 'El reparto del Fondo % no casa liquidación, comercio y cobro.', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "ActivityFundSplit_keep_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ActivityFundSplit"
  FOR EACH ROW
  EXECUTE FUNCTION "activity_fund_split_keep_history"();
