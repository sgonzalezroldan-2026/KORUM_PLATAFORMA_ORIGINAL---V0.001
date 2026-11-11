-- Sprint 4.4a (auditoría financiera, I1) · Un cobro puede volver a una liquidación con otro importe si su reparto anterior se anuló sin enviarse
-- (replanificación): la unicidad solo cuenta los repartos vivos. Va en una migración aparte porque el valor CANCELLED se añadió en la anterior y
-- PostgreSQL no deja usar un valor nuevo de un enum en la misma transacción que lo crea.
DROP INDEX "EscrowPayoutSplit_payoutId_contributionId_key";
CREATE UNIQUE INDEX "EscrowPayoutSplit_live_payout_contribution_key" ON "EscrowPayoutSplit"("payoutId", "contributionId") WHERE "status" <> 'CANCELLED';
CREATE INDEX "EscrowPayoutSplit_payoutId_contributionId_idx" ON "EscrowPayoutSplit"("payoutId", "contributionId");
