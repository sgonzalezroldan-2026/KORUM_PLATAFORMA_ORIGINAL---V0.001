-- Sprint 4.2c · Documentos del titular (KYB) y ajustes de la entidad.
-- Cada documento queda en el cubo privado (`FileAsset`, uso `KYB_DOCUMENT`) y esta tabla dice de qué tipo es y si es el vigente. Sustituir un
-- documento no lo borra: se marca `replacedAt` y se conserva su plazo legal (mientras dure la relación + 6 años).
CREATE TYPE "KybDocumentKind" AS ENUM ('TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP', 'LEY49_ACCREDITATION');

-- Teléfono de la entidad (distinto del móvil de quien dirige, `contactPhone`), fecha de envío a revisión y nota de KORUM al devolverlos.
ALTER TABLE "Organization" ADD COLUMN "kybReviewNote" TEXT,
ADD COLUMN "kybSubmittedAt" TIMESTAMP(3),
ADD COLUMN "phone" TEXT;

-- El teléfono se guarda ya limpio (solo cifras y, como mucho, un + delante) y la nota es corta: viaja en la pantalla de la entidad.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^\+?[0-9]{9,15}$');
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_kybReviewNote_check" CHECK ("kybReviewNote" IS NULL OR char_length("kybReviewNote") <= 600);

CREATE TABLE "KybDocument" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "KybDocumentKind" NOT NULL,
    "fileId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedAt" TIMESTAMP(3),

    CONSTRAINT "KybDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KybDocument_fileId_key" ON "KybDocument"("fileId");
CREATE INDEX "KybDocument_organizationId_kind_idx" ON "KybDocument"("organizationId", "kind");
-- Un solo documento vigente de cada tipo por entidad: dos subidas a la vez no pueden dejar dos vigentes.
CREATE UNIQUE INDEX "KybDocument_current_key" ON "KybDocument"("organizationId", "kind") WHERE "replacedAt" IS NULL;

ALTER TABLE "KybDocument" ADD CONSTRAINT "KybDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KybDocument" ADD CONSTRAINT "KybDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El fichero tiene que ser un documento KYB privado de la misma entidad: un fallo del código no puede colgar de una entidad el fichero de otra
-- ni una imagen pública.
CREATE FUNCTION "kyb_document_file_matches"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "FileAsset" f
    WHERE f."id" = NEW."fileId" AND f."organizationId" = NEW."organizationId" AND f."purpose" = 'KYB_DOCUMENT' AND f."visibility" = 'PRIVATE'
  ) THEN
    RAISE EXCEPTION 'El fichero % no es un documento KYB privado de la entidad %.', NEW."fileId", NEW."organizationId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "KybDocument_file_matches"
  BEFORE INSERT ON "KybDocument"
  FOR EACH ROW
  EXECUTE FUNCTION "kyb_document_file_matches"();

-- Un documento entregado no se edita ni se borra: lo único que cambia, una sola vez, es que deja de ser el vigente (`replacedAt`).
CREATE FUNCTION "kyb_document_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un documento KYB no se borra (KybDocument %).', OLD."id";
  END IF;
  IF OLD."replacedAt" IS NOT NULL OR NEW."replacedAt" IS NULL
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."fileId" IS DISTINCT FROM OLD."fileId" OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Un documento KYB solo puede marcarse como sustituido, una vez (KybDocument %).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "KybDocument_append_only"
  BEFORE UPDATE OR DELETE ON "KybDocument"
  FOR EACH ROW
  EXECUTE FUNCTION "kyb_document_append_only"();

-- El fichero de un documento KYB tampoco se cambia de sitio ni de dueño, ni se borra, por un fallo del código (auditoría del 4.2c). Solo puede cambiar
-- su plazo (`retainUntil`) y marcarse como borrado si ya no es el vigente o si la entidad está archivada (la purga respeta además sus 6 años).
CREATE FUNCTION "kyb_file_asset_guard"() RETURNS trigger AS $$
DECLARE
  doc RECORD;
BEGIN
  SELECT k."replacedAt", o."archivedAt" INTO doc FROM "KybDocument" k JOIN "Organization" o ON o."id" = k."organizationId" WHERE k."fileId" = OLD."id";
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'El fichero de un documento KYB no se borra (FileAsset %).', OLD."id";
  END IF;
  IF NEW."bucket" IS DISTINCT FROM OLD."bucket" OR NEW."objectKey" IS DISTINCT FROM OLD."objectKey" OR NEW."visibility" IS DISTINCT FROM OLD."visibility"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose" OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType" OR NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'El fichero de un documento KYB no cambia de sitio ni de dueño (FileAsset %).', OLD."id";
  END IF;
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND doc."replacedAt" IS NULL AND doc."archivedAt" IS NULL THEN
    RAISE EXCEPTION 'El documento KYB vigente de una entidad activa no se borra (FileAsset %).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "FileAsset_kyb_guard"
  BEFORE UPDATE OR DELETE ON "FileAsset"
  FOR EACH ROW
  EXECUTE FUNCTION "kyb_file_asset_guard"();
