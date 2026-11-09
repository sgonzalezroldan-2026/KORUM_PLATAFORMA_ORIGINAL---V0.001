-- Sprint 4.2e · Relevo de firmantes y cargos.
-- Cada persona firmante puede ceder su puesto, y cualquiera de las dos puede proponer el relevo de la otra, que lo confirma con su código
-- (decisión del promotor del 2026-11-09). La persona nueva no firma hasta aceptar su invitación; entonces se da de baja la fila del cargo de quien
-- sale (sus firmas pendientes dejan de valer: estaban atadas a esa fila) y se crea la suya, en la misma transacción.
CREATE TYPE "SignerHandoverStatus" AS ENUM ('AWAITING_CONSENT', 'INVITED', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "SignerHandover" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "outgoingMemberId" INTEGER NOT NULL,
    "outgoingUserId" TEXT NOT NULL,
    "incomingUserId" TEXT NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "proposedByUserId" TEXT NOT NULL,
    "status" "SignerHandoverStatus" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consentedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignerHandover_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SignerHandover_organizationId_status_idx" ON "SignerHandover"("organizationId", "status");
ALTER TABLE "SignerHandover" ADD CONSTRAINT "SignerHandover_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Solo se relevan los dos puestos que firman, nunca a una persona por sí misma, con textos cortos (salen en el panel y en los emails), y un relevo
-- invitado siempre tiene el visto bueno de quien sale.
ALTER TABLE "SignerHandover" ADD CONSTRAINT "SignerHandover_role_check" CHECK ("role" IN ('DIRECTOR', 'COSIGNER'));
ALTER TABLE "SignerHandover" ADD CONSTRAINT "SignerHandover_people_check" CHECK ("outgoingUserId" <> "incomingUserId");
ALTER TABLE "SignerHandover" ADD CONSTRAINT "SignerHandover_texts_check" CHECK (char_length("roleLabel") BETWEEN 3 AND 60 AND char_length("displayName") BETWEEN 2 AND 80);
ALTER TABLE "SignerHandover" ADD CONSTRAINT "SignerHandover_consent_check" CHECK ("status" IN ('AWAITING_CONSENT', 'DECLINED', 'CANCELLED', 'EXPIRED') OR "consentedAt" IS NOT NULL);
ALTER TABLE "SignerHandover" ADD CONSTRAINT "SignerHandover_closed_check" CHECK (("status" IN ('AWAITING_CONSENT', 'INVITED')) = ("closedAt" IS NULL));

-- Un solo relevo abierto por entidad: dos propuestas a la vez (una para cada puesto) podrían dejar la entidad sin ninguna de sus dos firmas.
CREATE UNIQUE INDEX "SignerHandover_one_open_key" ON "SignerHandover"("organizationId") WHERE "status" IN ('AWAITING_CONSENT', 'INVITED');

-- Un relevo cerrado no se reabre ni se reescribe: es el rastro de quién propuso, quién dio el visto bueno y quién entró. Lo único que se puede
-- cambiar de uno cerrado es el nombre que se escribió de la persona nueva, para anonimizarlo si ejerce su derecho de supresión.
CREATE FUNCTION "signer_handover_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un relevo de firmantes no se borra (SignerHandover %).', OLD."id";
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."role" IS DISTINCT FROM OLD."role" OR NEW."outgoingMemberId" IS DISTINCT FROM OLD."outgoingMemberId"
     OR NEW."outgoingUserId" IS DISTINCT FROM OLD."outgoingUserId" OR NEW."incomingUserId" IS DISTINCT FROM OLD."incomingUserId" OR NEW."proposedByUserId" IS DISTINCT FROM OLD."proposedByUserId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Las personas y el puesto de un relevo no se cambian (SignerHandover %).', OLD."id";
  END IF;
  IF OLD."status" NOT IN ('AWAITING_CONSENT', 'INVITED') AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."roleLabel" IS DISTINCT FROM OLD."roleLabel"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."consentedAt" IS DISTINCT FROM OLD."consentedAt" OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt") THEN
    RAISE EXCEPTION 'Un relevo de firmantes cerrado no se modifica (SignerHandover %).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SignerHandover_keep_history"
  BEFORE UPDATE OR DELETE ON "SignerHandover"
  FOR EACH ROW
  EXECUTE FUNCTION "signer_handover_keep_history"();
