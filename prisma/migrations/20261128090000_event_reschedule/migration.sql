-- Sprint 5.13 · Reglas de las entradas (decisión 30 del promotor). Un evento puede cambiar de fecha: cada comprador de antes del cambio recibe un aviso con
-- un enlace personal para recuperar el 100 % durante 14 días, y mientras ese plazo siga abierto la entidad no liquida. Cada cambio es una fila que no se
-- reescribe ni se borra: sus fechas y su plazo son la prueba de lo que se prometió a quien compró. Solo avanza el reparto de los avisos (cursor, recuento y
-- fin, una vez) y quien lo hizo puede quedar vacío (supresión de su cuenta).

CREATE TABLE "EventReschedule" (
    "id" SERIAL NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "previousDate" TIMESTAMP(3) NOT NULL,
    "newDate" TIMESTAMP(3) NOT NULL,
    "refundUntil" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cursorId" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "noticesCompletedAt" TIMESTAMP(3),

    CONSTRAINT "EventReschedule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EventReschedule_dates_check" CHECK ("newDate" <> "previousDate" AND "refundUntil" > "createdAt"),
    CONSTRAINT "EventReschedule_counters_check" CHECK ("cursorId" >= 0 AND "queuedCount" >= 0)
);

CREATE INDEX "EventReschedule_initiativeId_refundUntil_idx" ON "EventReschedule"("initiativeId", "refundUntil");
CREATE INDEX "EventReschedule_noticesCompletedAt_id_idx" ON "EventReschedule"("noticesCompletedAt", "id");

ALTER TABLE "EventReschedule" ADD CONSTRAINT "EventReschedule_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "event_reschedule_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Los cambios de fecha de los eventos no se vacían.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un cambio de fecha no se borra (EventReschedule %).', OLD."id";
  END IF;
  IF NEW."initiativeId" IS DISTINCT FROM OLD."initiativeId" OR NEW."previousDate" IS DISTINCT FROM OLD."previousDate" OR NEW."newDate" IS DISTINCT FROM OLD."newDate"
     OR NEW."refundUntil" IS DISTINCT FROM OLD."refundUntil" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."createdById" IS DISTINCT FROM OLD."createdById" AND NEW."createdById" IS NOT NULL) THEN
    RAISE EXCEPTION 'Las fechas de un cambio de fecha no se reescriben (EventReschedule %).', OLD."id";
  END IF;
  IF NEW."cursorId" < OLD."cursorId" OR NEW."queuedCount" < OLD."queuedCount" OR (OLD."noticesCompletedAt" IS NOT NULL AND NEW."noticesCompletedAt" IS DISTINCT FROM OLD."noticesCompletedAt") THEN
    RAISE EXCEPTION 'El reparto de los avisos de un cambio de fecha solo avanza (EventReschedule %).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "EventReschedule_keep_history"
  BEFORE UPDATE OR DELETE ON "EventReschedule"
  FOR EACH ROW
  EXECUTE FUNCTION "event_reschedule_keep_history"();

CREATE TRIGGER "EventReschedule_no_truncate"
  BEFORE TRUNCATE ON "EventReschedule"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "event_reschedule_keep_history"();

-- Momento en que KORUM emite cada pase al procesar el pago ("createdAt" es la hora del cobro que da el banco, que puede ser anterior). Con él se encuentra a
-- quien terminó de pagar después de un cambio de fecha para enviarle su aviso. Los pases que ya existían toman la hora de esta migración.
ALTER TABLE "TicketPass" ADD COLUMN "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
