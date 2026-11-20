-- Sprint 5.14b · Vales: Estudio, ficha, compra y pase. Una venta de vales sin tope lleva un objetivo orientativo de vales (decisión del promotor del
-- 2026-11-20): no limita la venta, pero da la barra de avance, la meta y con qué comparar el mantenimiento. Con tope, el tope ya hace ese papel.

ALTER TABLE "Initiative" ADD COLUMN "voucherTargetCount" INTEGER;

-- El objetivo solo existe en una venta de vales sin tope, y siempre es positivo.
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_voucher_target_check"
  CHECK ("voucherTargetCount" IS NULL OR ("ticketSubtype" IS NOT DISTINCT FROM 'VOUCHER' AND "ticketMax" IS NULL AND "voucherTargetCount" > 0));

-- Una venta de vales publicada tiene tope o, sin él, su objetivo: si no, su barra y su meta no tendrían con qué medirse.
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_voucher_published_target_check"
  CHECK ("ticketSubtype" IS DISTINCT FROM 'VOUCHER' OR "status" IN ('BUDGETING', 'CANCELLED') OR "ticketMax" IS NOT NULL OR "voucherTargetCount" IS NOT NULL);
