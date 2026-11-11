-- Sprint 4.7 · Endurecimiento de la ronda extra y de la puerta (decisiones del promotor, 2026-11-11).
--  · `RaffleDraw.replacedNumbers`: en una ronda extra, qué números ganadores sustituye (uno por premio nuevo), para que la otra persona firmante pueda
--    comprobar lo que se declaró. La tabla es inmutable (triggers de UPDATE/DELETE/TRUNCATE): añadir la columna no los toca. El `CHECK` se añade `NOT VALID`
--    (solo exige lo nuevo) por si hubiera rondas extra anteriores sin esta información.
--  · `Initiative.gateCode`: código no adivinable de la puerta (10 caracteres en base 32), único; va en el enlace de la portería en lugar del identificador numérico.

ALTER TABLE "RaffleDraw" ADD COLUMN "replacedNumbers" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "RaffleDraw" ADD CONSTRAINT "RaffleDraw_replaced_matches_round" CHECK (
  ("extraRoundReason" IS NULL AND cardinality("replacedNumbers") = 0) OR ("extraRoundReason" IS NOT NULL AND cardinality("replacedNumbers") = cardinality("winningNumbers"))
) NOT VALID;

ALTER TABLE "Initiative" ADD COLUMN "gateCode" TEXT;
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_gateCode_format" CHECK ("gateCode" IS NULL OR "gateCode" ~ '^[a-z2-7]{10}$');
CREATE UNIQUE INDEX "Initiative_gateCode_key" ON "Initiative"("gateCode");
