-- Sprint 4.2d · Renovación de comercios amigos, reasignación de patrocinios y bolsa CREDIT_POOL.
-- El patrocinio de una campaña que fracasa no se devuelve: pasa a la bolsa de su comercio (`SPONSOR_CREDIT_POOL`) y desde ella a otra campaña activa
-- según la regla de la entidad (`sponsorRenewalRule`). La bolsa tiene plazo: `min(creditPoolMaxDays desde la entrada, 85 días desde el cobro)`, por
-- la ventana de 90 días de Paycomet; al vencer se devuelve al comercio. La renovación anual es un cobro nuevo (fila nueva) que entra en la bolsa y se
-- coloca con la misma regla.
ALTER TABLE "Sponsor" ADD COLUMN "creditPoolAt" TIMESTAMP(3);
ALTER TABLE "Sponsor" ADD COLUMN "reassignedCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Sponsor" ADD COLUMN "renewedFromId" INTEGER;

CREATE INDEX "Sponsor_renewedFromId_idx" ON "Sponsor"("renewedFromId");
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lo reasignado nunca pasa del nivel; un patrocinio en la bolsa tiene fecha de entrada, y uno fuera de ella no; una renovación no se renueva a sí misma.
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_reassigned_check" CHECK ("reassignedCents" >= 0 AND "reassignedCents" <= "amountCents");
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_credit_pool_check" CHECK (("status" = 'CREDIT_POOL') = ("creditPoolAt" IS NOT NULL));
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_renewal_check" CHECK ("renewedFromId" IS NULL OR "renewedFromId" <> "id");
-- Un año se renueva una sola vez: dos pedidos del mismo enlace pagados no pueden dejar dos renovaciones cobradas (el segundo se devuelve entero).
CREATE UNIQUE INDEX "Sponsor_one_paid_renewal_key" ON "Sponsor"("renewedFromId") WHERE "paidAt" IS NOT NULL;

CREATE TABLE "SponsorAllocation" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sponsorId" INTEGER NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SponsorAllocation_initiativeId_withdrawnAt_idx" ON "SponsorAllocation"("initiativeId", "withdrawnAt");
CREATE INDEX "SponsorAllocation_sponsorId_withdrawnAt_idx" ON "SponsorAllocation"("sponsorId", "withdrawnAt");
ALTER TABLE "SponsorAllocation" ADD CONSTRAINT "SponsorAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SponsorAllocation" ADD CONSTRAINT "SponsorAllocation_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SponsorAllocation" ADD CONSTRAINT "SponsorAllocation_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SponsorAllocation" ADD CONSTRAINT "SponsorAllocation_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SponsorAllocation" ADD CONSTRAINT "SponsorAllocation_amount_check" CHECK ("amountCents" > 0);

-- Una asignación es el rastro de dónde estuvo el dinero de un comercio (y de qué cobro reparte la liquidación): no se borra, y lo único que cambia es
-- su cierre, una sola vez. La campaña que la recibe es de la misma entidad que el comercio y el cobro es el suyo.
CREATE FUNCTION "sponsor_allocation_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una asignación de patrocinio no se borra (SponsorAllocation %).', OLD."id";
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."sponsorId" IS DISTINCT FROM OLD."sponsorId" OR NEW."contributionId" IS DISTINCT FROM OLD."contributionId"
       OR NEW."initiativeId" IS DISTINCT FROM OLD."initiativeId" OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR (OLD."withdrawnAt" IS NOT NULL AND NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt") THEN
      RAISE EXCEPTION 'Una asignación de patrocinio solo se cierra, una vez (SponsorAllocation %).', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Sponsor" s
    JOIN "Contribution" c ON c."sponsorId" = s."id"
    JOIN "Initiative" i ON i."id" = NEW."initiativeId"
    WHERE s."id" = NEW."sponsorId" AND c."id" = NEW."contributionId" AND s."organizationId" = NEW."organizationId" AND i."organizationId" = NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'La asignación % no casa comercio, cobro, campaña y entidad.', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "SponsorAllocation_keep_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "SponsorAllocation"
  FOR EACH ROW
  EXECUTE FUNCTION "sponsor_allocation_keep_history"();
