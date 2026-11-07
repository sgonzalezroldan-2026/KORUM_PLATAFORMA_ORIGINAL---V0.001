-- Sprint 3.8 · Mi Hucha en modo PLEDGE: aportación mensual programada con tarjeta guardada.
-- `WalletSubscription.active` pasa a un estado con su motivo; la tarjeta llega con el primer cobro, así que es opcional hasta entonces.
CREATE TYPE "PledgeStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'FINISHED');
CREATE TYPE "PledgeStatusReason" AS ENUM ('BY_FAMILY', 'CHARGE_FAILED', 'CARD_UNAVAILABLE', 'FIRST_PAYMENT_FAILED', 'CARD_NOT_SAVED', 'REPLACED', 'ACCOUNT_ERASED', 'CHARGEBACK', 'PAUSE_EXPIRED');

ALTER TABLE "WalletSubscription"
  ADD COLUMN "initiativeId" INTEGER,
  ADD COLUMN "skippedMonths" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chargeDay" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "status" "PledgeStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "statusReason" "PledgeStatusReason",
  ADD COLUMN "statusChangedAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion" TEXT,
  ALTER COLUMN "paymentMethodTokenId" DROP NOT NULL;

UPDATE "WalletSubscription" SET "status" = CASE WHEN "active" THEN 'ACTIVE'::"PledgeStatus" ELSE 'CANCELLED'::"PledgeStatus" END;

DROP INDEX "WalletSubscription_active_nextChargeAt_idx";
ALTER TABLE "WalletSubscription" DROP COLUMN "active";
CREATE INDEX "WalletSubscription_status_nextChargeAt_idx" ON "WalletSubscription"("status", "nextChargeAt");
CREATE INDEX "WalletSubscription_userId_status_idx" ON "WalletSubscription"("userId", "status");
ALTER TABLE "WalletSubscription" ADD CONSTRAINT "WalletSubscription_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una sola aportación viva (activa o en pausa) por persona y entidad, aunque lleguen dos altas a la vez. Índice parcial: Prisma no lo modela.
CREATE UNIQUE INDEX "WalletSubscription_one_live_per_org_key" ON "WalletSubscription"("userId", "organizationId") WHERE "status" IN ('ACTIVE', 'PAUSED');

-- Defensa en la base: importes y meses siempre con sentido, y nunca más meses tratados que los acordados.
ALTER TABLE "WalletSubscription"
  ADD CONSTRAINT "WalletSubscription_amounts_check" CHECK ("monthlyAmountCents" > 0 AND "feePerMonthCents" >= 0),
  ADD CONSTRAINT "WalletSubscription_months_check" CHECK ("totalMonths" > 0 AND "executedMonths" >= 0 AND "skippedMonths" >= 0 AND "skippedMonths" <= "executedMonths" AND "executedMonths" <= "totalMonths"),
  ADD CONSTRAINT "WalletSubscription_chargeDay_check" CHECK ("chargeDay" BETWEEN 1 AND 28);

ALTER TABLE "Contribution" ADD COLUMN "walletSubscriptionId" INTEGER, ADD COLUMN "pledgeCycle" INTEGER;
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_walletSubscriptionId_fkey" FOREIGN KEY ("walletSubscriptionId") REFERENCES "WalletSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Un mes de una aportación mensual se cobra una sola vez, aunque la tarea corra dos veces a la vez.
CREATE UNIQUE INDEX "Contribution_walletSubscriptionId_pledgeCycle_key" ON "Contribution"("walletSubscriptionId", "pledgeCycle");
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_pledge_check" CHECK (("walletSubscriptionId" IS NULL) = ("pledgeCycle" IS NULL) AND ("pledgeCycle" IS NULL OR ("pledgeCycle" > 0 AND "type" = 'DONATION')));
