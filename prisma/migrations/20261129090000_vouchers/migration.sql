-- Sprint 5.14a · Vales: el motor (decisión 32 del promotor, con las 49 y las del 2026-11-19). Una venta de vales es una taquilla (`TICKETING`) de tipo
-- `VOUCHER`: precio único por vale, tope opcional (`ticketMax` vacío = sin tope), fecha de validez que fija la entidad y, si la entidad lo activa, la
-- aportación «sin producto» al agotarse. Cada compra tiene un solo pase con su saldo (`quantity − checkedInCount`, que la base ya no deja pasar de
-- `quantity`) y cada canje es una lectura (`TicketCheckIn`) con su puesto y su hora. El libro mayor no cambia: un vale se asienta como una entrada.

-- 1. El tipo de taquilla gana `VOUCHER`. Se sustituye el tipo entero (como en la retirada de las rifas) para poder usar el valor nuevo en las guardas de abajo
--    dentro de esta misma migración: un valor añadido con `ADD VALUE` no se puede usar hasta confirmar la transacción.
ALTER TYPE "TicketSubtype" RENAME TO "TicketSubtype_before_vouchers";
CREATE TYPE "TicketSubtype" AS ENUM ('EVENT', 'VOUCHER');
ALTER TABLE "Initiative" ALTER COLUMN "ticketSubtype" TYPE "TicketSubtype" USING ("ticketSubtype"::text::"TicketSubtype");
ALTER TABLE "TicketPass" ALTER COLUMN "subtype" DROP DEFAULT;
ALTER TABLE "TicketPass" ALTER COLUMN "subtype" TYPE "TicketSubtype" USING ("subtype"::text::"TicketSubtype");
ALTER TABLE "TicketPass" ALTER COLUMN "subtype" SET DEFAULT 'EVENT';
DROP TYPE "TicketSubtype_before_vouchers";

-- 2. Tarifa propia de los vales: fijo por compra + porcentaje sobre el importe de la compra. La global y la copia de cada entidad (las entidades sin
--    tarifa propia la igualan a la global al guardarla en la consola). Arrancan con los valores de las entradas.
ALTER TABLE "GlobalConfig" ADD COLUMN "voucherFeeFixedCents" INTEGER NOT NULL DEFAULT 45;
ALTER TABLE "GlobalConfig" ADD COLUMN "voucherFeeBps" INTEGER NOT NULL DEFAULT 200;
ALTER TABLE "GlobalConfig" ADD CONSTRAINT "GlobalConfig_voucher_fee_check" CHECK ("voucherFeeFixedCents" >= 0 AND "voucherFeeBps" BETWEEN 0 AND 10000);
UPDATE "GlobalConfig" SET "voucherFeeFixedCents" = "ticketFeeFixedCents", "voucherFeeBps" = "ticketFeeBps";

ALTER TABLE "Organization" ADD COLUMN "voucherFeeFixedCents" INTEGER NOT NULL DEFAULT 45;
ALTER TABLE "Organization" ADD COLUMN "voucherFeeBps" INTEGER NOT NULL DEFAULT 200;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_voucher_fee_check" CHECK ("voucherFeeFixedCents" >= 0 AND "voucherFeeBps" BETWEEN 0 AND 10000);
UPDATE "Organization" SET "voucherFeeFixedCents" = "ticketFeeFixedCents", "voucherFeeBps" = "ticketFeeBps";

-- 3. La venta de vales: validez y aportación «sin producto». Solo una venta de vales los lleva, y una venta publicada siempre tiene su validez.
ALTER TABLE "Initiative" ADD COLUMN "voucherValidUntil" TIMESTAMP(3);
ALTER TABLE "Initiative" ADD COLUMN "voucherNoProductEnabled" BOOLEAN NOT NULL DEFAULT false;
-- `IS NOT DISTINCT FROM`: con el tipo vacío (una campaña de presupuesto) la comparación simple daría NULL y la guarda dejaría pasar la fila.
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_voucher_fields_check"
  CHECK (("voucherValidUntil" IS NULL AND NOT "voucherNoProductEnabled") OR "ticketSubtype" IS NOT DISTINCT FROM 'VOUCHER');
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_voucher_published_check"
  CHECK ("ticketSubtype" IS DISTINCT FROM 'VOUCHER' OR "status" IN ('BUDGETING', 'CANCELLED') OR ("voucherValidUntil" IS NOT NULL AND "format" = 'TICKETING'));

-- 4. La aportación «sin producto»: es un cobro de la venta (tipo `TICKET`, sin certificado y fuera del Modelo 182) sin vales, sin pase y sin plaza retenida.
ALTER TABLE "Contribution" ADD COLUMN "voucherNoProduct" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_voucher_no_product_check"
  CHECK (NOT "voucherNoProduct" OR ("type" = 'TICKET' AND "ticketQuantity" IS NULL AND "ticketHoldUntil" IS NULL));
