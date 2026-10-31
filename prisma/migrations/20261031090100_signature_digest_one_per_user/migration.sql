-- Lo que se firmó, para poder volver a verificar la huella de una firma aunque el importe cambie después.
ALTER TABLE "DoubleCheckSignature" ADD COLUMN "targetDigest" TEXT NOT NULL DEFAULT '';

-- La fila del cargo con el que se firmó, sin clave foránea: debe sobrevivir a la baja para poder verificar la huella.
ALTER TABLE "DoubleCheckSignature" ADD COLUMN "membershipId" INTEGER NOT NULL DEFAULT 0;

-- Una firma queda atada a la fila de su cargo. Cambiar de cargo obliga a una fila nueva: si no, quien pierde el rol y lo recupera
-- con un UPDATE resucitaría sus firmas antiguas.
CREATE FUNCTION "organization_member_keep_identity"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Un cargo no se modifica: se da de baja y se crea uno nuevo (OrganizationMember %).', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrganizationMember_keep_identity"
  BEFORE UPDATE ON "OrganizationMember"
  FOR EACH ROW
  WHEN (OLD."role" IS DISTINCT FROM NEW."role" OR OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId")
  EXECUTE FUNCTION "organization_member_keep_identity"();

-- Una persona firma una idea una sola vez, aunque cambie de email. Las filas sin usuario (anonimizadas) no chocan: NULL no se repite.
CREATE UNIQUE INDEX "IdeaSignatureAudit_ideaId_userId_key" ON "IdeaSignatureAudit"("ideaId", "userId");
