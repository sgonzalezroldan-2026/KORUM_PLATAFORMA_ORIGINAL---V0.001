-- Sprint 5.12a · Retirada de las rifas (decisión 31 del promotor, 2026-11-18; CUMPLIMIENTO §8).
-- Se quitan el subtipo de taquilla `RAFFLE`, los premios (`Initiative.rafflePrizeCount` y su guarda), los números de las papeletas (`RaffleNumber`,
-- `TicketPass.raffleNumbers`, `TicketPass.isWinner`), las actas del sorteo y sus rondas (`RaffleDraw` y sus guardas de inmutabilidad), el plazo de
-- reclamación de un premio (ajuste `raffle.extraRoundMinHours`) y los avisos de ronda extra que esperan en la bandeja de salida.
--
-- No hay datos reales que migrar (la plataforma no ha cobrado nunca de verdad). En una base de demostración ya sembrada, una rifa que existiera pasa a ser
-- un **evento con entradas**: sus cobros, asientos y pases se conservan tal cual (el libro mayor es inmutable y debe seguir cuadrando), sus papeletas pasan a
-- ser entradas con su serie `PASE-` y su número de premios desaparece. Las guardas del libro mayor y de la auditoría no se tocan.
--
-- La categoría fija de la taquilla deja de llamarse «Taquilla y Rifas» y pasa a «Taquilla» en la plataforma, en cada entidad, en cada campaña y en cada
-- idea, con la regla que tuviera. Una categoría que ya se llamara «Taquilla» (propia de una entidad o global) pasa antes a «Taquilla (propia)» (paso 6).

-- 1. Guarda de los premios: ya no hay premios que fijar.
DROP TRIGGER IF EXISTS "Initiative_prize_count_locked" ON "Initiative";
DROP FUNCTION IF EXISTS "initiative_prize_count_locked"();
ALTER TABLE "Initiative" DROP CONSTRAINT IF EXISTS "Initiative_rafflePrizeCount_positive";
ALTER TABLE "Initiative" DROP COLUMN "rafflePrizeCount";

-- 2. Actas del sorteo y sus guardas de inmutabilidad (solo protegían el acta; las del libro mayor y de la auditoría siguen).
DROP TRIGGER IF EXISTS "RaffleDraw_immutable" ON "RaffleDraw";
DROP TRIGGER IF EXISTS "RaffleDraw_no_truncate" ON "RaffleDraw";
DROP TABLE "RaffleDraw";
DROP FUNCTION IF EXISTS "raffle_draw_append_only"();

-- 3. Números de las papeletas.
DROP TABLE "RaffleNumber";
ALTER TABLE "TicketPass" DROP COLUMN "raffleNumbers";
ALTER TABLE "TicketPass" DROP COLUMN "isWinner";

-- 4. Lo que fuera rifa en una base de demostración pasa a ser un evento con entradas (la serie del pase no forma parte de su firma QR).
UPDATE "TicketPass" SET "serialCode" = 'PASE-' || substr("serialCode", 6) WHERE "serialCode" LIKE 'RIFA-%';
UPDATE "TicketPass" SET "subtype" = 'EVENT' WHERE "subtype" = 'RAFFLE';
UPDATE "Initiative" SET "ticketSubtype" = 'EVENT' WHERE "ticketSubtype" = 'RAFFLE';

-- 5. El tipo de taquilla se queda solo con `EVENT` (PostgreSQL no quita un valor de un tipo enumerado: se sustituye el tipo entero).
ALTER TYPE "TicketSubtype" RENAME TO "TicketSubtype_retired";
CREATE TYPE "TicketSubtype" AS ENUM ('EVENT');
ALTER TABLE "Initiative" ALTER COLUMN "ticketSubtype" TYPE "TicketSubtype" USING ("ticketSubtype"::text::"TicketSubtype");
ALTER TABLE "TicketPass" ALTER COLUMN "subtype" DROP DEFAULT;
ALTER TABLE "TicketPass" ALTER COLUMN "subtype" TYPE "TicketSubtype" USING ("subtype"::text::"TicketSubtype");
ALTER TABLE "TicketPass" ALTER COLUMN "subtype" SET DEFAULT 'EVENT';
DROP TYPE "TicketSubtype_retired";

-- 6. La categoría fija de la taquilla: «Taquilla y Rifas» → «Taquilla». A partir de aquí el código trata «Taquilla» como la categoría fija (al 0 %, fuera
--    del buzón de ideas y solo para taquillas), así que una categoría que alguien ya hubiera creado con ese nombre (propia de una entidad o global del
--    Super-Admin) es otra cosa: se renombra antes a «Taquilla (propia)», con su regla y con las campañas e ideas que la usan. Si ese nombre ya se usara
--    en cualquier sitio (otra categoría global o de una entidad, una campaña o una idea) mientras quede alguna «Taquilla», la migración se detiene en
--    lugar de mezclar dos categorías: también entre niveles, porque una categoría propia manda sobre la global del mismo nombre en su entidad.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "GlobalCategory" WHERE "name" = 'Taquilla' UNION ALL SELECT 1 FROM "OrganizationCategory" WHERE "name" = 'Taquilla')
     AND EXISTS (
       SELECT 1 FROM "GlobalCategory" WHERE "name" = 'Taquilla (propia)'
       UNION ALL SELECT 1 FROM "OrganizationCategory" WHERE "name" = 'Taquilla (propia)'
       UNION ALL SELECT 1 FROM "Initiative" WHERE "category" = 'Taquilla (propia)'
       UNION ALL SELECT 1 FROM "Idea" WHERE "category" = 'Taquilla (propia)'
     ) THEN
    RAISE EXCEPTION 'KORUM_RETIRE_RAFFLES: ya existe una categoría «Taquilla» y el nombre «Taquilla (propia)» ya se usa; renombra una de las dos antes de migrar.';
  END IF;
END $$;
UPDATE "GlobalCategory" SET "name" = 'Taquilla (propia)' WHERE "name" = 'Taquilla';
UPDATE "OrganizationCategory" SET "name" = 'Taquilla (propia)' WHERE "name" = 'Taquilla';
UPDATE "Initiative" SET "category" = 'Taquilla (propia)' WHERE "category" = 'Taquilla';
UPDATE "Idea" SET "category" = 'Taquilla (propia)' WHERE "category" = 'Taquilla';

UPDATE "GlobalCategory" SET "name" = 'Taquilla' WHERE "name" = 'Taquilla y Rifas';
UPDATE "OrganizationCategory" SET "name" = 'Taquilla' WHERE "name" = 'Taquilla y Rifas';
UPDATE "Initiative" SET "category" = 'Taquilla' WHERE "category" = 'Taquilla y Rifas';
UPDATE "Idea" SET "category" = 'Taquilla' WHERE "category" = 'Taquilla y Rifas';

-- Los emails de un pase que aún no han salido llevan la serie con la que se emitió: la de la base acaba de cambiar a `PASE-`, así que la suya también
-- (es el nombre de los adjuntos del QR y del calendario), y dejan de llevar los números de las papeletas.
UPDATE "OutboxMessage"
  SET "payloadJson" = jsonb_set("payloadJson", '{serialCode}', to_jsonb('PASE-' || substr("payloadJson"->>'serialCode', 6))) - 'raffleNumbers'
  WHERE "templateKey" = 'ticket.pass' AND "status"::text IN ('PENDING', 'SENDING', 'FAILED') AND "payloadJson"->>'serialCode' LIKE 'RIFA-%';

-- 7. El plazo de reclamación de un premio y los avisos de ronda extra (llevan el nombre de quien la hizo: no se dejan sin plantilla que los envíe ni
--    fuera del alcance de la supresión de datos).
DELETE FROM "PlatformSetting" WHERE "key" = 'raffle.extraRoundMinHours';
DELETE FROM "OutboxMessage" WHERE "templateKey" = 'raffle.extraRound';
