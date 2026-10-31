-- Repartos de una liquidación: Paycomet reparte cobro a cobro, y cada reparto se registra antes de enviarlo para poder reanudar sin pagar dos veces.
CREATE TYPE "PayoutSplitStatus" AS ENUM ('PENDING', 'SENDING', 'DONE', 'FAILED');

CREATE TABLE "EscrowPayoutSplit" (
    "id" SERIAL NOT NULL,
    "payoutId" INTEGER NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PayoutSplitStatus" NOT NULL DEFAULT 'PENDING',
    "splitAuthCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowPayoutSplit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EscrowPayoutSplit_amountCents_positive" CHECK ("amountCents" > 0)
);

CREATE INDEX "EscrowPayoutSplit_payoutId_status_idx" ON "EscrowPayoutSplit"("payoutId", "status");
CREATE UNIQUE INDEX "EscrowPayoutSplit_payoutId_contributionId_key" ON "EscrowPayoutSplit"("payoutId", "contributionId");

ALTER TABLE "EscrowPayoutSplit" ADD CONSTRAINT "EscrowPayoutSplit_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "EscrowPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowPayoutSplit" ADD CONSTRAINT "EscrowPayoutSplit_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
