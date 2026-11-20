-- Sprint 5.14c · Vales: puesto con lector, devolución de 14 días, caducidad, cierre, cancelación y liquidación (decisiones 32, 49, 69, 70 y 71 del promotor).
-- Una venta de vales que la entidad cancela queda marcada: los vales dejan de gastarse y nadie más compra. Antes de liquidarla, la plataforma devuelve a cada
-- persona lo que no haya gastado (con el dinero aún retenido); después, avisa y responde la entidad.

ALTER TABLE "Initiative" ADD COLUMN "voucherCancelledAt" TIMESTAMP(3);

-- Solo una venta de vales publicada se cancela así: un evento con entradas tiene su propia cancelación (Sprint 5.13), que devuelve el 100 %.
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_voucher_cancelled_check"
  CHECK ("voucherCancelledAt" IS NULL OR ("ticketSubtype" IS NOT DISTINCT FROM 'VOUCHER' AND "quotaReservedAt" IS NOT NULL));

-- Una cancelación no se deshace ni se cambia de fecha: una vez avisadas las personas que compraron, sus vales no vuelven a valer.
CREATE OR REPLACE FUNCTION "initiative_voucher_cancel_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."voucherCancelledAt" IS NOT NULL AND NEW."voucherCancelledAt" IS DISTINCT FROM OLD."voucherCancelledAt" THEN
    RAISE EXCEPTION 'La cancelación de una venta de vales no se deshace ni se cambia (iniciativa %).', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "Initiative_voucher_cancel_guard"
  BEFORE UPDATE OF "voucherCancelledAt" ON "Initiative"
  FOR EACH ROW
  EXECUTE FUNCTION "initiative_voucher_cancel_guard"();

-- La última vez que la entidad acortó la validez de los vales: durante 14 días, quien compró antes recupera lo no gastado y la venta no se liquida.
ALTER TABLE "Initiative" ADD COLUMN "voucherValidityShortenedAt" TIMESTAMP(3);
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_voucher_shortened_check"
  CHECK ("voucherValidityShortenedAt" IS NULL OR "ticketSubtype" IS NOT DISTINCT FROM 'VOUCHER');

-- Devolución de lo no gastado de una compra de vales en la que ya se gastó algún vale.
-- `ON_HOLD`: llegó un contracargo o una devolución por otro importe de ese cobro; no se envía y lo revisa una persona.
CREATE TYPE "PartialRefundStatus" AS ENUM ('PENDING', 'ON_HOLD', 'REFUNDED');

CREATE TABLE "PartialRefund" (
    "id" SERIAL NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "vouchers" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "escrowCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "status" "PartialRefundStatus" NOT NULL DEFAULT 'PENDING',
    "sendingAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartialRefund_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PartialRefund_figures_check" CHECK ("vouchers" > 0 AND "escrowCents" >= 0 AND "feeCents" >= 0 AND "amountCents" > 0 AND "amountCents" = "escrowCents" + "feeCents"),
    CONSTRAINT "PartialRefund_reason_check" CHECK ("reason" IN ('VOUCHER_SALE_CANCELLED', 'VOUCHER_VALIDITY_SHORTENED')),
    CONSTRAINT "PartialRefund_status_check" CHECK (("status" = 'REFUNDED') = ("refundedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "PartialRefund_contributionId_key" ON "PartialRefund"("contributionId");
CREATE INDEX "PartialRefund_status_sendingAt_idx" ON "PartialRefund"("status", "sendingAt");
CREATE INDEX "PartialRefund_initiativeId_idx" ON "PartialRefund"("initiativeId");

ALTER TABLE "PartialRefund" ADD CONSTRAINT "PartialRefund_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartialRefund" ADD CONSTRAINT "PartialRefund_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartialRefund" ADD CONSTRAINT "PartialRefund_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Una devolución es dinero: sus cifras no se reescriben, no se borra y su estado solo avanza (aprobada → (retenida) → devuelta). Una retenida no vuelve a
-- pendiente: se enviaría a Paycomet aunque el banco ya hubiera retirado el cobro.
CREATE OR REPLACE FUNCTION "partial_refund_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Una devolución parcial no se borra.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."contributionId" <> OLD."contributionId" OR NEW."initiativeId" <> OLD."initiativeId" OR NEW."organizationId" <> OLD."organizationId" OR NEW."reason" <> OLD."reason"
     OR NEW."vouchers" <> OLD."vouchers" OR NEW."amountCents" <> OLD."amountCents" OR NEW."escrowCents" <> OLD."escrowCents" OR NEW."feeCents" <> OLD."feeCents"
     OR NEW."createdAt" <> OLD."createdAt" OR (OLD."status" = 'REFUNDED' AND (NEW."status" <> 'REFUNDED' OR NEW."refundedAt" IS DISTINCT FROM OLD."refundedAt"))
     OR (OLD."status" = 'ON_HOLD' AND NEW."status" = 'PENDING') THEN
    RAISE EXCEPTION 'Una devolución parcial no se reescribe (PartialRefund %).', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "PartialRefund_keep_history"
  BEFORE UPDATE OR DELETE ON "PartialRefund"
  FOR EACH ROW
  EXECUTE FUNCTION "partial_refund_keep_history"();

CREATE TRIGGER "PartialRefund_no_truncate"
  BEFORE TRUNCATE ON "PartialRefund"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "partial_refund_keep_history"();
