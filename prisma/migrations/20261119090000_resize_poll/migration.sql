-- Sprint 4.4b · Campañas vencidas: votación de redimensionamiento vinculante con derecho a devolución.
-- (1) La votación guarda quién la lanzó, la meta y lo recaudado al lanzarla, y al cerrarse el resultado (recuento, opción ganadora y meta nueva). Se cierra
--     en dos pasos si gana un proyecto (decisión del promotor, 2026-11-11): el recuento (`talliedAt`, con la opción ganadora) y, cuando se ha devuelto su
--     aportación a quien no votó un proyecto, el cierre con la meta nueva.
-- (2) Cada voto sale del enlace personal de una donación (`contributionId`): o elige una opción de proyecto o pide que le devuelvan su aportación.
-- (3) Una votación nace de una campaña de presupuesto vencida y no cambia sus opciones ni su plazo; su estado solo avanza y nada se borra ni se vacía; un voto se emite con la votación abierta, desde una donación completada, y después
--     solo se anonimiza (al suprimir la cuenta o al vencer su plazo de conservación, CUMPLIMIENTO §6).
-- Aún no hay votaciones reales (los cobros reales empiezan en el 6.1): las columnas obligatorias se añaden sin valor heredado.

ALTER TABLE "ResizePoll" ADD COLUMN "createdById" TEXT;
ALTER TABLE "ResizePoll" ADD COLUMN "originalGoalCents" INTEGER NOT NULL;
ALTER TABLE "ResizePoll" ADD COLUMN "raisedAtLaunchCents" INTEGER NOT NULL;
ALTER TABLE "ResizePoll" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "ResizePoll" ADD COLUMN "winningOptionIndex" INTEGER;
ALTER TABLE "ResizePoll" ADD COLUMN "newGoalCents" INTEGER;
ALTER TABLE "ResizePoll" ADD COLUMN "resultJson" JSONB;
ALTER TABLE "ResizePoll" ADD COLUMN "talliedAt" TIMESTAMP(3);
ALTER TABLE "ResizePoll" ADD CONSTRAINT "ResizePoll_amounts_valid" CHECK ("originalGoalCents" > 0 AND "raisedAtLaunchCents" > 0 AND ("newGoalCents" IS NULL OR "newGoalCents" > 0));
ALTER TABLE "ResizePoll" ADD CONSTRAINT "ResizePoll_closes_after_creation" CHECK ("closesAt" > "createdAt");
-- Cerrada a favor de un proyecto: con su recuento, su opción y su meta nueva. Cerrada sin proyecto (empate, sin votos): sin opción ni meta. Abierta: sin
-- cierre ni meta, y con opción solo si ya tiene el recuento (devolviendo a quien no votó).
ALTER TABLE "ResizePoll" ADD CONSTRAINT "ResizePoll_result_by_status" CHECK (
  ("status" = 'OPEN' AND "closedAt" IS NULL AND "newGoalCents" IS NULL AND ("winningOptionIndex" IS NULL OR ("talliedAt" IS NOT NULL AND "winningOptionIndex" >= 0)))
  OR ("status" = 'CLOSED_APPROVED' AND "closedAt" IS NOT NULL AND "talliedAt" IS NOT NULL AND "winningOptionIndex" >= 0 AND "newGoalCents" IS NOT NULL)
  OR ("status" = 'CLOSED_REJECTED' AND "closedAt" IS NOT NULL AND "winningOptionIndex" IS NULL AND "newGoalCents" IS NULL)
);
CREATE INDEX "ResizePoll_status_closesAt_idx" ON "ResizePoll"("status", "closesAt");


-- La donación desde la que se votó: obligatoria al votar; se suelta (`NULL`) solo al anonimizar el voto, para que no siga ligado a nadie.
ALTER TABLE "ResizeVote" ADD COLUMN "contributionId" INTEGER;
ALTER TABLE "ResizeVote" ADD COLUMN "wantsRefund" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ResizeVote" ALTER COLUMN "optionIndex" DROP NOT NULL;
ALTER TABLE "ResizeVote" ADD CONSTRAINT "ResizeVote_choice_valid" CHECK (("wantsRefund" AND "optionIndex" IS NULL) OR (NOT "wantsRefund" AND "optionIndex" >= 0));
ALTER TABLE "ResizeVote" ADD CONSTRAINT "ResizeVote_donation_or_anonymized" CHECK ("contributionId" IS NOT NULL OR "canonicalEmail" LIKE 'anonimizado:%');
ALTER TABLE "ResizeVote" ADD CONSTRAINT "ResizeVote_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ResizeVote_contributionId_idx" ON "ResizeVote"("contributionId");

-- La votación: nace de una campaña de presupuesto vencida; sus opciones, su plazo, su iniciativa y lo que había al lanzarla no cambian; el recuento se
-- hace una vez y su opción ganadora (una de las suyas) ya no cambia; el estado solo pasa de abierta a cerrada, una vez; y no se borra ni se vacía (es la
-- decisión que mueve el dinero de quienes donaron).
CREATE FUNCTION "resize_poll_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Las votaciones de redimensionamiento no se vacían.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una votación de redimensionamiento no se borra (ResizePoll %).', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NOT EXISTS (SELECT 1 FROM "Initiative" i WHERE i."id" = NEW."initiativeId" AND i."status" = 'EXPIRED' AND i."format" = 'BUDGET') THEN
      RAISE EXCEPTION 'Solo se vota sobre una campaña de presupuesto vencida (iniciativa %).', NEW."initiativeId";
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
    RETURN NEW;
  END IF;
  IF NEW."initiativeId" IS DISTINCT FROM OLD."initiativeId" OR NEW."optionsJson"::text IS DISTINCT FROM OLD."optionsJson"::text OR NEW."closesAt" IS DISTINCT FROM OLD."closesAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."originalGoalCents" IS DISTINCT FROM OLD."originalGoalCents" OR NEW."raisedAtLaunchCents" IS DISTINCT FROM OLD."raisedAtLaunchCents"
     OR (OLD."talliedAt" IS NOT NULL AND NEW."talliedAt" IS DISTINCT FROM OLD."talliedAt") THEN
    RAISE EXCEPTION 'Las opciones, el plazo y los datos de lanzamiento de la votación % no cambian.', OLD."id";
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'La votación % ya está cerrada.', OLD."id";
  END IF;
  -- Abierta → abierta: solo el recuento, una vez. Después, la opción ganadora no cambia (salvo quedarse sin ninguna si al final no queda dinero).
  IF NEW."status" = 'OPEN' AND (OLD."talliedAt" IS NOT NULL OR NEW."talliedAt" IS NULL) THEN
    RAISE EXCEPTION 'La votación % solo cambia con su recuento (una vez) o al cerrarse.', OLD."id";
  END IF;
  IF OLD."talliedAt" IS NOT NULL AND NEW."winningOptionIndex" IS NOT NULL AND NEW."winningOptionIndex" IS DISTINCT FROM OLD."winningOptionIndex" THEN
    RAISE EXCEPTION 'La opción ganadora de la votación % ya no cambia.', OLD."id";
  END IF;
  IF NEW."winningOptionIndex" IS NOT NULL AND NEW."winningOptionIndex" >= jsonb_array_length(NEW."optionsJson") THEN
    RAISE EXCEPTION 'La opción ganadora de la votación % no es una de sus opciones.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "ResizePoll_keep_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ResizePoll"
  FOR EACH ROW
  EXECUTE FUNCTION "resize_poll_keep_history"();
CREATE TRIGGER "ResizePoll_no_truncate" BEFORE TRUNCATE ON "ResizePoll" FOR EACH STATEMENT EXECUTE FUNCTION "resize_poll_keep_history"();

-- Un voto se emite con la votación abierta y en plazo, desde una donación completada de la misma iniciativa. Después solo se anonimiza (email canónico a
-- `anonimizado:…` y la donación soltada); su elección no cambia nunca, y no se borra ni se vacía.
CREATE FUNCTION "resize_vote_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Los votos de redimensionamiento no se vacían.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un voto no se borra (ResizeVote %).', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ResizePoll" p JOIN "Contribution" c ON c."id" = NEW."contributionId"
      WHERE p."id" = NEW."pollId" AND p."status" = 'OPEN' AND p."talliedAt" IS NULL AND p."closesAt" > now() AND c."initiativeId" = p."initiativeId" AND c."type" = 'DONATION' AND c."status" = 'COMPLETED'
    ) THEN
      RAISE EXCEPTION 'El voto no casa con una votación abierta y una donación completada de su iniciativa (votación %, donación %).', NEW."pollId", NEW."contributionId";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."pollId" IS DISTINCT FROM OLD."pollId" OR NEW."optionIndex" IS DISTINCT FROM OLD."optionIndex"
     OR NEW."wantsRefund" IS DISTINCT FROM OLD."wantsRefund" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."contributionId" IS DISTINCT FROM OLD."contributionId" AND NEW."contributionId" IS NOT NULL)
     OR (NEW."canonicalEmail" IS DISTINCT FROM OLD."canonicalEmail" AND NEW."canonicalEmail" NOT LIKE 'anonimizado:%') THEN
    RAISE EXCEPTION 'El voto % no cambia (solo se anonimiza).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "ResizeVote_keep_history"
  BEFORE INSERT OR UPDATE OR DELETE ON "ResizeVote"
  FOR EACH ROW
  EXECUTE FUNCTION "resize_vote_keep_history"();
CREATE TRIGGER "ResizeVote_no_truncate" BEFORE TRUNCATE ON "ResizeVote" FOR EACH STATEMENT EXECUTE FUNCTION "resize_vote_keep_history"();
