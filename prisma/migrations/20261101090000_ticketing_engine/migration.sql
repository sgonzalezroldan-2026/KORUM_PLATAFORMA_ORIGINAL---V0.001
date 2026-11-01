-- Reserva de plazas: `ticketsSold` solo cuenta lo pagado y `ticketsHeld` lo que está en pago.
ALTER TABLE "Initiative" ADD COLUMN "ticketsHeld" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Contribution" ADD COLUMN "ticketQuantity" INTEGER;
ALTER TABLE "Contribution" ADD COLUMN "ticketHoldUntil" TIMESTAMP(3);
CREATE INDEX "Contribution_initiativeId_ticketHoldUntil_idx" ON "Contribution"("initiativeId", "ticketHoldUntil");

UPDATE "Contribution" AS c SET "ticketQuantity" = p."quantity" FROM "TicketPass" AS p WHERE p."contributionId" = c."id";

-- Última defensa contra la sobreventa: aunque un error del código saltara el bloqueo, la base de datos rechaza pasarse del aforo.
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_tickets_within_capacity"
  CHECK ("ticketsSold" >= 0 AND "ticketsHeld" >= 0 AND ("ticketMax" IS NULL OR "ticketsSold" + "ticketsHeld" <= "ticketMax"));
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_ticketQuantity_positive" CHECK ("ticketQuantity" IS NULL OR "ticketQuantity" > 0);

-- Pases: anulación, y nunca más accesos que entradas.
ALTER TABLE "TicketPass" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "TicketPass" ADD CONSTRAINT "TicketPass_checkins_within_quantity" CHECK ("checkedInCount" >= 0 AND "checkedInCount" <= "quantity");

-- Números de rifa: la clave primaria impide vender dos veces el mismo.
CREATE TABLE "RaffleNumber" (
  "initiativeId" INTEGER NOT NULL,
  "number" INTEGER NOT NULL,
  "ticketPassId" INTEGER NOT NULL,
  CONSTRAINT "RaffleNumber_pkey" PRIMARY KEY ("initiativeId", "number"),
  CONSTRAINT "RaffleNumber_number_positive" CHECK ("number" > 0)
);
CREATE INDEX "RaffleNumber_ticketPassId_idx" ON "RaffleNumber"("ticketPassId");
ALTER TABLE "RaffleNumber" ADD CONSTRAINT "RaffleNumber_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RaffleNumber" ADD CONSTRAINT "RaffleNumber_ticketPassId_fkey" FOREIGN KEY ("ticketPassId") REFERENCES "TicketPass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Actas de sorteo.
CREATE TABLE "RaffleDraw" (
  "id" SERIAL NOT NULL,
  "initiativeId" INTEGER NOT NULL,
  "round" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "extraRoundReason" TEXT,
  "participantsJson" JSONB NOT NULL,
  "participantsSha256" TEXT NOT NULL,
  "winningNumbers" INTEGER[],
  "actSha256" TEXT NOT NULL,
  "drawnByType" TEXT NOT NULL,
  "drawnById" TEXT NOT NULL,
  "drawnAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RaffleDraw_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RaffleDraw_initiativeId_round_key" ON "RaffleDraw"("initiativeId", "round");
CREATE UNIQUE INDEX "RaffleDraw_initiativeId_idempotencyKey_key" ON "RaffleDraw"("initiativeId", "idempotencyKey");
ALTER TABLE "RaffleDraw" ADD CONSTRAINT "RaffleDraw_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "raffle_draw_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'KORUM_IMMUTABLE: el acta de un sorteo no se modifica ni se borra.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RaffleDraw_immutable" BEFORE UPDATE OR DELETE ON "RaffleDraw" FOR EACH ROW EXECUTE FUNCTION "raffle_draw_append_only"();
CREATE TRIGGER "RaffleDraw_no_truncate" BEFORE TRUNCATE ON "RaffleDraw" FOR EACH STATEMENT EXECUTE FUNCTION "raffle_draw_append_only"();

-- Los premios de una rifa se fijan antes de vender: si no, se podría ampliar la cifra para repetir el sorteo.
ALTER TABLE "Initiative" ADD COLUMN "rafflePrizeCount" INTEGER;
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_rafflePrizeCount_positive" CHECK ("rafflePrizeCount" IS NULL OR "rafflePrizeCount" > 0);

CREATE FUNCTION "initiative_prize_count_locked"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'KORUM_IMMUTABLE: los premios de una rifa no cambian una vez a la venta (iniciativa %).', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Initiative_prize_count_locked"
  BEFORE UPDATE ON "Initiative"
  FOR EACH ROW
  WHEN (OLD."rafflePrizeCount" IS DISTINCT FROM NEW."rafflePrizeCount" AND OLD."status"::text <> 'BUDGETING')
  EXECUTE FUNCTION "initiative_prize_count_locked"();

-- Una operación, una factura; y el NIF con el que se calculó su huella.
ALTER TABLE "Invoice" ADD COLUMN "issuerTaxId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Invoice_idempotencyKey_key" ON "Invoice"("idempotencyKey");
